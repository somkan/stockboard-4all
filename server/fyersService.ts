import crypto from 'crypto';
import { db } from './db.js';
import { logger } from './logger.js';
import { FyersTokenData } from './types.js';

export function formatFyersSymbol(rawSymbol: string): string {
  if (!rawSymbol) return rawSymbol;
  let formatted = rawSymbol.trim();
  // Ensure NIFTY50 options are normalized to FYERS format: NSE:NIFTY26AUG...
  if (formatted.startsWith('NSE:NIFTY50') && (formatted.endsWith('CE') || formatted.endsWith('PE') || /\d+(CE|PE)$/i.test(formatted))) {
    formatted = formatted.replace('NSE:NIFTY50', 'NSE:NIFTY');
  }
  return formatted;
}

export class FyersService {
  private positionCache: Map<string, { ltp: number; pl: number; netAvg: number; qty: number }> = new Map();
  private lastAutoLoginAttempt: number = 0;
  private rateLimitUntil: number = 0;
  private consecutiveRateLimits: number = 0;
  private activeAutoLoginPromise: Promise<FyersTokenData> | null = null;
  private lastLogTimes: Map<string, number> = new Map();
  private lastTotpGenDate: string = '';
  private lastTotpGenTimestamp: number = 0;
  private totpFailureCooldownUntil: number = 0;
  private consecutiveTotpFailures: number = 0;
  private cachedProfile: { data: any; timestamp: number } | null = null;
  private lastVerificationResult: { isValid: boolean; timestamp: number; message: string; profile?: any } | null = null;
  private consumedAuthCodes: Set<string> = new Set();

  public markAuthCodeConsumed(code?: string): void {
    if (!code) return;
    const clean = code.trim();
    if (!clean) return;
    this.consumedAuthCodes.add(clean);
    if (clean.length > 40) {
      this.consumedAuthCodes.add(clean.substring(0, 40));
    }
  }

  public isAuthCodeConsumed(code?: string): boolean {
    if (!code) return false;
    const clean = code.trim();
    if (!clean) return false;
    return this.consumedAuthCodes.has(clean) || (clean.length > 40 && this.consumedAuthCodes.has(clean.substring(0, 40)));
  }

  public getRateLimitStatus(): { isRateLimited: boolean; remainingSec: number } {
    return { isRateLimited: false, remainingSec: 0 };
  }

  private logThrottled(key: string, message: string, level: 'warn' | 'info' | 'error' = 'warn', throttleMs: number = 60000) {
    const now = Date.now();
    const last = this.lastLogTimes.get(key) || 0;
    if (now - last > throttleMs) {
      this.lastLogTimes.set(key, now);
      if (level === 'warn') logger.warn(message);
      else if (level === 'info') logger.info(message);
      else logger.error(message);
    }
  }

  public getCacheLTP(symbol: string): number | undefined {
    return this.positionCache.get(symbol)?.ltp;
  }

  public getCachePL(symbol: string): number | undefined {
    return this.positionCache.get(symbol)?.pl;
  }

  /**
   * Returns formatted FYERS App ID with type (e.g., 'V78VJBA972-100')
   */
  public getFormattedAppId(): string {
    const settings = db.getSettings();
    let appId = (settings.fyersAppId || '').trim();
    if (appId && !appId.includes('-')) {
      const appType = (settings.fyersAppType || '100').trim();
      appId = `${appId}-${appType}`;
    }
    return appId;
  }

  /**
   * Helper to format Authorization header consistently for FYERS API v3 calls
   */
  public getAuthHeader(tokenOverride?: string): string {
    const auth = db.getFyersAuth();
    let token = (tokenOverride || auth.accessToken || '').trim();
    if (!token) return '';

    if (token.startsWith('Bearer ')) {
      token = token.substring(7).trim();
    }

    if (token.includes(':')) {
      return token;
    }

    const appId = this.getFormattedAppId();
    return appId ? `${appId}:${token}` : token;
  }

  /**
   * Generates Fyers AppId Hash: SHA256(app_id:secret_key)
   */
  public generateAppIdHash(customSecretKey?: string): string {
    const settings = db.getSettings();
    const appId = this.getFormattedAppId();
    const secret = (customSecretKey || settings.fyersSecretKey || '').trim();
    if (secret) {
      const concatStr = `${appId}:${secret}`;
      return crypto.createHash('sha256').update(concatStr).digest('hex');
    }
    if (settings.fyersAppIdHash && settings.fyersAppIdHash.trim().length === 64) {
      return settings.fyersAppIdHash.trim();
    }
    return '';
  }

  /**
   * Returns list of candidate AppId hashes to try during auth code exchange.
   * Prioritizes valid custom hashes and correctly computed SHA256(formattedAppId:secretKey).
   */
  public getAppIdHashCandidates(customAppIdHash?: string, customSecretKey?: string): string[] {
    const settings = db.getSettings();
    const candidates: string[] = [];
    const formattedAppId = this.getFormattedAppId();
    const rawAppId = (settings.fyersAppId || '').trim();

    // 1. If an explicit custom App ID Hash is provided, try it FIRST
    if (customAppIdHash && customAppIdHash.trim().length === 64) {
      candidates.push(customAppIdHash.trim().toLowerCase());
    }

    // 2. If an App ID Hash is saved in settings, add it
    if (settings.fyersAppIdHash && settings.fyersAppIdHash.trim().length === 64) {
      const savedHash = settings.fyersAppIdHash.trim().toLowerCase();
      if (!candidates.includes(savedHash)) {
        candidates.push(savedHash);
      }
    }

    // 3. Determine secret to use
    const secret = (customSecretKey || settings.fyersSecretKey || '').trim();
    const totpKey = (settings.fyersTotpKey || '').trim();
    const isTotpMistakenForSecret = secret && totpKey && secret.toUpperCase() === totpKey.toUpperCase();

    if (secret) {
      // Calculate standard Fyers API v3 specification: SHA256(formattedAppId:secretKey)
      if (formattedAppId) {
        const formattedHash = crypto.createHash('sha256').update(`${formattedAppId}:${secret}`).digest('hex');
        if (!candidates.includes(formattedHash)) {
          // If the secret is NOT the TOTP key, prioritize this computed hash
          if (!isTotpMistakenForSecret) {
            candidates.unshift(formattedHash);
          } else {
            candidates.push(formattedHash);
          }
        }
      }

      // Base AppId without suffix (e.g. V78VJBA972:secret)
      if (rawAppId && rawAppId !== formattedAppId) {
        const rawHash = crypto.createHash('sha256').update(`${rawAppId}:${secret}`).digest('hex');
        if (!candidates.includes(rawHash)) {
          candidates.push(rawHash);
        }
      }
    }

    // 4. Also include the placeholder candidate if not yet present
    const fallbackPlaceholder = '5593718a0e9e2e8f01ba03f0a8415502cff7f0be93cdd7ac201186d0cce0406d';
    if (!candidates.includes(fallbackPlaceholder)) {
      candidates.push(fallbackPlaceholder);
    }

    return candidates;
  }

