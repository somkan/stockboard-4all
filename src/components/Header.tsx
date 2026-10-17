import React, { useState, useEffect, useRef } from 'react';
import { 
  ShieldAlert, 
  Activity, 
  CheckCircle2, 
  AlertCircle, 
  RefreshCw, 
  Bot, 
  Sliders, 
  FileText, 
  Layers, 
  Terminal,
  Zap,
  Play,
  Pause,
  X,
  ExternalLink,
  Key,
  BarChart2,
  LogOut,
  Sun,
  Moon,
  User as UserIcon,
  Database,
  Copy,
  Check,
  ClipboardPaste,
  Sparkles,
  ArrowRight,
  Radio,
  Globe,
  ChevronDown,
  ChevronUp,
  Hash,
  Lock,
  Compass
} from 'lucide-react';
import { Settings, UserAccessCode } from '../types';
import { User } from '../firebase';
import { saveUserAccessCode } from '../services/userAccessCodeService';

interface HeaderProps {
  activeTab: string;
  setActiveTab: (tab: string) => void;
  settings: Settings | null;
  authStatus: { isValid: boolean; mode: string; message: string; profile?: any } | null;
  onRefresh: () => void;
  onToggleAutoTrading: () => void;
  onToggleMode?: (targetMode?: 'LIVE' | 'PAPER') => void;
  isRefreshing: boolean;
  currentUser?: User | null;
  userAccessCode?: UserAccessCode | null;
  onSignOut?: () => void;
  theme?: 'dark' | 'light';
  onToggleTheme?: () => void;
  showAuthModal?: boolean;
  setShowAuthModal?: (show: boolean) => void;
}

