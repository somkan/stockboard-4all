#!/usr/bin/env node

/**
 * FYERS Headless Auth Companion Script (Node.js)
 * 
 * Executes full headless authentication:
 * 1. Initiates login OTP
 * 2. Generates TOTP code & verifies OTP
 * 3. Verifies 4-digit PIN
 * 4. Requests authorization from Fyers token endpoint
 * 5. Captures the local URI from the response without navigating in UI mode
 * 6. Parses the access code from the local URI
 * 7. Exchanges code with Fyers API and/or syncs directly to Stockboard
 * 
 * Usage:
 *   node scripts/fyers_headless_auth.mjs
 * Or with environment variables:
 *   FY_ID=... FYERS_TOTP_KEY=... FYERS_PIN=... FYERS_APP_ID=... FYERS_SECRET_KEY=... node scripts/fyers_headless_auth.mjs
 */

import crypto from 'crypto';

// Configuration
const FY_ID = process.env.FY_ID || process.env.FYERS_CLIENT_ID || '';
const TOTP_KEY = process.env.FYERS_TOTP_KEY || '';
const PIN = process.env.FYERS_PIN || '';
const APP_ID = process.env.FYERS_APP_ID || '';
const APP_SECRET = process.env.FYERS_SECRET_KEY || '';
const REDIRECT_URI = process.env.FYERS_REDIRECT_URI || 'https://127.0.0.1:6414';
const APP_TYPE = process.env.FYERS_APP_TYPE || '100';
const STOCKBOARD_URL = process.env.STOCKBOARD_URL || 'https://ais-dev-q24gpmg5htl2mfszzrnchs-824420889987.asia-southeast1.run.app';

// Base32 TOTP Generator (RFC 6238)
function generateTOTP(secretBase32) {
  if (!secretBase32) return '';
  const clean = secretBase32.replace(/=+$/, '').toUpperCase().replace(/\s+/g, '');
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (let i = 0; i < clean.length; i++) {
    const val = chars.indexOf(clean.charAt(i));
    if (val < 0) continue;
    bits += val.toString(2).padStart(5, '0');
  }
  const bytes = new Uint8Array(Math.floor(bits.length / 8));
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(bits.substring(i * 8, i * 8 + 8), 2);
  }
  const epoch = Math.floor(Date.now() / 1000);
  const timeStep = Math.floor(epoch / 30);
  const timeBuf = Buffer.alloc(8);
  timeBuf.writeUInt32BE(0, 0);
  timeBuf.writeUInt32BE(timeStep, 4);

  const hmac = crypto.createHmac('sha1', Buffer.from(bytes)).update(timeBuf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = ((hmac[offset] & 0x7f) << 24) |
               ((hmac[offset + 1] & 0xff) << 16) |
               ((hmac[offset + 2] & 0xff) << 8) |
               (hmac[offset + 3] & 0xff);
  return (code % 1000000).toString().padStart(6, '0');
}

