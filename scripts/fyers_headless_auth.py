#!/usr/bin/env python3
"""
FYERS Headless Auth Companion Script (Python 3)

Performs automated headless authentication:
1. Initiates login OTP
2. Generates TOTP code & verifies OTP
3. Verifies 4-digit PIN
4. Requests token endpoint in headless mode
5. Captures the redirected local URI directly from response JSON (Url field)
6. Parses the local URI to extract the access code (auth_code) without UI navigation
7. Exchanges access code or syncs to Stockboard API

Usage:
    pip install requests pyotp
    python3 scripts/fyers_headless_auth.py
Or with environment variables:
    FY_ID=... FYERS_TOTP_KEY=... FYERS_PIN=... FYERS_APP_ID=... python3 scripts/fyers_headless_auth.py
"""

import os
import sys
import json
import urllib.parse

try:
    import requests
except ImportError:
    print("Please install requests: pip install requests")
    sys.exit(1)

try:
    import pyotp
except ImportError:
    print("Please install pyotp: pip install pyotp")
    sys.exit(1)

FY_ID = os.getenv("FY_ID") or os.getenv("FYERS_CLIENT_ID") or ""
TOTP_KEY = os.getenv("FYERS_TOTP_KEY") or ""
PIN = os.getenv("FYERS_PIN") or ""
APP_ID = os.getenv("FYERS_APP_ID") or ""
APP_TYPE = os.getenv("FYERS_APP_TYPE") or "100"
REDIRECT_URI = os.getenv("FYERS_REDIRECT_URI") or "https://127.0.0.1:6414"
STOCKBOARD_URL = os.getenv("STOCKBOARD_URL") or "https://ais-dev-q24gpmg5htl2mfszzrnchs-824420889987.asia-southeast1.run.app"

def main():
    print("====================================================")
    print("  FYERS HEADLESS AUTHENTICATION & CODE EXTRACTOR    ")
    print("====================================================")

    if not FY_ID or not TOTP_KEY or not PIN:
        print("Usage: Set FY_ID, FYERS_TOTP_KEY, FYERS_PIN environment variables.")
        print("Example:")
        print("  export FY_ID='XXXXX'")
        print("  export FYERS_TOTP_KEY='YYYYY'")
        print("  export FYERS_PIN='1234'")
        print("  export FYERS_APP_ID='ZZZZZ'")
        print("  python3 scripts/fyers_headless_auth.py")
        sys.exit(1)

    formatted_app_id = APP_ID if "-" in APP_ID else f"{APP_ID}-{APP_TYPE}"
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/plain, */*",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        "Origin": "https://login.fyers.in",
        "Referer": "https://login.fyers.in/"
    }

    session = requests.Session()

    # Step 1: Send Login OTP
    print(f"[1/5] Initiating login OTP for {FY_ID}...")
    res = session.post(
        "https://api-t2.fyers.in/vagator/v2/send_login_otp",
        headers=headers,
        json={"fy_id": FY_ID, "app_id": "2"}
    )
    otp_data = res.json()
    if not res.ok or not otp_data.get("request_key"):
        print(f"Failed to initiate OTP: {otp_data}")
        sys.exit(1)
    request_key = otp_data["request_key"]
    print("✓ OTP initiated successfully.")

    # Step 2: Generate TOTP & Verify
    totp = pyotp.TOTP(TOTP_KEY.replace(" ", "")).now()
    print(f"[2/5] Generated TOTP ({totp}), verifying with Fyers...")
    res = session.post(
        "https://api-t2.fyers.in/vagator/v2/verify_otp",
        headers=headers,
        json={"request_key": request_key, "otp": totp}
    )
    verify_otp_data = res.json()
    if not res.ok or verify_otp_data.get("s") != "ok":
        print(f"Failed to verify TOTP: {verify_otp_data}")
        sys.exit(1)
    updated_request_key = verify_otp_data.get("request_key", request_key)
    print("✓ TOTP verified successfully.")

    # Step 3: Verify PIN
    print("[3/5] Verifying PIN...")
    res = session.post(
        "https://api-t2.fyers.in/vagator/v2/verify_pin",
        headers=headers,
        json={
            "request_key": updated_request_key,
            "identity_type": "pin",
            "identifier": str(PIN)
        }
    )
    verify_pin_data = res.json()
    if not res.ok or verify_pin_data.get("s") != "ok":
        print(f"Failed to verify PIN: {verify_pin_data}")
        sys.exit(1)

    pin_data = verify_pin_data.get("data", {})
    session_token = pin_data.get("access_token") or pin_data.get("token")
    if not session_token:
        print("Session token not found in verify_pin response.")
        sys.exit(1)
    print("✓ PIN verified successfully.")

    # Step 4: Capture Local URI from Fyers Token Endpoint
    print(f"[4/5] Capturing local URI in headless mode (Redirect URI: {REDIRECT_URI})...")
    token_headers = headers.copy()
    token_headers["Authorization"] = f"Bearer {session_token}"
    token_payload = {
        "fyers_id": FY_ID,
        "app_id": formatted_app_id,
        "redirect_uri": REDIRECT_URI,
        "appType": APP_TYPE,
        "code_challenge": "",
        "state": "fyers_iron_condor_state",
        "scope": "",
        "nonce": "",
        "response_type": "code",
        "create_cookie": True
    }

    res = session.post(
        "https://api-t1.fyers.in/api/v3/token",
        headers=token_headers,
        json=token_payload
    )
    token_data = res.json()
    local_uri = token_data.get("Url") or token_data.get("url") or token_data.get("data", {}).get("Url")
    if not local_uri:
        print(f"Could not capture local URI from response: {token_data}")
        sys.exit(1)

    print("====================================================")
    print("CAPTURED LOCAL URI IN HEADLESS MODE:")
    print(local_uri)
    print("====================================================")

    # Step 5: Parse Local URI for Access Code
    parsed_url = urllib.parse.urlparse(local_uri)
    query_params = urllib.parse.parse_qs(parsed_url.query)
    auth_code_list = query_params.get("auth_code") or query_params.get("code")
    if not auth_code_list:
        print("Failed to parse access code (auth_code) from captured local URI.")
        sys.exit(1)

    auth_code = auth_code_list[0]
    print(f"[5/5] Extracted Access Code: {auth_code[:16]}...")

    # Sync to Stockboard API
    if STOCKBOARD_URL:
        print(f"Syncing extracted code to Stockboard ({STOCKBOARD_URL})...")
        try:
            sync_res = session.post(
                f"{STOCKBOARD_URL}/api/auth/extract-code",
                json={"url": local_uri, "authCode": auth_code}
            )
            sync_data = sync_res.json()
            if sync_data.get("success"):
                print("🎉 Successfully synced to Stockboard! Live Fyers session is now active.")
            else:
                print(f"Stockboard response: {sync_data}")
        except Exception as ex:
            print(f"Could not sync to Stockboard directly: {ex}")

    print("✅ Headless authentication completed with ZERO UI navigation.")

if __name__ == "__main__":
    main()