  /**
   * Directly fetches the active user profile from Fyers API v3 (/api/v3/profile)
   */
  public async getProfile(tokenOverride?: string): Promise<{ success: boolean; data?: any; error?: string }> {
    const auth = db.getFyersAuth();
    const token = (tokenOverride || auth.accessToken || '').trim();
    if (!token) {
      return { success: false, error: 'No Fyers access token available' };
    }

    const appId = this.getFormattedAppId();
    const authHeader = this.getAuthHeader(token);

    const endpoints = [
      'https://api-t1.fyers.in/api/v3/profile',
      'https://api.fyers.in/api/v3/profile'
    ];

    for (const url of endpoints) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 4000);
        const res = await fetch(url, {
          headers: {
            'Authorization': authHeader,
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/plain, */*'
          },
          signal: controller.signal
        });
        clearTimeout(timeoutId);

        const data = await res.json() as any;
        if (res.ok && data && (data.s === 'ok' || data.code === 200)) {
          const profileData = data.data || data.d || data;
          this.cachedProfile = { data: profileData, timestamp: Date.now() };
          return { success: true, data: profileData };
        }

        if (res.status === 401 || (data && (data.code === -17 || data.code === -16))) {
          return { success: false, error: data?.message || 'Fyers authentication rejected (401 Unauthorized)' };
        }
      } catch (err: any) {
        // Try fallback endpoint
      }
    }
    return { success: false, error: 'Could not connect to Fyers profile API' };
  }

  /**
   * Actively verifies the validity of a Fyers access token against live API
   */
  public async verifyTokenWithFyers(tokenOverride?: string): Promise<{ isValid: boolean; message: string; profile?: any }> {
    const res = await this.getProfile(tokenOverride);
    if (res.success && res.data) {
      const p = res.data;
      const name = p.display_name || p.name || p.fy_id || 'Fyers Trader';
      const fyId = p.fy_id || '';
      const msg = `Connected to Fyers: ${name}${fyId ? ` (${fyId})` : ''}`;
      this.lastVerificationResult = { isValid: true, timestamp: Date.now(), message: msg, profile: p };
      return { isValid: true, message: msg, profile: p };
    }

    const errorMsg = res.error || 'Fyers token verification failed';
    this.lastVerificationResult = { isValid: false, timestamp: Date.now(), message: errorMsg };
    return { isValid: false, message: errorMsg };
  }

  /**
   * Checks if a Fyers authorization code or redirect URL contains a still-unexpired JWT code.
   * Fyers authorization codes expire strictly within 5 minutes (300 seconds) from issue.
   */
  public isAuthCodeValid(inputCode?: string): boolean {
    if (!inputCode || !inputCode.trim()) return false;
    try {
      const { authCode } = this.extractTokenOrCodeFromUrl(inputCode);
      const code = (authCode || inputCode).trim();
      if (!code) return false;

      if (this.isAuthCodeConsumed(code)) {
        return false;
      }

      if (code.startsWith('eyJ') && code.includes('.')) {
        const parts = code.split('.');
        if (parts.length >= 2) {
          const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));

          // Explicit access token claim means it cannot be an auth code
          if (payload.sub === 'access_token' || payload.type === 'access_token' || payload.scope === 'access_token') {
            return false;
          }

          // Fyers auth codes strictly expire within 5 minutes (lifetime <= 900s).
          // If token lifetime is > 15 minutes, it is an access token, NOT an auth code.
          if (payload.exp && payload.iat) {
            const lifetime = payload.exp - payload.iat;
            if (lifetime > 900) {
              return false;
            }
          }

          if (payload.iat && typeof payload.iat === 'number') {
            const ageSeconds = (Date.now() / 1000) - payload.iat;
            if (ageSeconds > 360) {
              return false;
            }
          }

          if (payload.exp && typeof payload.exp === 'number') {
            // exp in seconds
            return Date.now() < (payload.exp * 1000);
          }
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Checks if an authorization code or redirect URL has explicitly expired by decoding its JWT timestamp.
   */
  public isAuthCodeExpired(inputCode?: string): boolean {
    if (!inputCode || !inputCode.trim()) return false;
    try {
      const { authCode } = this.extractTokenOrCodeFromUrl(inputCode);
      const code = (authCode || inputCode).trim();
      if (!code) return false;
      if (this.isAuthCodeConsumed(code)) {
        return true;
      }
      if (code.startsWith('eyJ') && code.includes('.')) {
        const parts = code.split('.');
        if (parts.length >= 2) {
          const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
          if (payload.exp && typeof payload.exp === 'number') {
            return Date.now() >= (payload.exp * 1000);
          }
        }
      }
    } catch {
      return false;
    }
    return false;
  }

  /**
   * Builds OAuth Authorization URL for Fyers API v3
   */
  public getAuthUrl(customRedirectUri?: string, statePayload?: string): string {
    const settings = db.getSettings();
    const appId = this.getFormattedAppId();
    let rawUri = customRedirectUri || settings.fyersRedirectUri || 'https://127.0.0.1:6414';
    // If no custom URI is provided and settings has a cloud callback URL, fallback to https://127.0.0.1:6414
    // to prevent 401 Unauthorized errors from Fyers when cloud URL is not registered on myapi.fyers.in
    if (!customRedirectUri && rawUri.includes('/auth/callback')) {
      rawUri = 'https://127.0.0.1:6414';
    }
    const cleanUri = rawUri.trim();
    const redirectUri = encodeURIComponent(cleanUri);
    const state = encodeURIComponent(statePayload || 'fyers_iron_condor_state');

    return `https://api-t1.fyers.in/api/v3/generate-authcode?client_id=${appId}&redirect_uri=${redirectUri}&response_type=code&state=${state}`;
  }

  /**
   * Native Base32 TOTP Code Generator (RFC 6238) for backend TOTP verification
   */
  public generateTOTP(secretBase32: string): string {
    if (!secretBase32) return '';
    const cleanSecret = secretBase32.replace(/=+$/, '').toUpperCase().replace(/\s+/g, '');
    const base32chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = '';
    for (let i = 0; i < cleanSecret.length; i++) {
      const val = base32chars.indexOf(cleanSecret.charAt(i));
      if (val < 0) continue;
      bits += val.toString(2).padStart(5, '0');
    }
    const bytes = new Uint8Array(Math.floor(bits.length / 8));
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(bits.substring(i * 8, i * 8 + 8), 2);
    }

    const epoch = Math.floor(Date.now() / 1000);
    const timeStep = Math.floor(epoch / 30);
    const timeBuffer = Buffer.alloc(8);
    timeBuffer.writeUInt32BE(0, 0);
    timeBuffer.writeUInt32BE(timeStep, 4);

    const hmac = crypto.createHmac('sha1', Buffer.from(bytes)).update(timeBuffer).digest();
    const offset = hmac[hmac.length - 1] & 0xf;
    const code = ((hmac[offset] & 0x7f) << 24) |
                 ((hmac[offset + 1] & 0xff) << 16) |
                 ((hmac[offset + 2] & 0xff) << 8) |
                 (hmac[offset + 3] & 0xff);
    return (code % 1000000).toString().padStart(6, '0');
  }

  /**
   * Helper to extract access token or auth code from full redirect URL or raw strings
   */
  public extractTokenOrCodeFromUrl(inputStr: string): { accessToken?: string; authCode?: string } {
    if (!inputStr || !inputStr.trim()) return {};
    let str = inputStr.trim().replace(/^["']|["']$/g, '');
    if (str.startsWith('Bearer ')) {
      str = str.replace(/^Bearer\s+/i, '').trim();
    }

    // Replace HTML entities like &amp;
    str = str.replace(/&amp;/g, '&');

    // Strip markdown links [text](url) or angle brackets <url>
    const mdMatch = str.match(/\[.*?\]\((https?:\/\/[^\s)]+)\)/);
    if (mdMatch && mdMatch[1]) str = mdMatch[1];
    str = str.replace(/^<|>$/g, '').trim();

    // Check if user accidentally pasted the initial authorization URL instead of the callback redirect
    if (str.includes('generate-authcode') && !str.includes('auth_code=') && !str.includes('access_token=')) {
      throw new Error('You pasted the Fyers login request URL instead of the redirect URL. Please open this link in your browser, log into Fyers with your PIN/TOTP, and after you are redirected, copy the complete URL from your browser address bar.');
    }

    // Decode URL-encoded string if whole string is encoded
    if (str.includes('%3A%2F%2F') || (str.includes('%3D') && str.includes('%26'))) {
      try {
        str = decodeURIComponent(str);
      } catch {
        // ignore
      }
    }

    // Try parsing as JSON if wrapped in braces
    if ((str.startsWith('{') && str.endsWith('}')) || (str.includes('{"') && str.includes('"}'))) {
      try {
        const jsonStart = str.indexOf('{');
        const jsonEnd = str.lastIndexOf('}');
        const jsonSub = str.substring(jsonStart, jsonEnd + 1);
        const parsed = JSON.parse(jsonSub);
        const candidateCode = parsed.auth_code || parsed.authCode || (parsed.code && typeof parsed.code === 'string' && parsed.code.length > 15 ? parsed.code : undefined);
        const candidateToken = parsed.access_token || parsed.accessToken || parsed.token;
        if (candidateCode) return { authCode: String(candidateCode).trim() };
        if (candidateToken) return { accessToken: String(candidateToken).trim() };
      } catch {
        // ignore
      }
    }

    // Direct key-value strings: auth_code=... or access_token=...
    if (/^auth_?code=/i.test(str)) {
      const val = str.replace(/^auth_?code=/i, '').split('&')[0].trim();
      if (val) return { authCode: decodeURIComponent(val) };
    }
    if (/^(access_?token|token)=/i.test(str)) {
      const val = str.replace(/^(access_?token|token)=/i, '').split('&')[0].trim();
      if (val) return { accessToken: decodeURIComponent(val) };
    }

    // Regex check for auth_code= or access_token= inside any string or URL
    const authCodeRegexMatch = str.match(/auth_?code=([a-zA-Z0-9._\-]+)/i);
    if (authCodeRegexMatch && authCodeRegexMatch[1]) {
      return { authCode: decodeURIComponent(authCodeRegexMatch[1]) };
    }
    const tokenRegexMatch = str.match(/(?:access_?token|token)=([a-zA-Z0-9._\-]+)/i);
    if (tokenRegexMatch && tokenRegexMatch[1]) {
      return { accessToken: decodeURIComponent(tokenRegexMatch[1]) };
    }

    // Extract search / hash parameters
    let searchPart = '';
    if (str.includes('?')) {
      searchPart += str.split('?')[1].split('#')[0] + '&';
    }
    if (str.includes('#')) {
      searchPart += str.split('#')[1] + '&';
    }
    if (!str.includes('?') && !str.includes('#') && str.includes('=')) {
      searchPart = str;
    }

    if (searchPart) {
      const params = new URLSearchParams(searchPart);

      // Check for Fyers redirect error responses
      const sParam = params.get('s');
      const errorMsg = params.get('error_description') || params.get('message') || params.get('error');
      if (sParam === 'error' || (errorMsg && !params.get('auth_code') && !params.get('access_token'))) {
        throw new Error(`Fyers login returned error: ${decodeURIComponent(errorMsg || 'Authentication was denied or cancelled')}. Please click 'Launch Fyers Auth' to authenticate again.`);
      }

      // If user copied URL with code=200 but missing auth_code
      if ((sParam === 'ok' || params.get('code') === '200') && !params.get('auth_code') && !params.get('access_token')) {
        throw new Error('The URL contains status code 200 but is missing the auth_code parameter. Please ensure you copied the complete URL from your browser address bar.');
      }

      const authCode = params.get('auth_code') || params.get('authCode');
      const accessToken = params.get('access_token') || params.get('token') || params.get('accessToken');

      // In Fyers redirect, auth_code is always the primary credential to exchange
      if (authCode) {
        return { authCode: decodeURIComponent(authCode) };
      }
      if (accessToken) {
        return { accessToken: decodeURIComponent(accessToken) };
      }

      const codeParam = params.get('code');
      // If codeParam is not numeric status (e.g. 200), it might be an auth code
      if (codeParam && codeParam.length > 15 && !/^\d+$/.test(codeParam)) {
        return { authCode: decodeURIComponent(codeParam) };
      }
    }

    // Direct JWT detection anywhere in the string (embedded or exact)
    const jwtRegex = /(eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,})/;
    const jwtMatch = str.match(jwtRegex);
    if (jwtMatch && jwtMatch[1]) {
      const jwtCandidate = jwtMatch[1];
      try {
        const parts = jwtCandidate.split('.');
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
        const isExplicitAuthCode = payload.sub === 'auth_code' || payload.type === 'auth_code' || payload.scope === 'auth_code';
        const isExplicitAccessToken = payload.sub === 'access_token' || payload.type === 'access_token' || payload.scope === 'access_token';

        if (isExplicitAuthCode) {
          return { authCode: jwtCandidate };
        }
        if (isExplicitAccessToken) {
          return { accessToken: jwtCandidate };
        }

        // Fyers auth codes expire strictly within 5 minutes (300s, lifetime <= 900s).
        // Fyers access tokens last 24 hours (86400s).
        if (payload.exp && payload.iat) {
          const lifetime = payload.exp - payload.iat;
          if (lifetime <= 900) {
            return { authCode: jwtCandidate };
          } else {
            return { accessToken: jwtCandidate };
          }
        }

        if (payload.exp) {
          const timeLeftSec = payload.exp - Math.floor(Date.now() / 1000);
          if (timeLeftSec <= 360) {
            return { authCode: jwtCandidate };
          } else {
            return { accessToken: jwtCandidate };
          }
        }
      } catch {
        // Fallback if parsing fails
      }
      return { accessToken: jwtCandidate };
    }

    // Non-URL raw code string
    if (!str.includes('=') && !str.includes('?') && !str.includes('&') && str.length > 15) {
      return { authCode: str };
    }

    return {};
  }

  /**
   * Connects Fyers using full redirect URL (extracting access token or auth code automatically)
   */
  public async connectFromUrl(
    inputUrl: string,
    targetUserId?: string,
    targetUserEmail?: string,
    customAppIdHash?: string,
    customSecretKey?: string
  ): Promise<FyersTokenData> {
    const { accessToken, authCode } = this.extractTokenOrCodeFromUrl(inputUrl);

    if (accessToken) {
      logger.info('Extracted potential Access Token, validating with Fyers live API...');
      const verifyRes = await this.verifyTokenWithFyers(accessToken);
      if (verifyRes.isValid) {
        const expiresAt = Date.now() + (24 * 60 * 60 * 1000);
        const updatedAuth = db.updateFyersAuth({
          accessToken,
          expiresAt,
          isValid: true
        }, targetUserId, targetUserEmail);

        if (targetUserId) {
          db.saveUserAccessCode(targetUserId, updatedAuth, targetUserEmail);
        }

        this.rateLimitUntil = 0;
        this.consecutiveRateLimits = 0;
        logger.success(`Fyers Access Token verified and saved! ${verifyRes.message}`);
        return updatedAuth;
      }

      // If direct access token verification failed, but authCode is also present (or token starts with eyJ and could be an auth code)
      if (authCode && authCode !== accessToken) {
        logger.info('Token verification failed, trying extracted Auth Code instead...');
        return await this.validateAuthCode(authCode, targetUserId, targetUserEmail, customAppIdHash, customSecretKey);
      } else if (this.isAuthCodeValid(accessToken)) {
        logger.info('Direct token verification returned invalid. Attempting to exchange as Fyers Auth Code...');
        try {
          return await this.validateAuthCode(accessToken, targetUserId, targetUserEmail, customAppIdHash, customSecretKey);
        } catch (exchangeErr: any) {
          throw new Error(`Fyers token verification failed: ${verifyRes.message}. Token exchange also failed: ${exchangeErr.message}. Please trigger a fresh auth link.`);
        }
      }

      throw new Error(`Fyers rejected this access token: ${verifyRes.message}. Please trigger a new auth link and copy the new redirect URL.`);
    }

    if (authCode) {
      if (this.isAuthCodeExpired(authCode)) {
        const errMsg = 'This Fyers authorization code has expired (Fyers codes are single-use and expire within 5 minutes). Please click "Launch Fyers Auth" to generate a fresh link.';
        db.clearAuthCode(targetUserId);
        logger.warn(errMsg);
        throw new Error(errMsg);
      }
      logger.info('Extracted Auth Code from URL, exchanging with Fyers API...');
      return await this.validateAuthCode(authCode, targetUserId, targetUserEmail, customAppIdHash, customSecretKey);
    }

    throw new Error('Could not extract a valid access_token or auth_code from the provided URL. Please copy the complete URL from your browser address bar.');
  }

  /**
   * Attempts 100% automated headless TOTP + PIN authentication with Fyers SSO
   */
  public async attemptHeadlessLogin(targetUserId?: string, targetUserEmail?: string): Promise<FyersTokenData> {
    const settings = db.getSettings();
    const fyId = (settings.fyId || '').trim();
    const totpKey = (settings.fyersTotpKey || '').trim();
    const pin = (settings.fyersPin || '').trim();
    const appId = this.getFormattedAppId();

    if (!fyId || !totpKey || !pin) {
      throw new Error('Automated headless login requires FYERS Client ID, TOTP Secret Key, and PIN in settings.');
    }

    const now = Date.now();
    if (now < this.totpFailureCooldownUntil) {
      const waitSec = Math.ceil((this.totpFailureCooldownUntil - now) / 1000);
      throw new Error(`Headless login cooldown active (${waitSec}s). Please use 1-Click "Launch Fyers Auth" to authenticate in your browser.`);
    }

    logger.info(`Initiating automated headless TOTP authentication for ${fyId}...`);

    const totp = this.generateTOTP(totpKey);
    if (!totp || totp.length !== 6) {
      throw new Error('Failed to generate valid 6-digit TOTP code from secret key.');
    }

    const browserHeaders = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/plain, */*',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
      'Origin': 'https://login.fyers.in',
      'Referer': 'https://login.fyers.in/',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-site',
      'Sec-Fetch-Dest': 'empty'
    };

    try {
      // Step 1: Send Login OTP / Request Key initiation
      const sendOtpRes = await fetch('https://api-t2.fyers.in/vagator/v2/send_login_otp', {
        method: 'POST',
        headers: browserHeaders,
        body: JSON.stringify({
          fy_id: fyId,
          app_id: (settings.fyersAppIdType || '2').trim()
        })
      });

      if (sendOtpRes.status === 429 || sendOtpRes.status === 403) {
        this.totpFailureCooldownUntil = Date.now() + (10 * 1000);
        throw new Error('Fyers login rate-limited automated headless requests from cloud IP (Cloudflare 1015 on api-t2.fyers.in).');
      }

      const otpData = await sendOtpRes.json() as any;
      if (!sendOtpRes.ok || !otpData || (!otpData.request_key && otpData.s !== 'ok')) {
        throw new Error(otpData?.message || `Failed to initiate Fyers login OTP (status ${sendOtpRes.status})`);
      }

      const requestKey = otpData.request_key;
      if (!requestKey) {
        throw new Error('Fyers did not return a valid request_key for OTP verification.');
      }

      // Step 2: Verify TOTP
      const verifyOtpRes = await fetch('https://api-t2.fyers.in/vagator/v2/verify_otp', {
        method: 'POST',
        headers: browserHeaders,
        body: JSON.stringify({
          request_key: requestKey,
          otp: totp
        })
      });

      const verifyOtpData = await verifyOtpRes.json() as any;
      if (!verifyOtpRes.ok || !verifyOtpData || verifyOtpData.s !== 'ok') {
        throw new Error(verifyOtpData?.message || 'Failed to verify TOTP code with Fyers.');
      }

      const updatedRequestKey = verifyOtpData.request_key || requestKey;

      // Step 3: Verify PIN
      const verifyPinRes = await fetch('https://api-t2.fyers.in/vagator/v2/verify_pin', {
        method: 'POST',
        headers: browserHeaders,
        body: JSON.stringify({
          request_key: updatedRequestKey,
          identity_type: 'pin',
          identifier: pin
        })
      });

      const verifyPinData = await verifyPinRes.json() as any;
      if (!verifyPinRes.ok || !verifyPinData || verifyPinData.s !== 'ok') {
        throw new Error(verifyPinData?.message || 'Failed to verify PIN with Fyers.');
      }

      // Step 4: Extract session bearer token and capture local URI in headless mode
      const returnedData = verifyPinData.data || verifyPinData.d || verifyPinData;
      const sessionBearerToken = returnedData.access_token || returnedData.token;
      const returnedAuthCode = returnedData.auth_code || returnedData.code;

      if (returnedAuthCode) {
        logger.info(`Headless authentication retrieved auth code directly from verify_pin, exchanging with API v3...`);
        return await this.validateAuthCode(returnedAuthCode, targetUserId, targetUserEmail);
      }

      if (!sessionBearerToken) {
        throw new Error('Fyers verified PIN but did not return a session access token.');
      }

      // First check if the returned token is already an active API access token
      const verifyDirectRes = await this.verifyTokenWithFyers(sessionBearerToken);
      if (verifyDirectRes.isValid) {
        logger.success(`Headless authentication succeeded! Active 24H access token verified for ${fyId}.`);
        const expiresAt = Date.now() + (24 * 60 * 60 * 1000);
        const updated = db.updateFyersAuth({
          accessToken: sessionBearerToken,
          expiresAt,
          isValid: true
        }, targetUserId, targetUserEmail);

        if (targetUserId) {
          db.saveUserAccessCode(targetUserId, updated, targetUserEmail);
        }
        return updated;
      }

      // Request OAuth authorization code from Fyers API v3 token endpoint
      // NOTE: Fyers v3 token endpoint requires the raw app_id (without -100 suffix)
      const redirectUri = settings.fyersRedirectUri || 'https://127.0.0.1:6414';
      const rawAppId = (settings.fyersAppId || '').replace(/-.*$/, '').trim();
      logger.info(`Capturing local URI in headless mode via Fyers token endpoint (rawAppId: ${rawAppId}, redirectUri: ${redirectUri})...`);

      const tokenPayload = {
        fyers_id: fyId,
        app_id: rawAppId || appId,
        redirect_uri: redirectUri,
        appType: (settings.fyersAppType || '100').trim(),
        code_challenge: '',
        state: 'fyers_iron_condor_state',
        scope: '',
        nonce: '',
        response_type: 'code',
        create_cookie: true
      };

      const tokenRes = await fetch('https://api-t1.fyers.in/api/v3/token', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${sessionBearerToken}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/plain, */*',
          'Origin': 'https://login.fyers.in',
          'Referer': 'https://login.fyers.in/',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-site'
        },
        body: JSON.stringify(tokenPayload)
      });

      const tokenData = await tokenRes.json() as any;
      logger.info('Fyers token endpoint headless response:', {
        status: tokenRes.status,
        s: tokenData.s,
        code: tokenData.code,
        hasUrl: Boolean(tokenData.Url || tokenData.url || tokenData.data?.Url)
      });

      // 1. Capture local URI from headless response and parse for extracting access code
      const localUri = tokenData.Url || tokenData.url || tokenData.data?.Url || tokenData.data?.url || tokenData.redirect_url;
      if (localUri) {
        logger.info(`Captured local URI from headless response: ${localUri}`);
        const { authCode, accessToken } = this.extractTokenOrCodeFromUrl(localUri);
        if (authCode) {
          logger.info(`Successfully parsed access code from local URI in headless mode! Exchanging for 24H API token...`);
          return await this.validateAuthCode(authCode, targetUserId, targetUserEmail);
        }
        if (accessToken) {
          logger.info(`Extracted access token directly from local URI in headless mode! Validating...`);
          return await this.connectFromUrl(accessToken, targetUserId, targetUserEmail);
        }
      }

      // 2. Direct auth_code or access_token in response body
      const directCode = tokenData.auth_code || tokenData.code || tokenData.data?.auth_code;
      if (directCode && typeof directCode === 'string' && directCode.length > 20) {
        logger.info(`Parsed access code directly from headless response! Exchanging for 24H API token...`);
        return await this.validateAuthCode(directCode, targetUserId, targetUserEmail);
      }

      const directAccessToken = tokenData.access_token || tokenData.data?.access_token;
      if (directAccessToken && typeof directAccessToken === 'string' && directAccessToken.length > 20) {
        logger.info(`Parsed access token directly from headless response! Validating...`);
        return await this.connectFromUrl(directAccessToken, targetUserId, targetUserEmail);
      }

      throw new Error(tokenData?.message || 'Fyers verified PIN but did not return a local URI or access code.');
    } catch (err: any) {
      this.totpFailureCooldownUntil = Date.now() + (15 * 1000); // 15s cooldown
      throw err;
    }
  }