// Parse access code from local URI
function extractCodeFromUri(uri) {
  if (!uri) return null;
  const match = uri.match(/[?&#]auth_code=([^&]+)/) || uri.match(/[?&#]code=([^&]+)/);
  if (match) {
    return decodeURIComponent(match[1]);
  }
  return null;
}

async function runHeadlessAuth() {
  console.log('====================================================');
  console.log('  FYERS HEADLESS AUTHENTICATION & CODE EXTRACTOR   ');
  console.log('====================================================');

  if (!FY_ID || !TOTP_KEY || !PIN) {
    console.error('Error: Please provide FY_ID, FYERS_TOTP_KEY, and FYERS_PIN.');
    console.error('Example: FY_ID=XXXXX FYERS_TOTP_KEY=YYYYY FYERS_PIN=1234 FYERS_APP_ID=ZZZZZ node scripts/fyers_headless_auth.mjs');
    process.exit(1);
  }

  const formattedAppId = APP_ID.includes('-') ? APP_ID : `${APP_ID}-${APP_TYPE}`;
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/plain, */*',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    'Origin': 'https://login.fyers.in',
    'Referer': 'https://login.fyers.in/'
  };

  try {
    // Step 1: Send Login OTP
    console.log(`[1/5] Initiating login OTP for ${FY_ID}...`);
    const otpRes = await fetch('https://api-t2.fyers.in/vagator/v2/send_login_otp', {
      method: 'POST',
      headers,
      body: JSON.stringify({ fy_id: FY_ID, app_id: '2' })
    });
    const otpData = await otpRes.json();
    if (!otpRes.ok || !otpData.request_key) {
      throw new Error(`OTP initiation failed: ${JSON.stringify(otpData)}`);
    }
    const requestKey = otpData.request_key;
    console.log('✓ OTP initiated successfully.');

    // Step 2: Generate TOTP & Verify
    const totp = generateTOTP(TOTP_KEY);
    console.log(`[2/5] Generated TOTP (${totp}), verifying with Fyers...`);
    const verifyOtpRes = await fetch('https://api-t2.fyers.in/vagator/v2/verify_otp', {
      method: 'POST',
      headers,
      body: JSON.stringify({ request_key: requestKey, otp: totp })
    });
    const verifyOtpData = await verifyOtpRes.json();
    if (!verifyOtpRes.ok || verifyOtpData.s !== 'ok') {
      throw new Error(`TOTP verification failed: ${JSON.stringify(verifyOtpData)}`);
    }
    const updatedRequestKey = verifyOtpData.request_key || requestKey;
    console.log('✓ TOTP verified successfully.');

    // Step 3: Verify PIN
    console.log('[3/5] Verifying PIN...');
    const verifyPinRes = await fetch('https://api-t2.fyers.in/vagator/v2/verify_pin', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        request_key: updatedRequestKey,
        identity_type: 'pin',
        identifier: PIN
      })
    });
    const verifyPinData = await verifyPinRes.json();
    if (!verifyPinRes.ok || verifyPinData.s !== 'ok') {
      throw new Error(`PIN verification failed: ${JSON.stringify(verifyPinData)}`);
    }
    const sessionToken = verifyPinData.data?.access_token || verifyPinData.data?.token;
    if (!sessionToken) {
      throw new Error('PIN verified but session token missing.');
    }
    console.log('✓ PIN verified successfully.');

    // Step 4: Capture Local URI from Fyers Token Endpoint
    console.log(`[4/5] Capturing local URI in headless mode (Redirect URI: ${REDIRECT_URI})...`);
    const tokenRes = await fetch('https://api-t1.fyers.in/api/v3/token', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${sessionToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/plain, */*',
        'Origin': 'https://login.fyers.in',
        'Referer': 'https://login.fyers.in/'
      },
      body: JSON.stringify({
        fyers_id: FY_ID,
        app_id: formattedAppId,
        redirect_uri: REDIRECT_URI,
        appType: APP_TYPE,
        code_challenge: '',
        state: 'fyers_iron_condor_state',
        scope: '',
        nonce: '',
        response_type: 'code',
        create_cookie: true
      })
    });

    const tokenData = await tokenRes.json();
    const localUri = tokenData.Url || tokenData.url || tokenData.data?.Url || tokenData.data?.url;
    if (!localUri) {
      throw new Error(`Local URI was not returned in response: ${JSON.stringify(tokenData)}`);
    }

    console.log('====================================================');
    console.log('CAPTURED LOCAL URI IN HEADLESS MODE:');
    console.log(localUri);
    console.log('====================================================');

    // Step 5: Parse Local URI for Access Code
    const authCode = extractCodeFromUri(localUri);
    if (!authCode) {
      throw new Error('Failed to parse access code (auth_code) from captured local URI.');
    }
    console.log(`[5/5] Extracted Access Code: ${authCode.substring(0, 16)}...`);

    // Sync to Stockboard API
    if (STOCKBOARD_URL) {
      console.log(`Syncing extracted code to Stockboard (${STOCKBOARD_URL})...`);
      try {
        const syncRes = await fetch(`${STOCKBOARD_URL}/api/auth/extract-code`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: localUri, authCode })
        });
        const syncData = await syncRes.json();
        if (syncData.success) {
          console.log('🎉 Successfully synced to Stockboard! Live Fyers session is now active.');
        } else {
          console.warn('Stockboard response:', syncData);
        }
      } catch (syncErr) {
        console.warn('Could not sync to Stockboard directly:', syncErr.message);
      }
    }

    console.log('✅ Headless authentication completed with ZERO UI navigation.');
  } catch (err) {
    console.error('❌ Error during headless auth:', err.message);
  }
}

runHeadlessAuth();