export const Header: React.FC<HeaderProps> = ({
  activeTab,
  setActiveTab,
  settings,
  authStatus,
  onRefresh,
  onToggleAutoTrading,
  onToggleMode,
  isRefreshing,
  currentUser,
  userAccessCode,
  onSignOut,
  theme = 'dark',
  onToggleTheme,
  showAuthModal: propShowAuthModal,
  setShowAuthModal: propSetShowAuthModal
}) => {
  const isPaper = settings?.mode === 'PAPER';
  const isAuto = settings?.autoTradingEnabled;

  const [internalShowAuthModal, setInternalShowAuthModal] = useState(false);
  const showAuthModal = propShowAuthModal !== undefined ? propShowAuthModal : internalShowAuthModal;
  const setShowAuthModal = propSetShowAuthModal || setInternalShowAuthModal;
  const [authCodeInput, setAuthCodeInput] = useState('');
  const [accessTokenInput, setAccessTokenInput] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [authMsg, setAuthMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [authUrl, setAuthUrl] = useState('');
  const [copiedLink, setCopiedLink] = useState(false);
  const [isTriggering, setIsTriggering] = useState(false);
  const [detectedItem, setDetectedItem] = useState<{ type: string; val: string } | null>(null);
  const [authMode, setAuthMode] = useState<'cloud' | 'local'>('local');
  const [selectedRedirectUri, setSelectedRedirectUri] = useState<string>('https://127.0.0.1:6414');
  const [authLinkMetadata, setAuthLinkMetadata] = useState<{ appId?: string; activeRedirectUri?: string } | null>(null);
  const [copiedCloudUri, setCopiedCloudUri] = useState(false);
  const [isSavingRedirect, setIsSavingRedirect] = useState(false);
  const [isWaitingForLogin, setIsWaitingForLogin] = useState(false);
  const [modalSecretKey, setModalSecretKey] = useState('');
  const [modalAppIdHash, setModalAppIdHash] = useState('');
  const [showCredentialsSection, setShowCredentialsSection] = useState(false);
  const [isComputingModalHash, setIsComputingModalHash] = useState(false);
  const pollingRef = useRef<NodeJS.Timeout | null>(null);

  const cloudCallbackUri = typeof window !== 'undefined' ? `${window.location.origin}/auth/callback` : '';

  const isTotpMistakenForSecret = Boolean(
    (modalSecretKey || settings?.fyersSecretKey) &&
    settings?.fyersTotpKey &&
    (modalSecretKey || settings?.fyersSecretKey || '').trim().toUpperCase() === (settings?.fyersTotpKey || '').trim().toUpperCase()
  );

  // Synchronize credentials when modal opens or settings update
  useEffect(() => {
    if (showAuthModal) {
      if (settings?.fyersSecretKey) setModalSecretKey(settings.fyersSecretKey);
      if (settings?.fyersAppIdHash) setModalAppIdHash(settings.fyersAppIdHash);
      if (isTotpMistakenForSecret) setShowCredentialsSection(true);
    }
  }, [showAuthModal, settings?.fyersSecretKey, settings?.fyersAppIdHash, isTotpMistakenForSecret]);

  // Synchronize initial mode and redirect preset from saved settings (always ensure registered local URI by default)
  useEffect(() => {
    if (settings?.fyersRedirectUri) {
      const uri = settings.fyersRedirectUri.trim();
      // Never force cloud mode or cloud callback as default because it causes 401 if not registered in myapi.fyers.in
      if (uri && !uri.includes('/auth/callback')) {
        setSelectedRedirectUri(uri);
        setAuthMode('local');
      } else {
        setSelectedRedirectUri('https://127.0.0.1:6414');
        setAuthMode('local');
      }
    } else {
      setSelectedRedirectUri('https://127.0.0.1:6414');
      setAuthMode('local');
    }
  }, [settings?.fyersRedirectUri]);

  // Automated background polling while waiting for Fyers login or when modal is open
  useEffect(() => {
    if (!showAuthModal && !isWaitingForLogin) {
      if (pollingRef.current) clearInterval(pollingRef.current);
      return;
    }

    const checkStatus = async () => {
      try {
        const res = await fetch('/auth/status');
        const data = await res.json();
        if (data.isValid) {
          setAuthMsg({
            type: 'success',
            text: '🎉 Fyers Authenticated Live! Connecting terminal...'
          });
          setIsWaitingForLogin(false);
          onRefresh();
          setTimeout(() => {
            setShowAuthModal(false);
            setAuthMsg(null);
          }, 1200);
        }
      } catch {
        // ignore polling failures
      }
    };

    pollingRef.current = setInterval(checkStatus, 2000);
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, [showAuthModal, isWaitingForLogin, onRefresh, setShowAuthModal]);

  // Handle Escape key to close modal
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && showAuthModal) {
        setShowAuthModal(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showAuthModal, setShowAuthModal]);

  const fetchAuthUrl = async (overrideUri?: string): Promise<string> => {
    try {
      const activeUri = (overrideUri || selectedRedirectUri || (authMode === 'cloud' ? cloudCallbackUri : (settings?.fyersRedirectUri || 'https://127.0.0.1:6414'))).trim();
      const modeParam = authMode === 'cloud' ? 'mode=cloud' : 'mode=local';
      const redirectParam = `redirect_uri=${encodeURIComponent(activeUri)}`;
      const originParam = `origin=${encodeURIComponent(window.location.origin)}`;
      const res = await fetch(`/api/auth/trigger-auth?${redirectParam}&${modeParam}&${originParam}`);
      const data = await res.json();
      if (data.success && data.authUrl) {
        setAuthUrl(data.authUrl);
        setAuthLinkMetadata({ appId: data.appId, activeRedirectUri: data.activeRedirectUri || activeUri });
        return data.authUrl;
      }
    } catch (e) {
      // ignore
    }
    const fallback = `${window.location.origin}/auth/login`;
    setAuthUrl(fallback);
    return fallback;
  };

  useEffect(() => {
    if (showAuthModal) {
      fetchAuthUrl();
    }
  }, [showAuthModal, selectedRedirectUri, authMode]);

  const handleCopyCloudUri = async () => {
    try {
      await navigator.clipboard.writeText(cloudCallbackUri);
      setCopiedCloudUri(true);
      setTimeout(() => setCopiedCloudUri(false), 2500);
    } catch {
      // ignore
    }
  };

  const handleSelectPresetUri = async (uri: string) => {
    const cleanUri = uri.trim();
    setSelectedRedirectUri(cleanUri);
    if (cleanUri === cloudCallbackUri) {
      setAuthMode('cloud');
    } else {
      setAuthMode('local');
    }
    await fetchAuthUrl(cleanUri);
    try {
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fyersRedirectUri: cleanUri })
      });
      onRefresh();
    } catch {
      // ignore
    }
  };

  const handleSetCloudRedirectAsDefault = async () => {
    setIsSavingRedirect(true);
    try {
      await handleSelectPresetUri(cloudCallbackUri);
      await handleCopyCloudUri();
      setAuthMsg({
        type: 'success',
        text: '✅ Cloud Callback saved to Stockboard settings & copied to clipboard! Paste it once into myapi.fyers.in.'
      });
    } catch (err: any) {
      setAuthMsg({ type: 'error', text: err.message || 'Failed to save redirect URI' });
    } finally {
      setIsSavingRedirect(false);
    }
  };

  const handleTestConnection = async () => {
    setIsTesting(true);
    setAuthMsg(null);
    try {
      const res = await fetch('/api/fyers/test-connection');
      const data = await res.json();
      if (data.connected && data.isLive) {
        setAuthMsg({ 
          type: 'success', 
          text: `Verified Live: ${data.message} | Available: ₹${data.funds?.availableBalance?.toLocaleString('en-IN') || 0}` 
        });
      } else {
        setAuthMsg({ 
          type: 'error', 
          text: `Fyers Connection Status: ${data.message || 'Token unverified or expired'}` 
        });
      }
      onRefresh();
    } catch (err: any) {
      setAuthMsg({ type: 'error', text: err.message || 'Diagnostic ping failed' });
    } finally {
      setIsTesting(false);
    }
  };

  const [isAutoLoggingIn, setIsAutoLoggingIn] = useState<boolean>(false);

  const handleAutoLogin = async () => {
    setIsAutoLoggingIn(true);
    setAuthMsg({ type: 'success', text: 'Connecting to FYERS via automated backend TOTP...' });
    try {
      const res = await fetch('/auth/auto-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: currentUser?.uid, userEmail: currentUser?.email })
      });
      const data = await res.json();
      if (data.success) {
        setAuthMsg({ type: 'success', text: '🎉 Automated Fyers Connection Successful! Live token active.' });
        onRefresh();
        setTimeout(() => {
          setShowAuthModal(false);
          setAuthMsg(null);
        }, 1500);
      } else {
        setAuthMsg({ type: 'error', text: data.error || 'Auto-login requires PIN/TOTP or manual authorization. Use Step 1 below.' });
      }
    } catch (err: any) {
      setAuthMsg({ type: 'error', text: err.message || 'Auto-login failed' });
    } finally {
      setIsAutoLoggingIn(false);
    }
  };

  const handleDisconnect = async () => {
    try {
      await fetch('/auth/disconnect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: currentUser?.uid, userEmail: currentUser?.email })
      });
      setAuthMsg({ type: 'success', text: 'Disconnected from Fyers Broker API.' });
      onRefresh();
    } catch (err: any) {
      setAuthMsg({ type: 'error', text: `Failed to disconnect: ${err.message}` });
    }
  };

  const handleTriggerAuth = async () => {
    setIsTriggering(true);
    setAuthMsg(null);
    // Pre-open window immediately to prevent browser popup blocker from blocking async open
    const authWindow = window.open('about:blank', '_blank');
    try {
      const url = await fetchAuthUrl(selectedRedirectUri);
      if (authWindow) {
        authWindow.location.href = url;
      } else {
        window.location.href = url;
      }
      setIsWaitingForLogin(true);
      if (authMode === 'cloud') {
        setAuthMsg({
          type: 'success',
          text: '⚡ Zero-Touch Login Triggered! Complete login on the Fyers popup. It will automatically redirect back, exchange token, and connect live.'
        });
      } else {
        setAuthMsg({
          type: 'success',
          text: '📡 Fyers Auth opened! Log in with PIN. When redirected to 127.0.0.1:6414, simply copy the URL. Stockboard will auto-detect it from your clipboard!'
        });
      }
    } catch (err: any) {
      if (authWindow) authWindow.close();
      setAuthMsg({ type: 'error', text: err.message || 'Failed to trigger Fyers auth' });
    } finally {
      setIsTriggering(false);
    }
  };

  const handleCopyAuthLink = async () => {
    try {
      const url = await fetchAuthUrl(selectedRedirectUri);
      await navigator.clipboard.writeText(url);
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2500);
    } catch (err) {
      // fallback
      const fallback = `${window.location.origin}/auth/login`;
      await navigator.clipboard.writeText(fallback);
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2500);
    }
  };

  const handleInputChange = (val: string) => {
    setAuthCodeInput(val);
    const trimmed = val.trim();
    if (!trimmed) {
      setDetectedItem(null);
      return;
    }
    if (trimmed.includes('auth_code=')) {
      const match = trimmed.match(/[?&]auth_code=([^&]+)/);
      if (match) {
        setDetectedItem({ type: 'Auth Code from URL', val: match[1].substring(0, 18) + '...' });
        return;
      }
    }
    if (trimmed.includes('access_token=')) {
      const match = trimmed.match(/[?&]access_token=([^&]+)/);
      if (match) {
        setDetectedItem({ type: 'Access Token from URL', val: match[1].substring(0, 18) + '...' });
        return;
      }
    }
    if (trimmed.startsWith('eyJ')) {
      setDetectedItem({ type: 'Direct JWT Access Token', val: trimmed.substring(0, 18) + '...' });
      return;
    }
    if (trimmed.length > 20) {
      setDetectedItem({ type: 'Raw Auth Code / Key', val: trimmed.substring(0, 18) + '...' });
      return;
    }
    setDetectedItem(null);
  };

  const handlePasteFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        handleInputChange(text);
      }
    } catch (err) {
      // if clipboard permissions are restricted, user can paste manually
    }
  };

  const handleComputeModalHash = async () => {
    const rawSecret = modalSecretKey.trim() || settings?.fyersSecretKey || '';
    if (!rawSecret) {
      setAuthMsg({ type: 'error', text: 'Please enter your Fyers App Secret Key from myapi.fyers.in first.' });
      return;
    }
    const rawAppId = settings?.fyersAppId || 'V78VJBA972';
    const appType = settings?.fyersAppType || '100';
    const formattedAppId = rawAppId.includes('-') ? rawAppId : `${rawAppId}-${appType}`;
    try {
      setIsComputingModalHash(true);
      const strToHash = `${formattedAppId}:${rawSecret}`;
      const encoder = new TextEncoder();
      const data = encoder.encode(strToHash);
      const hashBuffer = await window.crypto.subtle.digest('SHA-256', data);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
      setModalAppIdHash(hashHex);
      setAuthMsg({ type: 'success', text: `SHA256 App ID Hash computed: ${hashHex.substring(0, 16)}...` });
    } catch (err: any) {
      setAuthMsg({ type: 'error', text: `Failed to compute hash: ${err.message}` });
    } finally {
      setIsComputingModalHash(false);
    }
  };

  const handleExtractCodeSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setAuthMsg(null);

    const inputVal = (authCodeInput || accessTokenInput).trim();
    if (!inputVal) {
      setAuthMsg({ type: 'error', text: 'Please paste the redirected Fyers link or auth code first.' });
      return;
    }

    setIsSubmitting(true);

    try {
      const res = await fetch('/api/auth/extract-code', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-User-Email': currentUser?.email || '',
          'X-User-Id': currentUser?.uid || ''
        },
        body: JSON.stringify({ 
          url: inputVal,
          userId: currentUser?.uid || '',
          userEmail: currentUser?.email || '',
          appIdHash: modalAppIdHash.trim() || undefined,
          secretKey: modalSecretKey.trim() || undefined
        })
      });
      const data = await res.json();
      if (data.success) {
        if (currentUser?.uid && data.auth?.accessToken) {
          try {
            await saveUserAccessCode(currentUser.uid, {
              accessToken: data.auth.accessToken,
              accessCode: undefined, // Consumed single-use codes should not be persisted
              userEmail: currentUser.email || '',
              source: 'extracted_link'
            });
          } catch (fsErr) {
            console.warn('Firestore access code save warning:', fsErr);
          }
        }
        setAuthCodeInput('');
        setAccessTokenInput('');
        setAuthMsg({ 
          type: 'success', 
          text: `Success! Extracted and connected as ${data.profile?.name || data.auth?.fyId || 'Authorized Trader'}. Token saved!` 
        });
        setTimeout(() => {
          setShowAuthModal(false);
          onRefresh();
        }, 1500);
      } else {
        const errorText = data.error || 'Failed to extract access code from the provided link.';
        if (errorText.toLowerCase().includes('app id hash')) {
          setShowCredentialsSection(true);
        }
        setAuthMsg({ type: 'error', text: errorText });
      }
    } catch (err: any) {
      const errMsg = err.message || 'Failed to extract and authenticate.';
      if (errMsg.toLowerCase().includes('app id hash')) {
        setShowCredentialsSection(true);
      }
      setAuthMsg({ type: 'error', text: errMsg });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <header className="bg-slate-900 border-b border-slate-800 sticky top-0 z-40">
      <div className="max-w-7xl mx-auto px-2.5 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between min-h-[3.75rem] h-auto py-2 sm:py-0 gap-2">
          
          {/* Logo & Brand Title */}
          <div className="flex items-center space-x-2 sm:space-x-3 shrink min-w-0">
            <div className="bg-gradient-to-tr from-indigo-600 to-blue-500 p-1.5 sm:p-2 rounded-xl text-white shadow-lg shadow-indigo-500/20 shrink-0">
              <Zap className="w-4 h-4 sm:w-5 sm:h-5" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center space-x-1.5 sm:space-x-2">
                <span className="font-bold text-base sm:text-lg text-slate-100 tracking-tight truncate">Stockboard</span>
                <span className={`text-[9px] sm:text-[10px] font-semibold uppercase px-1.5 sm:px-2 py-0.5 rounded-full border whitespace-nowrap shrink-0 ${
                  isPaper 
                    ? 'bg-amber-500/10 text-amber-400 border-amber-500/30' 
                    : 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                }`}>
                  {isPaper ? 'Paper' : 'Live'}
                </span>
              </div>
              <p className="hidden md:block text-xs text-slate-400 truncate">Short Straddle → Golden Rule Iron Condor Strategy</p>
            </div>
          </div>

          {/* Right Controls & Status */}
          <div className="flex items-center space-x-1 sm:space-x-2 shrink-0">
            
            {/* Auto Trading Status Switch */}
            <button
              onClick={onToggleAutoTrading}
              className={`flex items-center space-x-1 sm:space-x-1.5 text-[11px] sm:text-xs font-semibold px-2 sm:px-2.5 py-1 sm:py-1.5 rounded-lg transition-all border shrink-0 ${
                isAuto
                  ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/20'
                  : 'bg-rose-500/10 text-rose-400 border-rose-500/30 hover:bg-rose-500/20'
              }`}
              title="Toggle Automated Strategy Monitoring"
            >
              {isAuto ? (
                <>
                  <span className="relative flex h-2 w-2 shrink-0">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                  </span>
                  <span>Active</span>
                </>
              ) : (
                <>
                  <Pause className="w-3 h-3 sm:w-3.5 sm:h-3.5 shrink-0" />
                  <span>Paused</span>
                </>
              )}
            </button>

            {/* Fyers OAuth Connection Badge */}
            <button
              onClick={() => setShowAuthModal(true)}
              className={`flex items-center space-x-1 text-[11px] sm:text-xs px-2 sm:px-2.5 py-1 rounded-md border transition-all cursor-pointer shrink-0 ${
                authStatus?.isValid
                  ? 'bg-emerald-950/40 text-emerald-300 border-emerald-800/50 hover:bg-emerald-900/50'
                  : 'bg-amber-950/40 text-amber-300 border-amber-800/50 hover:bg-amber-900/50 animate-pulse'
              }`}
              title={authStatus?.isValid ? 'Fyers API Connected (Click for details)' : 'Click to authenticate Fyers Live Broker API'}
            >
              {authStatus?.isValid ? (
                <CheckCircle2 className="w-3 h-3 sm:w-3.5 sm:h-3.5 text-emerald-400 shrink-0" />
              ) : (
                <AlertCircle className="w-3 h-3 sm:w-3.5 sm:h-3.5 text-amber-400 shrink-0" />
              )}
              <span className="font-semibold whitespace-nowrap">
                {authStatus?.isValid ? 'Connected' : 'Auth'}
              </span>
            </button>

            {/* Manual Refresh */}
            <button
              onClick={onRefresh}
              disabled={isRefreshing}
              className="p-1.5 sm:p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors border border-slate-700 cursor-pointer shrink-0"
              title="Refresh Market Data & Positions"
            >
              <RefreshCw className={`w-3.5 h-3.5 sm:w-4 sm:h-4 ${isRefreshing ? 'animate-spin text-indigo-400' : ''}`} />
            </button>

            {/* Dark / Light Mode Toggle */}
            {onToggleTheme && (
              <button
                onClick={onToggleTheme}
                className="p-1.5 sm:p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors border border-slate-700 cursor-pointer flex items-center justify-center shrink-0"
                title={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
              >
                {theme === 'dark' ? (
                  <Moon className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-indigo-400" />
                ) : (
                  <Sun className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-amber-500" />
                )}
              </button>
            )}

            {/* Firebase Auth User Profile & Sign Out */}
            {currentUser && (
              <div className="flex items-center space-x-1.5 pl-1 sm:pl-2 border-l border-slate-800 shrink-0">
                <div className="hidden lg:flex items-center space-x-1.5 px-2.5 py-1 bg-slate-800/80 rounded-lg text-xs text-slate-300 border border-slate-700/60">
                  <UserIcon className="w-3.5 h-3.5 text-indigo-400" />
                  <span className="max-w-[120px] truncate font-medium">{currentUser.email || 'Trader'}</span>
                </div>
                {onSignOut && (
                  <button
                    onClick={onSignOut}
                    className="p-1.5 sm:p-2 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 transition-colors border border-rose-500/20 shrink-0"
                    title="Sign Out of Firebase Account"
                  >
                    <LogOut className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Tab Navigation */}
        <div className="flex space-x-1 overflow-x-auto py-1.5 sm:py-2 border-t border-slate-800/60 no-scrollbar w-full touch-pan-x">
          {[
            { id: 'dashboard', label: 'Dashboard', icon: Activity },
            { id: 'vol-surface', label: '3D Vol Surface', icon: Compass },
            { id: 'simulation', label: '5D Backtest', icon: BarChart2 },
            { id: 'option-chain', label: 'Option Chain', icon: Layers },
            { id: 'trade-logs', label: 'Trade Logs', icon: FileText },
            { id: 'settings', label: 'Settings', icon: Sliders },
            { id: 'system-logs', label: 'Audit Logs', icon: Terminal },
          ].map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center space-x-1.5 px-2.5 sm:px-3.5 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap shrink-0 transition-all ${
                  isActive
                    ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/30 font-semibold'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                }`}
              >
                <Icon className="w-3.5 h-3.5 shrink-0" />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* FYERS AUTH MODAL */}
      {showAuthModal && (
        <div 
          className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4 overflow-y-auto"
          onClick={() => setShowAuthModal(false)}
        >
          <div 
            className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-xl shadow-2xl relative my-auto max-h-[90vh] flex flex-col overflow-hidden animate-in fade-in zoom-in duration-150"
            onClick={(e) => e.stopPropagation()}
          >
            
            {/* Header (Fixed Top) */}
            <div className="flex items-center justify-between border-b border-slate-800 p-4 sm:p-5 shrink-0 bg-slate-900/95 backdrop-blur z-10">
              <div className="flex items-center space-x-2.5">
                <div className="p-2 bg-emerald-500/10 border border-emerald-500/20 rounded-lg">
                  <Key className="w-5 h-5 text-emerald-400" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-slate-100">Fyers Live Broker Authorization</h3>
                  <p className="text-xs text-slate-400">Connect your Fyers Account for Live Strategy Execution</p>
                </div>
              </div>

              <button
                type="button"
                onClick={() => setShowAuthModal(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors cursor-pointer"
                title="Close modal (Esc)"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Scrollable Content Body */}
            <div className="p-4 sm:p-5 overflow-y-auto space-y-4 flex-1">

              {/* Current Status */}
              <div className={`p-3.5 rounded-xl border text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 ${
                authStatus?.isValid
                  ? 'bg-emerald-950/30 text-emerald-300 border-emerald-800/40'
                  : 'bg-amber-950/30 text-amber-300 border-amber-800/40'
              }`}>
                <div className="flex items-center space-x-2.5">
                  {authStatus?.isValid ? (
                    <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
                  ) : (
                    <AlertCircle className="w-5 h-5 text-amber-400 shrink-0" />
                  )}
                  <div>
                    <div className="font-bold flex items-center gap-1.5">
                      <span>{authStatus?.message || (authStatus?.isValid ? 'Fyers Live Token Active' : 'Auth Required')}</span>
                      {authStatus?.profile?.name && (
                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                          {authStatus.profile.name}
                        </span>
                      )}
                    </div>
                    <p className="text-[10px] text-slate-400 mt-0.5 font-mono">
                      Broker App ID: {settings?.fyersAppId || 'V78VJBA972-100'} | Mode: {settings?.mode || 'PAPER'}
                    </p>
                  </div>
                </div>
                <div className="flex items-center space-x-2 self-end sm:self-auto">
                  {authStatus?.isValid && (
                    <button
                      type="button"
                      onClick={handleDisconnect}
                      className="px-2.5 py-1 text-[11px] font-semibold bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 border border-rose-500/30 rounded-lg transition-colors flex items-center space-x-1 cursor-pointer"
                      title="Disconnect Fyers session"
                    >
                      <LogOut className="w-3 h-3 text-rose-400" />
                      <span>Disconnect</span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={handleTestConnection}
                    disabled={isTesting}
                    className="px-2.5 py-1 text-[11px] font-semibold bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-lg transition-colors flex items-center space-x-1 cursor-pointer disabled:opacity-50"
                    title="Ping Fyers live API to test token validity & live funds"
                  >
                    <RefreshCw className={`w-3 h-3 text-indigo-400 ${isTesting ? 'animate-spin' : ''}`} />
                    <span>{isTesting ? 'Testing...' : 'Test Connection'}</span>
                  </button>
                  <span className="font-mono text-[10px] uppercase px-2 py-1 rounded bg-slate-900 border border-slate-800 text-slate-300">
                    {settings?.mode || 'PAPER'}
                  </span>
                </div>
              </div>

              {/* User Firestore Status Banner */}
              <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
                <div className="flex items-center space-x-2.5">
                  <div className="p-1.5 bg-indigo-500/20 text-indigo-400 rounded-lg border border-indigo-500/30">
                    <Database className="w-4 h-4" />
                  </div>
                  <div>
                    <div className="flex items-center gap-1.5">
                      <span className="font-bold text-xs text-white">FIRESTORE USER ACCESS STORAGE</span>
                      <span className="text-[9px] font-mono px-1.5 py-0.2 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded">
                        ACTIVE
                      </span>
                    </div>
                    <p className="text-[11px] text-slate-400">
                      Stored against: <span className="font-mono text-indigo-300 font-bold">{currentUser?.email || 'Logged in user'}</span>
                    </p>
                  </div>
                </div>
                {userAccessCode?.accessToken && (
                  <div className="text-right">
                    <span className="text-[10px] font-mono text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded block">
                      TOKEN IN FIRESTORE: {userAccessCode.isValid ? 'VALID' : 'EXPIRED'}
                    </span>
                    {userAccessCode.expiresAt && (
                      <span className="text-[9px] text-slate-500 font-mono block mt-0.5">
                        Expires: {new Date(userAccessCode.expiresAt).toLocaleTimeString()}
                      </span>
                    )}
                  </div>
                )}
              </div>

              {/* Status or Error Notifications */}
              {authMsg && (
                <div className={`p-3 rounded-xl border text-xs font-semibold flex items-start space-x-2 ${
                  authMsg.type === 'success'
                    ? 'bg-emerald-950/60 text-emerald-200 border-emerald-500/50'
                    : 'bg-rose-950/60 text-rose-200 border-rose-500/50'
                }`}>
                  {authMsg.type === 'success' ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                  ) : (
                    <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                  )}
                  <div className="flex-1 leading-relaxed">
                    {authMsg.text}
                    {authMsg.type === 'error' && (authMsg.text.toLowerCase().includes('expire') || authMsg.text.toLowerCase().includes('auth code')) && (
                      <div className="mt-2">
                        <button
                          type="button"
                          onClick={handleTriggerAuth}
                          disabled={isTriggering}
                          className="px-2.5 py-1 bg-rose-900/80 hover:bg-rose-800 text-white rounded text-[11px] font-bold border border-rose-500/50 inline-flex items-center space-x-1.5 transition-colors shadow-sm cursor-pointer"
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                          <span>{isTriggering ? 'Opening...' : 'Launch Fresh Fyers Login Link'}</span>
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* FAST ZERO-TOUCH AUTO AUTHENTICATE CARD */}
              <div className="bg-gradient-to-r from-amber-950/40 via-slate-900 to-indigo-950/40 p-4 rounded-xl border-2 border-amber-500/40 flex flex-col sm:flex-row sm:items-center justify-between gap-3 shadow-lg">
                <div className="flex items-center space-x-3">
                  <div className="p-2.5 bg-amber-500/20 text-amber-300 rounded-xl border border-amber-500/30 shrink-0">
                    <Zap className="w-5 h-5 fill-amber-300" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h4 className="font-bold text-xs sm:text-sm text-white">1-Click Auto Authenticate</h4>
                      <span className="text-[9px] font-mono px-2 py-0.5 bg-amber-500/20 text-amber-300 border border-amber-500/30 rounded-full font-bold">
                        FASTEST
                      </span>
                    </div>
                    <p className="text-[11px] text-slate-300 mt-0.5 leading-snug">
                      Uses your saved FYERS PIN & TOTP Secret to generate an active 24-hour token automatically.
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={handleAutoLogin}
                  disabled={isAutoLoggingIn}
                  className="px-4 py-2.5 bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-slate-950 font-bold text-xs rounded-xl shadow-lg flex items-center justify-center space-x-1.5 transition-all cursor-pointer border border-amber-300/40 shrink-0 disabled:opacity-50"
                >
                  <Zap className={`w-3.5 h-3.5 fill-slate-950 ${isAutoLoggingIn ? 'animate-spin' : ''}`} />
                  <span>{isAutoLoggingIn ? 'Connecting...' : '⚡ Auto-Authenticate Now'}</span>
                </button>
              </div>

              {/* STEP 1: LAUNCH FYERS LOGIN */}
              <div className="bg-slate-950/70 p-4 rounded-xl border border-indigo-500/30 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-2">
                    <span className="w-5 h-5 rounded-full bg-indigo-500/20 text-indigo-400 font-bold text-xs flex items-center justify-center border border-indigo-500/30">
                      1
                    </span>
                    <span className="font-bold text-slate-100 text-xs sm:text-sm">Step 1: Launch Fyers Login</span>
                  </div>
                  <span className="text-[10px] bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 px-2 py-0.5 rounded font-mono">
                    Enter PIN on Fyers
                  </span>
                </div>

                <p className="text-slate-300 text-xs leading-relaxed">
                  Click below to open the Fyers authorization page. Log in with your credentials and enter your 4-digit PIN.
                </p>

                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <button
                    type="button"
                    onClick={handleTriggerAuth}
                    disabled={isTriggering}
                    className="inline-flex items-center space-x-2 bg-gradient-to-r from-indigo-600 to-blue-600 hover:from-indigo-500 hover:to-blue-500 disabled:opacity-50 text-white font-bold px-4 py-2.5 rounded-lg transition-all shadow-md cursor-pointer text-xs"
                  >
                    <ExternalLink className="w-4 h-4" />
                    <span>{isTriggering ? 'Opening Fyers Portal...' : '🚀 Launch Fyers Auth (Login & Enter PIN)'}</span>
                  </button>

                  <button
                    type="button"
                    onClick={handleCopyAuthLink}
                    className="inline-flex items-center space-x-1.5 bg-slate-800 hover:bg-slate-750 text-slate-200 font-semibold px-3 py-2 rounded-lg border border-slate-700 transition-all text-xs cursor-pointer"
                  >
                    {copiedLink ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5 text-indigo-400" />}
                    <span>{copiedLink ? 'Link Copied!' : 'Copy Link'}</span>
                  </button>
                </div>
              </div>

              {/* STEP 2: PASTE REDIRECT URL / AUTH CODE */}
              <div className="bg-gradient-to-br from-slate-950 via-slate-900 to-indigo-950/40 p-4 rounded-xl border-2 border-emerald-500/40 space-y-3 shadow-lg">
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-2">
                    <span className="w-5 h-5 rounded-full bg-emerald-500/20 text-emerald-400 font-bold text-xs flex items-center justify-center border border-emerald-500/30">
                      2
                    </span>
                    <span className="font-bold text-emerald-300 text-xs sm:text-sm">Step 2: Paste Redirected URL or Auth Code</span>
                  </div>
                  <span className="text-[10px] bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 px-2 py-0.5 rounded font-bold">
                    Connects Your Account
                  </span>
                </div>

                <div className="bg-slate-950/80 p-3 rounded-lg border border-slate-800 text-xs text-slate-300 space-y-1.5">
                  <p className="leading-relaxed">
                    After entering your PIN, Fyers redirects to:
                    <br />
                    <code className="text-indigo-300 font-mono text-[11px] break-all">https://127.0.0.1:6414/?s=ok&code=200&auth_code=...</code>
                  </p>
                  <p className="text-[11px] text-amber-300/90 leading-tight">
                    ⚠️ Your browser will show <strong>"This site can’t be reached"</strong> — that is <strong>completely normal</strong> because 127.0.0.1 is local!
                  </p>
                  <p className="text-[11px] text-slate-300">
                    👉 Simply <strong>copy that URL from your browser's address bar</strong> and <strong>paste it below</strong>:
                  </p>
                </div>

                <form onSubmit={handleExtractCodeSubmit} className="space-y-2.5 pt-1">
                  <div className="relative">
                    <input
                      type="text"
                      value={authCodeInput}
                      onChange={(e) => handleInputChange(e.target.value)}
                      placeholder="Paste https://127.0.0.1:6414/?s=ok&auth_code=... or auth code here"
                      className="w-full bg-slate-950 border-2 border-slate-700 focus:border-emerald-400 rounded-lg pl-3 pr-24 py-2.5 text-slate-100 font-mono text-xs outline-none transition-colors"
                    />
                    <button
                      type="button"
                      onClick={handlePasteFromClipboard}
                      className="absolute right-1.5 top-1.5 bottom-1.5 px-3 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded text-xs font-semibold flex items-center space-x-1 border border-slate-700 transition-colors cursor-pointer"
                      title="Paste from clipboard"
                    >
                      <ClipboardPaste className="w-3.5 h-3.5 text-indigo-400" />
                      <span>Paste</span>
                    </button>
                  </div>

                  {detectedItem && (
                    <div className="flex items-center space-x-2 bg-emerald-950/60 border border-emerald-500/50 px-3 py-1.5 rounded-lg text-xs text-emerald-300 animate-pulse">
                      <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                      <span>{detectedItem.type} Detected: <strong className="font-mono text-white text-[11px] break-all">{detectedItem.val}</strong></span>
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={isSubmitting || !authCodeInput.trim()}
                    className="w-full py-2.5 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 disabled:opacity-50 text-white font-bold text-xs sm:text-sm rounded-lg transition-all shadow-md flex items-center justify-center space-x-2 cursor-pointer border border-emerald-400/30"
                  >
                    <Key className="w-4 h-4 text-emerald-200" />
                    <span>{isSubmitting ? 'Validating & Connecting Token...' : '⚡ Connect & Save Live 24H Token'}</span>
                  </button>
                </form>

                {/* APP ID HASH & SECRET KEY TROUBLESHOOTING ACCORDION */}
                <div className="mt-3 pt-3 border-t border-slate-800">
                  <button
                    type="button"
                    onClick={() => setShowCredentialsSection(!showCredentialsSection)}
                    className="w-full flex items-center justify-between text-xs text-slate-300 hover:text-white py-1 transition-colors cursor-pointer"
                  >
                    <div className="flex items-center space-x-2">
                      <Lock className="w-3.5 h-3.5 text-indigo-400" />
                      <span className="font-semibold">App ID Hash & Secret Key Troubleshooting</span>
                      {isTotpMistakenForSecret && (
                        <span className="bg-amber-500/20 text-amber-300 text-[10px] px-2 py-0.5 rounded-full border border-amber-500/40 font-bold">
                          ⚠️ Action Needed: TOTP Key used as Secret
                        </span>
                      )}
                      {!isTotpMistakenForSecret && modalAppIdHash && (
                        <span className="bg-emerald-500/20 text-emerald-300 text-[10px] px-2 py-0.5 rounded-full border border-emerald-500/40 font-mono">
                          Hash Ready
                        </span>
                      )}
                    </div>
                    {showCredentialsSection ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
                  </button>

                  {showCredentialsSection && (
                    <div className="mt-2.5 p-3 bg-slate-950/90 rounded-lg border border-slate-800 space-y-3 text-xs">
                      {isTotpMistakenForSecret && (
                        <div className="p-2.5 bg-amber-950/80 border border-amber-500/50 rounded-lg text-amber-200 text-[11px] leading-relaxed space-y-1">
                          <div className="font-bold flex items-center space-x-1.5 text-amber-300">
                            <AlertCircle className="w-4 h-4 shrink-0" />
                            <span>Why "invalid app id hash" occurs:</span>
                          </div>
                          <p>
                            Your saved Fyers Secret Key is set to your 2FA TOTP key (Google Authenticator key), NOT your Fyers App Secret. Fyers API computes <code>SHA256(AppID:SecretKey)</code> using the <strong>App Secret Key</strong> listed under your App Details at <a href="https://myapi.fyers.in" target="_blank" rel="noreferrer" className="underline font-bold text-white hover:text-indigo-200">myapi.fyers.in</a> (usually 10-12 characters).
                          </p>
                        </div>
                      )}

                      <div className="space-y-1">
                        <div className="flex items-center justify-between">
                          <label className="text-slate-300 font-medium text-[11px]">
                            Fyers App Secret Key (from myapi.fyers.in):
                          </label>
                          <button
                            type="button"
                            onClick={handleComputeModalHash}
                            disabled={isComputingModalHash || !modalSecretKey.trim()}
                            className="text-[10px] font-bold text-indigo-400 hover:text-indigo-300 flex items-center space-x-1 disabled:opacity-40 cursor-pointer"
                          >
                            <Hash className="w-3 h-3" />
                            <span>{isComputingModalHash ? 'Computing...' : 'Auto-Compute SHA256'}</span>
                          </button>
                        </div>
                        <input
                          type="text"
                          value={modalSecretKey}
                          onChange={(e) => setModalSecretKey(e.target.value)}
                          placeholder="e.g. XNS7DQJFNR (App Secret from myapi.fyers.in)"
                          className="w-full bg-slate-900 border border-slate-700 focus:border-indigo-400 rounded p-2 text-slate-200 font-mono text-xs outline-none"
                        />
                      </div>

                      <div className="space-y-1">
                        <label className="text-slate-300 font-medium text-[11px] flex items-center justify-between">
                          <span>Or Direct 64-char SHA256 App ID Hash:</span>
                          <span className="text-[10px] text-slate-500 font-mono">SHA256(V78VJBA972-100:secret)</span>
                        </label>
                        <input
                          type="text"
                          value={modalAppIdHash}
                          onChange={(e) => setModalAppIdHash(e.target.value)}
                          placeholder="64-character hex hash"
                          className="w-full bg-slate-900 border border-slate-700 focus:border-indigo-400 rounded p-2 text-slate-200 font-mono text-[11px] outline-none"
                        />
                      </div>

                      <div className="flex items-center justify-between pt-1">
                        <p className="text-[10.5px] text-slate-400">
                          App Secret Key from myapi.fyers.in ensures auth codes can be exchanged successfully.
                        </p>
                        <button
                          type="button"
                          onClick={async () => {
                            try {
                              const updates: any = {};
                              if (modalSecretKey) updates.fyersSecretKey = modalSecretKey.trim();
                              if (modalAppIdHash) updates.fyersAppIdHash = modalAppIdHash.trim();
                              const res = await fetch('/api/settings', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify(updates)
                              });
                              if (res.ok) {
                                setAuthMsg({ type: 'success', text: '✅ App Secret Key saved to Settings successfully!' });
                                onRefresh();
                              }
                            } catch (e: any) {
                              setAuthMsg({ type: 'error', text: e.message || 'Failed to save' });
                            }
                          }}
                          className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs rounded-lg transition-colors cursor-pointer shrink-0"
                        >
                          Save App Secret
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* REDIRECT URI & 401 SETTINGS (EXPANDABLE) */}
              <div className="bg-slate-950/80 p-3.5 rounded-xl border border-slate-800 space-y-3">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1.5 text-[11px]">
                  <span className="font-semibold text-slate-200 flex items-center space-x-1.5">
                    <span>Active Redirect URI in Fyers Link:</span>
                    <span className="font-mono text-indigo-300 text-[10px] bg-indigo-950/80 px-2 py-0.5 rounded border border-indigo-500/40">
                      {selectedRedirectUri}
                    </span>
                  </span>
                  <span className="text-[10px] text-amber-400 font-mono">
                    App ID: {authLinkMetadata?.appId || 'V78VJBA972-100'}
                  </span>
                </div>

                {/* 401 Notice */}
                {selectedRedirectUri.includes('/auth/callback') ? (
                  <div className="bg-rose-950/70 border border-rose-500/60 p-3 rounded-lg flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
                    <div className="flex items-start space-x-2 text-xs text-rose-200">
                      <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                      <div className="leading-snug">
                        <span className="font-bold">401 Error Notice:</span> This link uses the Cloud Callback URI. If your Fyers App at <a href="https://myapi.fyers.in" target="_blank" rel="noreferrer" className="underline font-bold text-white hover:text-indigo-200">myapi.fyers.in</a> is set to <code className="text-emerald-300 font-bold font-mono">https://127.0.0.1:6414</code>, click below to match it.
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleSelectPresetUri('https://127.0.0.1:6414')}
                      className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs rounded-lg shadow-md shrink-0 flex items-center justify-center space-x-1 transition-all cursor-pointer"
                    >
                      <Check className="w-3.5 h-3.5" />
                      <span>Set to https://127.0.0.1:6414</span>
                    </button>
                  </div>
                ) : (
                  <div className="bg-emerald-950/40 border border-emerald-500/30 p-2.5 rounded-lg flex items-center space-x-2 text-xs text-emerald-300">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                    <span>
                      Matches standard Fyers App setting: <strong className="font-mono">{selectedRedirectUri}</strong>
                    </span>
                  </div>
                )}

                {/* Quick Presets */}
                <div className="space-y-1.5 pt-1">
                  <div className="flex items-center justify-between">
                    <span className="text-[10.5px] text-slate-400 font-medium">Quick URI presets:</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5 items-center">
                    {[
                      { label: '⭐ https://127.0.0.1:6414 (Default)', value: 'https://127.0.0.1:6414' },
                      { label: 'http://127.0.0.1:6414', value: 'http://127.0.0.1:6414' },
                      { label: 'Cloud Callback (Zero-Touch)', value: cloudCallbackUri }
                    ].map((preset) => {
                      const isActive = selectedRedirectUri === preset.value;
                      return (
                        <button
                          key={preset.value}
                          type="button"
                          onClick={() => handleSelectPresetUri(preset.value)}
                          className={`text-[10px] px-2.5 py-1 rounded font-mono transition-all border cursor-pointer ${
                            isActive
                              ? 'bg-indigo-600 border-indigo-400 text-white font-bold shadow-sm'
                              : 'bg-slate-900 border-slate-700 text-slate-400 hover:text-slate-200 hover:border-slate-500'
                          }`}
                        >
                          {preset.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>

            </div>

            {/* Footer (Fixed Bottom) */}
            <div className="border-t border-slate-800 p-3 sm:px-5 bg-slate-950/90 flex items-center justify-between shrink-0 text-xs">
              <span className="text-slate-400 text-[11px] font-mono">
                App ID: <span className="text-indigo-300">{settings?.fyersAppId || 'V78VJBA972-100'}</span>
              </span>
              <button
                type="button"
                onClick={() => setShowAuthModal(false)}
                className="px-4 py-1.5 bg-slate-800 hover:bg-slate-750 text-slate-200 hover:text-white rounded-lg text-xs font-semibold border border-slate-700 transition-colors cursor-pointer"
              >
                Close Window
              </button>
            </div>

          </div>
        </div>
      )}
    </header>
  );
};
