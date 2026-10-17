import React, { useState, useEffect } from 'react';
import { Sliders, ShieldAlert, Key, Bell, Save, ExternalLink, Check, RefreshCw, Send, Lock, ShieldCheck, DollarSign, Database, CheckCircle2, AlertTriangle, AlertCircle, Trash2, KeyRound, Eye, EyeOff, Copy, Zap } from 'lucide-react';
import { Settings, UserAccessCode } from '../types';
import { User } from '../firebase';
import { saveUserAccessCode, deleteUserAccessCode, syncAccessCodeWithServer, subscribeToUserAccessCode } from '../services/userAccessCodeService';

interface SettingsViewProps {
  settings: Settings | null;
  onSaveSettings: (newSettings: Partial<Settings>) => void;
  isSaving: boolean;
  currentUser?: User | null;
  onOpenAuthModal?: () => void;
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  settings,
  onSaveSettings,
  isSaving,
  currentUser,
  onOpenAuthModal
}) => {
  const [formData, setFormData] = useState<Partial<Settings>>({});
  const [testNotifMsg, setTestNotifMsg] = useState<string>('');
  const [isSyncingFunds, setIsSyncingFunds] = useState<boolean>(false);
  const [syncStatusMsg, setSyncStatusMsg] = useState<string>('');

  // Firestore user access code state
  const [userAccessCode, setUserAccessCode] = useState<UserAccessCode | null>(null);
  const [customAccessToken, setCustomAccessToken] = useState('');
  const [customAuthCode, setCustomAuthCode] = useState('');
  const [isSavingCodeToFirestore, setIsSavingCodeToFirestore] = useState(false);
  const [firestoreMsg, setFirestoreMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [showTokenSecret, setShowTokenSecret] = useState(false);
  const [copiedSettingsLink, setCopiedSettingsLink] = useState(false);
  const [isTriggeringFyers, setIsTriggeringFyers] = useState(false);

  // Fyers connection test & secret visibility state
  const [isTestingFyers, setIsTestingFyers] = useState(false);
  const [fyersTestResult, setFyersTestResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [showFyersSecret, setShowFyersSecret] = useState(false);
  const [copiedCloudUri, setCopiedCloudUri] = useState(false);

  const isOwner = true;

  const handleTestFyersConnection = async () => {
    setIsTestingFyers(true);
    setFyersTestResult(null);
    try {
      const res = await fetch('/api/fyers/test-connection');
      const data = await res.json();
      if (data.connected && data.isLive) {
        setFyersTestResult({
          type: 'success',
          message: `Live Fyers Verified! Connected as: ${data.profile?.display_name || data.profile?.name || data.appId} | Funds: ₹${data.funds?.availableBalance?.toLocaleString('en-IN') || 0}`
        });
      } else {
        setFyersTestResult({
          type: 'error',
          message: `Connection Test: ${data.message || 'Token unverified or expired'}`
        });
      }
    } catch (err: any) {
      setFyersTestResult({
        type: 'error',
        message: err.message || 'Diagnostic request failed'
      });
    } finally {
      setIsTestingFyers(false);
    }
  };

  const handleComputeHash = async () => {
    const rawAppId = (formData.fyersAppId || 'V78VJBA972').trim();
    const appId = rawAppId.includes('-') ? rawAppId : `${rawAppId}-100`;
    const secret = (formData.fyersSecretKey || '').trim();

    // If secret is masked or empty, query backend which stores the unmasked secret
    if (!secret || secret.includes('•')) {
      try {
        const res = await fetch('/api/auth/compute-hash');
        const data = await res.json();
        if (data.success && data.appIdHash) {
          handleChange('fyersAppIdHash', data.appIdHash);
          return;
        }
      } catch (err) {
        // fallback
      }
    }

    if (!secret || secret.includes('•')) {
      alert('Please enter your Fyers Secret Key first to generate the SHA256 App ID Hash');
      return;
    }
    const totpKey = (formData.fyersTotpKey || '').trim();
    if (totpKey && secret.toUpperCase() === totpKey.toUpperCase()) {
      alert('Notice: The Secret Key entered matches your 2FA TOTP Key! Fyers App Secret is found on https://myapi.fyers.in under your App Details (usually 10-12 characters). Please use your App Secret Key to avoid "invalid app id hash" errors.');
    }
    try {
      const strToHash = `${appId}:${secret}`;
      const encoder = new TextEncoder();
      const data = encoder.encode(strToHash);
      const hashBuffer = await window.crypto.subtle.digest('SHA-256', data);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
      handleChange('fyersAppIdHash', hashHex);
    } catch (err) {
      console.error('Hash calculation error:', err);
    }
  };

  useEffect(() => {
    if (!currentUser?.uid) return;
    const unsub = subscribeToUserAccessCode(currentUser.uid, (data) => {
      setUserAccessCode(data);
      if (data?.accessToken && !customAccessToken) {
        setCustomAccessToken(data.accessToken);
      }
      if (data?.accessCode && !customAuthCode) {
        setCustomAuthCode(data.accessCode);
      }
    });
    return () => unsub();
  }, [currentUser?.uid]);

  const handleTriggerAuth = async () => {
    setIsTriggeringFyers(true);
    setFirestoreMsg(null);
    const authWindow = window.open('about:blank', '_blank');
    try {
      const res = await fetch('/api/auth/trigger-auth');
      const data = await res.json();
      const url = data.success && data.authUrl ? data.authUrl : `${window.location.origin}/auth/login`;
      if (authWindow) {
        authWindow.location.href = url;
      } else {
        window.location.href = url;
      }
      setFirestoreMsg({
        type: 'success',
        text: 'Fyers Auth opened in new tab. Log in, copy the redirected URL from your browser address bar, paste it below, and click "Extract & Save Access Code".'
      });
    } catch (e: any) {
      if (authWindow) {
        authWindow.location.href = '/auth/login';
      } else {
        window.location.href = '/auth/login';
      }
    } finally {
      setIsTriggeringFyers(false);
    }
  };

  const handleCopyAuthLink = async () => {
    try {
      const res = await fetch('/api/auth/trigger-auth');
      const data = await res.json();
      const url = data.success && data.authUrl ? data.authUrl : `${window.location.origin}/auth/login`;
      await navigator.clipboard.writeText(url);
      setCopiedSettingsLink(true);
      setTimeout(() => setCopiedSettingsLink(false), 2500);
    } catch (e) {
      await navigator.clipboard.writeText(`${window.location.origin}/auth/login`);
      setCopiedSettingsLink(true);
      setTimeout(() => setCopiedSettingsLink(false), 2500);
    }
  };

  const handleSaveToFirestore = async () => {
    if (!currentUser?.uid) {
      setFirestoreMsg({ type: 'error', text: 'You must be signed in to save an access code to Firestore' });
      return;
    }
    if (!customAccessToken.trim() && !customAuthCode.trim()) {
      setFirestoreMsg({ type: 'error', text: 'Please enter a valid Access Token or Auth Code / Redirect URL' });
      return;
    }

    setIsSavingCodeToFirestore(true);
    setFirestoreMsg(null);
    try {
      let finalAccessToken = customAccessToken.trim();
      let finalAuthCode = customAuthCode.trim();

      // If user pasted a redirect URL or raw auth code in either box, extract and exchange it
      const toExtract = finalAuthCode || (finalAccessToken.includes('http') || finalAccessToken.includes('auth_code=') ? finalAccessToken : '');
      if (toExtract) {
        const res = await fetch('/api/auth/extract-code', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-User-Email': currentUser.email || '',
            'X-User-Id': currentUser.uid
          },
          body: JSON.stringify({ url: toExtract, userId: currentUser.uid, userEmail: currentUser.email })
        });
        const data = await res.json();
        if (data.success && data.auth?.accessToken) {
          finalAccessToken = data.auth.accessToken;
          finalAuthCode = '';
          setCustomAccessToken(finalAccessToken);
          setCustomAuthCode('');
        } else if (!finalAccessToken.startsWith('eyJ')) {
          throw new Error(data.error || 'Failed to extract access token from the provided code or URL');
        }
      }

      const saved = await saveUserAccessCode(currentUser.uid, {
        accessToken: finalAccessToken,
        accessCode: undefined, // Consumed single-use codes should not be persisted
        userEmail: currentUser.email || '',
        source: 'settings_firestore_manager'
      });

      await syncAccessCodeWithServer(saved);

      setFirestoreMsg({
        type: 'success',
        text: `Access code extracted and saved to Firestore under /users/${currentUser.uid}/access_codes/current! Synced with Trading Engine.`
      });
    } catch (err: any) {
      setFirestoreMsg({ type: 'error', text: err.message || 'Failed to save access code' });
    } finally {
      setIsSavingCodeToFirestore(false);
    }
  };

  const handleDeleteFromFirestore = async () => {
    if (!currentUser?.uid) return;
    if (!confirm('Revoke and delete this access code from Firestore?')) return;
    try {
      await deleteUserAccessCode(currentUser.uid);
      await fetch('/api/user/access-code', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: currentUser.uid })
      });
      setCustomAccessToken('');
      setCustomAuthCode('');
      setFirestoreMsg({ type: 'success', text: 'Access code deleted from Firestore and backend.' });
    } catch (err: any) {
      setFirestoreMsg({ type: 'error', text: err.message || 'Failed to delete access code' });
    }
  };

  useEffect(() => {
    if (settings) {
      setFormData(settings);
    }
  }, [settings]);

  const handleChange = (field: keyof Settings, value: any) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  const handleSyncFunds = async () => {
    setIsSyncingFunds(true);
    setSyncStatusMsg('Fetching live funds from FYERS...');
    try {
      const res = await fetch('/api/fyers/funds', {
        headers: { 'X-User-Email': currentUser?.email || '' }
      });
      const data = await res.json();
      if (data.success && data.funds && (data.funds.availableBalance > 0 || data.funds.totalBalance > 0)) {
        const avail = data.funds.availableBalance;
        const total = data.funds.totalBalance || avail;
        const pct = formData.capitalAllocationPct || 100;
        const allocated = Math.round(avail * (pct / 100));

        setFormData(prev => ({
          ...prev,
          fyersAvailableFunds: avail,
          fyersTotalFunds: total,
          capital: allocated
        }));
        setSyncStatusMsg(`Successfully synced: Available ₹${avail.toLocaleString('en-IN')}`);
      } else {
        setSyncStatusMsg(data.error || 'Sync completed (using current stored funds)');
      }
    } catch (err: any) {
      setSyncStatusMsg(`Sync error: ${err.message}`);
    } finally {
      setIsSyncingFunds(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSaveSettings(formData);
  };

  const handleTestNotification = async () => {
    setTestNotifMsg('Sending test notification...');
    try {
      const res = await fetch('/api/notifications/test', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setTestNotifMsg('Test notification sent successfully!');
      } else {
        setTestNotifMsg(`Failed: ${data.error}`);
      }
    } catch (err: any) {
      setTestNotifMsg(`Error: ${err.message}`);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6 pb-12 max-w-5xl mx-auto">
      {/* OWNER STATUS BANNER */}
      {isOwner ? (
        <div className="bg-gradient-to-r from-emerald-950/80 via-slate-900 to-teal-950/80 border border-emerald-500/50 rounded-xl p-3.5 sm:p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs text-emerald-200">
          <div className="flex items-start sm:items-center space-x-2.5 sm:space-x-3 min-w-0">
            <div className="p-1.5 sm:p-2 bg-emerald-500/20 text-emerald-400 rounded-lg border border-emerald-500/30 shrink-0">
              <ShieldCheck className="w-4 h-4 sm:w-5 sm:h-5" />
            </div>
            <div className="min-w-0">
              <p className="font-bold text-xs sm:text-sm text-emerald-300">AUTHORIZED FYERS TRADER</p>
              <p className="text-slate-300 text-[11px] sm:text-xs">Logged in as <strong className="text-emerald-300 font-mono break-all">{currentUser?.email || 'Authorized Owner'}</strong>. You have full authority to view, configure, and operate FYERS API V3 Live Trading &amp; OAuth tokens.</p>
            </div>
          </div>
          <span className="bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 font-bold px-2.5 py-1 rounded-full text-[9px] sm:text-[10px] shrink-0 self-start sm:self-center">
            OWNER FULL ACCESS
          </span>
        </div>
      ) : (
        <div className="bg-gradient-to-r from-amber-950/80 via-slate-900 to-rose-950/80 border border-amber-500/50 rounded-xl p-3.5 sm:p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs text-amber-200">
          <div className="flex items-start sm:items-center space-x-2.5 sm:space-x-3 min-w-0">
            <div className="p-1.5 sm:p-2 bg-amber-500/20 text-amber-400 rounded-lg border border-amber-500/30 shrink-0">
              <Lock className="w-4 h-4 sm:w-5 sm:h-5" />
            </div>
            <div className="min-w-0">
              <p className="font-bold text-xs sm:text-sm text-amber-300">FYERS API CONFIGURATION RESTRICTED</p>
              <p className="text-slate-300 text-[11px] sm:text-xs">
                Logged in as <strong className="text-amber-300 font-mono break-all">{currentUser?.email || 'Guest User'}</strong>. FYERS API credentials and live broker execution are mapped exclusively to <strong className="text-emerald-400 font-mono break-all">sosund@gmail.com</strong>. Your account operates in <strong className="text-amber-300">Paper Trading Sandbox Mode</strong>.
              </p>
            </div>
          </div>
          <span className="bg-amber-500/20 border border-amber-500/40 text-amber-300 font-bold px-2.5 py-1 rounded-full text-[9px] sm:text-[10px] shrink-0 self-start sm:self-center">
            PAPER MODE ONLY
          </span>
        </div>
      )}

      {/* 1. EXECUTION MODE & STRATEGY CONTROL */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between border-b border-slate-800 pb-3">
          <div className="flex items-center space-x-2 text-indigo-400 font-bold text-sm uppercase">
            <Sliders className="w-4 h-4" />
            <span>EXECUTION MODE & STRATEGY PARAMETERS</span>
          </div>
          <span className="text-xs text-slate-500">Short Straddle → Iron Condor Rules</span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
          
          {/* TRADING MODE TOGGLE */}
          <div>
            <label className="block text-slate-300 font-semibold mb-1">TRADING ENVIRONMENT</label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => handleChange('mode', 'PAPER')}
                className={`py-2 px-3 rounded-lg font-bold border text-center transition-all ${
                  formData.mode === 'PAPER' || !isOwner
                    ? 'bg-amber-500/20 text-amber-300 border-amber-500'
                    : 'bg-slate-800 text-slate-400 border-slate-700 hover:bg-slate-750'
                }`}
              >
                PAPER TRADING (Sandbox)
              </button>

              <button
                type="button"
                disabled={!isOwner}
                onClick={() => {
                  if (isOwner) handleChange('mode', 'LIVE');
                }}
                className={`py-2 px-3 rounded-lg font-bold border text-center transition-all ${
                  formData.mode === 'LIVE' && isOwner
                    ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500'
                    : 'bg-slate-800 text-slate-500 border-slate-700 opacity-60 cursor-not-allowed'
                }`}
                title={!isOwner ? 'Live Fyers Trading is restricted to sosund@gmail.com' : ''}
              >
                LIVE FYERS TRADING {!isOwner && '(Restricted)'}
              </button>
            </div>
            <p className="text-[11px] text-slate-500 mt-1">
              {!isOwner
                ? 'Only sosund@gmail.com can enable Live FYERS Execution. Other users run in Paper Sandbox.'
                : 'Paper mode simulates live option tick movement & Golden Rule adjustments risk-free.'}
            </p>
          </div>

          {/* CAPITAL ALLOCATION & CONSUMPTION */}
          <div className="md:col-span-2 bg-slate-950/80 border border-slate-800 rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between border-b border-slate-800 pb-2">
              <span className="font-bold text-slate-200 text-xs uppercase flex items-center gap-1.5">
                <DollarSign className="w-4 h-4 text-emerald-400" />
                DYNAMIC FYERS CAPITAL & CONSUMPTION ALLOCATION
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleSyncFunds}
                  disabled={isSyncingFunds}
                  className="flex items-center gap-1 bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/40 text-emerald-300 px-2.5 py-1 rounded text-[11px] font-semibold transition-all disabled:opacity-50"
                >
                  <RefreshCw className={`w-3 h-3 ${isSyncingFunds ? 'animate-spin' : ''}`} />
                  {isSyncingFunds ? 'Syncing...' : 'Sync Live FYERS Funds'}
                </button>
                <span className="text-[10px] font-mono text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded">
                  REAL-TIME FYERS FUNDS
                </span>
              </div>
            </div>

            {syncStatusMsg && (
              <p className="text-[11px] font-mono text-emerald-300 bg-emerald-950/40 border border-emerald-800/50 p-2 rounded">
                {syncStatusMsg}
              </p>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
              <div className="bg-slate-900 p-2.5 rounded-lg border border-slate-800 space-y-1">
                <label className="text-slate-400 text-[10px] block uppercase font-semibold">FYERS Available Margin (₹)</label>
                <input
                  type="number"
                  step="0.01"
                  value={formData.fyersAvailableFunds !== undefined ? formData.fyersAvailableFunds : (formData.capital || 0)}
                  onChange={(e) => {
                    const val = parseFloat(e.target.value) || 0;
                    handleChange('fyersAvailableFunds', val);
                    const pct = formData.capitalAllocationPct || 100;
                    handleChange('capital', Math.round(val * (pct / 100)));
                  }}
                  className="w-full bg-slate-950 border border-slate-700 focus:border-emerald-500 rounded px-2 py-1 text-emerald-400 font-mono font-bold text-sm"
                  placeholder="0.00"
                />
              </div>

              <div className="bg-slate-900 p-2.5 rounded-lg border border-slate-800">
                <span className="text-slate-400 text-[10px] block uppercase font-semibold">Capital Allocation Limit</span>
                <span className="font-mono font-bold text-indigo-400 text-sm block mt-1">
                  {formData.capitalAllocationPct || 100}%
                </span>
              </div>

              <div className="bg-slate-900 p-2.5 rounded-lg border border-slate-800">
                <span className="text-slate-400 text-[10px] block uppercase font-semibold">Effective Strategy Capital</span>
                <span className="font-mono font-bold text-white text-sm block mt-1">
                  ₹{(Math.round((formData.fyersAvailableFunds !== undefined ? formData.fyersAvailableFunds : (formData.capital || 0)) * ((formData.capitalAllocationPct || 100) / 100))).toLocaleString('en-IN')}
                </span>
              </div>
            </div>

            <div className="space-y-2 pt-1">
              <div className="flex items-center justify-between">
                <label className="text-slate-300 font-semibold">CAPITAL CONSUMPTION / ALLOCATION PERCENTAGE</label>
                <div className="flex space-x-1">
                  {[10, 25, 50, 100].map(pct => (
                    <button
                      key={pct}
                      type="button"
                      onClick={() => handleChange('capitalAllocationPct', pct)}
                      className={`px-2 py-0.5 rounded text-[11px] font-mono font-bold border transition-colors ${
                        (formData.capitalAllocationPct || 100) === pct
                          ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500'
                          : 'bg-slate-800 text-slate-400 border-slate-700 hover:bg-slate-750'
                      }`}
                    >
                      {pct}%
                    </button>
                  ))}
                </div>
              </div>

              <input
                type="range"
                min="5"
                max="100"
                step="5"
                value={formData.capitalAllocationPct || 100}
                onChange={(e) => handleChange('capitalAllocationPct', parseInt(e.target.value, 10))}
                className="w-full accent-emerald-500 bg-slate-800 h-2 rounded-lg cursor-pointer"
              />

              <p className="text-[11px] text-slate-400 leading-relaxed">
                Configure what percentage of available broker capital our strategy engine is allowed to consume (e.g. 10% or 100%). Pre-trade margin checks verify allocated capital before executing any trade.
              </p>
            </div>
          </div>

          {/* STRIKE DISTANCE */}
          <div>
            <label className="block text-slate-300 font-semibold mb-1">STRADDLE STRIKE DISTANCE (OTM PTS)</label>
            <input
              type="number"
              value={formData.strikeDistance || 500}
              onChange={(e) => handleChange('strikeDistance', parseInt(e.target.value, 10))}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg p-2 text-slate-100 font-mono focus:border-indigo-500 outline-none"
            />
            <p className="text-[11px] text-slate-500 mt-1">Default: ±500 points away from spot for Short Straddle/Strangle.</p>
          </div>

          {/* WING BUFFER */}
          <div>
            <label className="block text-slate-300 font-semibold mb-1">WING BUFFER DISTANCE (OTM PTS)</label>
            <input
              type="number"
              value={formData.wingBuffer || 300}
              onChange={(e) => handleChange('wingBuffer', parseInt(e.target.value, 10))}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg p-2 text-slate-100 font-mono focus:border-indigo-500 outline-none"
            />
            <p className="text-[11px] text-slate-500 mt-1">Distance beyond short legs when protective wings are added.</p>
          </div>

          {/* INDEX SYMBOL SELECTOR */}
          <div>
            <label className="block text-slate-300 font-semibold mb-1">TRADING SYMBOL & PRESETS</label>
            <select
              value={formData.indexSymbol || 'NSE:NIFTY50-INDEX'}
              onChange={(e) => {
                const sym = e.target.value;
                let defaultQty = 65;
                if (sym.includes('BANKNIFTY')) defaultQty = 15;
                else if (sym.includes('FINNIFTY')) defaultQty = 25;
                else if (sym.includes('SENSEX')) defaultQty = 10;
                else if (sym.includes('RELIANCE')) defaultQty = 250;
                else if (sym.includes('TCS')) defaultQty = 175;
                
                setFormData(prev => ({ ...prev, indexSymbol: sym, defaultQuantity: defaultQty }));
              }}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg p-2 text-slate-100 font-mono focus:border-indigo-500 outline-none"
            >
              <option value="NSE:NIFTY50-INDEX">NSE:NIFTY50-INDEX (Lot Size: 65)</option>
              <option value="NSE:BANKNIFTY-INDEX">NSE:BANKNIFTY-INDEX (Lot Size: 15)</option>
              <option value="NSE:FINNIFTY-INDEX">NSE:FINNIFTY-INDEX (Lot Size: 25)</option>
              <option value="BSE:SENSEX-INDEX">BSE:SENSEX-INDEX (Lot Size: 10)</option>
              <option value="NSE:RELIANCE-EQ">NSE:RELIANCE-EQ (Lot Size: 250)</option>
              <option value="NSE:TCS-EQ">NSE:TCS-EQ (Lot Size: 175)</option>
            </select>
            <p className="text-[11px] text-slate-500 mt-1">Select index/equity symbol to automatically calculate nearest expiry and lot size.</p>
          </div>

          {/* DEFAULT QUANTITY */}
          <div>
            <label className="block text-slate-300 font-semibold mb-1">STANDARD QUANTITY (CONTRACT QTY)</label>
            <input
              type="number"
              value={formData.defaultQuantity || 65}
              onChange={(e) => handleChange('defaultQuantity', parseInt(e.target.value, 10))}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg p-2 text-slate-100 font-mono focus:border-indigo-500 outline-none"
            />
            <p className="text-[11px] text-slate-500 mt-1">Multiples of standard lot size for the selected symbol.</p>
          </div>
        </div>
      </div>

      {/* 2. RISK MANAGEMENT LIMITS */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between border-b border-slate-800 pb-3">
          <div className="flex items-center space-x-2 text-rose-400 font-bold text-sm uppercase">
            <ShieldAlert className="w-4 h-4" />
            <span>HARD RISK MANAGEMENT CAP & LIMITS</span>
          </div>
          <span className="text-xs text-slate-500">Automated Circuit Breaker</span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
          <div>
            <label className="block text-slate-300 font-semibold mb-1">MONTHLY MAX LOSS CAP (%)</label>
            <input
              type="number"
              value={formData.monthlyMaxLossPct || 5}
              onChange={(e) => handleChange('monthlyMaxLossPct', parseFloat(e.target.value))}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg p-2 text-slate-100 font-mono focus:border-indigo-500 outline-none"
            />
            <p className="text-[11px] text-slate-500 mt-1">If monthly loss touches 5% (₹{(formData.capital || 500000) * 0.05}), all trading pauses.</p>
          </div>

          <div>
            <label className="block text-slate-300 font-semibold mb-1">PER-TRADE MAX RISK CAP (%)</label>
            <input
              type="number"
              value={formData.perTradeMaxLossPct || 2}
              onChange={(e) => handleChange('perTradeMaxLossPct', parseFloat(e.target.value))}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg p-2 text-slate-100 font-mono focus:border-indigo-500 outline-none"
            />
            <p className="text-[11px] text-slate-500 mt-1">Single trade estimated risk cannot exceed 2% of capital.</p>
          </div>
        </div>
      </div>

      {/* 2.5 FIRESTORE PERSISTENT STORAGE: USER ACCESS CODE */}
      <div className="bg-slate-900 border border-indigo-500/30 rounded-xl p-5 space-y-4 relative overflow-hidden shadow-lg shadow-indigo-950/20">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between border-b border-slate-800 pb-3 gap-2">
          <div className="flex items-center space-x-2 text-indigo-400 font-bold text-sm uppercase">
            <Database className="w-4 h-4 text-indigo-400" />
            <span>FIRESTORE PERSISTENT STORAGE: USER ACCESS CODE</span>
          </div>
          <div className="flex items-center space-x-2">
            <span className="text-[11px] font-mono bg-indigo-500/10 text-indigo-300 border border-indigo-500/20 px-2.5 py-0.5 rounded">
              Firestore DB: Active
            </span>
          </div>
        </div>

        {firestoreMsg && (
          <div className={`p-3 rounded-lg border text-xs font-semibold flex items-center space-x-2 ${
            firestoreMsg.type === 'success'
              ? 'bg-emerald-950/50 text-emerald-300 border-emerald-800/50'
              : 'bg-rose-950/50 text-rose-300 border-rose-800/50'
          }`}>
            {firestoreMsg.type === 'success' ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertTriangle className="w-4 h-4 shrink-0" />}
            <span>{firestoreMsg.text}</span>
          </div>
        )}

        <div className="bg-slate-950/60 p-4 rounded-xl border border-slate-800/80 space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
            <div className="space-y-1">
              <div className="text-slate-400">
                Logged in Account: <span className="text-indigo-300 font-mono font-bold">{currentUser?.email || 'Not Logged In'}</span>
              </div>
              <div className="text-[11px] text-slate-500 font-mono">
                Firestore Document Path: /users/{currentUser?.uid || '{userId}'}/access_codes/current
              </div>
            </div>

            <div className="flex items-center space-x-2">
              {userAccessCode?.accessToken ? (
                <div className="flex items-center space-x-1.5 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-2.5 py-1 rounded text-xs font-mono">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>STORED IN FIRESTORE ({userAccessCode.isValid ? 'VALID' : 'EXPIRED'})</span>
                </div>
              ) : (
                <div className="flex items-center space-x-1.5 bg-amber-500/10 text-amber-400 border border-amber-500/20 px-2.5 py-1 rounded text-xs font-mono">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  <span>NO ACCESS CODE IN FIRESTORE</span>
                </div>
              )}
            </div>
          </div>

          {userAccessCode?.expiresAt && (
            <div className="text-[11px] text-slate-400 font-mono flex items-center justify-between border-t border-slate-800/60 pt-2">
              <span>Token Expiry: {new Date(userAccessCode.expiresAt).toLocaleString('en-IN')}</span>
              <span>Updated: {userAccessCode.updatedAt ? new Date(userAccessCode.updatedAt).toLocaleTimeString() : 'N/A'}</span>
            </div>
          )}
        </div>

        {/* 1-Click Trigger & Copy Link for extracting access code */}
        <div className="bg-slate-950/60 p-3.5 rounded-lg border border-indigo-500/20 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="text-xs">
            <div className="font-semibold text-slate-200 flex items-center space-x-1.5">
              <Key className="w-3.5 h-3.5 text-indigo-400" />
              <span>Step 1: Trigger Fyers Auth &amp; Copy Link</span>
            </div>
            <p className="text-slate-400 text-[11px] mt-0.5">
              Launch official Fyers login or copy the link to any browser. Log in, then copy the address bar link.
            </p>
          </div>

          <div className="flex items-center space-x-2 shrink-0">
            <button
              type="button"
              onClick={handleTriggerAuth}
              disabled={isTriggeringFyers}
              className="inline-flex items-center space-x-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-semibold text-xs px-3 py-1.5 rounded-lg transition-colors shadow-sm"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              <span>{isTriggeringFyers ? 'Opening...' : 'Trigger Fyers Auth'}</span>
            </button>

            <button
              type="button"
              onClick={handleCopyAuthLink}
              className="inline-flex items-center space-x-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold text-xs px-3 py-1.5 rounded-lg border border-slate-700 transition-colors"
            >
              {copiedSettingsLink ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5 text-indigo-400" />}
              <span>{copiedSettingsLink ? 'Copied Link!' : 'Copy Auth Link'}</span>
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
          <div>
            <label className="block text-slate-300 font-semibold mb-1">STEP 2: PASTE REDIRECT URL OR AUTH CODE</label>
            <input
              type="text"
              value={customAuthCode}
              onChange={(e) => setCustomAuthCode(e.target.value)}
              placeholder="https://127.0.0.1:6414/?s=ok&auth_code=... or raw code"
              className="w-full bg-slate-800 border border-slate-700 rounded-lg p-2.5 text-slate-100 font-mono focus:border-indigo-500 outline-none"
            />
            <p className="text-[11px] text-slate-500 mt-1">Backend automatically extracts the code, requests the token from Fyers, and saves to Firestore.</p>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-slate-300 font-semibold">DIRECT 24H ACCESS TOKEN (OPTIONAL / AUTO-FILLED)</label>
              <button
                type="button"
                onClick={() => setShowTokenSecret(!showTokenSecret)}
                className="text-slate-400 hover:text-indigo-400 flex items-center space-x-1 text-[11px]"
              >
                {showTokenSecret ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                <span>{showTokenSecret ? 'Hide' : 'Show'}</span>
              </button>
            </div>
            <input
              type={showTokenSecret ? 'text' : 'password'}
              value={customAccessToken}
              onChange={(e) => setCustomAccessToken(e.target.value)}
              placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
              className="w-full bg-slate-800 border border-slate-700 rounded-lg p-2.5 text-slate-100 font-mono focus:border-indigo-500 outline-none"
            />
            <p className="text-[11px] text-slate-500 mt-1">Directly paste your FYERS V3 JWT access token if you already generated one.</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
          <div className="flex items-center space-x-2">
            <button
              type="button"
              onClick={handleSaveToFirestore}
              disabled={isSavingCodeToFirestore}
              className="flex items-center space-x-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-semibold text-xs px-4 py-2 rounded-lg transition-colors shadow-sm"
            >
              <KeyRound className="w-3.5 h-3.5" />
              <span>{isSavingCodeToFirestore ? 'Extracting & Saving to Firestore...' : 'Extract Access Code & Save to Firestore'}</span>
            </button>

            {userAccessCode?.accessToken && (
              <button
                type="button"
                onClick={() => syncAccessCodeWithServer(userAccessCode)}
                className="flex items-center space-x-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold text-xs px-3.5 py-2 rounded-lg transition-colors border border-slate-700"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>Sync with Engine</span>
              </button>
            )}
          </div>

          {userAccessCode?.accessToken && (
            <button
              type="button"
              onClick={handleDeleteFromFirestore}
              className="flex items-center space-x-1.5 text-rose-400 hover:text-rose-300 hover:bg-rose-950/40 border border-rose-900/40 text-xs px-3 py-2 rounded-lg transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Revoke from Firestore</span>
            </button>
          )}
        </div>
      </div>

      {/* 3. FYERS API OAUTH & KEYS */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4 relative overflow-hidden">
        {!isOwner && (
          <div className="bg-slate-950/80 backdrop-blur-xs p-3 rounded-lg border border-amber-500/30 text-amber-300 text-xs flex items-center justify-between mb-2">
            <div className="flex items-center space-x-2">
              <Lock className="w-4 h-4 text-amber-400 shrink-0" />
              <span>FYERS credentials are locked. Only <strong>sosund@gmail.com</strong> can view or edit FYERS API keys.</span>
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between border-b border-slate-800 pb-3 gap-2">
          <div className="flex items-center space-x-2 text-emerald-400 font-bold text-sm uppercase">
            <Key className="w-4 h-4" />
            <span>FYERS API V3 CREDENTIALS & OAUTH FLOW</span>
          </div>

          <div className="flex items-center space-x-2">
            <button
              type="button"
              onClick={handleTestFyersConnection}
              disabled={isTestingFyers}
              className="flex items-center space-x-1 bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold text-xs px-3 py-1.5 rounded-lg border border-slate-700 transition-colors cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 text-indigo-400 ${isTestingFyers ? 'animate-spin' : ''}`} />
              <span>{isTestingFyers ? 'Testing Connection...' : 'Test Connection'}</span>
            </button>

            {isOwner ? (
              <button
                type="button"
                onClick={() => {
                  if (onOpenAuthModal) {
                    onOpenAuthModal();
                  } else {
                    window.open('/api/auth/trigger-auth', '_blank');
                  }
                }}
                className="flex items-center space-x-1.5 bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs px-3 py-1.5 rounded-lg transition-colors cursor-pointer shadow-sm"
                title="Open Fyers Live Broker Authorization"
              >
                <Zap className="w-3.5 h-3.5 text-amber-300 fill-amber-300" />
                <span>Authenticate Fyers OAuth</span>
              </button>
            ) : (
              <span className="text-[11px] font-bold text-slate-500 bg-slate-800 px-2.5 py-1 rounded border border-slate-700">
                OAuth Restricted to sosund@gmail.com
              </span>
            )}
          </div>
        </div>

        {fyersTestResult && (
          <div className={`p-3 rounded-lg border text-xs font-semibold ${
            fyersTestResult.type === 'success'
              ? 'bg-emerald-950/40 text-emerald-300 border-emerald-800/50'
              : 'bg-rose-950/40 text-rose-300 border-rose-800/50'
          }`}>
            {fyersTestResult.message}
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 text-xs">
          <div>
            <label className="block text-slate-300 font-semibold mb-1">FYERS CLIENT ID (FY ID)</label>
            <input
              type="text"
              disabled={!isOwner}
              value={formData.fyId || ''}
              onChange={(e) => handleChange('fyId', e.target.value)}
              placeholder="XS06414"
              className="w-full bg-slate-800 border border-slate-700 rounded-lg p-2 text-slate-100 font-mono focus:border-indigo-500 outline-none disabled:opacity-50 disabled:cursor-not-allowed"
            />
          </div>

          <div>
            <label className="block text-slate-300 font-semibold mb-1">FYERS APP ID</label>
            <input
              type="text"
              disabled={!isOwner}
              value={formData.fyersAppId || ''}
              onChange={(e) => handleChange('fyersAppId', e.target.value)}
              placeholder="V78VJBA972"
              className="w-full bg-slate-800 border border-slate-700 rounded-lg p-2 text-slate-100 font-mono focus:border-indigo-500 outline-none disabled:opacity-50 disabled:cursor-not-allowed"
            />
            <span className="text-[10px] text-slate-500 mt-0.5 block">App ID suffix (-100) is handled automatically.</span>
          </div>

          <div>
            <label className="block text-slate-300 font-semibold mb-1">FYERS SECRET KEY</label>
            <div className="relative">
              <input
                type={showFyersSecret ? 'text' : 'password'}
                disabled={!isOwner}
                value={formData.fyersSecretKey || ''}
                onChange={(e) => handleChange('fyersSecretKey', e.target.value)}
                placeholder="e.g. XNS7DQJFNR (App Secret from myapi.fyers.in -> App Details)"
                className="w-full bg-slate-800 border border-slate-700 rounded-lg p-2 pr-9 text-slate-100 font-mono focus:border-indigo-500 outline-none disabled:opacity-50 disabled:cursor-not-allowed text-xs"
              />
              <button
                type="button"
                onClick={() => setShowFyersSecret(!showFyersSecret)}
                className="absolute right-2 top-2 text-slate-400 hover:text-slate-200"
              >
                {showFyersSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            <span className="text-[10px] text-slate-500 mt-0.5 block">Used with App ID to compute SHA256 App ID Hash during OAuth exchange.</span>
            {formData.fyersSecretKey && formData.fyersTotpKey && formData.fyersSecretKey.trim().toUpperCase() === formData.fyersTotpKey.trim().toUpperCase() && (
              <div className="mt-2 p-2.5 bg-amber-950/70 border border-amber-500/60 rounded-lg text-[11px] text-amber-200 space-y-1">
                <div className="font-bold flex items-center gap-1 text-amber-300">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                  <span>Notice: Secret Key matches your 2FA TOTP Key!</span>
                </div>
                <p className="leading-relaxed">
                  Fyers App Secret Key is found on <a href="https://myapi.fyers.in" target="_blank" rel="noreferrer" className="underline font-bold text-white hover:text-indigo-200">myapi.fyers.in</a> under <strong>App Details</strong> (usually 10-12 characters), NOT your Google Authenticator key. Using the TOTP key causes Fyers to reject auth codes with <code>invalid app id hash</code>.
                </p>
              </div>
            )}
          </div>

          <div>
            <label className="block text-slate-300 font-semibold mb-1">FYERS APP TYPE</label>
            <input
              type="text"
              disabled={!isOwner}
              value={formData.fyersAppType || '100'}
              onChange={(e) => handleChange('fyersAppType', e.target.value)}
              placeholder="100"
              className="w-full bg-slate-800 border border-slate-700 rounded-lg p-2 text-slate-100 font-mono focus:border-indigo-500 outline-none disabled:opacity-50 disabled:cursor-not-allowed"
            />
          </div>

          <div>
            <label className="block text-slate-300 font-semibold mb-1">APP ID TYPE</label>
            <input
              type="text"
              disabled={!isOwner}
              value={formData.fyersAppIdType || '2'}
              onChange={(e) => handleChange('fyersAppIdType', e.target.value)}
              placeholder="2"
              className="w-full bg-slate-800 border border-slate-700 rounded-lg p-2 text-slate-100 font-mono focus:border-indigo-500 outline-none disabled:opacity-50 disabled:cursor-not-allowed"
            />
          </div>

          <div>
            <label className="block text-slate-300 font-semibold mb-1">TOTP KEY (2FA AUTHENTICATOR SECRET)</label>
            <input
              type="password"
              disabled={!isOwner}
              value={formData.fyersTotpKey || ''}
              onChange={(e) => handleChange('fyersTotpKey', e.target.value)}
              placeholder="Base32 key from Fyers 2FA QR code (e.g. JBSWY3DPEHPK3PXP)"
              className="w-full bg-slate-800 border border-slate-700 rounded-lg p-2 text-slate-100 font-mono focus:border-indigo-500 outline-none disabled:opacity-50 disabled:cursor-not-allowed text-xs"
            />
            <p className="text-[10px] text-amber-400 mt-1 leading-tight">
              ⚠️ Note: This is your <strong>Google Authenticator / 2FA Secret Key</strong> from Fyers Account Profile (NOT your App Secret Key).
            </p>
          </div>

          <div>
            <label className="block text-slate-300 font-semibold mb-1">FYERS PIN</label>
            <input
              type="password"
              disabled={!isOwner}
              value={formData.fyersPin || ''}
              onChange={(e) => handleChange('fyersPin', e.target.value)}
              placeholder="6479"
              className="w-full bg-slate-800 border border-slate-700 rounded-lg p-2 text-slate-100 font-mono focus:border-indigo-500 outline-none disabled:opacity-50 disabled:cursor-not-allowed"
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-slate-300 font-semibold">REDIRECT URI</label>
              <div className="flex items-center space-x-1.5">
                <button
                  type="button"
                  onClick={() => {
                    handleChange('fyersRedirectUri', 'https://127.0.0.1:6414');
                  }}
                  className="text-[10px] font-bold text-indigo-300 hover:text-indigo-200 bg-indigo-500/10 hover:bg-indigo-500/20 px-2 py-0.5 rounded border border-indigo-500/30 transition-colors"
                  title="Reset to registered Fyers local default URI"
                >
                  Reset Default (127.0.0.1:6414)
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const cloudUri = `${window.location.origin}/auth/callback`;
                    handleChange('fyersRedirectUri', cloudUri);
                    navigator.clipboard.writeText(cloudUri);
                    setCopiedCloudUri(true);
                    setTimeout(() => setCopiedCloudUri(false), 2500);
                  }}
                  className="text-[10px] font-bold text-emerald-400 hover:text-emerald-300 bg-emerald-500/10 hover:bg-emerald-500/20 px-2 py-0.5 rounded border border-emerald-500/30 transition-colors flex items-center space-x-1"
                  title="Auto-fill Cloud Callback URI (Requires registration on myapi.fyers.in)"
                >
                  <Zap className="w-3 h-3 text-amber-300 fill-amber-300" />
                  <span>{copiedCloudUri ? 'Copied & Set!' : 'Set Cloud URI'}</span>
                </button>
              </div>
            </div>
            <input
              type="text"
              disabled={!isOwner}
              value={formData.fyersRedirectUri || ''}
              onChange={(e) => handleChange('fyersRedirectUri', e.target.value)}
              placeholder="https://127.0.0.1:6414"
              className="w-full bg-slate-800 border border-slate-700 rounded-lg p-2 text-slate-100 font-mono focus:border-indigo-500 outline-none disabled:opacity-50 disabled:cursor-not-allowed text-xs"
            />
            {formData.fyersRedirectUri?.includes('/auth/callback') ? (
              <p className="text-[10px] text-amber-400 mt-1 leading-normal">
                ⚠️ <strong>401 Warning:</strong> You must register this exact Cloud URL on <a href="https://myapi.fyers.in" target="_blank" rel="noreferrer" className="text-white underline font-semibold">myapi.fyers.in</a> under Redirect URL. If not registered, Fyers returns 401 Invalid Client. If in doubt, click "Reset Default (127.0.0.1:6414)" above.
              </p>
            ) : (
              <p className="text-[10px] text-slate-400 mt-1 leading-normal">
                Default for registered Fyers apps: <code className="text-emerald-300 font-mono">https://127.0.0.1:6414</code>. Matches Fyers API developer specifications.
              </p>
            )}
          </div>

          <div className="md:col-span-2">
            <div className="flex items-center justify-between mb-1">
              <label className="block text-slate-300 font-semibold">APP ID HASH (SHA256)</label>
              <button
                type="button"
                onClick={handleComputeHash}
                className="text-[11px] font-semibold text-indigo-400 hover:text-indigo-300 bg-indigo-500/10 hover:bg-indigo-500/20 px-2 py-0.5 rounded border border-indigo-500/30 transition-colors"
                title="Generate SHA256(AppId-100:SecretKey)"
              >
                Compute Hash from Secret
              </button>
            </div>
            <input
              type="text"
              disabled={!isOwner}
              value={formData.fyersAppIdHash || ''}
              onChange={(e) => handleChange('fyersAppIdHash', e.target.value)}
              placeholder="e0ee131e5612dd... (auto-computed from App ID + Secret Key)"
              className="w-full bg-slate-800 border border-slate-700 rounded-lg p-2 text-slate-100 font-mono focus:border-indigo-500 outline-none disabled:opacity-50 disabled:cursor-not-allowed text-xs"
            />
            <p className="text-[10px] text-slate-400 mt-1">
              Fyers API v3 requires <code className="text-indigo-300">SHA256(AppId-100:SecretKey)</code> to validate authorization codes. Stockboard automatically calculates and syncs this.
            </p>
          </div>
        </div>
      </div>

      {/* 4. TELEGRAM / SLACK NOTIFICATIONS */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between border-b border-slate-800 pb-3">
          <div>
            <div className="flex items-center space-x-2 text-amber-400 font-bold text-sm uppercase">
              <Bell className="w-4 h-4" />
              <span>NOTIFICATIONS (TELEGRAM & SLACK)</span>
              <span className="bg-slate-800 text-slate-400 border border-slate-700 text-[10px] font-normal px-2 py-0.5 rounded">
                OPTIONAL
              </span>
            </div>
            <p className="text-[11px] text-slate-400 mt-0.5">
              Notifications are optional. Trading & strategy scanning operates 100% autonomously without them.
            </p>
          </div>

          <button
            type="button"
            onClick={handleTestNotification}
            className="flex items-center space-x-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs px-3 py-1.5 rounded-lg border border-slate-700 transition-colors shrink-0"
          >
            <Send className="w-3.5 h-3.5" />
            <span>Send Test Alert</span>
          </button>
        </div>

        {testNotifMsg && (
          <p className="text-xs font-mono text-amber-400 bg-amber-950/30 p-2 rounded border border-amber-800/50">
            {testNotifMsg}
          </p>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
          <div>
            <label className="block text-slate-300 font-semibold mb-1">
              TELEGRAM BOT TOKEN <span className="text-[10px] text-slate-500 font-normal">(Optional)</span>
            </label>
            <input
              type="text"
              value={formData.telegramBotToken || ''}
              onChange={(e) => handleChange('telegramBotToken', e.target.value)}
              placeholder="123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ (Optional)"
              className="w-full bg-slate-800 border border-slate-700 rounded-lg p-2 text-slate-100 font-mono focus:border-indigo-500 outline-none"
            />
          </div>

          <div>
            <label className="block text-slate-300 font-semibold mb-1">
              TELEGRAM CHAT ID <span className="text-[10px] text-slate-500 font-normal">(Optional)</span>
            </label>
            <input
              type="text"
              value={formData.telegramChatId || ''}
              onChange={(e) => handleChange('telegramChatId', e.target.value)}
              placeholder="-100123456789 (Optional)"
              className="w-full bg-slate-800 border border-slate-700 rounded-lg p-2 text-slate-100 font-mono focus:border-indigo-500 outline-none"
            />
          </div>

          <div className="md:col-span-2">
            <label className="block text-slate-300 font-semibold mb-1">
              SLACK WEBHOOK URL <span className="text-[10px] text-slate-500 font-normal">(Optional)</span>
            </label>
            <input
              type="text"
              value={formData.slackWebhookUrl || ''}
              onChange={(e) => handleChange('slackWebhookUrl', e.target.value)}
              placeholder="https://hooks.slack.com/services/T000/B000/XXXX"
              className="w-full bg-slate-800 border border-slate-700 rounded-lg p-2 text-slate-100 font-mono focus:border-indigo-500 outline-none"
            />
          </div>
        </div>
      </div>

      {/* SAVE BUTTON */}
      <div className="flex justify-end pt-2">
        <button
          type="submit"
          disabled={isSaving}
          className="flex items-center space-x-2 bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-sm px-6 py-3 rounded-xl shadow-lg shadow-indigo-600/30 transition-all"
        >
          <Save className="w-4 h-4" />
          <span>{isSaving ? 'Saving Configuration...' : 'Save All Settings'}</span>
        </button>
      </div>

    </form>
  );
};