  /**
   * Performs authentication using stored FYERS credentials or returns active token.
   * Eliminates manual interruption by trying headless login first, then seamless OAuth.
   */
  public async autoLoginWithBackendCredentials(force: boolean = false, targetUserId?: string, targetUserEmail?: string): Promise<FyersTokenData> {
    const currentAuth = db.getFyersAuth(targetUserId);

    // 1. If access token exists, test if it is already valid
    if (currentAuth.accessToken) {
      if (!force && currentAuth.isValid && currentAuth.expiresAt > Date.now()) {
        return currentAuth;
      }
      try {
        const verifyRes = await this.verifyTokenWithFyers(currentAuth.accessToken);
        if (verifyRes.isValid) {
          const expiresAt = currentAuth.expiresAt > Date.now() ? currentAuth.expiresAt : Date.now() + (24 * 60 * 60 * 1000);
          const updated = db.updateFyersAuth({
            ...currentAuth,
            isValid: true,
            expiresAt
          }, targetUserId, targetUserEmail);
          if (targetUserId) {
            db.saveUserAccessCode(targetUserId, updated, targetUserEmail);
          }
          return updated;
        }
      } catch {
        // Token expired or invalid, continue to refresh or headless
      }
    }

    // 2. Try Refresh Token if available
    if (currentAuth.refreshToken) {
      try {
        const refreshed = await this.refreshAccessToken();
        if (refreshed && refreshed.isValid && refreshed.expiresAt > Date.now()) {
          if (targetUserId) {
            db.saveUserAccessCode(targetUserId, refreshed, targetUserEmail);
          }
          return refreshed;
        }
      } catch (err: any) {
        logger.info(`Refresh token attempt notice: ${err.message}`);
      }
    }

    // 3. Try automated headless login with TOTP + PIN if credentials exist
    const settings = db.getSettings();
    if (settings.fyId && settings.fyersTotpKey && settings.fyersPin) {
      try {
        const headlessResult = await this.attemptHeadlessLogin(targetUserId, targetUserEmail);
        if (headlessResult && headlessResult.isValid && headlessResult.expiresAt > Date.now()) {
          return headlessResult;
        }
      } catch (err: any) {
        logger.info('Auto-login headless TOTP attempt completed:', err.message);
      }
    }

    throw new Error(`Fyers broker authorization required. Click 'Launch Fyers Auth' to login in 1 click, or paste your redirect URL.`);
  }

