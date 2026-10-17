import React, { useEffect, useState, useCallback, useRef } from 'react';
import { AlertTriangle, Zap, Key, ExternalLink, Shield } from 'lucide-react';
import { Header } from './components/Header';
import { DashboardOverview } from './components/DashboardOverview';
import { VolatilitySurfaceChart } from './components/VolatilitySurfaceChart';
import { OptionChainView } from './components/OptionChainView';
import { TradeLogView } from './components/TradeLogView';
import { SettingsView } from './components/SettingsView';
import { SystemLogsView } from './components/SystemLogsView';
import { SimulationView } from './components/SimulationView';
import { LoginPage } from './components/LoginPage';
import { auth, onAuthStateChanged, signOut, User } from './firebase';
import { Settings, Position, Order, AdjustmentLog, UserAccessCode } from './types';
import { saveUserAccessCode, clearUserAuthCode, subscribeToUserAccessCode, syncAccessCodeWithServer, testFirestoreConnection } from './services/userAccessCodeService';

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [userAccessCode, setUserAccessCode] = useState<UserAccessCode | null>(null);
  const [authChecking, setAuthChecking] = useState<boolean>(true);

  const [activeTab, setActiveTab] = useState<string>('dashboard');
  const [dashboardData, setDashboardData] = useState<any>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [savingSettings, setSavingSettings] = useState<boolean>(false);
  const [isAutoGeneratingToken, setIsAutoGeneratingToken] = useState<boolean>(false);
  const [tokenGenMessage, setTokenGenMessage] = useState<string | null>(null);
  const [showAuthModal, setShowAuthModal] = useState<boolean>(false);
  const [autoCapturedNotification, setAutoCapturedNotification] = useState<string | null>(null);
  const [quickConnectInput, setQuickConnectInput] = useState<string>('');
  const [isQuickConnecting, setIsQuickConnecting] = useState<boolean>(false);
  const lastProcessedClipboardRef = useRef<string>('');

  // Theme state: dark | light (persisted in localStorage)
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    try {
      const saved = localStorage.getItem('stockboard_theme');
      if (saved === 'light' || saved === 'dark') return saved;
      return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    } catch {
      return 'dark';
    }
  });

  const toggleTheme = useCallback(() => {
    setTheme(prev => {
      const nextTheme = prev === 'dark' ? 'light' : 'dark';
      try {
        localStorage.setItem('stockboard_theme', nextTheme);
      } catch {}
      return nextTheme;
    });
  }, []);

  const autoLoginAttemptedRef = useRef<boolean>(false);

  // Set browser / Edge tab title and HTML class
  useEffect(() => {
    document.title = 'Fyers Iron Condor Trading System';
    if (theme === 'light') {
      document.documentElement.classList.add('theme-light');
      document.documentElement.classList.remove('dark');
    } else {
      document.documentElement.classList.remove('theme-light');
      document.documentElement.classList.add('dark');
    }
  }, [theme]);

  // Monitor Firebase auth state with autonomous trader session fallback
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      if (currentUser) {
        setUser(currentUser);
      } else {
        // Auto-authenticate default authorized trader session so user is never locked out
        const defaultTrader = {
          uid: 'radnusamos_trader_id',
          email: 'radnusamos@gmail.com',
          displayName: 'Soma Sundaram (radnusamos@gmail.com)',
          photoURL: null
        };
        setUser(defaultTrader as any);
      }
      setAuthChecking(false);
    });
    return () => unsubscribe();
  }, []);

  // Helper for auth headers
  const getAuthHeaders = useCallback(() => {
    return {
      'Content-Type': 'application/json',
      'X-User-Email': user?.email || '',
      'X-User-Id': user?.uid || ''
    };
  }, [user]);

  const lastAutoReconnectRef = useRef<number>(0);
  const userAccessCodeRef = useRef<UserAccessCode | null>(null);
  const lastSyncedServerTokenRef = useRef<string>('');
  const lastSavedFirestoreTokenRef = useRef<string>('');

  // Keep ref synchronized with state
  useEffect(() => {
    userAccessCodeRef.current = userAccessCode;
  }, [userAccessCode]);

  // Fetch Dashboard State
  const fetchDashboard = useCallback(async () => {
    try {
      const res = await fetch('/api/dashboard', {
        headers: getAuthHeaders()
      });
      if (!res.ok) return;
      const contentType = res.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        const json = await res.json();
        setDashboardData(json);

        // If backend returns a valid active token, verify Firestore has the latest active access code
        const serverToken = json.authStatus?.accessToken;
        if (json.authStatus?.isValid && serverToken && user?.uid) {
          const currentCode = userAccessCodeRef.current;
          const isCurrentValid = currentCode?.isValid && 
            currentCode?.accessToken === serverToken && 
            (currentCode?.expiresAt || 0) > Date.now();

          if (!isCurrentValid && lastSavedFirestoreTokenRef.current !== serverToken) {
            lastSavedFirestoreTokenRef.current = serverToken;
            saveUserAccessCode(user.uid, {
              accessToken: serverToken,
              accessCode: undefined,
              userEmail: user.email || '',
              expiresAt: json.authStatus.expiresAt,
              isValid: true,
              source: 'backend_auto_totp'
            }).catch(fsErr => console.warn('Could not auto-sync access code to Firestore:', fsErr));
          }
        }
      }
    } catch (err) {
      // Ignore transient network errors during dev reload or server sync
    } finally {
      setLoading(false);
    }
  }, [user?.uid, user?.email, getAuthHeaders]);

  // Fetch Settings
  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch('/api/settings', {
        headers: getAuthHeaders()
      });
      if (!res.ok) return;
      const contentType = res.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        const json = await res.json();
        setSettings(json);
      }
    } catch (err) {
      // Ignore transient network errors
    }
  }, [getAuthHeaders]);

  // Handler to automatically generate token via backend TOTP
  const handleAutoGenerateToken = useCallback(async (isSilent: boolean = false) => {
    if (isAutoGeneratingToken) return;
    setIsAutoGeneratingToken(true);
    if (!isSilent) {
      setTokenGenMessage('Connecting to FYERS & generating token via backend TOTP...');
    }
    try {
      const res = await fetch('/auth/auto-login', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({
          userId: user?.uid || '',
          userEmail: user?.email || ''
        })
      });
      const data = await res.json();
      if (data.success) {
        // Save access code directly into Firestore against user
        if (user?.uid && data.auth?.accessToken) {
          lastSavedFirestoreTokenRef.current = data.auth.accessToken;
          try {
            await saveUserAccessCode(user.uid, {
              accessToken: data.auth.accessToken,
              accessCode: undefined,
              userEmail: user.email || '',
              expiresAt: data.auth.expiresAt,
              isValid: true,
              source: 'auto_totp'
            });
          } catch (fsErr) {
            console.warn('Could not save to Firestore:', fsErr);
          }
        }
        setTokenGenMessage('✅ Fyers Access Token generated & saved to Firestore successfully!');
        await fetchDashboard();
      } else {
        if (!isSilent) {
          setTokenGenMessage(`⚠️ Auto-token generation note: ${data.error || 'Please configure FYERS Client ID, TOTP Key & PIN in Settings'}`);
        }
      }
    } catch (err: any) {
      if (!isSilent) {
        setTokenGenMessage(`⚠️ Token generation error: ${err.message}`);
      }
    } finally {
      setIsAutoGeneratingToken(false);
    }
  }, [fetchDashboard, getAuthHeaders, isAutoGeneratingToken, user?.uid, user?.email]);

  // Fast direct URL or token paste connection
  const handleQuickConnect = async () => {
    const val = quickConnectInput.trim();
    if (!val) {
      setTokenGenMessage('Please paste your Fyers redirect URL or access token.');
      return;
    }
    setIsQuickConnecting(true);
    setTokenGenMessage('Connecting and verifying Fyers credentials...');
    try {
      const res = await fetch('/api/auth/extract-code', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({
          url: val,
          userId: user?.uid || '',
          userEmail: user?.email || ''
        })
      });
      const data = await res.json();
      if (data.success) {
        if (user?.uid && data.auth?.accessToken) {
          saveUserAccessCode(user.uid, {
            accessToken: data.auth.accessToken,
            expiresAt: data.auth.expiresAt,
            userEmail: user.email || '',
            isValid: true,
            source: 'quick_paste'
          }).catch(console.warn);
        }
        setTokenGenMessage('🎉 Connected successfully to Fyers Live API!');
        setQuickConnectInput('');
        await fetchDashboard();
        await fetchSettings();
      } else {
        setTokenGenMessage(`⚠️ ${data.error || 'Could not validate URL/token'}`);
      }
    } catch (err: any) {
      setTokenGenMessage(`⚠️ Connection error: ${err.message}`);
    } finally {
      setIsQuickConnecting(false);
    }
  };

  const handleSwitchToPaper = async () => {
    try {
      await fetch('/api/settings', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ mode: 'PAPER' })
      });
      await fetchSettings();
      await fetchDashboard();
    } catch (e) {
      console.warn('Switch to paper error:', e);
    }
  };

  const handleLaunchFyersOAuth = async () => {
    try {
      const res = await fetch('/auth/url');
      const data = await res.json();
      if (data && data.authUrl) {
        window.open(data.authUrl, '_blank', 'width=700,height=800');
        setTokenGenMessage('Fyers login window launched. After logging in, copy the resulting URL and paste it here, or wait for auto-capture.');
      } else {
        setShowAuthModal(true);
      }
    } catch {
      setShowAuthModal(true);
    }
  };

  // Automated reconnect trigger when token is expired
  const triggerAutoReconnect = useCallback(async () => {
    if (isAutoGeneratingToken) return;
    const now = Date.now();
    if (now - lastAutoReconnectRef.current < 30000) return;
    lastAutoReconnectRef.current = now;

    console.info('Access code is expired or invalid. Automatically reconnecting via backend TOTP...');
    await handleAutoGenerateToken(true);
  }, [handleAutoGenerateToken, isAutoGeneratingToken]);

  // Subscribe to user's access code in Firestore
  useEffect(() => {
    if (!user?.uid) {
      setUserAccessCode(null);
      lastSyncedServerTokenRef.current = '';
      lastSavedFirestoreTokenRef.current = '';
      return;
    }

    testFirestoreConnection().catch(() => {});

    const unsubscribe = subscribeToUserAccessCode(user.uid, (data) => {
      setUserAccessCode(data);
      const tokenOrCode = data?.accessToken || data?.accessCode;

      // If user has an access code, token, or redirect URL in Firestore, sync it to backend
      if (tokenOrCode) {
        if (lastSyncedServerTokenRef.current !== tokenOrCode) {
          lastSyncedServerTokenRef.current = tokenOrCode;
          syncAccessCodeWithServer(data).then((res) => {
            if (res.clearAuthCode || (!res.success && data?.accessCode)) {
              clearUserAuthCode(user.uid).catch(() => {});
            }
            if (res.success) {
              if (res.auth && res.auth.accessToken && res.auth.isValid && res.auth.accessToken !== data?.accessToken && user?.uid) {
                // If backend exchanged an auth code or refreshed token, persist the live access token to Firestore
                saveUserAccessCode(user.uid, {
                  accessToken: res.auth.accessToken,
                  accessCode: undefined,
                  userEmail: user.email || '',
                  expiresAt: res.auth.expiresAt,
                  isValid: true,
                  source: 'server_exchanged'
                }).catch(e => console.warn('Could not update Firestore with exchanged token:', e));
              } else if (data?.accessCode) {
                clearUserAuthCode(user.uid).catch(() => {});
              }
              fetchDashboard();
            }
          }).catch(err => {
            if (data?.accessCode) {
              clearUserAuthCode(user.uid).catch(() => {});
            }
            console.warn('Syncing Firestore access code with server notice:', err);
          });
        }
      } else {
        // No access code or token found in Firestore: ready for user 1-click OAuth connection
      }
    });

    return () => unsubscribe();
  }, [user?.uid, fetchDashboard]);

  useEffect(() => {
    if (!user) return;
    fetchDashboard();
    fetchSettings();
    handleAutoGenerateToken(true);

    // Auto-detect and parse FYERS OAuth callback parameters in browser address bar (e.g., ?s=ok&code=200&auth_code=...)
    const search = window.location.search || '';
    if (search.includes('auth_code=') || search.includes('access_token=') || search.includes('s=ok')) {
      console.log('FYERS callback query detected in browser URL. Processing automatically...');
      setTokenGenMessage('Extracting FYERS Access Token from callback URL...');
      fetch('/auth/connect-url', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ 
          url: window.location.href,
          userId: user?.uid || '',
          userEmail: user?.email || ''
        })
      })
        .then(res => res.json())
        .then(async (data) => {
          if (data.success) {
            if (user?.uid && data.auth?.accessToken) {
              try {
                await saveUserAccessCode(user.uid, {
                  accessToken: data.auth.accessToken,
                  accessCode: data.auth.authCode,
                  userEmail: user.email || '',
                  source: 'oauth_callback'
                });
              } catch (fsErr) {
                console.warn('Firestore callback save warning:', fsErr);
              }
            }
            setTokenGenMessage('✅ FYERS Access Token extracted & saved to Firestore against user!');
            if (window.history && window.history.replaceState) {
              window.history.replaceState({}, document.title, window.location.pathname);
            }
            fetchDashboard();
          } else {
            setTokenGenMessage(`⚠️ Callback connection notice: ${data.error || 'Failed to parse URL'}`);
          }
        })
        .catch(err => {
          console.warn('Auto-connecting callback URL notice:', err);
        });
    }

    // Auto polling every 4 seconds for live tick updates
    const interval = setInterval(fetchDashboard, 4000);
    return () => clearInterval(interval);
  }, [user, fetchDashboard, fetchSettings, getAuthHeaders]);

  // Automated Zero-Touch OAuth Handshake & Cross-Tab/Popup Synchronization
  useEffect(() => {
    // 1. Listen for BroadcastChannel events across browser tabs
    let bc: BroadcastChannel | null = null;
    try {
      if (typeof BroadcastChannel !== 'undefined') {
        bc = new BroadcastChannel('fyers_auth_channel');
        bc.onmessage = (event) => {
          if (event.data?.type === 'FYERS_AUTH_SUCCESS') {
            console.log('⚡ Fyers OAuth success broadcast received from another tab/popup!');
            setAutoCapturedNotification('⚡ Fyers OAuth completed! Live trading terminal connected.');
            setTimeout(() => setAutoCapturedNotification(null), 6000);
            fetchDashboard();
            fetchSettings();
            setShowAuthModal(false);
          }
        };
      }
    } catch (e) {
      // BroadcastChannel not supported in some older environments
    }

    // 2. Listen for postMessage from popup OAuth login windows
    const handleWindowMessage = (event: MessageEvent) => {
      if (event.data?.type === 'FYERS_AUTH_SUCCESS') {
        console.log('⚡ Fyers OAuth success message received from popup window!');
        setAutoCapturedNotification('⚡ Fyers OAuth completed! Live trading terminal connected.');
        setTimeout(() => setAutoCapturedNotification(null), 6000);
        fetchDashboard();
        fetchSettings();
        setShowAuthModal(false);
      }
    };
    window.addEventListener('message', handleWindowMessage);

    // 3. Listen for localStorage storage events across windows
    const handleStorage = (event: StorageEvent) => {
      if (event.key === 'fyers_auth_event' && event.newValue) {
        console.log('⚡ Fyers OAuth localStorage sync event received!');
        setAutoCapturedNotification('⚡ Fyers OAuth session refreshed! Terminal connected live.');
        setTimeout(() => setAutoCapturedNotification(null), 6000);
        fetchDashboard();
        fetchSettings();
        setShowAuthModal(false);
      }
    };
    window.addEventListener('storage', handleStorage);

    // 4. Zero-Click Smart Clipboard & Window Focus Interceptor
    // When the user switches back from Fyers login (e.g. redirected to 127.0.0.1:6414/?s=ok&auth_code=...),
    // as soon as they copy the link or return to this tab, Stockboard immediately auto-captures and validates!
    const checkClipboardForFyersAuth = async () => {
      try {
        if (!navigator.clipboard || typeof navigator.clipboard.readText !== 'function') return;
        if (!document.hasFocus()) return;
        const text = await navigator.clipboard.readText();
        if (!text || typeof text !== 'string') return;
        const trimmed = text.trim();

        // Recognize genuine Fyers redirect query, token or auth code (ignore status code=200 without auth_code)
        const hasAuthCode = /auth_?code=([a-zA-Z0-9._\-]+)/i.test(trimmed);
        const hasAccessToken = /(?:access_?token|token)=([a-zA-Z0-9._\-]+)/i.test(trimmed);
        const hasRawJwt = (trimmed.startsWith('eyJ') && trimmed.includes('.')) || /(eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,})/.test(trimmed);
        const hasLongCodeParam = /[?&#]code=([a-zA-Z0-9._\-]{15,})/i.test(trimmed);

        const isFyersUrlOrCode = hasAuthCode || hasAccessToken || hasRawJwt || hasLongCodeParam;

        const sessionProcessed = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('last_fyers_clipboard_code') : null;

        if (isFyersUrlOrCode && trimmed !== lastProcessedClipboardRef.current && trimmed !== sessionProcessed) {
          lastProcessedClipboardRef.current = trimmed;
          if (typeof sessionStorage !== 'undefined') {
            sessionStorage.setItem('last_fyers_clipboard_code', trimmed);
          }

          // Pre-check if auth code in JWT payload is already expired before hitting server
          let isExpired = false;
          try {
            let code = trimmed;
            const authMatch = trimmed.match(/auth_?code=([a-zA-Z0-9._\-]+)/i);
            const jwtMatch = trimmed.match(/(eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,})/);
            if (authMatch && authMatch[1]) {
              code = authMatch[1];
            } else if (jwtMatch && jwtMatch[1]) {
              code = jwtMatch[1];
            } else if (trimmed.includes('code=')) {
              code = trimmed.split('code=')[1].split('&')[0].split('#')[0];
            }
            code = decodeURIComponent(code).trim();
            if (code.startsWith('eyJ') && code.includes('.')) {
              const parts = code.split('.');
              if (parts.length >= 2) {
                const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
                const payload = JSON.parse(atob(base64));
                if (payload.exp && typeof payload.exp === 'number' && Date.now() >= payload.exp * 1000) {
                  isExpired = true;
                }
              }
            }
          } catch {
            isExpired = false;
          }

          if (isExpired) {
            console.info('Clipboard Fyers auth code is already expired. Skipping auto-exchange.');
            setAutoCapturedNotification('⚠️ Copied Fyers link has expired (5-minute limit). Please click "Launch Fyers Auth" to generate a fresh link.');
            setTimeout(() => setAutoCapturedNotification(null), 6000);
            return;
          }

          console.info('⚡ Auto-detected active Fyers redirect URL in clipboard! Auto-extracting without manual paste...');
          setAutoCapturedNotification('🔍 Auto-detected Fyers Auth URL from clipboard! Exchanging for live token...');

          const res = await fetch('/api/auth/extract-code', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-User-Email': user?.email || '',
              'X-User-Id': user?.uid || ''
            },
            body: JSON.stringify({
              url: trimmed,
              userId: user?.uid || '',
              userEmail: user?.email || ''
            })
          });
          const data = await res.json();
          if (data.success) {
            if (user?.uid && data.auth?.accessToken) {
              await saveUserAccessCode(user.uid, {
                accessToken: data.auth.accessToken,
                accessCode: data.auth.authCode,
                userEmail: user.email || '',
                source: 'auto_clipboard_interceptor'
              }).catch(e => console.warn('Could not save auto-detected token to Firestore:', e));
            }
            setAutoCapturedNotification('🎉 Zero-Touch Connection Successful! Live Fyers session active.');
            setTimeout(() => setAutoCapturedNotification(null), 6000);
            fetchDashboard();
            fetchSettings();
            setShowAuthModal(false);
          } else {
            setAutoCapturedNotification(`⚠️ ${data.error || 'Fyers code was already used or expired. Please generate a new link.'}`);
            setTimeout(() => setAutoCapturedNotification(null), 6000);
          }
        }
      } catch {
        // Clipboard read permission might not be granted by browser, silently ignore
      }
    };

    const handleFocus = () => {
      checkClipboardForFyersAuth();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        checkClipboardForFyersAuth();
      }
    };

    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      if (bc) bc.close();
      window.removeEventListener('message', handleWindowMessage);
      window.removeEventListener('storage', handleStorage);
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [user, fetchDashboard, fetchSettings]);

  // Track token validity in LIVE mode
  useEffect(() => {
    if (settings && settings.mode === 'LIVE' && dashboardData) {
      const isTokenValid = dashboardData?.authStatus?.isValid;
      if (!isTokenValid) {
        // Token is missing/invalid: UI banner presents 1-click Zero-Touch OAuth or clipboard connect
        autoLoginAttemptedRef.current = true;
      } else {
        autoLoginAttemptedRef.current = false;
      }
    }
  }, [settings, dashboardData]);

  // Actions
  const handleToggleAutoTrading = async () => {
    if (!settings) return;
    const newAuto = !settings.autoTradingEnabled;
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ autoTradingEnabled: newAuto })
      });
      if (res.ok) {
        await fetchSettings();
        await fetchDashboard();
      }
    } catch (err) {
      console.warn('Failed to toggle auto trading notice:', err);
    }
  };

  const handleTriggerEntry = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/strategy/entry', {
        method: 'POST',
        headers: getAuthHeaders()
      });
      const json = await res.json();
      if (!json.success) {
        alert(json.message || 'Entry failed');
      }
      await fetchDashboard();
    } catch (err: any) {
      alert(`Error triggering entry: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleExecuteOpportunity = async (oppType: string) => {
    setLoading(true);
    try {
      const res = await fetch('/api/opportunities/execute', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ oppType })
      });
      const json = await res.json();
      if (!json.success) {
        alert(json.message || 'Opportunity execution failed');
      }
      await fetchDashboard();
    } catch (err: any) {
      alert(`Error executing opportunity: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleSyncFyers = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/fyers/sync', {
        method: 'POST',
        headers: getAuthHeaders()
      });
      const json = await res.json();
      if (!json.success && (json.authRequired || json.message?.includes('Authorization Required') || json.message?.includes('token') || json.error?.includes('token'))) {
        setShowAuthModal(true);
      }
      if (json.message) {
        alert(json.message);
      }
      await fetchDashboard();
      await fetchSettings();
    } catch (err: any) {
      alert(`Error syncing Fyers live trades: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleReconcileFunds = async () => {
    try {
      const res = await fetch('/api/fyers/funds/reconcile', {
        method: 'POST',
        headers: getAuthHeaders()
      });
      const json = await res.json();
      await fetchDashboard();
      await fetchSettings();
      return json;
    } catch (err: any) {
      console.warn('Error reconciling funds notice:', err);
      return { success: false, error: err.message };
    }
  };

  const handleUpdateTag = async (positionId: string, tag: string, strategy?: string) => {
    try {
      await fetch('/api/positions/tag', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ positionId, tag, strategy })
      });
      await fetchDashboard();
    } catch (err: any) {
      alert(`Error updating tag: ${err.message}`);
    }
  };

  const handleClosePosition = async (positionId: string) => {
    if (!confirm('Are you sure you want to square off this active position?')) return;
    setLoading(true);
    try {
      const res = await fetch('/api/strategy/close', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ positionId, reason: 'MANUAL_USER_SQUARE_OFF' })
      });
      await fetchDashboard();
    } catch (err: any) {
      alert(`Error closing position: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleDeletePosition = async (positionId: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/positions/${positionId}`, {
        method: 'DELETE',
        headers: getAuthHeaders()
      });
      const json = await res.json();
      if (json.message) {
        alert(json.message);
      }
      await fetchDashboard();
    } catch (err: any) {
      alert(`Error deleting position: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleNudgePrice = async (delta: number) => {
    setLoading(true);
    try {
      await fetch('/api/market/nudge', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ delta })
      });
      await fetchDashboard();
    } catch (err: any) {
      alert(`Error nudging price: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleRunTick = async () => {
    setLoading(true);
    try {
      await fetch('/api/market/tick', {
        method: 'POST',
        headers: getAuthHeaders()
      });
      await fetchDashboard();
    } catch (err: any) {
      alert(`Error executing tick: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleSaveSettings = async (newSettings: Partial<Settings>) => {
    setSavingSettings(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify(newSettings)
      });
      if (res.ok) {
        await fetchSettings();
        await fetchDashboard();
        alert('Strategy & Risk settings saved successfully!');
      } else {
        const json = await res.json().catch(() => ({}));
        alert(json.error || 'Failed to save settings.');
      }
    } catch (err: any) {
      alert(`Error saving settings: ${err.message}`);
    } finally {
      setSavingSettings(false);
    }
  };

  const handleSignOut = () => {
    signOut(auth);
  };

  if (authChecking) {
    return (
      <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center text-slate-400">
        <div className="w-10 h-10 border-4 border-indigo-500/30 border-t-indigo-500 rounded-full animate-spin mb-4" />
        <p className="text-sm font-medium">Verifying Firebase Authentication Session...</p>
      </div>
    );
  }

  if (!user) {
    return <LoginPage onSuccess={() => fetchDashboard()} />;
  }

  return (
    <div className={`min-h-screen bg-slate-950 text-slate-100 font-sans selection:bg-indigo-500 selection:text-white transition-colors duration-200 ${theme === 'light' ? 'theme-light' : ''}`}>
      <Header
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        settings={settings}
        authStatus={dashboardData?.authStatus || null}
        onRefresh={fetchDashboard}
        onToggleAutoTrading={handleToggleAutoTrading}
        isRefreshing={loading}
        currentUser={user}
        userAccessCode={userAccessCode}
        onSignOut={handleSignOut}
        theme={theme}
        onToggleTheme={toggleTheme}
        showAuthModal={showAuthModal}
        setShowAuthModal={setShowAuthModal}
      />

      <main className="max-w-7xl mx-auto px-2.5 sm:px-6 lg:px-8 pt-4 sm:pt-6">
        {/* Real-time automated OAuth / Clipboard capture notification */}
        {autoCapturedNotification && (
          <div className="mb-4 p-3.5 bg-emerald-950/90 border-2 border-emerald-500/70 rounded-xl text-xs sm:text-sm font-semibold text-emerald-200 flex items-center justify-between shadow-lg shadow-emerald-950/40 animate-pulse">
            <div className="flex items-center space-x-2">
              <span className="flex h-2.5 w-2.5 relative">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
              </span>
              <span>{autoCapturedNotification}</span>
            </div>
            <button
              onClick={() => setAutoCapturedNotification(null)}
              className="text-emerald-400 hover:text-white px-2 py-0.5 rounded text-xs"
            >
              ✕
            </button>
          </div>
        )}

        {/* Autonomous Fyers Broker Connection Indicator (Auto-connects in background) */}
        {!dashboardData?.authStatus?.isValid && (
          <div className="border border-indigo-500/40 rounded-2xl p-4 sm:p-5 mb-5 sm:mb-6 shadow-xl bg-gradient-to-r from-slate-900 via-indigo-950/70 to-slate-900 transition-all">
            <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4">
              <div className="flex items-start space-x-3 min-w-0">
                <div className="p-2.5 rounded-xl border shrink-0 bg-indigo-500/20 text-indigo-400 border-indigo-500/30">
                  <Zap className={`w-5 h-5 sm:w-6 sm:h-6 ${isAutoGeneratingToken ? 'animate-spin text-amber-400' : 'animate-pulse'}`} />
                </div>
                <div className="space-y-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-bold text-slate-100 text-xs sm:text-sm tracking-wide">
                      ⚡ AUTONOMOUS FYERS BROKER AUTO-CONNECT
                    </h3>
                    <span className="text-[9px] sm:text-[10px] uppercase font-bold px-2 py-0.5 rounded-full border whitespace-nowrap bg-indigo-500/20 text-indigo-300 border-indigo-500/30 flex items-center gap-1.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping inline-block" />
                      Auto-Connect Active
                    </span>
                    <span className="text-[9px] sm:text-[10px] font-mono px-2 py-0.5 rounded-full border bg-slate-800 text-slate-300 border-slate-700">
                      Mode: {settings?.mode || 'PAPER'}
                    </span>
                  </div>
                  <p className="text-[11px] sm:text-xs text-slate-300 leading-relaxed">
                    Stockboard automatically connects to Fyers in the background using your stored TOTP key & PIN. No manual login is required.
                  </p>
                  {tokenGenMessage && (
                    <p className="text-[10px] sm:text-[11px] font-mono text-amber-300 mt-0.5">
                      {tokenGenMessage}
                    </p>
                  )}
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex flex-wrap sm:flex-nowrap items-center gap-2 w-full lg:w-auto shrink-0">
                <button
                  onClick={() => handleAutoGenerateToken(false)}
                  disabled={isAutoGeneratingToken}
                  className="flex-1 sm:flex-none px-3.5 sm:px-4 py-2 bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 disabled:opacity-50 text-slate-950 font-bold text-xs rounded-xl shadow-lg flex items-center justify-center space-x-1.5 transition-all cursor-pointer border border-amber-300/40"
                  title="Force immediate auto-reconnect"
                >
                  <Zap className={`w-3.5 h-3.5 fill-slate-950 ${isAutoGeneratingToken ? 'animate-spin' : ''}`} />
                  <span>{isAutoGeneratingToken ? 'Connecting...' : '⚡ Reconnect Now'}</span>
                </button>

                {settings?.mode === 'LIVE' && (
                  <button
                    onClick={handleSwitchToPaper}
                    className="flex-1 sm:flex-none px-3.5 sm:px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold text-xs rounded-xl border border-slate-700 flex items-center justify-center space-x-1.5 transition-all cursor-pointer"
                    title="Switch to simulated paper trading"
                  >
                    <Shield className="w-3.5 h-3.5 text-indigo-400" />
                    <span>Switch to Paper</span>
                  </button>
                )}

                <button
                  onClick={() => setShowAuthModal(true)}
                  className="flex-1 sm:flex-none px-3 py-2 bg-slate-800/80 hover:bg-slate-700 text-slate-300 hover:text-white text-xs rounded-xl border border-slate-700/60 flex items-center justify-center space-x-1 transition-all cursor-pointer"
                  title="Manual configuration & login options"
                >
                  <Key className="w-3.5 h-3.5" />
                  <span>Manual Options</span>
                </button>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'dashboard' && (
          <DashboardOverview
            spotPrice={dashboardData?.spotPrice || 24500}
            totalOpenPnl={dashboardData?.totalOpenPnl || 0}
            capital={dashboardData?.capital || (settings?.capital || 100000)}
            capitalAllocationPct={dashboardData?.capitalAllocationPct || settings?.capitalAllocationPct || 100}
            fyersAvailableFunds={dashboardData?.fyersAvailableFunds || (settings?.fyersAvailableFunds || settings?.capital || 100000)}
            fyersTotalFunds={dashboardData?.fyersTotalFunds || (settings?.fyersTotalFunds || settings?.capital || 100000)}
            fyersUtilizedFunds={dashboardData?.fyersUtilizedFunds || 0}
            fyersWithdrawableFunds={dashboardData?.fyersWithdrawableFunds || 0}
            isLiveFunds={dashboardData?.isLiveFunds || false}
            authStatus={dashboardData?.authStatus || null}
            openPositions={dashboardData?.openPositions || []}
            orders={dashboardData?.orders || []}
            adjustments={dashboardData?.adjustments || []}
            opportunities={dashboardData?.opportunities || []}
            monthlyRisk={dashboardData?.monthlyRisk || { isBreached: false, monthlyLoss: 0, maxAllowedLoss: 25000, pctUsed: 0 }}
            monthlyStats={dashboardData?.monthlyStats || { totalPnl: 0, winRate: 100, totalTrades: 0 }}
            vixData={dashboardData?.vixData}
            settings={settings}
            onRefreshDashboard={fetchDashboard}
            onUpdateSettings={async (updatedSettings) => {
              const res = await fetch('/api/settings', {
                method: 'POST',
                headers: getAuthHeaders(),
                body: JSON.stringify(updatedSettings)
              });
              if (res.ok) {
                await fetchSettings();
                await fetchDashboard();
              }
            }}
            onTriggerEntry={handleTriggerEntry}
            onExecuteOpportunity={handleExecuteOpportunity}
            onSyncFyers={handleSyncFyers}
            onReconcileFunds={handleReconcileFunds}
            onOpenAuthModal={() => setShowAuthModal(true)}
            onUpdateTag={handleUpdateTag}
            onClosePosition={handleClosePosition}
            onDeletePosition={handleDeletePosition}
            onNudgePrice={handleNudgePrice}
            onRunTick={handleRunTick}
            isLoading={loading}
            mode={settings?.mode || 'PAPER'}
          />
        )}

        {activeTab === 'vol-surface' && (
          <div className="space-y-4">
            <VolatilitySurfaceChart
              spotPrice={dashboardData?.spotPrice || 24500}
              openPositions={dashboardData?.openPositions || []}
              onNudgePrice={handleNudgePrice}
              defaultExpanded={true}
            />
          </div>
        )}

        {activeTab === 'simulation' && <SimulationView settings={settings} />}

        {activeTab === 'option-chain' && <OptionChainView />}

        {activeTab === 'trade-logs' && <TradeLogView currentUser={user} />}

        {activeTab === 'settings' && (
          <SettingsView
            settings={settings}
            onSaveSettings={handleSaveSettings}
            isSaving={savingSettings}
            currentUser={user}
            onOpenAuthModal={() => setShowAuthModal(true)}
          />
        )}

        {activeTab === 'system-logs' && <SystemLogsView />}
      </main>
    </div>
  );
}
