import express from 'express';
import path from 'path';
import cors from 'cors';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import { createServer as createViteServer } from 'vite';

import { db } from './server/db.js';
import { logger, getSystemLogs } from './server/logger.js';
import { fyersService } from './server/fyersService.js';
import { Position, Leg } from './server/types.js';
import { marketDataService } from './server/marketDataService.js';
import { strategyEngine } from './server/strategyEngine.js';
import { riskService } from './server/riskService.js';
import { notificationService } from './server/notificationService.js';
import { initCronScheduler } from './server/cronService.js';
import { opportunityScanner } from './server/opportunityScanner.js';
import { backtestService } from './server/backtestService.js';
import { parseFyersOptionSymbol, detectOptionStrategy, getNearestExpiryForSymbol } from './server/expiryService.js';

dotenv.config();

const PORT = 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'fyers_iron_condor_secret_jwt_key_2026';
function isAuthorizedFyersUser(req: express.Request): boolean {
  // Always authorize user in this private container applet
  return true;
}

async function startServer() {
  // Initialize SQLite Database
  await db.init();

  const app = express();

  app.use(cors({
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'X-User-Email', 'x-user-email', 'X-User-Id', 'x-user-id']
  }));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Initialize Strategy Engine Cron Scheduler
  initCronScheduler();

  // Health check endpoints
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // -------------------------------------------------------------
  // 1. AUTHENTICATION & FYERS OAUTH ENDPOINTS
  // -------------------------------------------------------------
  
  // Login -> Redirect to Fyers authorization URL
  app.get('/auth/login', (req, res) => {
    try {
      const customUri = (req.query.redirect_uri || req.query.customRedirectUri) as string;
      const mode = (req.query.mode as string) || '';
      const statePayload = (req.query.state as string) || 'fyers_iron_condor_state';

      const host = req.get('x-forwarded-host') || req.get('host') || '127.0.0.1:3000';
      const protocol = req.protocol === 'https' || req.get('x-forwarded-proto') === 'https' ? 'https' : 'http';
      const cloudCallbackUri = `${protocol}://${host}/auth/callback`;

      let targetUri: string | undefined = customUri ? customUri.trim() : undefined;
      if (!targetUri) {
        if (mode === 'cloud') {
          targetUri = cloudCallbackUri;
        } else {
          // Never default to cloud callback if unconfigured; default to registered local URI to prevent 401 Unauthorized
          const currentConfigured = (db.getSettings().fyersRedirectUri || '').trim();
          targetUri = (currentConfigured && !currentConfigured.includes('/auth/callback')) 
            ? currentConfigured 
            : 'https://127.0.0.1:6414';
        }
      }

      const authUrl = fyersService.getAuthUrl(targetUri, statePayload);
      logger.info('Redirecting user to Fyers OAuth Login URL', { targetUri: targetUri || 'default', authUrl });
      res.redirect(authUrl);
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to generate Fyers login URL', details: err.message });
    }
  });

  // Callback -> Handle auth code or access token exchange from Fyers URL
  const handleFyersCallback = async (req: express.Request, res: express.Response) => {
    const rawUrl = req.originalUrl || req.url;
    const accessToken = (req.query.access_token || req.query.token) as string;
    const authCode = (req.query.auth_code || req.query.code) as string;
    const state = (req.query.state as string) || '';

    let targetUid = '';
    let targetEmail = '';
    if (state && state.includes('usr_')) {
      try {
        const decoded = Buffer.from(state.replace('usr_', ''), 'base64').toString('utf8');
        const [uid, email] = decoded.split(':::');
        targetUid = uid || '';
        targetEmail = email || '';
      } catch (e) {
        // ignore
      }
    }

    try {
      let authData;
      if (accessToken) {
        authData = db.updateFyersAuth({
          accessToken: accessToken.trim(),
          expiresAt: Date.now() + (24 * 60 * 60 * 1000),
          isValid: true
        }, targetUid, targetEmail);
        logger.success('Fyers Access Token directly saved from callback URL!');
      } else if (authCode) {
        authData = await fyersService.validateAuthCode(authCode.trim(), targetUid, targetEmail);
      } else {
        // Try parsing full URL string
        authData = await fyersService.connectFromUrl(rawUrl, targetUid, targetEmail);
      }

      if (targetUid && authData) {
        db.saveUserAccessCode(targetUid, authData, targetEmail);
      }

      // Issue session JWT
      const token = jwt.sign({ user: 'trader', authenticated: true, uid: targetUid }, JWT_SECRET, { expiresIn: '24h' });
      
      // Redirect back to dashboard UI with token and broadcast across tabs/windows
      const safeAuthPayload = JSON.stringify(authData || {});
      res.send(`
        <!DOCTYPE html>
        <html>
          <head>
            <title>Fyers OAuth Success</title>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
              body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; text-align: center; padding: 40px 16px; background: #0f172a; color: white; margin: 0; }
              .card { max-width: 480px; margin: 30px auto; background: #1e293b; padding: 32px; border-radius: 16px; border: 1px solid #334155; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.5); }
              .badge { display: inline-flex; align-items: center; justify-content: center; width: 48px; height: 48px; border-radius: 50%; background: rgba(16, 185, 129, 0.15); color: #10b981; font-size: 24px; margin-bottom: 16px; }
              h2 { color: #10b981; margin: 0 0 12px 0; font-size: 20px; font-weight: 700; }
              p { color: #cbd5e1; font-size: 14px; margin: 0 0 8px 0; line-height: 1.5; }
              .sub { color: #94a3b8; font-size: 12px; margin-top: 16px; }
              .spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid rgba(255,255,255,0.2); border-top-color: #10b981; border-radius: 50%; animation: spin 0.8s linear infinite; vertical-align: middle; margin-right: 6px; }
              @keyframes spin { to { transform: rotate(360deg); } }
            </style>
          </head>
          <body>
            <div class="card">
              <div class="badge">✓</div>
              <h2>Fyers Authentication Successful!</h2>
              <p>Your session token was automatically validated and saved to Firestore.</p>
              <p class="sub"><span class="spinner"></span>Returning to your live trading terminal...</p>
            </div>
            <script>
              (function() {
                const token = '${token}';
                const authData = ${safeAuthPayload};
                const eventPayload = {
                  type: 'FYERS_AUTH_SUCCESS',
                  token: token,
                  auth: authData,
                  timestamp: Date.now()
                };

                // 1. Save directly to localStorage for current origin
                try {
                  localStorage.setItem('fyers_token', token);
                  localStorage.setItem('fyers_auth_event', JSON.stringify(eventPayload));
                } catch(e) {}

                // 2. Broadcast via BroadcastChannel to other tabs/windows
                try {
                  if (typeof BroadcastChannel !== 'undefined') {
                    const bc = new BroadcastChannel('fyers_auth_channel');
                    bc.postMessage(eventPayload);
                    bc.close();
                  }
                } catch(e) {}

                // 3. Post message to opener window if opened as popup
                let sentToOpener = false;
                try {
                  if (window.opener && !window.opener.closed) {
                    window.opener.postMessage(eventPayload, '*');
                    sentToOpener = true;
                  }
                } catch(e) {}

                // 4. Smoothly close window if popup, or redirect if main window
                setTimeout(function() {
                  if (sentToOpener) {
                    try { window.close(); } catch(e) {}
                  }
                  // Fallback navigation in case window.close is blocked
                  window.location.href = '/';
                }, 800);
              })();
            </script>
          </body>
        </html>
      `);
    } catch (err: any) {
      logger.error('Fyers callback processing failed', err);
      res.status(500).send(`<h2>Fyers Auth Error</h2><p>${err.message}</p><a href="/">Return to Dashboard</a>`);
    }
  };

  app.get('/auth/callback', handleFyersCallback);
  app.get('/auth/fyers/callback', handleFyersCallback);
  app.get('/api/fyers/callback', handleFyersCallback);
  app.get('/fyers/callback', handleFyersCallback);

  // Token & Connection Status
  app.get('/auth/status', async (req, res) => {
    const userId = (req.headers['x-user-id'] || req.query.userId) as string;
    const userEmail = (req.headers['x-user-email'] || req.query.userEmail) as string;
    
    // Automatically ensure valid token with backend TOTP login if expired
    await fyersService.ensureValidToken(userId, userEmail).catch(() => {});

    const status = fyersService.getTokenStatus(userId);
    const userAuth = (userId || userEmail) ? db.getUserAccessCode(userId || userEmail) : null;
    res.json({ 
      ...status, 
      isOwner: true,
      userAccessCode: userAuth || null
    });
  });

  // Dedicated User Access Code APIs (Stored against user in Firestore & backend)
  app.get('/api/user/access-code', async (req, res) => {
    const userId = (req.headers['x-user-id'] || req.query.userId || req.headers['x-user-email'] || req.query.userEmail) as string;
    const userEmail = (req.headers['x-user-email'] || req.query.userEmail) as string;
    if (!userId) {
      return res.status(400).json({ error: 'User identifier required' });
    }
    let userCode = db.getUserAccessCode(userId);
    if (!userCode || !userCode.isValid || !userCode.accessToken || userCode.expiresAt <= Date.now()) {
      // Automatically execute backend TOTP re-authentication if access code is expired
      await fyersService.ensureValidToken(userId, userEmail).catch(() => {});
      userCode = db.getUserAccessCode(userId);
    }
    res.json({ success: true, accessCode: userCode });
  });

  app.post('/api/user/access-code', async (req, res) => {
    const userId = (req.body.userId || req.headers['x-user-id']) as string;
    const userEmail = (req.body.userEmail || req.headers['x-user-email']) as string;
    const { accessToken, accessCode, expiresAt, isValid, tokenType } = req.body;

    if (!userId || (!accessToken && !accessCode)) {
      return res.status(400).json({ error: 'userId and accessToken (or accessCode) are required' });
    }

    const rawInput = ((accessToken || accessCode) as string).trim();
    const rawAuthCode = accessCode ? (accessCode as string).trim() : undefined;

    try {
      // 1. Detect if input is a redirect URL or has token/code
      const extracted = fyersService.extractTokenOrCodeFromUrl(rawInput);
      let verifiedAuth: any = null;

      // FIRST PRIORITY: If an accessToken is already provided or extracted, verify if it is active and valid!
      const candidateToken = (accessToken ? (accessToken as string).trim() : undefined) || extracted.accessToken;
      if (candidateToken && !candidateToken.includes('http') && !candidateToken.includes('?') && !candidateToken.includes('=')) {
        const verifyRes = await fyersService.verifyTokenWithFyers(candidateToken);
        if (verifyRes.isValid) {
          verifiedAuth = db.updateFyersAuth({
            accessToken: candidateToken,
            expiresAt: expiresAt || (Date.now() + 24 * 60 * 60 * 1000),
            isValid: true,
            tokenType: tokenType || 'Bearer'
          }, userId, userEmail);
          db.clearAuthCode(userId);
        }
      }

      // SECOND PRIORITY: Only if we do NOT have an active verified access token, try exchanging an unconsumed auth code
      if (!verifiedAuth) {
        const candidateAuthCode = extracted.authCode || (rawAuthCode && rawAuthCode.length > 20 ? rawAuthCode : undefined);
        if (candidateAuthCode && candidateAuthCode !== candidateToken && fyersService.isAuthCodeValid(candidateAuthCode)) {
          try {
            logger.info(`Detected valid unconsumed Fyers Auth Code during user access code sync. Exchanging for ${userEmail || userId}...`);
            verifiedAuth = await fyersService.validateAuthCode(candidateAuthCode, userId, userEmail);
          } catch (exchangeErr: any) {
            const isConsumed = exchangeErr.message?.includes('expired') || exchangeErr.message?.includes('consumed') || exchangeErr.message?.includes('invalid auth code');
            if (isConsumed) {
              logger.info('Fyers authorization code was previously consumed or expired; cleared single-use code cleanly.');
            } else {
              logger.info(`Auth code exchange sync notice: ${exchangeErr.message}`);
            }
            db.clearAuthCode(userId);
          }
        } else if (candidateAuthCode) {
          logger.info(`Auth Code in user access code sync is already expired or consumed, skipping exchange.`);
          db.clearAuthCode(userId);
        }
      }

      // 3. Save to database
      const finalToken = verifiedAuth?.accessToken || candidateToken || rawInput;
      const isTokenValid = verifiedAuth ? verifiedAuth.isValid : (isValid !== undefined ? Boolean(isValid) : false);
      const finalExpiry = verifiedAuth?.expiresAt || expiresAt || (Date.now() + 24 * 60 * 60 * 1000);

      const saved = db.saveUserAccessCode(userId, {
        accessToken: finalToken,
        authCode: undefined, // Never persist consumed single-use auth codes
        expiresAt: finalExpiry,
        isValid: isTokenValid,
        tokenType: tokenType || 'Bearer'
      }, userEmail);

      logger.success(`User access code processed for ${userEmail || userId}: isValid=${isTokenValid}, tokenLen=${finalToken?.length || 0}`);
      res.json({ 
        success: true, 
        message: isTokenValid ? `Live Fyers access token active for ${userEmail || userId}` : `Access code saved for ${userEmail || userId}`,
        data: saved,
        auth: saved,
        clearAuthCode: !isTokenValid || Boolean(rawAuthCode || extracted.authCode)
      });
    } catch (err: any) {
      logger.error('Error handling user access code in POST /api/user/access-code', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/user/access-code', (req, res) => {
    const userId = (req.body.userId || req.query.userId || req.headers['x-user-id']) as string;
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }
    const deleted = db.deleteUserAccessCode(userId);
    res.json({ success: true, deleted });
  });

  // Trigger OAuth URL generator endpoint
  app.all('/api/auth/trigger-auth', (req, res) => {
    try {
      const userEmail = (req.headers['x-user-email'] || req.query.userEmail || req.body?.userEmail || '') as string;
      const uid = (req.headers['x-user-id'] || req.query.userId || req.body?.userId || userEmail) as string;
      const requestedMode = (req.query.mode || req.body?.mode || '') as string;
      const clientOrigin = (req.headers['origin'] || req.query.origin || req.body?.origin || '') as string;
      const customRedirectUri = (req.query.redirect_uri || req.query.customRedirectUri || req.body?.redirect_uri || req.body?.customRedirectUri || '') as string;

      let statePayload = 'fyers_iron_condor_state';
      if (uid) {
        statePayload = `usr_${Buffer.from(`${uid}:::${userEmail}`).toString('base64')}`;
      }

      const host = req.get('x-forwarded-host') || req.get('host') || '127.0.0.1:3000';
      const protocol = req.protocol === 'https' || req.get('x-forwarded-proto') === 'https' ? 'https' : 'http';
      const cloudCallbackUri = clientOrigin ? `${clientOrigin}/auth/callback` : `${protocol}://${host}/auth/callback`;

      const settings = db.getSettings();
      const directCloudAuthUrl = fyersService.getAuthUrl(cloudCallbackUri, statePayload);
      const configuredUri = (settings.fyersRedirectUri || 'https://127.0.0.1:6414').trim();
      const configuredAuthUrl = fyersService.getAuthUrl(configuredUri, statePayload);
      const localHttpsAuthUrl = fyersService.getAuthUrl('https://127.0.0.1:6414', statePayload);
      const localHttpAuthUrl = fyersService.getAuthUrl('http://127.0.0.1:6414', statePayload);

      let activeAuthUrl: string;
      if (customRedirectUri && customRedirectUri.trim()) {
        activeAuthUrl = fyersService.getAuthUrl(customRedirectUri.trim(), statePayload);
      } else if (requestedMode === 'cloud') {
        activeAuthUrl = directCloudAuthUrl;
      } else if (requestedMode === 'local_http') {
        activeAuthUrl = localHttpAuthUrl;
      } else if (requestedMode === 'local' || requestedMode === 'local_https') {
        activeAuthUrl = localHttpsAuthUrl;
      } else if (requestedMode === 'configured') {
        activeAuthUrl = configuredAuthUrl;
      } else {
        // Safe default: always default to registered local HTTPS URL (https://127.0.0.1:6414) to prevent 401 error
        activeAuthUrl = (configuredUri && !configuredUri.includes('/auth/callback')) ? configuredAuthUrl : localHttpsAuthUrl;
      }

      const appId = fyersService.getFormattedAppId();
      const appIdHash = fyersService.generateAppIdHash();

      res.json({
        success: true,
        authUrl: activeAuthUrl,
        directCloudAuthUrl,
        localAuthUrl: localHttpsAuthUrl,
        localHttpsAuthUrl,
        localHttpAuthUrl,
        configuredAuthUrl,
        cloudCallbackUri,
        appId,
        appIdHash,
        hasSecret: Boolean(settings.fyersSecretKey),
        redirectUri: settings.fyersRedirectUri,
        activeRedirectUri: customRedirectUri || (requestedMode === 'cloud' ? cloudCallbackUri : configuredUri),
        mode: requestedMode || (configuredUri.includes('/auth/callback') ? 'cloud' : 'configured'),
        message: 'Open this link to authorize Fyers. Note: The redirect URI in this link MUST match the redirect URI configured on your Fyers Developer Dashboard to avoid 401 errors.'
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Check and compute App ID Hash from current settings
  app.get('/api/auth/compute-hash', (req, res) => {
    try {
      const hash = fyersService.generateAppIdHash();
      const appId = fyersService.getFormattedAppId();
      const candidates = fyersService.getAppIdHashCandidates();
      const settings = db.getSettings();
      res.json({
        success: true,
        appId,
        appIdHash: hash,
        candidates,
        hasSecret: Boolean(settings.fyersSecretKey),
        secretLength: settings.fyersSecretKey ? settings.fyersSecretKey.length : 0
      });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // Extract access code from redirect URL and exchange for live session
  app.post('/api/auth/extract-code', async (req, res) => {
    const { url, redirectUrl, input, authCode, accessToken, code, userId, appIdHash, secretKey } = req.body;
    const userEmail = (req.headers['x-user-email'] || req.body.userEmail || '') as string;
    const uid = (userId || req.headers['x-user-id'] || userEmail) as string;
    const inputStr = (url || redirectUrl || input || authCode || accessToken || code || '').trim();

    if (!inputStr) {
      return res.status(400).json({ success: false, error: 'Please provide the copied redirect URL or access code' });
    }

    try {
      const authData = await fyersService.connectFromUrl(inputStr, uid, userEmail, appIdHash, secretKey);
      if (uid) {
        db.saveUserAccessCode(uid, authData, userEmail);
      }
      const verifyRes = await fyersService.verifyTokenWithFyers(authData.accessToken);
      res.json({
        success: true,
        message: 'Access code extracted, exchanged, and authenticated successfully with FYERS!',
        auth: authData,
        profile: verifyRes.profile
      });
    } catch (err: any) {
      const isExpectedAuthNotice = err.message && (
        err.message.includes('auth code') ||
        err.message.includes('auth_code') ||
        err.message.includes('access_token') ||
        err.message.includes('extract') ||
        err.message.includes('expired') ||
        err.message.includes('consumed') ||
        err.message.includes('invalid') ||
        err.message.includes('valid') ||
        err.message.includes('address bar') ||
        err.message.includes('missing') ||
        err.message.includes('app id hash')
      );
      if (isExpectedAuthNotice) {
        logger.info('Auth extraction notice:', err.message);
      } else {
        logger.warn('Auth extraction notice:', err.message);
      }
      res.status(400).json({ success: false, error: err.message || 'Could not extract access token from URL' });
    }
  });

  // Connect directly by pasting full redirect URL
  app.post('/auth/connect-url', async (req, res) => {
    const { url, redirectUrl, input, userId, appIdHash, secretKey } = req.body;
    const userEmail = (req.headers['x-user-email'] || req.body.userEmail || '') as string;
    const uid = (userId || req.headers['x-user-id'] || userEmail) as string;
    const inputStr = (url || redirectUrl || input || '').trim();
    try {
      const authData = await fyersService.connectFromUrl(inputStr, uid, userEmail, appIdHash, secretKey);
      if (uid) {
        db.saveUserAccessCode(uid, authData, userEmail);
      }
      res.json({ success: true, message: 'Extracted Access Token / Auth Code from URL & Connected Successfully!', auth: authData });
    } catch (err: any) {
      const isExpectedAuthNotice = err.message && (
        err.message.includes('auth code') ||
        err.message.includes('auth_code') ||
        err.message.includes('access_token') ||
        err.message.includes('extract') ||
        err.message.includes('expired') ||
        err.message.includes('consumed') ||
        err.message.includes('invalid') ||
        err.message.includes('valid') ||
        err.message.includes('address bar') ||
        err.message.includes('missing') ||
        err.message.includes('app id hash')
      );
      if (isExpectedAuthNotice) {
        logger.info('Connect from URL notice:', err.message);
      } else {
        logger.warn('Connect from URL notice:', err.message);
      }
      res.status(400).json({ success: false, error: err.message || 'Could not extract access token from URL' });
    }
  });

  // 100% Automated Backend Login using saved credentials or active session
  app.post('/auth/auto-login', async (req, res) => {
    const userEmail = (req.headers['x-user-email'] || req.body.userEmail || '') as string;
    const uid = (req.body.userId || req.headers['x-user-id'] || userEmail) as string;
    try {
      const authData = await fyersService.autoLoginWithBackendCredentials(false, uid, userEmail);
      if (uid) {
        db.saveUserAccessCode(uid, authData, userEmail);
      }
      const verifyRes = await fyersService.verifyTokenWithFyers(authData.accessToken);
      res.json({
        success: true,
        message: 'Fyers Authentication Successful!',
        auth: authData,
        profile: verifyRes.profile
      });
    } catch (err: any) {
      logger.info('Auto-login attempt notice:', err.message);
      res.json({
        success: false,
        authRequired: true,
        authUrl: fyersService.getAuthUrl(),
        error: err.message || 'Auto-login requires user authorization. Click "Launch Fyers Auth" to connect.'
      });
    }
  });

  // Disconnect & Reset Fyers Token Endpoint
  app.post(['/auth/disconnect', '/api/auth/disconnect'], async (req, res) => {
    const userEmail = (req.headers['x-user-email'] || req.body.userEmail || '') as string;
    const uid = (req.body.userId || req.headers['x-user-id'] || userEmail) as string;
    db.clearAuthCode(uid);
    db.updateFyersAuth({
      accessToken: '',
      refreshToken: '',
      expiresAt: 0,
      isValid: false
    }, uid, userEmail);
    logger.info(`Fyers authentication disconnected for user: ${uid || 'default'}`);
    res.json({ success: true, message: 'Disconnected from Fyers Live Broker API.' });
  });

  // Manual Auth Code / Access Token / URL Submission Endpoint
  app.post('/auth/manual-token', async (req, res) => {
    const { authCode, accessToken, url, redirectUrl, userId } = req.body;
    const userEmail = (req.headers['x-user-email'] || req.body.userEmail || '') as string;
    const uid = (userId || req.headers['x-user-id'] || userEmail) as string;
    const inputUrl = url || redirectUrl || '';

    try {
      if (inputUrl && inputUrl.trim()) {
        const authData = await fyersService.connectFromUrl(inputUrl.trim());
        if (uid) {
          db.saveUserAccessCode(uid, authData, userEmail);
        }
        return res.json({ success: true, message: 'Access token extracted from URL and verified successfully!', auth: authData });
      }

      // If accessToken is provided
      if (accessToken && accessToken.trim()) {
        const cleanToken = accessToken.trim().replace(/^Bearer\s+/i, '');
        const verifyRes = await fyersService.verifyTokenWithFyers(cleanToken);
        if (!verifyRes.isValid) {
          return res.status(400).json({ success: false, error: `Fyers rejected this access token: ${verifyRes.message}` });
        }
        const updated = db.updateFyersAuth({
          accessToken: cleanToken,
          expiresAt: Date.now() + (24 * 60 * 60 * 1000),
          isValid: true
        }, uid, userEmail);
        logger.success(`Manual Fyers Access Token verified and saved successfully! ${verifyRes.message}`);
        return res.json({ success: true, message: `Connected successfully! ${verifyRes.message}`, auth: updated, profile: verifyRes.profile });
      }

      // If authCode or raw token string is provided in authCode field
      if (authCode && authCode.trim()) {
        const rawCode = authCode.trim();

        // 1. Check if user pasted a full URL
        if (rawCode.includes('http') || rawCode.includes('auth_code=') || rawCode.includes('access_token=')) {
          const authData = await fyersService.connectFromUrl(rawCode);
          if (uid) {
            db.saveUserAccessCode(uid, authData, userEmail);
          }
          return res.json({ success: true, message: 'Extracted token/code from URL and connected successfully!', auth: authData });
        }

        // 2. Check if user pasted an Access Token directly into authCode field (JWT format or long token)
        if (rawCode.startsWith('eyJ') || (rawCode.length > 80 && rawCode.includes('.'))) {
          const verifyRes = await fyersService.verifyTokenWithFyers(rawCode);
          if (!verifyRes.isValid) {
            return res.status(400).json({ success: false, error: `Fyers rejected this access token: ${verifyRes.message}` });
          }
          const updated = db.updateFyersAuth({
            accessToken: rawCode,
            expiresAt: Date.now() + (24 * 60 * 60 * 1000),
            isValid: true
          }, uid, userEmail);
          logger.success(`Direct Fyers Access Token verified and saved successfully! ${verifyRes.message}`);
          return res.json({ success: true, message: `Connected successfully! ${verifyRes.message}`, auth: updated, profile: verifyRes.profile });
        }

        // 3. Otherwise treat as authorization code
        const authData = await fyersService.validateAuthCode(rawCode, uid, userEmail);
        if (uid) {
          db.saveUserAccessCode(uid, authData, userEmail);
        }
        return res.json({ success: true, message: 'Auth Code exchanged & Access Token verified successfully', auth: authData });
      }

      return res.status(400).json({ error: 'Please provide an access token, auth code, or redirect URL' });
    } catch (err: any) {
      logger.error('Failed manual token submission', err);
      res.status(500).json({ error: err.message || 'Token exchange failed' });
    }
  });

  // Dedicated Fyers Profile API
  app.get('/api/fyers/profile', async (req, res) => {
    try {
      const profile = await fyersService.getProfile();
      res.json(profile);
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Dedicated Fyers Live Connection Diagnostic API
  app.get('/api/fyers/test-connection', async (req, res) => {
    try {
      const auth = db.getFyersAuth();
      const settings = db.getSettings();
      const appId = fyersService.getFormattedAppId();

      if (!auth.accessToken) {
        return res.json({
          connected: false,
          isLive: false,
          message: 'No access token in database. Please authenticate with Fyers.',
          appId,
          mode: settings.mode
        });
      }

      const verifyRes = await fyersService.verifyTokenWithFyers(auth.accessToken);
      if (!verifyRes.isValid) {
        return res.json({
          connected: false,
          isLive: false,
          message: verifyRes.message,
          appId,
          mode: settings.mode
        });
      }

      const funds = await fyersService.getFunds();
      const positions = await fyersService.getPositions();

      return res.json({
        connected: true,
        isLive: funds.isLive,
        message: verifyRes.message,
        profile: verifyRes.profile,
        funds,
        netPositionsCount: positions.netPositions?.length || 0,
        appId,
        mode: settings.mode
      });
    } catch (err: any) {
      res.status(500).json({ connected: false, error: err.message });
    }
  });

  // -------------------------------------------------------------
  // TRADING ENVIRONMENT TOGGLE (Paper <-> Live)
  // -------------------------------------------------------------
  app.post('/api/mode/toggle', async (req, res) => {
    try {
      const { targetMode } = req.body || {};
      const current = db.getSettings();
      const nextMode = targetMode 
        ? (targetMode.toUpperCase() === 'LIVE' ? 'LIVE' : 'PAPER') 
        : (current.mode === 'LIVE' ? 'PAPER' : 'LIVE');

      const updated = db.updateSettings({ mode: nextMode });
      logger.info(`Trading mode toggled: Switched from ${current.mode} to ${nextMode}`);
      res.json({ success: true, mode: nextMode, settings: updated });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // -------------------------------------------------------------
  // 2. DASHBOARD & STRATEGY APIS
  // -------------------------------------------------------------

  app.get('/api/dashboard', async (req, res) => {
    try {
      const isOwner = isAuthorizedFyersUser(req);
      const userId = (req.headers['x-user-id'] || req.query.userId) as string;
      const userEmail = (req.headers['x-user-email'] || req.query.userEmail) as string;
      const settings = db.getSettings();
      if (!isOwner) {
        settings.mode = 'PAPER';
      }

      // Automatically verify and reconnect autonomously via backend TOTP if access token is expired or missing
      await fyersService.ensureValidToken(userId, userEmail).catch(() => {});

      let openPositions = (db.getPositions() || []).filter(p => p.status === 'OPEN' || p.status === 'ADJUSTED');
      const orders = (db.getOrders() || []).slice(0, 15);
      const adjustments = (db.getAdjustments() || []).slice(0, 15);
      const authStatus = fyersService.getTokenStatus(userId);

      const spotPrice = await marketDataService.getLTP(settings.indexSymbol || 'NSE:NIFTY50-INDEX');

      // Fetch and synchronize Available Funds directly from FYERS whenever authenticated or configured
      let fyersFunds: any = null;
      try {
        fyersFunds = await fyersService.getFunds();
        if (fyersFunds && fyersFunds.isLive) {
          logger.info(`Live FYERS funds synced for dashboard: Available ₹${fyersFunds.availableBalance}, Utilised ₹${fyersFunds.utilizedMargin}, Total ₹${fyersFunds.totalBalance}`);
        }
      } catch (err) {
        logger.warn('Notice fetching FYERS live funds inside dashboard endpoint:', err);
      }

      // Fetch Live/Synced Positions from Fyers
      let fyersData: any = null;
      try {
        fyersData = await fyersService.getPositions();
      } catch (err) {
        logger.warn('Notice fetching FYERS net positions inside dashboard endpoint:', err);
      }

      const netPositions = fyersData?.netPositions || [];
      const fyersNetMap = new Map<string, any>();
      netPositions.forEach((p: any) => {
        if (p.symbol) {
          fyersNetMap.set(p.symbol, p);
        }
      });

      // Auto-sync and reconcile live positions with FYERS whenever authorized owner connects
      if (isOwner) {
        try {
          await strategyEngine.syncFyersPositions();
          openPositions = (db.getPositions() || []).filter(p => p.status === 'OPEN' || p.status === 'ADJUSTED');
        } catch (syncErr) {
          logger.warn('Error during auto-syncing Fyers positions:', syncErr);
        }
      }

      // Recalculate total current open position P&L
      let totalOpenPnl = 0;
      for (const pos of openPositions) {
        if (!pos.legs) pos.legs = [];
        for (const leg of pos.legs) {
          try {
            const liveMatch = fyersNetMap.get(leg.symbol);
            if (liveMatch) {
              if (typeof liveMatch.ltp === 'number' && liveMatch.ltp > 0) {
                leg.currentPrice = liveMatch.ltp;
              }
              if (liveMatch.netAvg || liveMatch.sellAvg || liveMatch.buyAvg) {
                leg.entryPrice = liveMatch.netAvg || liveMatch.sellAvg || liveMatch.buyAvg;
              }
              if (typeof liveMatch.pl === 'number') {
                leg.pnl = Math.round(liveMatch.pl);
              } else if (typeof liveMatch.unrealized_pnl === 'number') {
                leg.pnl = Math.round(liveMatch.unrealized_pnl);
              } else {
                leg.pnl = Math.round((leg.side === 'SELL' ? leg.entryPrice - leg.currentPrice : leg.currentPrice - leg.entryPrice) * leg.qty);
              }
            } else {
              const cachedPl = fyersService.getCachePL(leg.symbol);
              if (typeof cachedPl === 'number') {
                leg.pnl = Math.round(cachedPl);
              } else {
                leg.currentPrice = await marketDataService.getLTP(leg.symbol);
                if (leg.side === 'SELL') {
                  leg.pnl = Math.round((leg.entryPrice - leg.currentPrice) * leg.qty);
                } else {
                  leg.pnl = Math.round((leg.currentPrice - leg.entryPrice) * leg.qty);
                }
              }
            }
          } catch (legErr) {
            logger.warn(`Error updating leg P&L for ${leg.symbol}:`, legErr);
          }
        }
        pos.totalPnl = pos.legs.reduce((acc, leg) => acc + (leg.pnl || 0), 0);
        try {
          db.savePosition(pos);
        } catch (dbErr) {
          logger.warn('Failed to update position in DB:', dbErr);
        }
        totalOpenPnl += pos.totalPnl;
      }

      const freshSettings = db.getSettings();
      const livePositions = openPositions.filter(p => p.mode === 'LIVE');
      const paperPositions = openPositions.filter(p => p.mode === 'PAPER' || !p.mode);
      const livePnl = livePositions.reduce((sum, p) => sum + (p.totalPnl || 0), 0);
      const paperPnl = paperPositions.reduce((sum, p) => sum + (p.totalPnl || 0), 0);

      const monthlyRisk = riskService.checkMonthlyRisk(freshSettings.mode);
      const monthlyStats = riskService.getMonthlyStats(freshSettings.mode);

      let opportunities: any[] = [];
      try {
        opportunities = await opportunityScanner.scanOpportunities();
      } catch (oppErr) {
        logger.warn('Error scanning opportunities:', oppErr);
      }

      // Fetch dynamic India VIX and compute Iron Condor structure recommendations
      let vixData = null;
      try {
        vixData = await marketDataService.getIndiaVIX(spotPrice, freshSettings.vixThreshold || 15.5);
      } catch (vixErr) {
        logger.warn('Error computing India VIX data:', vixErr);
      }

      const isLiveFunds = !!(fyersFunds && fyersFunds.isLive);
      const defaultCap = freshSettings.capital && freshSettings.capital > 0 ? freshSettings.capital : 100000;
      const defaultAvail = (freshSettings.fyersAvailableFunds !== undefined && freshSettings.fyersAvailableFunds > 0) ? freshSettings.fyersAvailableFunds : defaultCap;
      const defaultTotal = (freshSettings.fyersTotalFunds !== undefined && freshSettings.fyersTotalFunds > 0) ? freshSettings.fyersTotalFunds : defaultCap;

      const userAvailableFunds = isLiveFunds ? fyersFunds.availableBalance : defaultAvail;
      const userTotalFunds = isLiveFunds ? fyersFunds.totalBalance : defaultTotal;
      const userUtilizedFunds = isLiveFunds ? fyersFunds.utilizedMargin : 0;
      const userWithdrawableFunds = isLiveFunds ? fyersFunds.withdrawableBalance : 0;
      const userCapital = isLiveFunds ? fyersFunds.allocatedCapital : defaultCap;

      res.json({
        mode: freshSettings.mode,
        spotPrice,
        capital: userCapital,
        capitalAllocationPct: freshSettings.capitalAllocationPct || 100,
        fyersAvailableFunds: userAvailableFunds,
        fyersTotalFunds: userTotalFunds,
        fyersUtilizedFunds: userUtilizedFunds,
        fyersWithdrawableFunds: userWithdrawableFunds,
        isLiveFunds,
        fundsData: fyersFunds || null,
        allocatedCapital: userCapital,
        openPositions,
        livePositions,
        paperPositions,
        livePnl,
        paperPnl,
        totalOpenPnl,
        orders,
        adjustments,
        monthlyRisk,
        monthlyStats,
        authStatus,
        autoTradingEnabled: freshSettings.autoTradingEnabled,
        opportunities,
        vixData
      });
    } catch (err: any) {
      logger.error('Error fetching dashboard data', err);
      res.status(500).json({ error: err.message || 'Internal Server Error' });
    }
  });

  // Apply VIX-calculated Recommended Iron Condor Parameters to Settings
  app.post('/api/settings/apply-vix-condor', (req, res) => {
    try {
      const { recommendedStrikeBuffer, recommendedWingWidth } = req.body;
      const current = db.getSettings();
      const strikeDistance = typeof recommendedStrikeBuffer === 'number' && recommendedStrikeBuffer > 0 ? recommendedStrikeBuffer : current.strikeDistance;
      const wingBuffer = typeof recommendedWingWidth === 'number' && recommendedWingWidth > 0 ? recommendedWingWidth : current.wingBuffer;

      const updated = db.updateSettings({
        strikeDistance,
        wingBuffer,
        vixAutoAdjustEnabled: true
      });

      logger.info(`Updated Condor settings to VIX recommendations: Buffer=${strikeDistance} pts, Wings=${wingBuffer} pts`);
      res.json({
        success: true,
        message: `Successfully applied VIX-based Iron Condor structure: Strike Buffer ${strikeDistance} pts, Wing Buffer ${wingBuffer} pts!`,
        settings: updated
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Test live order placement on Fyers
  app.post('/api/fyers/place-test-order', async (req, res) => {
    if (!isAuthorizedFyersUser(req)) {
      return res.status(403).json({ success: false, message: 'Fyers order execution is restricted to authorized user.' });
    }
    try {
      const { symbol, qty, side, type, productType } = req.body;
      const result = await fyersService.placeOrder({
        symbol: symbol || 'NSE:NIFTY26AUG24500CE',
        qty: qty || 65,
        side: side || 'SELL',
        type: type || 'MARKET',
        productType: productType || 'INTRADAY'
      });
      res.json({ success: true, fyersResponse: result });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message || String(err) });
    }
  });

  // Get live opportunities
  app.get('/api/opportunities', async (req, res) => {
    try {
      const opportunities = await opportunityScanner.scanOpportunities();
      res.json(opportunities);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Execute an identified opportunity (Iron Condor, Short Straddle, Cash-and-Carry, Synthetic Arbitrage)
  app.post('/api/opportunities/execute', async (req, res) => {
    const { oppType, mode } = req.body;
    try {
      const isOwner = isAuthorizedFyersUser(req);
      const settings = db.getSettings();
      const targetMode = mode ? (mode.toUpperCase() === 'LIVE' ? 'LIVE' : 'PAPER') : settings.mode;
      if (targetMode === 'LIVE' && !isOwner) {
        return res.status(403).json({
          success: false,
          message: 'Live opportunity execution on FYERS is restricted exclusively to authorized account.'
        });
      }
      const result = await strategyEngine.executeOpportunityById(oppType, targetMode);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // Run 5-Day Historical Iron Condor Strategy Simulation / Backtest
  app.get('/api/simulation/backtest', (req, res) => {
    try {
      const result = backtestService.runBacktest();
      res.json(result);
    } catch (err: any) {
      logger.error('Error running 5-day backtest simulation:', err);
      res.status(500).json({ error: err.message || 'Backtest failed' });
    }
  });

  app.post('/api/simulation/backtest', (req, res) => {
    try {
      const customParams = req.body || {};
      const result = backtestService.runBacktest(customParams);
      res.json(result);
    } catch (err: any) {
      logger.error('Error running custom backtest simulation:', err);
      res.status(500).json({ error: err.message || 'Custom backtest failed' });
    }
  });

  // Get raw live net positions from Fyers API v3
  app.get('/api/fyers/positions', async (req, res) => {
    if (!isAuthorizedFyersUser(req)) {
      return res.json({ netPositions: [], isOwner: false, message: 'Fyers live sync restricted to authorized account' });
    }
    try {
      const positions = await fyersService.getPositions();
      res.json(positions);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Sync Fyers Live Trades into Strategy Engine with Custom Tagging
  app.post('/api/fyers/sync', async (req, res) => {
    if (!isAuthorizedFyersUser(req)) {
      return res.status(403).json({ success: false, message: 'Fyers live sync restricted to authorized account' });
    }
    try {
      const { tag, strategy } = req.body || {};
      const result = await strategyEngine.syncFyersPositions(tag, strategy);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // Manual Entry of Position Legs and Strategy Tagging with Validation & Auto-Identification
  app.post('/api/positions/manual-entry', async (req, res) => {
    try {
      const { legs, strategy, tag, mode } = req.body || {};
      if (!Array.isArray(legs) || legs.length === 0) {
        return res.status(400).json({ success: false, message: 'At least one position leg is required.' });
      }

      const spotPrice = await marketDataService.getLTP('NSE:NIFTY50-INDEX');
      const expiryInfo = getNearestExpiryForSymbol('NSE:NIFTY50-INDEX');
      const dateCode = expiryInfo.fyersSymbolDateCode;

      const formattedLegs: Leg[] = [];
      for (let idx = 0; idx < legs.length; idx++) {
        const l = legs[idx];
        const qty = Math.abs(parseInt(l.qty, 10) || 65);
        const entryPrice = parseFloat(l.entryPrice) || 10;
        const side = (l.side === 'BUY' || l.side === 1 || l.side === 'buy') ? 'BUY' : 'SELL';
        
        let type: 'CE' | 'PE' | 'FUT' | 'EQUITY' = (l.type || 'CE').toUpperCase() as any;
        let strike = parseInt(l.strike, 10) || 0;
        let symbol = l.symbol ? l.symbol.trim() : '';

        // If symbol is provided, parse it
        if (symbol) {
          const parsed = parseFyersOptionSymbol(symbol);
          if (parsed.isValid) {
            type = parsed.type;
            strike = parsed.strike;
          }
        }

        // Validate strike: strikes for Nifty must be reasonable (e.g. 15000 to 35000)
        if (strike > 0 && strike < 1000) {
          // In case user entered 245 instead of 24500
          strike = strike * 100;
        } else if (strike > 1000000) {
          // If strike was concatenated with date code e.g. 2681824800
          const strikeStr = String(strike);
          const subMatch = strikeStr.match(/(\d{5})$/);
          if (subMatch) strike = parseInt(subMatch[1], 10);
        }

        if (!symbol || !symbol.startsWith('NSE:')) {
          symbol = `NSE:NIFTY${dateCode}${strike}${type}`;
        }

        // Fetch current live price if available
        let currentPrice = parseFloat(l.currentPrice) || 0;
        if (currentPrice <= 0) {
          try {
            currentPrice = await marketDataService.getLTP(symbol);
          } catch (e) {
            currentPrice = entryPrice;
          }
        }
        if (currentPrice <= 0) currentPrice = entryPrice;

        const pnl = Math.round((currentPrice - entryPrice) * (side === 'SELL' ? -1 : 1) * qty);

        formattedLegs.push({
          id: `manual_leg_${Date.now()}_${idx}`,
          symbol,
          type,
          strike,
          side,
          qty,
          entryPrice,
          currentPrice,
          pnl,
          isWing: side === 'BUY'
        });
      }

      const totalPnl = formattedLegs.reduce((acc, l) => acc + l.pnl, 0);
      
      // Auto-detect strategy if not explicitly chosen or if set to auto/custom
      const detected = detectOptionStrategy(formattedLegs);
      const strategyName = (strategy && strategy !== 'AUTO_DETECT' && strategy !== 'CUSTOM_STRATEGY') 
        ? strategy 
        : detected.strategy;
      const finalTag = tag?.trim() ? tag.trim() : detected.tag;

      const newPos: Position = {
        id: `pos_manual_${Date.now()}`,
        strategy: strategyName,
        tag: finalTag,
        source: 'MANUAL_ENTRY',
        symbol: 'NSE:NIFTY50-INDEX',
        indexEntryPrice: spotPrice,
        currentIndexPrice: spotPrice,
        status: 'OPEN',
        legs: formattedLegs,
        totalPnl,
        maxRisk: 15000,
        maxReward: 10000,
        entryTime: new Date().toISOString(),
        updatedTime: new Date().toISOString(),
        adjustmentCount: 0,
        wingsAdded: formattedLegs.some(l => l.isWing),
        mode: mode || 'LIVE',
        notes: `Manual trade entry validated: ${detected.description}`
      };

      db.savePosition(newPos);
      logger.success(`Manually logged and validated position ${newPos.id} with strategy "${strategyName}" and tag "${finalTag}"`);

      res.json({
        success: true,
        message: `Successfully validated and identified position as "${strategyName}" (${finalTag})!`,
        position: newPos,
        detected
      });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // Delete/Remove a manual or stale position
  app.delete('/api/positions/:id', async (req, res) => {
    try {
      const positionId = req.params.id;
      const pos = db.getPositions().find(p => p.id === positionId);
      if (!pos) {
        return res.status(404).json({ success: false, message: 'Position not found' });
      }
      pos.status = 'CLOSED';
      pos.exitReason = 'REMOVED_BY_USER';
      pos.exitTime = new Date().toISOString();
      db.savePosition(pos);
      logger.info(`Removed/closed position ${positionId}`);
      res.json({ success: true, message: `Position ${positionId} successfully removed.` });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // Update strategy tag and classification for a position
  app.post('/api/positions/tag', async (req, res) => {
    const { positionId, tag, strategy } = req.body;
    try {
      const result = strategyEngine.updatePositionTag(positionId, tag, strategy);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // Trigger New Short Straddle Entry
  app.post('/api/strategy/entry', async (req, res) => {
    try {
      const isOwner = isAuthorizedFyersUser(req);
      const settings = db.getSettings();
      if (settings.mode === 'LIVE' && !isOwner) {
        return res.status(403).json({
          success: false,
          message: 'Live FYERS order execution is restricted to sosund@gmail.com. Non-owner accounts run in Paper Mode.'
        });
      }
      const result = await strategyEngine.executeEntryIfEligible();
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // Square off position
  app.post('/api/strategy/close', async (req, res) => {
    const { positionId, reason } = req.body;
    try {
      const isOwner = isAuthorizedFyersUser(req);
      const position = db.getPositions().find(p => p.id === positionId);
      if (position?.mode === 'LIVE' && !isOwner) {
        return res.status(403).json({
          success: false,
          message: 'Live FYERS position square-off is restricted to authorized account.'
        });
      }
      const result = await strategyEngine.closePosition(positionId, reason || 'MANUAL_USER_REQUEST');
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // Force Immediate Strategy Tick Check
  app.post('/api/market/tick', async (req, res) => {
    try {
      const result = await strategyEngine.monitorAndAdjustPositions();
      res.json({ success: true, result });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Nudge Simulated Price (+250 / -250 pts) for testing Golden Rule adjustments
  app.post('/api/market/nudge', async (req, res) => {
    const { delta } = req.body;
    const deltaVal = parseFloat(delta) || 200;
    const newSpot = marketDataService.nudgeSimulatedPrice(deltaVal);
    
    // Automatically trigger monitor after nudge
    const tickResult = await strategyEngine.monitorAndAdjustPositions();

    res.json({
      success: true,
      newSpot,
      message: `Market spot price nudged by ${deltaVal > 0 ? '+' : ''}${deltaVal} pts to ₹${newSpot}`,
      tickResult
    });
  });

  // -------------------------------------------------------------
  // 3. TRADE LOG & SYSTEM LOG APIS
  // -------------------------------------------------------------

  app.get('/api/logs', async (req, res) => {
    try {
      const { startDate, endDate, action, mode, search } = req.query as any;
      const userEmail = (req.headers['x-user-email'] as string) || (req.query.userEmail as string) || '';

      // Optionally sync real trades from FYERS tradebook if authorized user
      if (isAuthorizedFyersUser(req)) {
        try {
          const tbData = await fyersService.getTradebook();
          if (tbData && Array.isArray(tbData.tradeBook) && tbData.tradeBook.length > 0) {
            const existingLogs = db.getTradeLogs();
            for (const trade of tbData.tradeBook) {
              const tradeId = trade.tradeNumber || trade.id || trade.orderNumber;
              const hasRecorded = existingLogs.some(l => l.notes?.includes(tradeId) || l.id === `fyers_tb_${tradeId}`);
              if (!hasRecorded && trade.symbol) {
                db.addTradeLog({
                  action: trade.transType === 1 ? 'BUY' : (trade.transType === -1 ? 'SELL' : 'TRADE_EXECUTION'),
                  symbol: trade.symbol,
                  strategy: 'FYERS_LIVE_TRADE',
                  price: trade.tradePrice || trade.tradeValue || 0,
                  quantity: trade.tradedQty || 0,
                  pnl: 0,
                  mode: 'LIVE',
                  notes: `Fyers Live Executed Trade: ${trade.symbol} (${trade.transType === 1 ? 'BUY' : 'SELL'} ${trade.tradedQty} @ ₹${trade.tradePrice}). Trade Ref: ${tradeId}. Time: ${trade.orderDateTime || ''}`,
                  userEmail: 'sosund@gmail.com'
                });
              }
            }
          }
        } catch (tbErr) {
          logger.warn('Fyers tradebook sync notice:', tbErr);
        }
      }

      const tradeLogs = db.getTradeLogs({
        startDate,
        endDate,
        action,
        mode,
        search,
        userEmail: userEmail || undefined
      });
      res.json(tradeLogs);
    } catch (err: any) {
      logger.error('Error fetching trade logs:', err);
      res.status(500).json({ error: err?.message || 'Failed to retrieve trade logs' });
    }
  });

  app.get('/api/system-logs', (req, res) => {
    try {
      const systemLogs = getSystemLogs();
      res.json(Array.isArray(systemLogs) ? systemLogs : []);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Failed to retrieve system logs' });
    }
  });

  // Strategy Marketplace & Rule Config Endpoints
  app.get('/api/strategies', (req, res) => {
    try {
      const list = db.getStrategies();
      res.json(list);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/strategies', (req, res) => {
    try {
      const strategyData = req.body;
      if (!strategyData || !strategyData.name) {
        return res.status(400).json({ error: 'Strategy name is required' });
      }
      const saved = db.saveStrategy(strategyData);
      res.json({ success: true, strategy: saved });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/strategies/:id/subscribe', (req, res) => {
    try {
      const { id } = req.params;
      const { isSubscribed } = req.body;
      const list = db.getStrategies();
      const existing = list.find(s => s.id === id);
      if (!existing) {
        return res.status(404).json({ error: 'Strategy not found' });
      }
      existing.isSubscribed = Boolean(isSubscribed);
      const updated = db.saveStrategy(existing);
      res.json({ success: true, strategy: updated });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/strategies/:id/visibility', (req, res) => {
    try {
      const { id } = req.params;
      const { isPublic } = req.body;
      const list = db.getStrategies();
      const existing = list.find(s => s.id === id);
      if (!existing) {
        return res.status(404).json({ error: 'Strategy not found' });
      }
      existing.isPublic = Boolean(isPublic);
      const updated = db.saveStrategy(existing);
      res.json({ success: true, strategy: updated });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/strategies/:id', (req, res) => {
    try {
      const { id } = req.params;
      db.deleteStrategy(id);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // -------------------------------------------------------------
  // 4. SETTINGS & RISK APIS
  // -------------------------------------------------------------

  // FYERS Funds Sync Endpoint
  app.all('/api/fyers/funds', async (req, res) => {
    try {
      const funds = await fyersService.getFunds();
      const currentSettings = db.getSettings();
      const isLive = funds?.isLive || false;
      res.json({
        success: true,
        isLive,
        funds,
        availableBalance: isLive ? funds.availableBalance : (currentSettings.mode === 'PAPER' ? currentSettings.capital : 0),
        utilizedMargin: isLive ? funds.utilizedMargin : 0,
        withdrawableBalance: isLive ? funds.withdrawableBalance : 0,
        allocatedCapital: isLive ? funds.allocatedCapital : (currentSettings.mode === 'PAPER' ? currentSettings.capital : 0),
        fyersTotalFunds: isLive ? funds.totalBalance : (currentSettings.mode === 'PAPER' ? currentSettings.capital : 0),
        capitalAllocationPct: currentSettings.capitalAllocationPct || 100,
        isOwner: true
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message || 'Failed fetching Fyers funds' });
    }
  });

  app.all('/api/fyers/funds/reconcile', async (req, res) => {
    try {
      const funds = await fyersService.getFunds();
      const settings = db.getSettings();
      const isLive = funds?.isLive || false;
      res.json({
        success: true,
        isLive,
        message: isLive 
          ? `Reconciled FYERS Live Funds: Available ₹${funds.availableBalance.toLocaleString('en-IN')}, Utilised ₹${funds.utilizedMargin.toLocaleString('en-IN')}, Total ₹${funds.totalBalance.toLocaleString('en-IN')}`
          : (settings.mode === 'PAPER' ? 'Paper Trading Mode Active' : 'FYERS Live Broker Disconnected / Authentication Required'),
        funds,
        availableBalance: isLive ? funds.availableBalance : (settings.fyersAvailableFunds || settings.capital || 100000),
        utilizedMargin: isLive ? funds.utilizedMargin : 0,
        withdrawableBalance: isLive ? funds.withdrawableBalance : 0,
        allocatedCapital: isLive ? funds.allocatedCapital : (settings.capital || 100000),
        fyersTotalFunds: isLive ? funds.totalBalance : (settings.fyersTotalFunds || settings.capital || 100000),
        capitalAllocationPct: settings.capitalAllocationPct || 100,
        isOwner: true
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message || 'Failed reconciling Fyers funds' });
    }
  });

  app.get('/api/settings', async (req, res) => {
    let settings = db.getSettings();

    try {
      await fyersService.getFunds();
      settings = db.getSettings();
    } catch (err) {
      logger.warn('Notice fetching Fyers live funds inside settings endpoint:', err);
    }

    res.json({
      ...settings,
      isFyersOwner: true,
      fyersSecretKey: settings.fyersSecretKey ? '••••••••' + settings.fyersSecretKey.slice(-4) : '',
      telegramBotToken: settings.telegramBotToken ? '••••••••' : ''
    });
  });

  app.post('/api/settings', (req, res) => {
    try {
      const newSettings = req.body;

      // Do not overwrite masked keys if unchanged
      if (newSettings.fyersSecretKey && newSettings.fyersSecretKey.startsWith('••••')) {
        delete newSettings.fyersSecretKey;
      }
      if (newSettings.telegramBotToken && newSettings.telegramBotToken.startsWith('••••')) {
        delete newSettings.telegramBotToken;
      }

      // Recompute effective capital based on capitalAllocationPct
      const currentSettings = db.getSettings();
      const pct = typeof newSettings.capitalAllocationPct === 'number'
        ? newSettings.capitalAllocationPct
        : (currentSettings.capitalAllocationPct || 100);
      
      const availFunds = (typeof newSettings.fyersAvailableFunds === 'number' && newSettings.fyersAvailableFunds > 0)
        ? newSettings.fyersAvailableFunds
        : (currentSettings.fyersAvailableFunds || newSettings.capital || currentSettings.capital || 500000);

      newSettings.capitalAllocationPct = Math.min(100, Math.max(1, pct));
      newSettings.capital = Math.round(availFunds * (newSettings.capitalAllocationPct / 100));

      const updated = db.updateSettings(newSettings);
      logger.info('Settings updated via Web API');
      res.json({ success: true, settings: updated, isFyersOwner: true });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // -------------------------------------------------------------
  // 5. OPTION CHAIN & MARKET DATA APIS
  // -------------------------------------------------------------

  app.get('/api/market/option-chain', async (req, res) => {
    try {
      const chain = await marketDataService.getOptionChain();
      res.json(chain);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/market/volatility-surface', async (req, res) => {
    try {
      const symbol = (req.query.symbol as string) || 'NSE:NIFTY50-INDEX';
      const customSpot = req.query.spot ? parseFloat(req.query.spot as string) : undefined;
      const regime = (req.query.regime as any) || 'NORMAL';
      const surface = await marketDataService.getVolatilitySurface(symbol, customSpot, regime);
      res.json(surface);
    } catch (err: any) {
      logger.error('Error fetching volatility surface:', err);
      res.status(500).json({ error: err.message || 'Failed to fetch volatility surface' });
    }
  });

  app.get('/api/market/ltp', async (req, res) => {
    const symbol = (req.query.symbol as string) || 'NSE:NIFTY50-INDEX';
    const ltp = await marketDataService.getLTP(symbol);
    res.json({ symbol, ltp });
  });

  // Test Notification
  app.post('/api/notifications/test', async (req, res) => {
    try {
      await notificationService.notify('Test Alert', 'This is a test notification from Fyers Iron Condor App.', 'INFO');
      res.json({ success: true, message: 'Notification sent successfully!' });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Fallback for unmatched API routes (prevents Vite middleware from returning index.html)
  app.all('/api/*', (req, res) => {
    res.status(404).json({ error: `API endpoint ${req.originalUrl} not found` });
  });

  // -------------------------------------------------------------
  // 6. VITE / STATIC CLIENT MIDDLEWARE
  // -------------------------------------------------------------

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        allowedHosts: true,
        cors: true
      },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    logger.info(`=======================================================`);
    logger.info(`🚀 FYERS Iron Condor Trading System running on http://localhost:${PORT}`);
    logger.info(`=======================================================`);

    // Autonomous startup authentication: if Fyers is not authenticated, auto connect immediately
    setTimeout(() => {
      fyersService.ensureValidToken().then(ok => {
        if (ok) logger.success('Autonomous startup connection to FYERS completed successfully!');
      }).catch(e => {
        logger.info('Autonomous startup connection attempt notice:', e.message);
      });
    }, 1500);
  });

  const handleShutdown = (signal: string) => {
    logger.info(`Received ${signal}, shutting down gracefully...`);
    server.close(() => {
      logger.info('HTTP server closed cleanly.');
      process.exit(0);
    });
    setTimeout(() => {
      process.exit(0);
    }, 2000).unref();
  };

  process.on('SIGTERM', () => handleShutdown('SIGTERM'));
  process.on('SIGINT', () => handleShutdown('SIGINT'));
}

startServer().catch((err) => {
  console.error('Fatal error starting server:', err);
  process.exit(1);
});