  /**
   * Validates auth code and fetches Access Token from Fyers API v3
   */
  public async validateAuthCode(
    authCode: string,
    targetUserId?: string,
    targetUserEmail?: string,
    customAppIdHash?: string,
    customSecretKey?: string
  ): Promise<FyersTokenData> {
    const cleanAuthCode = authCode.trim();

    if (this.isAuthCodeConsumed(cleanAuthCode) || this.isAuthCodeExpired(cleanAuthCode)) {
      this.markAuthCodeConsumed(cleanAuthCode);
      db.clearAuthCode(targetUserId);
      const errMsg = 'This Fyers authorization code has expired or was already consumed (Fyers codes are single-use and valid for strictly 5 minutes). Please click "Launch Fyers Auth" to generate a fresh link.';
      logger.info('Fyers authorization code already consumed or expired, skipping exchange.');
      throw new Error(errMsg);
    }

    const hashCandidates = this.getAppIdHashCandidates(customAppIdHash, customSecretKey);
    if (hashCandidates.length === 0) {
      hashCandidates.push(this.generateAppIdHash(customSecretKey));
    }

    logger.info('Exchanging Auth Code for Access Token with Fyers API...', {
      authCode: cleanAuthCode.substring(0, 10) + '...',
      hashesCount: hashCandidates.length
    });

    let lastErrorMsg = 'Failed to exchange auth code with Fyers';
    let lastData: any = null;

    for (const appIdHash of hashCandidates) {
      const payload = {
        grant_type: 'authorization_code',
        appIdHash: appIdHash,
        code: cleanAuthCode
      };

      try {
        const res = await fetch('https://api-t1.fyers.in/api/v3/validate-authcode', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          body: JSON.stringify(payload)
        });

        const data = await res.json() as any;
        lastData = data;

        if (res.ok && data && (data.access_token || (data.s === 'ok' && data.access_token))) {
          const tokenVal = data.access_token || (data.data && data.data.access_token);
          // Token valid for 24 hours
          const expiresAt = Date.now() + (24 * 60 * 60 * 1000);
          
          // Verify with Fyers profile to warm up user details
          const verifyRes = await this.verifyTokenWithFyers(tokenVal);

          const updatedAuth = db.updateFyersAuth({
            accessToken: tokenVal,
            refreshToken: data.refresh_token || '',
            expiresAt,
            isValid: true
          }, targetUserId, targetUserEmail);

          // Mark authCode as consumed and clear any stored single-use authCode now that it has been exchanged
          this.markAuthCodeConsumed(cleanAuthCode);
          db.clearAuthCode(targetUserId);

          if (targetUserId) {
            db.saveUserAccessCode(targetUserId, updatedAuth, targetUserEmail);
          }

          // Persist the confirmed working appIdHash so subsequent operations use it directly
          if (appIdHash && appIdHash.length === 64) {
            db.updateSettings({
              fyersAppIdHash: appIdHash,
              ...(customSecretKey ? { fyersSecretKey: customSecretKey } : {})
            });
          }

          // Clear any cooldowns/rate limits completely
          this.rateLimitUntil = 0;
          this.consecutiveRateLimits = 0;

          logger.success(`Fyers Access Token retrieved and saved successfully! ${verifyRes.isValid ? verifyRes.message : ''}`);
          return updatedAuth;
        }

        // Check error returned by Fyers
        const errMsg = data.message || data.errMsg || `Fyers returned status ${res.status}`;
        lastErrorMsg = errMsg;

        // Diagnostic handling for -5 (invalid app id hash)
        if (data.code === -5 || errMsg.toLowerCase().includes('app id hash')) {
          const currentSettings = db.getSettings();
          const secret = (customSecretKey || currentSettings.fyersSecretKey || '').trim();
          const totp = (currentSettings.fyersTotpKey || '').trim();
          const isTotpSecret = secret && totp && secret.toUpperCase() === totp.toUpperCase();

          lastErrorMsg = `Fyers rejected the App ID Hash ("invalid app id hash", code -5). ${
            isTotpSecret
              ? 'Notice: Your Fyers Secret Key in Settings is set to your 32-character 2FA TOTP key! Fyers App Secret is found on https://myapi.fyers.in under your App Details (usually 10-12 characters). Please update your App Secret Key in Settings or enter your SHA256 App ID Hash.'
              : 'Please ensure your App ID and Secret Key in Settings match your registered App Details on https://myapi.fyers.in, or enter your 64-character SHA256 App ID Hash.'
          }`;
          logger.info('Candidate App ID Hash rejected by Fyers, testing next candidate...', { candidate: appIdHash.substring(0, 8) + '...' });
          continue;
        }

        // If Fyers specifically says auth code is invalid/expired, mark it consumed and clear it
        if (data.code === -437 || data.code === -438 || errMsg.toLowerCase().includes('auth code')) {
          this.markAuthCodeConsumed(cleanAuthCode);
          db.clearAuthCode(targetUserId);
          lastErrorMsg = `Fyers authorization code expired or already consumed (${errMsg}). (Fyers auth codes expire within 5 minutes and can only be used once. Please click 'Launch Fyers Auth' to generate a new link).`;
          logger.info('Fyers authorization code expired or already consumed, cleared from active session.', { code: data.code });
          break;
        }
      } catch (fetchErr: any) {
        lastErrorMsg = fetchErr.message;
      }
    }

    const isCodeExpiredOrConsumed =
      lastData?.code === -437 ||
      lastData?.code === -438 ||
      lastErrorMsg.includes('expired') ||
      lastErrorMsg.includes('already consumed') ||
      lastErrorMsg.includes('invalid auth code');

    const isHashMismatch =
      lastData?.code === -5 ||
      lastErrorMsg.includes('invalid app id hash');

    if (isCodeExpiredOrConsumed) {
      logger.info('Fyers authorization code notice: code expired or already consumed, cleared cleanly.', { code: lastData?.code });
    } else if (isHashMismatch) {
      logger.warn('Fyers App ID Hash invalid:', { code: lastData?.code, error: lastErrorMsg });
    } else {
      logger.error('Fyers Auth Code validation failed', { data: lastData, error: lastErrorMsg });
    }
    throw new Error(lastErrorMsg);
  }

  /**
   * Checks token validity status and returns live profile details if authenticated
   */
  public getTokenStatus(userId?: string): { isValid: boolean; expiresAt: number; mode: string; message: string; accessToken?: string; authCode?: string; profile?: any } {
    const auth = db.getFyersAuth(userId);
    const settings = db.getSettings();

    const hasToken = !!auth.accessToken && auth.accessToken.trim().length > 20;
    const isTokenExpired = !auth.expiresAt || auth.expiresAt <= Date.now();

    // Truly valid only if flagged valid, token is present, and unexpired
    const isLiveValid = auth.isValid && hasToken && !isTokenExpired;

    let message = 'Fyers Token Expired or Not Authenticated';
    if (isLiveValid) {
      if (this.cachedProfile?.data) {
        const p = this.cachedProfile.data;
        const name = p.display_name || p.name || p.fy_id || 'Fyers Trader';
        message = `Connected: ${name} (${p.fy_id || settings.fyId || 'Live'})`;
      } else {
        message = 'Fyers Live Token Active';
      }
    }

    if (settings.mode === 'PAPER') {
      return {
        isValid: isLiveValid, // reflect real Fyers connection status even in paper mode
        expiresAt: auth.expiresAt || (Date.now() + 86400000),
        mode: 'PAPER',
        message: isLiveValid ? `${message} (Paper Mode)` : 'Paper Trading (Fyers Disconnected)',
        accessToken: auth.accessToken,
        authCode: auth.authCode,
        profile: this.cachedProfile?.data
      };
    }

    return {
      isValid: isLiveValid,
      expiresAt: auth.expiresAt,
      mode: 'LIVE',
      message,
      accessToken: auth.accessToken,
      authCode: auth.authCode,
      profile: this.cachedProfile?.data
    };
  }

  /**
   * Ensures that a valid Fyers access token exists, automatically executing backend TOTP + PIN authentication whenever the access code/token is expired or missing.
   */
  public async ensureValidToken(userId?: string, userEmail?: string): Promise<boolean> {
    const auth = db.getFyersAuth(userId);
    const settings = db.getSettings();

    // If access token is valid and unexpired, DO NOT repeat login or generate OTP
    if (auth.isValid && auth.accessToken && auth.expiresAt > Date.now()) {
      return true;
    }

    // Rate limit / failure cooldown check
    const now = Date.now();
    if (now < this.rateLimitUntil || now < this.totpFailureCooldownUntil) {
      return auth.isValid && !!auth.accessToken && auth.expiresAt > Date.now();
    }

    // Short debounce (10s) to avoid overlapping rapid requests
    if (now - this.lastAutoLoginAttempt < 10000) {
      return auth.isValid && !!auth.accessToken && auth.expiresAt > Date.now();
    }
    this.lastAutoLoginAttempt = now;

    // 1. Try Refresh Token first if available
    if (auth.refreshToken) {
      try {
        const refreshed = await this.refreshAccessToken();
        if (refreshed && refreshed.isValid && refreshed.expiresAt > Date.now()) {
          logger.success('Successfully auto-refreshed Fyers token via Refresh Token');
          if (userId) {
            db.saveUserAccessCode(userId, refreshed, userEmail);
          }
          return true;
        }
      } catch (err: any) {
        logger.warn(`Refresh token attempt failed: ${err.message}`);
      }
    }

    // 2. Try Auth Code exchange ONLY if a valid, unexpired code is present
    if (auth.authCode) {
      if (!this.isAuthCodeValid(auth.authCode)) {
        logger.info('Stored Fyers auth code has expired or is invalid. Clearing single-use auth code.');
        db.clearAuthCode(userId);
      } else {
        try {
          const exchanged = await this.connectFromUrl(auth.authCode, userId, userEmail);
          if (exchanged && exchanged.isValid && exchanged.expiresAt > Date.now()) {
            logger.success('Successfully exchanged stored Fyers auth code for live access token');
            db.clearAuthCode(userId);
            return true;
          }
        } catch (err: any) {
          const isConsumed = err.message?.includes('expired') || err.message?.includes('consumed') || err.message?.includes('invalid auth code');
          if (isConsumed) {
            logger.info('Stored Fyers auth code was previously consumed or expired; cleared single-use code.');
          } else {
            logger.info(`Auth code exchange notice in ensureValidToken: ${err.message}`);
          }
          db.clearAuthCode(userId);
        }
      }
    }

    // 3. Autonomously execute headless TOTP + PIN authentication
    if (settings.fyId && settings.fyersTotpKey && settings.fyersPin) {
      try {
        logger.info('ensureValidToken: Autonomously connecting to Fyers via backend TOTP + PIN...');
        const headlessResult = await this.attemptHeadlessLogin(userId, userEmail);
        if (headlessResult && headlessResult.isValid && headlessResult.expiresAt > Date.now()) {
          logger.success('ensureValidToken: Autonomous Fyers authentication succeeded!');
          return true;
        }
      } catch (err: any) {
        logger.warn('ensureValidToken: Autonomous Fyers authentication notice:', err.message);
      }
    }

    const current = db.getFyersAuth(userId);
    return current.isValid && !!current.accessToken && current.expiresAt > Date.now();
  }

  /**
   * Fetches Quotes / LTP from Fyers API v3 (data-v3/quotes and data/quotes)
   * Supports getQuotes(symbols) and getQuotes(accessToken, symbols)
   */
  public async getQuotes(param1: any, param2?: any): Promise<Record<string, number>> {
    let tokenOverride: string | undefined;
    let symbols: string[] = [];

    if (typeof param1 === 'string') {
      tokenOverride = param1;
      symbols = Array.isArray(param2) ? param2 : [param2];
    } else if (Array.isArray(param1)) {
      symbols = param1;
    }

    const settings = db.getSettings();

    if (settings.mode === 'LIVE') {
      await this.ensureValidToken().catch(() => {});
    }

    const currentAuth = db.getFyersAuth();
    const token = tokenOverride || currentAuth.accessToken;

    if ((tokenOverride || currentAuth.isValid) && token) {
      const appId = this.getFormattedAppId();
      const normalizedSymbols = symbols.map(s => formatFyersSymbol(s));
      const encodedSymbols = encodeURIComponent(normalizedSymbols.join(','));
      const endpoints = [
        `https://api-t1.fyers.in/data/quotes?symbols=${encodedSymbols}`,
        `https://api.fyers.in/data/quotes?symbols=${encodedSymbols}`,
        `https://api-t1.fyers.in/data-v3/quotes?symbols=${encodedSymbols}`
      ];

      const commonHeaders = {
        'Authorization': `${appId}:${token}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*'
      };

      for (const endpoint of endpoints) {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 2500);
          const res = await fetch(endpoint, { headers: commonHeaders, signal: controller.signal });
          clearTimeout(timeoutId);
          if (!res.ok) continue;
          const data = await res.json() as any;
          if (data && (data.s === 'ok' || data.code === 200) && Array.isArray(data.d)) {
            const result: Record<string, number> = {};
            data.d.forEach((item: any) => {
              const sym = item.n || (item.v && item.v.symbol);
              const lp = item.v ? (item.v.lp || item.v.cmd?.lp || item.v.prev_close_price || item.v.close_price || item.v.c || item.v.cmd?.c || item.v.ask || item.v.bid) : undefined;
              if (sym && typeof lp === 'number' && lp > 0) {
                result[sym] = lp;
                // Cache quote LTP for market closed fallback
                const existing = this.positionCache.get(sym);
                this.positionCache.set(sym, {
                  ltp: lp,
                  pl: existing?.pl || 0,
                  netAvg: existing?.netAvg || 0,
                  qty: existing?.qty || 0
                });
              }
            });
            if (Object.keys(result).length > 0) {
              return result;
            }
          }
        } catch (err: any) {
          // Silent fallback when endpoint is unavailable
        }
      }
      logger.info('Fyers live quotes endpoint silent, using marketDataService live LTP fallback');
    }
    return {};
  }

  /**
   * Attempts to auto-refresh Fyers Access Token using stored refresh token
   */
  public async refreshAccessToken(): Promise<FyersTokenData | null> {
    const auth = db.getFyersAuth();
    const settings = db.getSettings();
    if (!auth.refreshToken) {
      return null;
    }

    try {
      logger.info('Attempting automated daily token refresh with Fyers API...');
      const appIdHash = this.generateAppIdHash();
      const payload = {
        grant_type: 'refresh_token',
        appIdHash: appIdHash,
        refresh_token: auth.refreshToken,
        pin: settings.fyersPin || ''
      };

      const endpoints = [
        'https://api-t1.fyers.in/api/v3/validate-refresh-token',
        'https://api.fyers.in/api/v3/validate-refresh-token'
      ];

      for (const endpoint of endpoints) {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        if (!res.ok) continue;
        const data = await res.json() as any;
        if (data && data.code === -16) {
          logger.info('Fyers refresh token API is disabled per regulations. Daily browser login required.');
          db.updateFyersAuth({ refreshToken: '' });
          return null;
        }
        if (data && data.s === 'ok' && data.access_token) {
          const expiresAt = Date.now() + (24 * 60 * 60 * 1000);
          const updated = db.updateFyersAuth({
            accessToken: data.access_token,
            expiresAt,
            isValid: true
          });
          logger.success('Fyers Access Token auto-refreshed successfully for the day!');
          return updated;
        }
      }
      // Clear expired refresh token so background won't repeat failed attempts
      db.updateFyersAuth({ refreshToken: '' });
    } catch (err: any) {
      db.updateFyersAuth({ refreshToken: '' });
      logger.info(`Automated refresh token notice: ${err?.message || String(err)}`);
    }
    return null;
  }

  /**
   * Fetches Available Funds & Margin Limits directly from Fyers API v3
   */
  public async getFunds(): Promise<{ totalBalance: number; availableBalance: number; utilizedMargin: number; withdrawableBalance: number; capitalAllocationPct: number; allocatedCapital: number; realizedPnl: number; isLive: boolean }> {
    const settings = db.getSettings();

    // Check existing token status
    const auth = db.getFyersAuth();
    if (!auth.isValid || !auth.accessToken || auth.expiresAt <= Date.now()) {
      const pct = settings.capitalAllocationPct || 100;
      return {
        totalBalance: 0,
        availableBalance: 0,
        utilizedMargin: 0,
        withdrawableBalance: 0,
        capitalAllocationPct: pct,
        allocatedCapital: 0,
        realizedPnl: 0,
        isLive: false
      };
    }

    const cleanToken = (auth.accessToken || '').trim();
    const endpoints = [
      'https://api-t1.fyers.in/api/v3/funds',
      'https://api.fyers.in/api/v3/funds'
    ];

    let attemptedReAuth = false;
    let lastFetchErr = '';

    for (let attempt = 0; attempt < 2; attempt++) {
      const activeToken = (attemptedReAuth ? db.getFyersAuth().accessToken : cleanToken)?.trim();
      if (!activeToken) break;

      const headerVariants = [
        this.getAuthHeader(activeToken),
        `Bearer ${activeToken.includes(':') ? activeToken.split(':')[1] : activeToken}`,
        activeToken
      ];

      for (const endpoint of endpoints) {
        for (const authHeader of headerVariants) {
          try {
            const res = await fetch(endpoint, {
              headers: {
                'Authorization': authHeader,
                'Content-Type': 'application/json',
                'Accept': 'application/json, text/plain, */*'
              }
            });

            if (!res.ok) {
              lastFetchErr = `HTTP ${res.status}`;
              if (res.status === 401) {
                this.logThrottled('fyers_funds_401', 'Fyers Funds API returned 401 Unauthorized. Invalidating active token.', 'warn', 30000);
                db.updateFyersAuth({ isValid: false });
                this.cachedProfile = null;
                this.lastVerificationResult = null;
                break;
              }
              continue;
            }

            const data = await res.json() as any;
            if (!data) continue;

            if (data && (data.code === -17 || data.code === -16)) {
              this.logThrottled('fyers_funds_code17', `Fyers Funds API authentication rejected (${data.message || 'code -17'}). Invalidating active token.`, 'warn', 30000);
              db.updateFyersAuth({ isValid: false });
              this.cachedProfile = null;
              this.lastVerificationResult = null;
              break;
            }

            const fundLimits = Array.isArray(data?.fund_limit)
              ? data.fund_limit
              : (Array.isArray(data?.fund_limits)
                ? data.fund_limits
                : (Array.isArray(data?.fundLimit)
                  ? data.fundLimit
                  : (Array.isArray(data?.data?.fund_limit)
                    ? data.data.fund_limit
                    : (Array.isArray(data?.data?.fund_limits)
                      ? data.data.fund_limits
                      : []))));

            let totalBalance = 0;
            let availableBalance = 0;
            let utilizedMargin = 0;
            let withdrawableBalance = 0;
            let realizedPnl = 0;

            const parseVal = (v: any): number => {
              if (v === undefined || v === null) return 0;
              const n = typeof v === 'number' ? v : parseFloat(String(v));
              return isNaN(n) ? 0 : n;
            };

            if (fundLimits.length > 0) {
              const getItemVal = (item: any): number => {
                if (!item) return 0;
                if (item.equityAmount !== undefined && item.equityAmount !== null) {
                  return parseVal(item.equityAmount);
                }
                if (item.amount !== undefined && item.amount !== null) {
                  return parseVal(item.amount);
                }
                if (item.value !== undefined && item.value !== null) {
                  return parseVal(item.value);
                }
                if (item.commodityAmount !== undefined && item.commodityAmount !== null) {
                  return parseVal(item.commodityAmount);
                }
                return 0;
              };

              let foundAvailable = false;
              let foundTotal = false;

              fundLimits.forEach((item: any) => {
                const title = String(item.title || item.name || '').toLowerCase().trim();
                const val = getItemVal(item);

                // ID 1 = Total Balance
                if (item.id === 1 || title === 'total balance' || title === 'total funds') {
                  totalBalance = val;
                  foundTotal = true;
                }

                // ID 2 = Funds Utilised / Utilized Margin
                if (item.id === 2 || title.includes('utilised') || title.includes('utilized') || title.includes('margin used')) {
                  utilizedMargin = val;
                }

                // ID 10 = Available Balance, ID 3 = Clear Balance
                if (item.id === 10 || title === 'available balance' || title === 'funds available' || (!foundAvailable && (item.id === 3 || title === 'clear balance'))) {
                  availableBalance = val;
                  foundAvailable = true;
                }

                // ID 6 = Withdrawable balance
                if (item.id === 6 || title.includes('withdrawable')) {
                  withdrawableBalance = val;
                }

                // ID 4 = Realized Profit and Loss
                if (item.id === 4 || title.includes('realized') || title.includes('realised')) {
                  realizedPnl = val;
                }
              });

              if (!foundTotal && fundLimits.length > 0) {
                totalBalance = availableBalance + utilizedMargin;
              }
              if (!foundAvailable && totalBalance > 0) {
                availableBalance = Math.max(0, totalBalance - utilizedMargin);
              }

              logger.info(`FYERS Funds API raw parsed: Available ₹${availableBalance}, Utilised ₹${utilizedMargin}, Total ₹${totalBalance}, Withdrawable ₹${withdrawableBalance}, Realized PnL ₹${realizedPnl}`);
            } else if (data && typeof data === 'object') {
              const rawDataObj = data.data || data;
              availableBalance = parseVal(rawDataObj.availableBalance || rawDataObj.available_balance || rawDataObj.availableFunds || rawDataObj.clearBalance);
              totalBalance = parseVal(rawDataObj.totalBalance || rawDataObj.total_balance || rawDataObj.totalFunds || rawDataObj.fund_balance) || availableBalance;
              utilizedMargin = parseVal(rawDataObj.utilizedMargin || rawDataObj.fundsUtilized || rawDataObj.utilized_funds || 0);
              withdrawableBalance = parseVal(rawDataObj.withdrawableBalance || rawDataObj.withdrawable || 0);
            }

            const isSuccess = data.s === 'ok' || data.code === 200 || fundLimits.length > 0 || totalBalance > 0 || availableBalance > 0;

            if (isSuccess) {
              const pct = settings.capitalAllocationPct || 100;
              const allocatedCapital = Math.round(availableBalance * (pct / 100));

              db.updateSettings({
                capital: allocatedCapital,
                fyersAvailableFunds: availableBalance,
                fyersTotalFunds: totalBalance
              });

              this.logThrottled('funds_success', `FYERS Live Funds synchronized: Available ₹${availableBalance.toLocaleString('en-IN')}, Utilised ₹${utilizedMargin.toLocaleString('en-IN')}, Total ₹${totalBalance.toLocaleString('en-IN')}`, 'info', 60000);

              return {
                totalBalance,
                availableBalance,
                utilizedMargin,
                withdrawableBalance,
                capitalAllocationPct: pct,
                allocatedCapital,
                realizedPnl,
                isLive: true
              };
            }
          } catch (err: any) {
            this.logThrottled('funds_err', `FYERS Funds API request notice: ${err?.message || String(err)}`, 'warn', 60000);
          }
        }
      }
      break;
    }

    const pct = settings.capitalAllocationPct || 100;
    const fallbackCap = settings.capital && settings.capital > 0 ? settings.capital : 100000;
    const fallbackAvail = (settings.fyersAvailableFunds !== undefined && settings.fyersAvailableFunds > 0) ? settings.fyersAvailableFunds : fallbackCap;
    const fallbackTotal = (settings.fyersTotalFunds !== undefined && settings.fyersTotalFunds > 0) ? settings.fyersTotalFunds : fallbackCap;

    return {
      totalBalance: fallbackTotal,
      availableBalance: fallbackAvail,
      utilizedMargin: 0,
      withdrawableBalance: 0,
      capitalAllocationPct: pct,
      allocatedCapital: fallbackCap,
      realizedPnl: 0,
      isLive: false
    };
  }

  /**
   * Fetches Live Net Positions directly from Fyers API v3 across multiple endpoints
   */
  public async getPositions(accessTokenOverride?: string): Promise<{ s: string; netPositions: any[]; message?: string; isLive?: boolean }> {
    const auth = db.getFyersAuth();
    const token = accessTokenOverride || auth.accessToken;

    if (!token || (!accessTokenOverride && (!auth.isValid || auth.expiresAt <= Date.now()))) {
      return { s: 'error', netPositions: [], message: 'FYERS Access Token missing or unauthenticated. Please connect FYERS in Header or Settings.', isLive: false };
    }

    const endpoints = [
      'https://api-t1.fyers.in/api/v3/positions',
      'https://api.fyers.in/api/v3/positions'
    ];

    let attemptedReAuth = false;

    for (let attempt = 0; attempt < 2; attempt++) {
      const activeToken = (attemptedReAuth ? db.getFyersAuth().accessToken : token)?.trim();
      if (!activeToken) break;

      const headerVariants = [
        this.getAuthHeader(activeToken),
        `Bearer ${activeToken.includes(':') ? activeToken.split(':')[1] : activeToken}`,
        activeToken
      ];

      for (const endpoint of endpoints) {
        for (const authHeader of headerVariants) {
          try {
            const res = await fetch(endpoint, {
              headers: {
                'Authorization': authHeader,
                'Content-Type': 'application/json',
                'Accept': 'application/json, text/plain, */*'
              }
            });

            if (!res.ok) {
              if (res.status === 401) {
                this.logThrottled('fyers_pos_401', 'Fyers Positions API returned 401 Unauthorized. Access token expired.', 'warn', 60000);
                db.updateFyersAuth({ isValid: false, accessToken: '', refreshToken: '', expiresAt: 0 });
                this.cachedProfile = null;
                this.lastVerificationResult = null;
                break;
              }
              continue;
            }

            const data = await res.json() as any;
            if (!data) continue;

            if (data && (data.code === -17 || data.code === -16)) {
              this.logThrottled('fyers_pos_code17', `Fyers Positions API authentication rejected (${data.message || 'code -17'}). Invalidating active token.`, 'warn', 30000);
              db.updateFyersAuth({ isValid: false });
              this.cachedProfile = null;
              this.lastVerificationResult = null;
              break;
            }

            const rawList = data.netPositions
              || data.net_positions
              || data.positions
              || data.overallPosition
              || data.dayPositions
              || (data.data && (data.data.netPositions || data.data.net_positions || data.data.positions || data.data.overallPosition || data.data.dayPositions))
              || [];

            if (Array.isArray(rawList)) {
              const normalized = rawList.map((p: any) => {
                const rawSym = p.symbol || p.tradingSymbol || p.name || '';
                const sym = formatFyersSymbol(rawSym);
                const qty = typeof p.netQty === 'number' ? p.netQty : (typeof p.qty === 'number' ? p.qty : (p.quantity || 0));
                const netAvg = p.netAvg || p.avgPrice || p.sellAvg || p.buyAvg || p.price || 0;
                const ltp = p.ltp || p.lp || p.last_price || 0;
                const pl = typeof p.pl === 'number' ? p.pl : (typeof p.pnl === 'number' ? p.pnl : (typeof p.unrealized_pnl === 'number' ? p.unrealized_pnl : 0));
                const side = typeof p.side === 'number' ? p.side : (qty < 0 ? -1 : 1);

                if (sym) {
                  this.positionCache.set(sym, {
                    ltp: ltp || netAvg,
                    pl,
                    netAvg,
                    qty
                  });
                }

                return {
                  ...p,
                  symbol: sym,
                  netQty: qty,
                  qty: Math.abs(qty),
                  netAvg,
                  ltp,
                  pl,
                  side
                };
              });

              this.logThrottled('pos_success', `Fetched ${normalized.length} net positions directly from FYERS live API (${endpoint})`, 'info', 60000);
              return { s: 'ok', netPositions: normalized, message: `Successfully fetched ${normalized.length} position leg(s) from FYERS terminal.`, isLive: true };
            }
          } catch (err: any) {
            this.logThrottled('pos_err', `Error fetching live positions from FYERS API (${endpoint}): ${err?.message || String(err)}`, 'warn', 60000);
          }
        }
      }
      break;
    }

    return { s: 'ok', netPositions: [], message: 'No active open positions returned from FYERS terminal or FYERS unauthenticated.', isLive: false };
  }

  /**
   * Order Execution with FYERS API v3: Synchronous order execution supporting limit & market orders
   * Can be invoked as placeOrder(orderDetails) or placeOrder(accessToken, orderDetails)
   */
  public async placeOrder(param1: any, param2?: any): Promise<{ s: string; id?: string; message?: string; [key: string]: any }> {
    let token: string = '';
    let orderDetails: any = {};

    if (typeof param1 === 'string') {
      token = param1;
      orderDetails = param2 || {};
    } else {
      orderDetails = param1 || {};
    }

    const settings = db.getSettings();
    if (!token && settings.mode === 'LIVE') {
      await this.ensureValidToken().catch(() => {});
      const auth = db.getFyersAuth();
      token = auth.accessToken || '';
    }

    if (settings.mode === 'PAPER') {
      logger.info(`PAPER mode: Simulating order placement for ${orderDetails.symbol || 'NIFTY'}`);
      const simulatedId = `sim_ord_${Date.now()}`;
      return {
        s: 'ok',
        code: 1101,
        id: simulatedId,
        message: 'Order submitted successfully (Simulated)',
        status: 'FILLED'
      };
    }

    if (settings.mode === 'LIVE' && !token) {
      throw new Error('FYERS Access Token is invalid or missing. Please click Auth Required in the top bar to authorize FYERS live trading.');
    }

    const appId = this.getFormattedAppId();

    // Map order fields to FYERS v3 specification
    const sideVal = typeof orderDetails.side === 'number'
      ? orderDetails.side
      : (String(orderDetails.side).toUpperCase() === 'BUY' ? 1 : -1);

    let typeVal = 2; // Default MARKET (2)
    if (typeof orderDetails.type === 'number') {
      typeVal = orderDetails.type;
    } else if (String(orderDetails.type).toUpperCase() === 'LIMIT' || (orderDetails.limitPrice && orderDetails.limitPrice > 0)) {
      typeVal = 1; // LIMIT (1)
    }

    const targetSymbol = formatFyersSymbol(orderDetails.symbol);
    const primaryProduct = orderDetails.productType || 'INTRADAY';
    const fallbackProduct = primaryProduct === 'INTRADAY' ? 'MARGIN' : 'INTRADAY';
    const productVariants = [primaryProduct, fallbackProduct];

    const endpoints = [
      'https://api-t1.fyers.in/api/v3/orders/sync',
      'https://api-t1.fyers.in/api/v3/orders',
      'https://api.fyers.in/api/v3/orders/sync',
      'https://api.fyers.in/api/v3/orders'
    ];

    let lastErrorMessage = '';

    for (const prodType of productVariants) {
      const fyersPayload = {
        symbol: targetSymbol,
        qty: Math.round(Number(orderDetails.qty || orderDetails.quantity || 1)),
        type: typeVal,
        side: sideVal,
        productType: prodType,
        limitPrice: typeVal === 1 ? Number(orderDetails.limitPrice || orderDetails.price || 0) : 0,
        stopPrice: 0,
        disclosedQty: 0,
        validity: orderDetails.validity || 'DAY',
        offlineOrder: false,
        stopLoss: 0,
        takeProfit: 0
      };

      for (const endpoint of endpoints) {
        try {
          const res = await fetch(endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `${appId}:${token}`
            },
            body: JSON.stringify(fyersPayload)
          });

          const data = await res.json().catch(() => null) as any;
          if (res.ok && data && (data.s === 'ok' || data.code === 1101 || data.id || data.order_id)) {
            logger.info(`FYERS Live Order Executed (${targetSymbol}, product: ${prodType}, side: ${sideVal}, type: ${typeVal}): ID ${data.id || data.order_id}`);
            return data;
          }

          if (data && (data.message || data.s)) {
            lastErrorMessage = `${data.message || data.s} (code: ${data.code || data.s})`;
            logger.warn(`FYERS Order attempt [${targetSymbol}, ${prodType}] on ${endpoint} response: ${lastErrorMessage}`);
          } else if (!res.ok) {
            lastErrorMessage = `HTTP ${res.status} ${res.statusText}`;
            logger.warn(`FYERS Order attempt [${targetSymbol}, ${prodType}] on ${endpoint} HTTP error: ${lastErrorMessage}`);
          }
        } catch (err: any) {
          lastErrorMessage = err?.message || String(err);
          logger.error(`Error executing order on FYERS endpoint (${endpoint}): ${lastErrorMessage}`);
        }
      }
    }

    throw new Error(`Failed to place order on FYERS v3 API for ${orderDetails.symbol}${lastErrorMessage ? `: ${lastErrorMessage}` : ''}`);
  }

  /**
   * Fetches Option Chain expiry dates from Fyers API v3 when live token is valid
   */
  public async getOptionChainExpiries(symbol: string = 'NSE:NIFTY50-INDEX'): Promise<string[]> {
    const settings = db.getSettings();

    if (settings.mode === 'LIVE') {
      await this.ensureValidToken().catch(() => {});
    }

    const auth = db.getFyersAuth();

    if (settings.mode === 'LIVE' && auth.isValid && auth.accessToken) {
      const appId = this.getFormattedAppId();
      const encodedSym = encodeURIComponent(symbol);
      const endpoints = [
        `https://api-t1.fyers.in/data/options-chain?symbol=${encodedSym}`,
        `https://api-t1.fyers.in/api/v3/options/chain?symbol=${encodedSym}`,
        `https://api.fyers.in/data/options-chain?symbol=${encodedSym}`
      ];

      for (const endpoint of endpoints) {
        try {
          const res = await fetch(endpoint, {
            headers: {
              'Authorization': `${appId}:${auth.accessToken}`
            }
          });
          if (!res.ok) continue;
          const data = await res.json() as any;
          if (data && data.s === 'ok' && Array.isArray(data.expiryData)) {
            return data.expiryData.map((e: any) => e.date || e.expiry || e);
          }
        } catch (err: any) {
          logger.error(`Error fetching Fyers option chain expiries (${endpoint}): ${err?.message || String(err)}`);
        }
      }
    }
    return [];
  }

  /**
   * Fetches Live Orders directly from Fyers API v3
   */
  public async getOrders(): Promise<{ s: string; orderBook: any[] }> {
    const settings = db.getSettings();

    if (settings.mode === 'LIVE') {
      await this.ensureValidToken().catch(() => {});
    }

    const auth = db.getFyersAuth();

    if (settings.mode === 'LIVE' && auth.isValid && auth.accessToken) {
      const appId = this.getFormattedAppId();
      const endpoints = [
        'https://api-t1.fyers.in/api/v3/orders',
        'https://api.fyers.in/api/v3/orders'
      ];

      for (const endpoint of endpoints) {
        try {
          const res = await fetch(endpoint, {
            headers: {
              'Authorization': `${appId}:${auth.accessToken}`
            }
          });
          if (!res.ok) continue;
          const data = await res.json() as any;
          if (data && data.s === 'ok' && Array.isArray(data.orderBook)) {
            return data;
          }
        } catch (err: any) {
          logger.error(`Error fetching live orders from Fyers API (${endpoint}): ${err?.message || String(err)}`);
        }
      }
    }

    return { s: 'ok', orderBook: [] };
  }

  /**
   * Fetches Live & Historical Executed Trades directly from Fyers API v3 Tradebook
   */
  public async getTradebook(): Promise<{ s: string; tradeBook: any[] }> {
    const settings = db.getSettings();

    if (settings.mode === 'LIVE') {
      await this.ensureValidToken().catch(() => {});
    }

    const auth = db.getFyersAuth();

    if (settings.mode === 'LIVE' && auth.isValid && auth.accessToken) {
      const appId = this.getFormattedAppId();
      const endpoints = [
        'https://api-t1.fyers.in/api/v3/tradebook',
        'https://api.fyers.in/api/v3/tradebook'
      ];

      for (const endpoint of endpoints) {
        try {
          const res = await fetch(endpoint, {
            headers: {
              'Authorization': `${appId}:${auth.accessToken}`
            }
          });
          if (!res.ok) continue;
          const data = await res.json() as any;
          if (data && data.s === 'ok' && Array.isArray(data.tradeBook)) {
            return data;
          }
        } catch (err: any) {
          logger.error(`Error fetching tradebook from Fyers API (${endpoint}): ${err?.message || String(err)}`);
        }
      }
    }

    return { s: 'ok', tradeBook: [] };
  }
}

export const fyersService = new FyersService();

