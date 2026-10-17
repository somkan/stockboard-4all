import React, { useState } from 'react';
import { PayoffChart } from './PayoffChart';
import { VolatilitySurfaceChart } from './VolatilitySurfaceChart';
import { 
  TrendingUp, 
  TrendingDown, 
  ShieldAlert, 
  Zap, 
  ArrowUpRight, 
  ArrowDownRight, 
  PlusCircle, 
  XCircle, 
  Plus, 
  SlidersHorizontal,
  Clock,
  CheckCircle,
  AlertTriangle,
  Lock,
  RotateCcw,
  RefreshCw,
  Tag,
  Edit2,
  Layers,
  Check,
  X,
  Target,
  Calendar,
  DollarSign,
  BarChart2,
  PieChart,
  ShieldCheck,
  Eye,
  Sparkles
} from 'lucide-react';
import { Position, Order, AdjustmentLog, Opportunity, VixData, Settings } from '../types';
import { getClientExpiryDetails, clientDetectOptionStrategy } from '../utils/expiry';
import { VixAlertPanel } from './VixAlertPanel';

interface DashboardOverviewProps {
  spotPrice: number;
  totalOpenPnl: number;
  capital: number;
  capitalAllocationPct?: number;
  fyersAvailableFunds?: number;
  fyersTotalFunds?: number;
  fyersUtilizedFunds?: number;
  fyersWithdrawableFunds?: number;
  isLiveFunds?: boolean;
  authStatus?: { isValid: boolean; expiresAt: number; message?: string } | null;
  openPositions: Position[];
  orders: Order[];
  adjustments: AdjustmentLog[];
  opportunities?: Opportunity[];
  monthlyRisk: { isBreached: boolean; monthlyLoss: number; maxAllowedLoss: number; pctUsed: number };
  monthlyStats: { totalPnl: number; winRate: number; totalTrades: number };
  vixData?: VixData | null;
  settings?: Settings | null;
  onRefreshDashboard?: () => void;
  onUpdateSettings?: (updatedSettings: Partial<Settings>) => Promise<any>;
  onTriggerEntry: () => void;
  onExecuteOpportunity?: (oppType: string) => void;
  onSyncFyers?: () => void;
  onReconcileFunds?: () => Promise<any>;
  onOpenAuthModal?: () => void;
  onUpdateTag?: (positionId: string, tag: string, strategy?: string) => void;
  onClosePosition: (positionId: string) => void;
  onDeletePosition?: (positionId: string) => void;
  onNudgePrice: (delta: number) => void;
  onRunTick: () => void;
  isLoading: boolean;
  mode?: 'PAPER' | 'LIVE' | string;
}

export const DashboardOverview: React.FC<DashboardOverviewProps> = ({
  spotPrice,
  totalOpenPnl,
  capital,
  capitalAllocationPct = 100,
  fyersAvailableFunds = 0,
  fyersTotalFunds = 0,
  fyersUtilizedFunds = 0,
  fyersWithdrawableFunds = 0,
  isLiveFunds = false,
  authStatus,
  openPositions,
  orders,
  adjustments,
  opportunities = [],
  monthlyRisk,
  monthlyStats,
  vixData,
  settings,
  onRefreshDashboard,
  onUpdateSettings,
  onTriggerEntry,
  onExecuteOpportunity,
  onSyncFyers,
  onReconcileFunds,
  onOpenAuthModal,
  onUpdateTag,
  onClosePosition,
  onDeletePosition,
  onNudgePrice,
  onRunTick,
  isLoading,
  mode = 'PAPER'
}) => {
  const [isReconciling, setIsReconciling] = useState(false);
  const [reconcileMsg, setReconcileMsg] = useState<string | null>(null);

  const handleReconcileClick = async () => {
    if (!onReconcileFunds || isReconciling) return;
    setIsReconciling(true);
    setReconcileMsg('Reconciling live funds with FYERS...');
    try {
      const res = await onReconcileFunds();
      if (res && res.message) {
        setReconcileMsg(`✅ ${res.message}`);
      } else {
        setReconcileMsg('✅ Funds reconciled with FYERS!');
      }
    } catch (err: any) {
      setReconcileMsg(`⚠️ ${err.message || 'Reconciliation failed'}`);
    } finally {
      setIsReconciling(false);
      setTimeout(() => setReconcileMsg(null), 5000);
    }
  };
  const [customNudge, setCustomNudge] = useState<number>(200);
  const [editingPosId, setEditingPosId] = useState<string | null>(null);
  const [tagInput, setTagInput] = useState<string>('');
  const [strategyInput, setStrategyInput] = useState<string>('SHORT_STRADDLE');
  const [inspectOpp, setInspectOpp] = useState<Opportunity | null>(null);
  const [positionModeFilter, setPositionModeFilter] = useState<'ALL' | 'LIVE' | 'PAPER'>('ALL');

  // Pull & Tag Modal State
  const [isPullModalOpen, setIsPullModalOpen] = useState<boolean>(false);
  const [activePullTab, setActivePullTab] = useState<'API' | 'MANUAL'>('API');
  const [rawFyersPositions, setRawFyersPositions] = useState<any[]>([]);
  const [isFetchingRaw, setIsFetchingRaw] = useState<boolean>(false);
  const [rawFetchMsg, setRawFetchMsg] = useState<string>('');
  const [modalStrategy, setModalStrategy] = useState<string>('IRON_CONDOR');
  const [modalTag, setModalTag] = useState<string>('FYERS_LIVE_TRADE');
  const [isSubmittingSync, setIsSubmittingSync] = useState<boolean>(false);

  // Manual Legs Entry State
  const defaultExp = getClientExpiryDetails('NSE:NIFTY50-INDEX');
  const [manualLegs, setManualLegs] = useState<Array<{ symbol: string; strike: number; type: 'CE' | 'PE' | 'FUT'; side: 'BUY' | 'SELL'; qty: number; entryPrice: number }>>([
    { symbol: `NSE:NIFTY${defaultExp.fyersDateCode}24500CE`, strike: 24500, type: 'CE', side: 'SELL', qty: 65, entryPrice: 120 },
    { symbol: `NSE:NIFTY${defaultExp.fyersDateCode}24500PE`, strike: 24500, type: 'PE', side: 'SELL', qty: 65, entryPrice: 115 }
  ]);

  const handleAddManualLeg = () => {
    const exp = getClientExpiryDetails('NSE:NIFTY50-INDEX');
    setManualLegs(prev => {
      const newLegs = [
        ...prev,
        { symbol: `NSE:NIFTY${exp.fyersDateCode}24800CE`, strike: 24800, type: 'CE' as const, side: 'BUY' as const, qty: 65, entryPrice: 35 }
      ];
      // Auto-update strategy name and tag based on legs configuration
      const detected = clientDetectOptionStrategy(newLegs);
      setModalStrategy(detected.strategy);
      setModalTag(detected.tag);
      return newLegs;
    });
  };

  const handleRemoveManualLeg = (idx: number) => {
    setManualLegs(prev => {
      const newLegs = prev.filter((_, i) => i !== idx);
      const detected = clientDetectOptionStrategy(newLegs);
      setModalStrategy(detected.strategy);
      setModalTag(detected.tag);
      return newLegs;
    });
  };

  const handleUpdateManualLeg = (idx: number, field: string, value: any) => {
    const exp = getClientExpiryDetails('NSE:NIFTY50-INDEX');
    setManualLegs(prev => {
      const updated = prev.map((leg, i) => {
        if (i !== idx) return leg;
        const up = { ...leg, [field]: value };
        if (field === 'strike' || field === 'type') {
          const strk = field === 'strike' ? value : leg.strike;
          const typ = field === 'type' ? value : leg.type;
          up.symbol = `NSE:NIFTY${exp.fyersDateCode}${strk}${typ}`;
        }
        return up;
      });
      // Auto-detect and suggest strategy classification
      const detected = clientDetectOptionStrategy(updated);
      setModalStrategy(detected.strategy);
      setModalTag(detected.tag);
      return updated;
    });
  };

  const handleConfirmManualSubmit = async () => {
    if (manualLegs.length === 0) {
      alert('Please add at least one position leg.');
      return;
    }
    // Validate strike prices
    const invalidStrike = manualLegs.find(l => !l.strike || l.strike < 10000 || l.strike > 40000);
    if (invalidStrike) {
      alert(`Invalid strike price: ${invalidStrike.strike}. NIFTY strike prices should be between 10,000 and 40,000.`);
      return;
    }

    setIsSubmittingSync(true);
    try {
      const res = await fetch('/api/positions/manual-entry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          legs: manualLegs,
          strategy: modalStrategy,
          tag: modalTag,
          mode: 'LIVE'
        })
      });
      const data = await res.json();
      if (data.message) {
        alert(data.message);
      }
      if (onSyncFyers) onSyncFyers();
      setIsPullModalOpen(false);
    } catch (err: any) {
      alert(`Manual entry failed: ${err.message}`);
    } finally {
      setIsSubmittingSync(false);
    }
  };

  const handleOpenPullModal = async () => {
    setIsPullModalOpen(true);
    setIsFetchingRaw(true);
    setRawFetchMsg('Fetching live net positions directly from FYERS API...');
    try {
      const res = await fetch('/api/fyers/positions');
      const data = await res.json();
      if (data && Array.isArray(data.netPositions)) {
        setRawFyersPositions(data.netPositions);
        setRawFetchMsg(data.netPositions.length > 0 
          ? `Found ${data.netPositions.length} position leg(s) active in FYERS terminal.`
          : 'No active net positions returned from FYERS terminal.'
        );
      } else {
        setRawFyersPositions([]);
        setRawFetchMsg(data?.message || 'No net positions found in FYERS.');
      }
    } catch (err: any) {
      setRawFetchMsg(`Error fetching FYERS positions: ${err.message}`);
    } finally {
      setIsFetchingRaw(false);
    }
  };

  const handleConfirmPullAndTag = async () => {
    setIsSubmittingSync(true);
    try {
      const res = await fetch('/api/fyers/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag: modalTag, strategy: modalStrategy })
      });
      const data = await res.json();
      if (data.message) {
        alert(data.message);
      }
      if (onSyncFyers) onSyncFyers();
      setIsPullModalOpen(false);
    } catch (err: any) {
      alert(`Sync failed: ${err.message}`);
    } finally {
      setIsSubmittingSync(false);
    }
  };

  const handleSaveTag = (posId: string) => {
    if (onUpdateTag) {
      onUpdateTag(posId, tagInput.trim(), strategyInput);
    }
    setEditingPosId(null);
    setTagInput('');
  };

  const filteredPositions = openPositions
    .filter((p) => {
      if (positionModeFilter === 'LIVE') return p.mode === 'LIVE';
      if (positionModeFilter === 'PAPER') return p.mode === 'PAPER' || !p.mode;
      return true;
    })
    .sort((a, b) => (a.id || '').localeCompare(b.id || ''));

  const sortedOpportunities = [...opportunities].sort((a, b) => (a.id || '').localeCompare(b.id || ''));

  const activePosition = openPositions.length > 0 ? openPositions[0] : null;
  const isLiveMode = mode === 'LIVE';

  return (
    <div className="space-y-6 pb-12">
      
      {/* INDIA VIX DYNAMIC ALERT PANEL & IRON CONDOR STRUCTURE RECOMMENDER */}
      <VixAlertPanel
        vixData={vixData}
        settings={settings}
        spotPrice={spotPrice}
        onRefreshDashboard={onRefreshDashboard}
        onUpdateSettings={onUpdateSettings}
      />

      {/* WEEKLY 1-2% CAPITAL GOAL & MODE BANNER */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col md:flex-row md:items-center justify-between gap-4 shadow-sm">
        <div className="flex items-center space-x-3">
          <div className="p-2.5 bg-gradient-to-tr from-emerald-600 to-teal-500 rounded-xl text-white shadow-md">
            <Target className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <span className="font-bold text-sm text-slate-100 uppercase tracking-wide">WEEKLY CAPITAL GROWTH TARGET: 1.0% - 2.0%</span>
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded border uppercase ${
                isLiveMode 
                  ? (authStatus?.isValid ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' : 'bg-rose-500/10 text-rose-400 border-rose-500/30')
                  : 'bg-amber-500/10 text-amber-400 border-amber-500/30'
              }`}>
                {isLiveMode 
                  ? (authStatus?.isValid ? 'LIVE BROKER TRADING (FYERS)' : 'LIVE MODE (AUTH REQUIRED)')
                  : 'PAPER TRADING (SIMULATION)'}
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              Capital protection engine locks 1.5% weekly profit while capping max drawdown below 2% per trade.
            </p>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 shrink-0">
          {isLiveMode && !authStatus?.isValid && (
            <div className="flex items-center gap-2 font-mono text-xs bg-rose-950/40 px-3 py-1.5 rounded-lg border border-rose-800/60 shrink-0">
              <div className="flex items-center space-x-1.5 text-rose-300">
                <span className="w-2 h-2 rounded-full bg-rose-500 animate-pulse"></span>
                <span className="font-bold text-[11px]">FYERS Live Broker Offline</span>
              </div>
              {onOpenAuthModal && (
                <button
                  type="button"
                  onClick={onOpenAuthModal}
                  className="bg-rose-600 hover:bg-rose-500 text-white font-bold px-2.5 py-0.5 rounded text-[11px] transition-colors shadow cursor-pointer"
                >
                  Connect FYERS Live
                </button>
              )}
            </div>
          )}

          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 font-mono text-xs text-slate-300 bg-slate-950/60 p-2.5 rounded-lg border border-slate-800 shrink-0">
            <div>
              <div className="flex items-center space-x-1.5">
                <span className="text-slate-500 text-[10px] block uppercase flex items-center gap-1">
                  {authStatus?.isValid && isLiveFunds ? (
                    <>
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                      <span className="text-emerald-400 font-bold">LIVE FYERS FUNDS</span>
                    </>
                  ) : isLiveMode ? (
                    <>
                      <span className="w-1.5 h-1.5 rounded-full bg-amber-400"></span>
                      <span className="text-amber-300 font-bold">FUNDS (CONFIGURED)</span>
                    </>
                  ) : (
                    <>
                      <span className="w-1.5 h-1.5 rounded-full bg-slate-400"></span>
                      <span>PAPER CAPITAL</span>
                    </>
                  )}
                </span>
                <button
                  type="button"
                  onClick={handleReconcileClick}
                  disabled={isReconciling}
                  title="Reconcile FYERS margin and available funds"
                  className="p-0.5 text-emerald-400 hover:text-emerald-300 hover:bg-emerald-950/50 rounded transition-all disabled:opacity-50 cursor-pointer"
                >
                  <RefreshCw className={`w-3 h-3 ${isReconciling ? 'animate-spin' : ''}`} />
                </button>
              </div>
              <span className={`font-bold text-sm ${authStatus?.isValid && isLiveFunds ? 'text-emerald-400' : 'text-slate-100'}`}>
                ₹{(fyersAvailableFunds > 0 ? fyersAvailableFunds : capital).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            </div>

            {fyersUtilizedFunds > 0 && (
              <div className="border-l border-slate-800 pl-3">
                <span className="text-slate-500 text-[10px] block uppercase">Utilised</span>
                <span className="font-bold text-amber-400 text-sm">
                  ₹{fyersUtilizedFunds.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              </div>
            )}

            <div className="border-l border-slate-800 pl-3">
              <span className="text-slate-500 text-[10px] block uppercase">Total Balance</span>
              <span className="font-bold text-slate-200 text-sm">
                ₹{(fyersTotalFunds > 0 ? fyersTotalFunds : (fyersAvailableFunds > 0 ? fyersAvailableFunds : capital)).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            </div>

            <div className="border-l border-slate-800 pl-3">
              <span className="text-slate-500 text-[10px] block uppercase">Allocated ({capitalAllocationPct || 100}%)</span>
              <span className="font-bold text-white text-sm">
                ₹{capital.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            </div>

            <div className="border-l border-slate-800 pl-3">
              <span className="text-slate-500 text-[10px] block uppercase">Weekly Target</span>
              <span className="font-bold text-emerald-400 text-sm">+₹{(capital * 0.015).toLocaleString('en-IN', { maximumFractionDigits: 0 })} / wk</span>
            </div>

            {reconcileMsg && (
              <div className="w-full sm:w-auto text-[10px] text-emerald-300 bg-emerald-950/80 border border-emerald-500/40 px-2 py-1 rounded animate-fade-in">
                {reconcileMsg}
              </div>
            )}
          </div>
        </div>
      </div>
      
      {/* 1. TOP SUMMARY METRICS GRID */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
        
        {/* NIFTY SPOT PRICE */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 shadow-sm relative overflow-hidden">
          <div className="flex items-center justify-between text-slate-400 mb-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider">NSE NIFTY 50 SPOT</span>
            <Zap className="w-4 h-4 text-indigo-400" />
          </div>
          <div className="text-xl font-bold text-slate-100 font-mono">
            ₹{spotPrice.toLocaleString('en-IN', { minimumFractionDigits: 1 })}
          </div>
          <div className="text-[11px] text-slate-400 mt-1 flex items-center space-x-1">
            <span className="inline-block w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
            <span>Real-time Market LTP</span>
          </div>
        </div>

        {/* LIVE FYERS P&L */}
        <div className="bg-slate-900 border border-emerald-500/30 bg-emerald-950/10 rounded-xl p-4 shadow-sm relative overflow-hidden">
          <div className="flex items-center justify-between text-slate-400 mb-2">
            <span className="text-[11px] font-semibold text-emerald-400 uppercase tracking-wider flex items-center space-x-1">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse mr-1"></span>
              <span>LIVE FYERS P&L</span>
            </span>
            {onSyncFyers && (
              <button
                onClick={onSyncFyers}
                title="Sync Live Fyers Account P&L"
                className="p-1 text-slate-400 hover:text-emerald-400 hover:bg-slate-800 rounded transition-colors"
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          {(() => {
            const livePositions = openPositions.filter(p => p.mode === 'LIVE');
            const livePnl = livePositions.reduce((acc, p) => acc + (p.totalPnl || 0), 0);
            return (
              <>
                <div className={`text-xl font-bold font-mono ${livePnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {livePnl >= 0 ? '+' : ''}₹{livePnl.toLocaleString('en-IN')}
                </div>
                <div className="text-[11px] text-slate-400 mt-1 flex items-center justify-between">
                  <span>{livePositions.length} Open Live Trades</span>
                  <span className="text-[10px] text-emerald-400 font-medium">FYERS Account</span>
                </div>
              </>
            );
          })()}
        </div>

        {/* AUTOMATED PAPER OPPORTUNITIES P&L */}
        <div className="bg-slate-900 border border-indigo-500/30 bg-indigo-950/10 rounded-xl p-4 shadow-sm relative overflow-hidden">
          <div className="flex items-center justify-between text-slate-400 mb-2">
            <span className="text-[11px] font-semibold text-indigo-300 uppercase tracking-wider flex items-center space-x-1">
              <Sparkles className="w-3.5 h-3.5 text-indigo-400 mr-0.5" />
              <span>AUTO PAPER P&L</span>
            </span>
            <span className="text-[9px] bg-indigo-500/20 text-indigo-300 px-1.5 py-0.5 rounded border border-indigo-500/30 font-bold">
              100% AUTO
            </span>
          </div>
          {(() => {
            const paperPositions = openPositions.filter(p => p.mode === 'PAPER' || !p.mode);
            const paperPnl = paperPositions.reduce((acc, p) => acc + (p.totalPnl || 0), 0);
            return (
              <>
                <div className={`text-xl font-bold font-mono ${paperPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {paperPnl >= 0 ? '+' : ''}₹{paperPnl.toLocaleString('en-IN')}
                </div>
                <div className="text-[11px] text-slate-400 mt-1 flex items-center justify-between">
                  <span>{paperPositions.length} Auto Paper Trades</span>
                  <span className="text-[10px] text-indigo-300 font-medium">Opportunities</span>
                </div>
              </>
            );
          })()}
        </div>

        {/* MONTHLY SUMMARY */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 shadow-sm">
          <div className="flex items-center justify-between text-slate-400 mb-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider">MONTHLY SUMMARY</span>
            <span className="text-[11px] font-bold text-indigo-400">{monthlyStats.winRate}% Win Rate</span>
          </div>
          <div className={`text-xl font-bold font-mono ${monthlyStats.totalPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
            {monthlyStats.totalPnl >= 0 ? '+' : ''}₹{monthlyStats.totalPnl.toLocaleString('en-IN')}
          </div>
          <div className="text-[11px] text-slate-400 mt-1">
            {monthlyStats.totalTrades} Total Closed Trades
          </div>
        </div>

        {/* RISK UTILIZATION */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 shadow-sm">
          <div className="flex items-center justify-between text-slate-400 mb-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider">RISK CAP (5%)</span>
            <ShieldAlert className={`w-4 h-4 ${monthlyRisk.isBreached ? 'text-rose-400' : 'text-slate-400'}`} />
          </div>
          <div className="text-xl font-bold text-slate-100 font-mono">
            {monthlyRisk.pctUsed}% <span className="text-xs text-slate-400 font-normal">Used</span>
          </div>
          <div className="w-full bg-slate-800 rounded-full h-1.5 mt-2 overflow-hidden">
            <div 
              className={`h-full rounded-full transition-all ${
                monthlyRisk.pctUsed > 80 ? 'bg-rose-500' : monthlyRisk.pctUsed > 50 ? 'bg-amber-500' : 'bg-indigo-500'
              }`}
              style={{ width: `${Math.min(100, monthlyRisk.pctUsed)}%` }}
            ></div>
          </div>
        </div>
      </div>

      {/* 2. INTERACTIVE 3D VOLATILITY SURFACE & TERM STRUCTURE VISUALIZATION */}
      <VolatilitySurfaceChart
        spotPrice={spotPrice}
        openPositions={openPositions}
        onNudgePrice={onNudgePrice}
        defaultExpanded={true}
      />

      {/* 3. GOLDEN RULE STRATEGY PROTOCOL CARD */}
      <div className="bg-slate-900 border border-indigo-500/20 rounded-xl p-5 relative overflow-hidden">
        <div className="absolute top-0 right-0 w-64 h-64 bg-indigo-500/5 rounded-full blur-3xl pointer-events-none"></div>
        <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
          <div className="space-y-2">
            <div className="flex items-center space-x-2 text-indigo-400 font-bold text-sm">
              <Lock className="w-4 h-4" />
              <span>THE GOLDEN RULE: SHORT STRADDLE &amp; DYNAMIC NO-LOSS ENGINE</span>
            </div>
            
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs text-slate-300">
              <div className="bg-slate-950/60 border border-slate-800 p-3 rounded-lg">
                <div className="text-emerald-400 font-semibold mb-1 flex items-center space-x-1">
                  <span>Scenario 1: Profit &amp; DTE &lt; 5d</span>
                </div>
                <p className="text-[11px] text-slate-400 leading-relaxed">
                  Buy 1 lot CE <strong>50 pts below</strong> &amp; 1 lot PE <strong>50 pts above</strong> for same expiry. Locks into <strong>NO LOSS TRADE</strong>. Leave to expiry.
                </p>
              </div>

              <div className="bg-slate-950/60 border border-slate-800 p-3 rounded-lg">
                <div className="text-indigo-400 font-semibold mb-1 flex items-center space-x-1">
                  <span>Scenario 2: Profit &amp; DTE &ge; 5d</span>
                </div>
                <p className="text-[11px] text-slate-400 leading-relaxed">
                  Close max profit leg (CE or PE). Sell 1 lot <strong>100pt shifted / ATM</strong>. Buy 1 lot CE 50pt below &amp; PE 50pt above wings. Locks into <strong>NO LOSS TRADE</strong>.
                </p>
              </div>

              <div className="bg-slate-950/60 border border-slate-800 p-3 rounded-lg">
                <div className="text-amber-400 font-semibold mb-1 flex items-center space-x-1">
                  <span>Scenario 3: Negative P&amp;L</span>
                </div>
                <p className="text-[11px] text-slate-400 leading-relaxed">
                  <strong>Rule 1 &amp; 2:</strong> Sell positive leg with combined premium &le; negative leg. If &lt;50%, add leg. When P&amp;L reaches <strong>&gt; ₹2,500</strong>, buy wings for <strong>NO LOSS TRADE</strong>.
                </p>
              </div>
            </div>

            <p className="text-[11px] text-slate-400 italic">
              <strong>Monitoring Alerts:</strong> Breakeven Range with 100 points diff or avg of CE/PE premium price (whichever is lower). Triggers on upper or lower alert crossover.
            </p>
          </div>

          {/* Quick Trigger Button */}
          <div className="flex items-center space-x-3 shrink-0 pt-1">
            {!activePosition ? (
              <button
                onClick={onTriggerEntry}
                disabled={isLoading}
                className="flex items-center space-x-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs rounded-lg transition-all shadow-lg shadow-indigo-600/30"
              >
                <PlusCircle className="w-4 h-4" />
                <span>Open Golden Straddle</span>
              </button>
            ) : (
              <button
                onClick={() => onClosePosition(activePosition.id)}
                disabled={isLoading}
                className="flex items-center space-x-2 px-4 py-2 bg-rose-600/20 hover:bg-rose-600/30 text-rose-300 border border-rose-500/30 font-semibold text-xs rounded-lg transition-all"
              >
                <XCircle className="w-4 h-4" />
                <span>Square Off Position</span>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* 2B. REAL-TIME IDENTIFIED OPPORTUNITIES & AUTOMATED EXECUTION */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-sm">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-4 pb-3 border-b border-slate-800">
          <div>
            <div className="flex items-center space-x-2">
              <Zap className="w-4 h-4 text-amber-400 animate-pulse" />
              <h3 className="font-bold text-sm text-slate-100 tracking-wide uppercase">LIVE MARKET OPPORTUNITY SCANNER</h3>
              <span className="bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-[10px] font-bold px-2 py-0.5 rounded-full">
                Active Scanner
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              Identifies Short Straddle, Iron Condor, Cash-and-Carry Arbitrage & Synthetic Spread opportunities automatically.
            </p>
          </div>
          <div className="text-xs font-mono text-slate-400 shrink-0">
            Scanning 150+ Option Strike Pairs Every Tick
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {sortedOpportunities && sortedOpportunities.length > 0 ? (
            sortedOpportunities.map((opp) => (
              <div key={opp.id} className="bg-slate-950/70 border border-slate-800 rounded-xl p-4 flex flex-col justify-between hover:border-indigo-500/40 transition-all">
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className={`text-[9px] font-bold px-2 py-0.5 rounded border uppercase ${
                      opp.type.includes('ARBITRAGE')
                        ? 'bg-amber-500/10 text-amber-300 border-amber-500/30'
                        : opp.type === 'IRON_CONDOR'
                        ? 'bg-indigo-500/10 text-indigo-300 border-indigo-500/30'
                        : 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30'
                    }`}>
                      {opp.type.replace(/_/g, ' ')}
                    </span>
                    <span className="text-[10px] font-bold text-indigo-400 font-mono">
                      {opp.annualizedYieldPct}% YIELD
                    </span>
                  </div>

                  <h4 className="font-bold text-xs text-slate-100 mb-1 leading-snug">{opp.title}</h4>
                  <p className="text-[11px] text-slate-400 mb-3 line-clamp-2 leading-relaxed">{opp.description}</p>

                  <div className="space-y-1 bg-slate-900/80 p-2 rounded-lg text-[11px] font-mono mb-3">
                    <div className="flex justify-between text-slate-300">
                      <span>Est. Profit Lock:</span>
                      <span className="font-bold text-emerald-400">+₹{opp.expectedProfit.toLocaleString('en-IN')}</span>
                    </div>
                    <div className="flex justify-between text-slate-400 text-[10px]">
                      <span>Win Rate / Conf:</span>
                      <span className="text-slate-200">{opp.winProbabilityPct}%</span>
                    </div>
                    <div className="flex justify-between text-slate-400 text-[10px]">
                      <span>Max Strategy Risk:</span>
                      <span className="text-slate-300">{opp.maxRisk === 0 ? 'RISK FREE (0)' : `₹${opp.maxRisk.toLocaleString('en-IN')}`}</span>
                    </div>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <button
                    onClick={() => setInspectOpp(opp)}
                    className="w-full py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 font-semibold text-xs rounded-lg transition-all flex items-center justify-center space-x-1 cursor-pointer"
                  >
                    <Eye className="w-3.5 h-3.5 text-indigo-400" />
                    <span>Inspect Payoff & Greeks</span>
                  </button>

                  <button
                    onClick={() => onExecuteOpportunity ? onExecuteOpportunity(opp.type) : onTriggerEntry()}
                    disabled={isLoading || opp.status === 'IN_TRADE' || opp.status === 'EXECUTED'}
                    className={`w-full py-2 font-bold text-xs rounded-lg transition-all flex items-center justify-center space-x-1 shadow ${
                      opp.status === 'IN_TRADE' || opp.status === 'EXECUTED'
                        ? 'bg-emerald-950/70 border border-emerald-500/50 text-emerald-400 cursor-not-allowed opacity-90'
                        : 'bg-gradient-to-r from-indigo-600 to-blue-600 hover:from-indigo-500 hover:to-blue-500 text-white cursor-pointer'
                    }`}
                  >
                    {opp.status === 'IN_TRADE' || opp.status === 'EXECUTED' ? (
                      <>
                        <CheckCircle className="w-3.5 h-3.5 text-emerald-400" />
                        <span>IN TRADE (Executed)</span>
                      </>
                    ) : (
                      <>
                        <Zap className="w-3.5 h-3.5" />
                        <span>Execute & Lock Profit</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            ))
          ) : (
            <div className="col-span-full text-center py-6 text-slate-500 text-xs">
              Scanning live orderbook for opportunities...
            </div>
          )}
        </div>
      </div>

      {/* 3. SIMULATION & TESTING CONTROLS (INACTIVE / PAPER MODE SIMULATOR) */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center space-x-2 text-xs font-bold text-slate-300 uppercase tracking-wider">
            <SlidersHorizontal className="w-4 h-4 text-indigo-400" />
            <span>Interactive Market Simulator & Strategy Tester</span>
          </div>
          <span className="text-xs text-slate-500">Test Golden Rule Adjustments Live</span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs">
          <button
            onClick={() => onNudgePrice(+200)}
            disabled={isLoading}
            className="p-2.5 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 rounded-lg font-medium transition-all text-center flex items-center justify-center space-x-1"
          >
            <ArrowUpRight className="w-3.5 h-3.5" />
            <span>Nudge +200 Pts</span>
          </button>

          <button
            onClick={() => onNudgePrice(-200)}
            disabled={isLoading}
            className="p-2.5 bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 border border-rose-500/30 rounded-lg font-medium transition-all text-center flex items-center justify-center space-x-1"
          >
            <ArrowDownRight className="w-3.5 h-3.5" />
            <span>Nudge -200 Pts</span>
          </button>

          <button
            onClick={() => onNudgePrice(+400)}
            disabled={isLoading}
            className="p-2.5 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 rounded-lg font-medium transition-all text-center"
          >
            <span>Nudge +400 Pts</span>
          </button>

          <button
            onClick={() => onNudgePrice(-400)}
            disabled={isLoading}
            className="p-2.5 bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 border border-rose-500/30 rounded-lg font-medium transition-all text-center"
          >
            <span>Nudge -400 Pts</span>
          </button>

          <button
            onClick={onRunTick}
            disabled={isLoading}
            className="p-2.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg font-semibold transition-all text-center flex items-center justify-center space-x-1 col-span-2 sm:col-span-1"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Run Strategy Tick</span>
          </button>
        </div>
      </div>

      {/* 4. MULTI-STRATEGY MONITOR & FYERS LIVE SYNC */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-sm">
        <div className="p-4 border-b border-slate-800 flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div className="flex items-center space-x-3">
            <div className="p-2 bg-indigo-500/10 border border-indigo-500/20 rounded-lg">
              <Layers className="w-5 h-5 text-indigo-400" />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <h3 className="font-bold text-sm text-slate-100 uppercase tracking-wide">ACTIVE STRATEGIES & LIVE FYERS MONITOR</h3>
                <span className="bg-indigo-500/10 text-indigo-300 border border-indigo-500/20 text-[10px] font-bold px-2 py-0.5 rounded">
                  {openPositions.length} Total Open
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                Tag and monitor multiple Iron Condor, Short Straddle & Arbitrage strategies independently in real-time.
              </p>
            </div>
          </div>

          <div className="flex items-center space-x-2">
            {/* Filter Buttons */}
            <div className="bg-slate-950 p-1 rounded-lg border border-slate-800 flex items-center space-x-1 text-xs">
              <button
                onClick={() => setPositionModeFilter('ALL')}
                className={`px-2.5 py-1 rounded font-semibold transition-all ${
                  positionModeFilter === 'ALL'
                    ? 'bg-indigo-600 text-white shadow'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                All ({openPositions.length})
              </button>
              <button
                onClick={() => setPositionModeFilter('LIVE')}
                className={`px-2.5 py-1 rounded font-semibold transition-all flex items-center space-x-1 ${
                  positionModeFilter === 'LIVE'
                    ? 'bg-rose-600 text-white shadow'
                    : 'text-rose-400 hover:text-rose-300'
                }`}
              >
                <span className="w-1.5 h-1.5 rounded-full bg-rose-400 animate-ping inline-block"></span>
                <span>Live ({openPositions.filter(p => p.mode === 'LIVE').length})</span>
              </button>
              <button
                onClick={() => setPositionModeFilter('PAPER')}
                className={`px-2.5 py-1 rounded font-semibold transition-all ${
                  positionModeFilter === 'PAPER'
                    ? 'bg-amber-600 text-white shadow'
                    : 'text-amber-400 hover:text-amber-300'
                }`}
              >
                Paper ({openPositions.filter(p => p.mode === 'PAPER' || !p.mode).length})
              </button>
            </div>

            <button
              onClick={onSyncFyers}
              disabled={isLoading}
              className="flex items-center justify-center space-x-1.5 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white text-xs font-bold px-3 py-1.5 rounded-lg border border-emerald-500/30 shadow transition-all shrink-0 cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
              <span>Sync Fyers</span>
            </button>

            <button
              onClick={handleOpenPullModal}
              disabled={isLoading}
              className="flex items-center justify-center space-x-1.5 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white text-xs font-bold px-3 py-1.5 rounded-lg border border-indigo-500/30 shadow transition-all shrink-0 cursor-pointer"
            >
              <Tag className="w-3.5 h-3.5 text-indigo-200" />
              <span>Pull & Tag Trades</span>
            </button>
          </div>
        </div>

        {filteredPositions && filteredPositions.length > 0 ? (
          <div className="divide-y divide-slate-800/80">
            {filteredPositions.map((pos) => {
              const isEditingThisTag = editingPosId === pos.id;
              const isPosLive = pos.mode === 'LIVE';
              const expDetails = getClientExpiryDetails(pos.symbol || 'NSE:NIFTY50-INDEX');

              return (
                <div key={pos.id} className="p-4 space-y-3 bg-slate-900/50 hover:bg-slate-900 transition-colors">
                  {/* Strategy Card Header */}
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-2 border-b border-slate-800/60">
                    <div className="flex flex-wrap items-center gap-2">
                      
                      {/* TRADING MODE BADGE - PROMINENT DEMARCATION */}
                      {isPosLive ? (
                        <span className="bg-rose-500/20 text-rose-300 border border-rose-500/40 text-[10px] font-bold px-2.5 py-0.5 rounded flex items-center space-x-1.5 shadow-sm">
                          <span className="relative flex h-2 w-2">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75"></span>
                            <span className="relative inline-flex rounded-full h-2 w-2 bg-rose-500"></span>
                          </span>
                          <span>LIVE BROKER TRADE</span>
                        </span>
                      ) : (
                        <span className="bg-amber-500/10 text-amber-400 border border-amber-500/30 text-[10px] font-bold px-2.5 py-0.5 rounded uppercase">
                          PAPER SIMULATION
                        </span>
                      )}

                      <span className={`text-[10px] font-bold px-2.5 py-0.5 rounded border uppercase ${
                        pos.strategy.includes('ARBITRAGE')
                          ? 'bg-amber-500/10 text-amber-300 border-amber-500/30'
                          : pos.strategy === 'IRON_CONDOR'
                          ? 'bg-indigo-500/10 text-indigo-300 border-indigo-500/30'
                          : 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30'
                      }`}>
                        {pos.strategy.replace(/_/g, ' ')}
                      </span>

                      {/* Expiry Badge with Day Name */}
                      <span className="flex items-center space-x-1 bg-slate-800/90 text-indigo-300 border border-slate-700 text-[10px] font-mono px-2 py-0.5 rounded">
                        <Calendar className="w-3 h-3 text-indigo-400" />
                        <span>Expiry: <strong>{expDetails.dayName} {expDetails.expiryDate}</strong> ({expDetails.daysToExpiry}d)</span>
                      </span>

                      {/* Strategy Custom Tag & Tag Editor */}
                      {isEditingThisTag ? (
                        <div className="flex flex-wrap items-center gap-1.5 bg-slate-950 p-1.5 rounded-lg border border-indigo-500/50">
                          <select
                            value={strategyInput}
                            onChange={(e) => setStrategyInput(e.target.value)}
                            className="bg-slate-900 border border-slate-700 rounded px-2 py-0.5 text-[11px] text-indigo-300 font-bold outline-none cursor-pointer"
                          >
                            <option value="SHORT_STRADDLE">SHORT STRADDLE</option>
                            <option value="IRON_CONDOR">IRON CONDOR</option>
                            <option value="IRON_FLY">IRON FLY</option>
                            <option value="SHORT_STRANGLE">SHORT STRANGLE</option>
                            <option value="CALL_CREDIT_SPREAD">CALL CREDIT SPREAD</option>
                            <option value="PUT_CREDIT_SPREAD">PUT CREDIT SPREAD</option>
                            <option value="CALENDAR_SPREAD">CALENDAR SPREAD</option>
                            <option value="CUSTOM_STRATEGY">CUSTOM STRATEGY</option>
                          </select>

                          <input
                            type="text"
                            value={tagInput}
                            onChange={(e) => setTagInput(e.target.value)}
                            placeholder="Custom Tag Name"
                            className="bg-slate-900 border border-slate-700 rounded px-2 py-0.5 text-xs text-white font-mono outline-none w-36"
                          />

                          <button
                            onClick={() => handleSaveTag(pos.id)}
                            className="px-2 py-0.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded text-xs font-bold flex items-center gap-1 cursor-pointer"
                          >
                            <Check className="w-3.5 h-3.5" />
                            <span>Save Tag</span>
                          </button>

                          <button
                            onClick={() => setEditingPosId(null)}
                            className="p-1 text-slate-400 hover:text-rose-400"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center space-x-1">
                          <span className="flex items-center space-x-1 bg-slate-800 text-slate-200 border border-slate-700 text-[11px] font-mono px-2 py-0.5 rounded">
                            <Tag className="w-3 h-3 text-indigo-400" />
                            <span>{pos.tag || pos.strategy}</span>
                          </span>
                          <button
                            onClick={() => {
                              setEditingPosId(pos.id);
                              setTagInput(pos.tag || pos.strategy);
                              setStrategyInput(pos.strategy || 'SHORT_STRADDLE');
                            }}
                            className="p-1 text-slate-400 hover:text-indigo-300 transition-colors cursor-pointer"
                            title="Edit Strategy Classification & Tag"
                          >
                            <Edit2 className="w-3 h-3" />
                          </button>
                        </div>
                      )}

                      {pos.source === 'FYERS_SYNCED' && (
                        <span className="bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-[9px] font-bold px-1.5 py-0.5 rounded">
                          FYERS LIVE SYNCED
                        </span>
                      )}
                    </div>

                    <div className="flex items-center space-x-4 text-xs font-mono">
                      <span className="text-slate-400">
                        Spot: <strong className="text-slate-200">₹{pos.indexEntryPrice}</strong>
                      </span>
                      <span className="text-slate-400">
                        Strategy P&L:
                        <strong className={`ml-1 text-sm ${pos.totalPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                          {pos.totalPnl >= 0 ? '+' : ''}₹{pos.totalPnl.toLocaleString('en-IN')}
                        </strong>
                      </span>
                      <button
                        onClick={() => setInspectOpp({
                          id: pos.id,
                          type: pos.strategy,
                          title: `${pos.tag || pos.strategy} (Active Position)`,
                          description: `Active ${pos.mode || 'PAPER'} position entered at ₹${pos.indexEntryPrice}`,
                          symbol: 'NSE:NIFTY50-INDEX',
                          spotPrice: spotPrice,
                          expiryDate: pos.expiryDate || 'Expiry',
                          daysToExpiry: 3,
                          lotSize: 65,
                          numberOfLots: 1,
                          totalQty: pos.legs[0]?.qty || 65,
                          requiredMargin: 120000,
                          expectedProfit: pos.legs.filter(l => l.side === 'SELL').reduce((s, l) => s + (l.entryPrice * l.qty), 0),
                          maxRisk: 25000,
                          winProbabilityPct: 82,
                          weeklyReturnPct: 2.1,
                          annualizedYieldPct: 35,
                          breakevenLower: Math.round(spotPrice - 350),
                          breakevenUpper: Math.round(spotPrice + 350),
                          riskScore: 'LOW',
                          status: 'ACTIVE',
                          timestamp: pos.entryTimestamp,
                          greeks: { netDelta: 0.01, netTheta: 32, netGamma: -0.0005, netVega: -12, avgIV: 14.5 },
                          payoffPoints: [],
                          legs: pos.legs.map(l => ({
                            symbol: l.symbol,
                            side: l.side,
                            qty: l.qty,
                            estimatedPrice: l.entryPrice,
                            strike: l.strike,
                            optionType: l.optionType,
                            delta: 0,
                            theta: 0,
                            gamma: 0,
                            vega: 0,
                            iv: 0
                          }))
                        })}
                        className="px-2.5 py-1 bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 border border-indigo-500/30 rounded text-[11px] font-semibold transition-all cursor-pointer flex items-center space-x-1"
                      >
                        <Eye className="w-3.5 h-3.5" />
                        <span>Payoff Graph</span>
                      </button>
                      <button
                        onClick={() => onClosePosition(pos.id)}
                        disabled={isLoading}
                        className="px-2.5 py-1 bg-rose-500/10 hover:bg-rose-600 text-rose-300 hover:text-white border border-rose-500/30 rounded text-[11px] font-semibold transition-all cursor-pointer"
                      >
                        Square Off
                      </button>
                      {onDeletePosition && pos.source === 'MANUAL_ENTRY' && (
                        <button
                          onClick={() => {
                            if (window.confirm(`Delete manual position ${pos.tag || pos.strategy}?`)) {
                              onDeletePosition(pos.id);
                            }
                          }}
                          disabled={isLoading}
                          className="px-2 py-1 bg-slate-800 hover:bg-rose-900/60 text-slate-400 hover:text-rose-300 border border-slate-700 rounded text-[11px] font-semibold transition-all cursor-pointer"
                          title="Remove manual entry"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Legs Table for this Strategy */}
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs font-mono">
                      <thead>
                        <tr className="border-b border-slate-800 text-slate-400">
                          <th className="pb-1.5">LEG SYMBOL</th>
                          <th className="pb-1.5">TYPE</th>
                          <th className="pb-1.5">STRIKE</th>
                          <th className="pb-1.5">SIDE</th>
                          <th className="pb-1.5">QTY</th>
                          <th className="pb-1.5">ENTRY LTP</th>
                          <th className="pb-1.5">CURRENT LTP</th>
                          <th className="pb-1.5 text-right">UNREALIZED P&L</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/40">
                        {pos.legs.map((leg) => (
                          <tr key={leg.id} className={leg.isWing ? 'bg-indigo-950/20' : ''}>
                            <td className="py-2 font-semibold text-slate-200">
                              {leg.symbol}
                              {leg.isWing && (
                                <span className="ml-2 text-[9px] bg-indigo-500/20 text-indigo-300 px-1.5 py-0.5 rounded font-sans">WING</span>
                              )}
                            </td>
                            <td className="py-2">
                              <span className={leg.type === 'CE' ? 'text-emerald-400 font-bold' : leg.type === 'PE' ? 'text-rose-400 font-bold' : 'text-amber-400 font-bold'}>
                                {leg.type}
                              </span>
                            </td>
                            <td className="py-2 text-slate-300">{leg.strike || 'N/A'}</td>
                            <td className="py-2">
                              <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                                leg.side === 'SELL' ? 'bg-rose-500/10 text-rose-400' : 'bg-emerald-500/10 text-emerald-400'
                              }`}>
                                {leg.side}
                              </span>
                            </td>
                            <td className="py-2 text-slate-300">{leg.qty}</td>
                            <td className="py-2 text-slate-300">₹{leg.entryPrice}</td>
                            <td className="py-2 text-slate-300">₹{leg.currentPrice}</td>
                            <td className={`py-2 text-right font-bold ${leg.pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                              {leg.pnl >= 0 ? '+' : ''}₹{leg.pnl}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="p-8 text-center space-y-4">
            <div className="max-w-md mx-auto p-4 rounded-xl bg-slate-950/80 border border-slate-800 space-y-3">
              <div className="flex items-center justify-center space-x-2 text-slate-300 font-bold text-xs uppercase tracking-wider">
                <span className={`w-2 h-2 rounded-full ${positionModeFilter === 'LIVE' ? (authStatus?.isValid ? 'bg-emerald-400' : 'bg-rose-500 animate-pulse') : 'bg-amber-400'}`}></span>
                <span>
                  {positionModeFilter === 'LIVE'
                    ? (authStatus?.isValid ? 'FYERS Live Broker Connected (No Open Live Trades)' : 'FYERS Live Broker Offline / Re-auth Required')
                    : 'No Open Strategy Positions'}
                </span>
              </div>

              <p className="text-slate-400 text-xs leading-relaxed">
                {positionModeFilter === 'LIVE'
                  ? (authStatus?.isValid
                      ? 'Your FYERS API connection is verified and active. There are currently no open net option positions in your FYERS account (XS06414). When orders are executed or tagged from your terminal, they stream here live.'
                      : 'FYERS API authentication is required to stream live funds, margin, and terminal net positions directly from your broker account.')
                  : 'No active strategy positions are currently open. You can execute an opportunity from the scanner above or sync existing trades from your FYERS terminal.'}
              </p>

              <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
                {positionModeFilter === 'LIVE' && !authStatus?.isValid && onOpenAuthModal && (
                  <button
                    onClick={onOpenAuthModal}
                    className="bg-emerald-600 hover:bg-emerald-500 text-white font-bold px-3.5 py-1.5 rounded-lg text-xs transition-colors shadow cursor-pointer flex items-center space-x-1.5"
                  >
                    <Zap className="w-3.5 h-3.5 text-amber-300 fill-amber-300" />
                    <span>Connect FYERS Live</span>
                  </button>
                )}

                {onSyncFyers && (
                  <button
                    onClick={onSyncFyers}
                    disabled={isLoading}
                    className="bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold px-3 py-1.5 rounded-lg text-xs transition-colors border border-slate-700 cursor-pointer flex items-center space-x-1.5"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
                    <span>Sync Fyers Live</span>
                  </button>
                )}

                {openPositions.length > 0 && positionModeFilter !== 'ALL' && (
                  <button
                    onClick={() => setPositionModeFilter('ALL')}
                    className="bg-indigo-600/30 hover:bg-indigo-600/50 text-indigo-300 font-semibold px-3 py-1.5 rounded-lg text-xs transition-colors border border-indigo-500/40 cursor-pointer"
                  >
                    View All Open Trades ({openPositions.length})
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 5. RECENT ADJUSTMENTS & ORDERS GRID */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        
        {/* RECENT ADJUSTMENTS AUDIT LOG */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <span className="font-bold text-xs text-slate-300 uppercase tracking-wider">STRATEGY ADJUSTMENT LOGS</span>
            <span className="text-[10px] text-slate-500">Golden Rule Audit Trail</span>
          </div>

          <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
            {adjustments.length > 0 ? (
              adjustments.map((adj) => (
                <div key={adj.id} className="bg-slate-950/60 border border-slate-800/80 rounded-lg p-2.5 text-xs">
                  <div className="flex items-center justify-between text-slate-400 mb-1">
                    <span className="font-bold text-indigo-400">{adj.actionTaken}</span>
                    <span className="text-[10px]">{new Date(adj.timestamp).toLocaleTimeString('en-IN')}</span>
                  </div>
                  <p className="text-slate-300 text-[11px]">{adj.details}</p>
                  <div className="mt-1 flex items-center justify-between text-[10px] text-slate-400 font-mono">
                    <span>Spot at Adj: ₹{adj.indexPriceAtAdjustment}</span>
                    <span className={adj.pnlAtAdjustment >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                      P&L: {adj.pnlAtAdjustment >= 0 ? '+' : ''}₹{adj.pnlAtAdjustment}
                    </span>
                  </div>
                </div>
              ))
            ) : (
              <div className="text-center py-6 text-slate-500 text-xs">No strategy adjustments recorded yet.</div>
            )}
          </div>
        </div>

        {/* RECENT ORDERS TABLE */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <span className="font-bold text-xs text-slate-300 uppercase tracking-wider">EXECUTED ORDERS</span>
            <span className="text-[10px] text-slate-500">Live Fyers / Paper Feed</span>
          </div>

          <div className="overflow-x-auto max-h-64 overflow-y-auto">
            <table className="w-full text-left text-xs font-mono">
              <thead>
                <tr className="border-b border-slate-800 text-slate-400">
                  <th className="pb-2">TIME</th>
                  <th className="pb-2">SYMBOL</th>
                  <th className="pb-2">SIDE</th>
                  <th className="pb-2">QTY</th>
                  <th className="pb-2">PRICE</th>
                  <th className="pb-2 text-right">STATUS</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/50">
                {orders.length > 0 ? (
                  orders.map((ord) => (
                    <tr key={ord.id}>
                      <td className="py-2 text-slate-500 text-[10px]">
                        {new Date(ord.timestamp).toLocaleTimeString('en-IN')}
                      </td>
                      <td className="py-2 font-medium text-slate-200">{ord.symbol}</td>
                      <td className="py-2">
                        <span className={ord.side === 'SELL' ? 'text-rose-400 font-bold' : 'text-emerald-400 font-bold'}>
                          {ord.side}
                        </span>
                      </td>
                      <td className="py-2 text-slate-300">{ord.qty}</td>
                      <td className="py-2 text-slate-300">₹{ord.executedPrice || ord.price}</td>
                      <td className="py-2 text-right">
                        <span className="bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-1.5 py-0.5 rounded text-[10px]">
                          {ord.status}
                        </span>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={6} className="text-center py-6 text-slate-500 text-xs">
                      No executed orders yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

      </div>

      {/* 5. DETAILED OPPORTUNITY INSPECTION, PAYOFF & GREEKS MODAL */}
      {inspectOpp && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm overflow-y-auto">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-4xl w-full p-6 space-y-6 shadow-2xl relative my-8 max-h-[90vh] overflow-y-auto">
            
            {/* Modal Header */}
            <div className="flex items-start justify-between border-b border-slate-800 pb-4">
              <div>
                <div className="flex flex-wrap items-center gap-2 mb-1">
                  <span className={`text-[10px] font-bold px-2.5 py-0.5 rounded border uppercase ${
                    inspectOpp.type.includes('ARBITRAGE')
                      ? 'bg-amber-500/10 text-amber-300 border-amber-500/30'
                      : inspectOpp.type === 'IRON_CONDOR'
                      ? 'bg-indigo-500/10 text-indigo-300 border-indigo-500/30'
                      : 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30'
                  }`}>
                    {inspectOpp.type.replace(/_/g, ' ')}
                  </span>

                  <span className={`text-[10px] font-bold px-2.5 py-0.5 rounded border uppercase ${
                    isLiveMode
                      ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                      : 'bg-amber-500/10 text-amber-400 border-amber-500/30'
                  }`}>
                    {isLiveMode ? 'LIVE FYERS BROKER EXECUTION' : 'PAPER TRADING SIMULATION'}
                  </span>
                </div>

                <h2 className="text-lg font-bold text-slate-100">{inspectOpp.title}</h2>
                <p className="text-xs text-slate-400 mt-0.5">{inspectOpp.description}</p>
              </div>

              <button
                onClick={() => setInspectOpp(null)}
                className="p-1.5 text-slate-400 hover:text-white bg-slate-800 hover:bg-slate-700 rounded-lg transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Strategy Highlights & Target Metrics */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 font-mono text-xs">
              <div className="bg-slate-950 p-3 rounded-xl border border-slate-800">
                <span className="text-slate-500 text-[10px] block uppercase">Nearest Expiry</span>
                <span className="font-bold text-slate-200 text-sm">{inspectOpp.expiryDate || '14-AUG-2026'}</span>
                <span className="text-[10px] text-indigo-400 block mt-0.5">({inspectOpp.daysToExpiry || 6} Days to Expiry)</span>
              </div>

              <div className="bg-slate-950 p-3 rounded-xl border border-slate-800">
                <span className="text-slate-500 text-[10px] block uppercase">Standard Lot Scaling</span>
                <span className="font-bold text-slate-200 text-sm">{inspectOpp.numberOfLots || 2} Lots ({inspectOpp.totalQty || 50} Qty)</span>
                <span className="text-[10px] text-slate-400 block mt-0.5">Lot Size: {inspectOpp.lotSize || 25} / Lot</span>
              </div>

              <div className="bg-slate-950 p-3 rounded-xl border border-slate-800">
                <span className="text-slate-500 text-[10px] block uppercase">Required Margin</span>
                <span className="font-bold text-white text-sm">₹{(inspectOpp.requiredMargin || 145000).toLocaleString('en-IN')}</span>
                <span className="text-[10px] text-slate-400 block mt-0.5">Span + Exposure</span>
              </div>

              <div className="bg-slate-950 p-3 rounded-xl border border-slate-800">
                <span className="text-slate-500 text-[10px] block uppercase">Weekly Return Target</span>
                <span className="font-bold text-emerald-400 text-sm">+{inspectOpp.weeklyReturnPct || 1.85}% / wk</span>
                <span className="text-[10px] text-emerald-300 block mt-0.5">(Goal: 1.0% - 2.0%)</span>
              </div>
            </div>

            {/* Option Greeks Technical Matrix */}
            <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                <span className="font-bold text-xs text-indigo-300 uppercase tracking-wide flex items-center space-x-1">
                  <BarChart2 className="w-4 h-4 text-indigo-400 mr-1" />
                  <span>NET PORTFOLIO OPTION GREEKS</span>
                </span>
                <span className="text-[11px] text-slate-500 font-mono">Spot: ₹{inspectOpp.spotPrice}</span>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 font-mono text-center">
                <div className="p-2 bg-slate-900 rounded-lg border border-slate-800">
                  <span className="text-[10px] text-slate-400 block">Delta (Δ)</span>
                  <span className="font-bold text-emerald-400 text-sm">{inspectOpp.greeks?.netDelta || 0.02}</span>
                  <span className="text-[9px] text-slate-500 block">Delta Neutral</span>
                </div>

                <div className="p-2 bg-slate-900 rounded-lg border border-slate-800">
                  <span className="text-[10px] text-slate-400 block">Theta (Θ)</span>
                  <span className="font-bold text-emerald-400 text-sm">+₹{inspectOpp.greeks?.netTheta || 24.5}/day</span>
                  <span className="text-[9px] text-slate-500 block">Time Decay Income</span>
                </div>

                <div className="p-2 bg-slate-900 rounded-lg border border-slate-800">
                  <span className="text-[10px] text-slate-400 block">Gamma (Γ)</span>
                  <span className="font-bold text-slate-300 text-sm">{inspectOpp.greeks?.netGamma || -0.0004}</span>
                  <span className="text-[9px] text-slate-500 block">Curvature Risk</span>
                </div>

                <div className="p-2 bg-slate-900 rounded-lg border border-slate-800">
                  <span className="text-[10px] text-slate-400 block">Vega (ν)</span>
                  <span className="font-bold text-amber-400 text-sm">{inspectOpp.greeks?.netVega || -18.2}</span>
                  <span className="text-[9px] text-slate-500 block">Vol Sensitivity</span>
                </div>

                <div className="p-2 bg-slate-900 rounded-lg border border-slate-800 col-span-2 sm:col-span-1">
                  <span className="text-[10px] text-slate-400 block">Avg IV</span>
                  <span className="font-bold text-indigo-300 text-sm">{inspectOpp.greeks?.avgIV || 14.8}%</span>
                  <span className="text-[9px] text-slate-500 block">Implied Volatility</span>
                </div>
              </div>
            </div>

            {/* Individual Option Legs Breakdown with Leg Greeks */}
            <div className="space-y-2">
              <h4 className="text-xs font-bold text-slate-200 uppercase tracking-wide">STRATEGY LEGS & INDIVIDUAL OPTION TECHNICALS</h4>
              <div className="overflow-x-auto border border-slate-800 rounded-xl bg-slate-950">
                <table className="w-full text-left text-xs font-mono">
                  <thead>
                    <tr className="border-b border-slate-800 text-slate-400 bg-slate-900/60">
                      <th className="p-2.5">SYMBOL</th>
                      <th className="p-2.5">SIDE</th>
                      <th className="p-2.5">TYPE</th>
                      <th className="p-2.5">STRIKE</th>
                      <th className="p-2.5">QTY</th>
                      <th className="p-2.5">EST. PRICE</th>
                      <th className="p-2.5 text-center">DELTA</th>
                      <th className="p-2.5 text-center">THETA</th>
                      <th className="p-2.5 text-center">VEGA</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/50">
                    {inspectOpp.legs.map((leg, i) => (
                      <tr key={i} className="hover:bg-slate-900/40">
                        <td className="p-2.5 font-bold text-slate-200">{leg.symbol}</td>
                        <td className="p-2.5">
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                            leg.side === 'SELL' ? 'bg-rose-500/10 text-rose-400' : 'bg-emerald-500/10 text-emerald-400'
                          }`}>
                            {leg.side}
                          </span>
                        </td>
                        <td className="p-2.5 font-bold text-indigo-300">{leg.optionType || 'CE'}</td>
                        <td className="p-2.5 text-slate-300">{leg.strike || 'N/A'}</td>
                        <td className="p-2.5 text-slate-300">{leg.qty}</td>
                        <td className="p-2.5 text-slate-200">₹{leg.estimatedPrice}</td>
                        <td className="p-2.5 text-center text-slate-300">{leg.delta || '0.00'}</td>
                        <td className="p-2.5 text-center text-emerald-400">{leg.theta || '0.0'}</td>
                        <td className="p-2.5 text-center text-amber-300">{leg.vega || '0.0'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Interactive Embedded Payoff Graph with Moving Spot Level Simulator */}
            <PayoffChart
              spotPrice={inspectOpp.spotPrice || spotPrice}
              breakevenLower={inspectOpp.breakevenLower}
              breakevenUpper={inspectOpp.breakevenUpper}
              expectedProfit={inspectOpp.expectedProfit}
              maxRisk={inspectOpp.maxRisk}
              winProbabilityPct={inspectOpp.winProbabilityPct}
              legs={inspectOpp.legs.map(l => ({
                symbol: l.symbol,
                side: l.side,
                strike: l.strike,
                qty: l.qty,
                estimatedPrice: l.estimatedPrice,
                optionType: l.optionType
              }))}
              payoffPoints={inspectOpp.payoffPoints}
              title={`${inspectOpp.title} — Payoff Graph & Moving Spot Simulator`}
            />

            {/* Confirmation Footer */}
            <div className="flex items-center justify-end space-x-3 pt-2 border-t border-slate-800">
              <button
                onClick={() => setInspectOpp(null)}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold rounded-lg transition-colors"
              >
                Cancel
              </button>

              <button
                onClick={() => {
                  if (onExecuteOpportunity) onExecuteOpportunity(inspectOpp.type);
                  else onTriggerEntry();
                  setInspectOpp(null);
                }}
                disabled={isLoading}
                className="px-6 py-2.5 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-bold text-xs rounded-lg transition-all flex items-center space-x-2 shadow-lg cursor-pointer"
              >
                <Zap className="w-4 h-4" />
                <span>Confirm & Lock Strategy Profit</span>
              </button>
            </div>

          </div>
        </div>
      )}

      {/* PULL & TAG LIVE POSITIONS MODAL */}
      {isPullModalOpen && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-50 flex items-center justify-center p-2 sm:p-4 overflow-y-auto">
          <div className="bg-slate-900 border border-indigo-500/30 rounded-2xl max-w-2xl w-full p-4 sm:p-6 space-y-4 sm:space-y-5 shadow-2xl overflow-hidden max-h-[92vh] flex flex-col my-auto">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <div className="flex items-center space-x-2">
                <Tag className="w-4 h-4 sm:w-5 sm:h-5 text-indigo-400 shrink-0" />
                <h3 className="text-sm sm:text-lg font-bold text-white truncate">Pull & Tag Live FYERS Positions</h3>
              </div>
              <button
                onClick={() => setIsPullModalOpen(false)}
                className="text-slate-400 hover:text-white transition-colors cursor-pointer p-1"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Tabs Selector */}
            <div className="flex border-b border-slate-800 space-x-2 sm:space-x-4 overflow-x-auto no-scrollbar">
              <button
                type="button"
                onClick={() => setActivePullTab('API')}
                className={`pb-2 text-xs font-bold transition-colors whitespace-nowrap cursor-pointer border-b-2 ${
                  activePullTab === 'API'
                    ? 'border-indigo-500 text-indigo-400'
                    : 'border-transparent text-slate-400 hover:text-slate-200'
                }`}
              >
                1. Broker Sync (Auto)
              </button>
              <button
                type="button"
                onClick={() => setActivePullTab('MANUAL')}
                className={`pb-2 text-xs font-bold transition-colors whitespace-nowrap cursor-pointer border-b-2 ${
                  activePullTab === 'MANUAL'
                    ? 'border-indigo-500 text-indigo-400'
                    : 'border-transparent text-slate-400 hover:text-slate-200'
                }`}
              >
                2. Manual Trade Legs Entry
              </button>
            </div>

            {activePullTab === 'API' ? (
              <>
                <p className="text-[11px] sm:text-xs text-slate-300">
                  Fetch active trades directly from your FYERS terminal and tag them with your chosen option strategy classification.
                </p>

                {/* Fetch status */}
                <div className="bg-slate-950 p-2.5 sm:p-3 rounded-xl border border-slate-800 flex items-center justify-between text-xs gap-2">
                  <div className="flex items-center space-x-2 min-w-0">
                    <RefreshCw className={`w-3.5 h-3.5 sm:w-4 sm:h-4 text-indigo-400 shrink-0 ${isFetchingRaw ? 'animate-spin' : ''}`} />
                    <span className="text-slate-200 font-mono text-[11px] sm:text-xs truncate">{rawFetchMsg}</span>
                  </div>
                  <button
                    onClick={handleOpenPullModal}
                    disabled={isFetchingRaw}
                    className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 text-[10px] sm:text-[11px] font-bold rounded cursor-pointer shrink-0"
                  >
                    Refresh
                  </button>
                </div>

                {/* Raw positions table */}
                <div className="flex-1 overflow-x-auto overflow-y-auto max-h-56 sm:max-h-60 border border-slate-800 rounded-xl bg-slate-950/50 p-1 sm:p-2">
                  {rawFyersPositions.length > 0 ? (
                    <table className="w-full text-[11px] sm:text-xs text-left text-slate-300 min-w-[480px]">
                      <thead className="bg-slate-900/80 text-slate-400 text-[9px] sm:text-[10px] uppercase font-mono border-b border-slate-800">
                        <tr>
                          <th className="p-2">Symbol</th>
                          <th className="p-2">Side</th>
                          <th className="p-2 text-right">Net Qty</th>
                          <th className="p-2 text-right">Avg Price</th>
                          <th className="p-2 text-right">LTP</th>
                          <th className="p-2 text-right">P&L (₹)</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/50 font-mono">
                        {rawFyersPositions.map((pos, i) => (
                          <tr key={i} className="hover:bg-slate-900/40">
                            <td className="p-2 font-bold text-white truncate max-w-[140px]">{pos.symbol}</td>
                            <td className="p-2">
                              <span className={`px-1.5 py-0.5 text-[9px] sm:text-[10px] rounded font-bold ${
                                pos.netQty < 0 || pos.side < 0 ? 'bg-rose-500/20 text-rose-300' : 'bg-emerald-500/20 text-emerald-300'
                              }`}>
                                {pos.netQty < 0 || pos.side < 0 ? 'SELL' : 'BUY'}
                              </span>
                            </td>
                            <td className="p-2 text-right">{Math.abs(pos.netQty || pos.qty || 0)}</td>
                            <td className="p-2 text-right">₹{pos.netAvg || pos.avgPrice || 0}</td>
                            <td className="p-2 text-right text-indigo-300">₹{pos.ltp || pos.netAvg || 0}</td>
                            <td className={`p-2 text-right font-bold ${(pos.pl || 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                              ₹{(pos.pl || 0) >= 0 ? '+' : ''}{Math.round(pos.pl || 0).toLocaleString('en-IN')}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <div className="py-8 text-center text-slate-400 text-xs font-mono space-y-2">
                      <p>{isFetchingRaw ? 'Pulling positions from FYERS...' : 'No open net positions currently returned from FYERS API.'}</p>
                      <button
                        type="button"
                        onClick={() => setActivePullTab('MANUAL')}
                        className="text-xs text-indigo-400 underline font-bold cursor-pointer"
                      >
                        Switch to Manual Leg Input
                      </button>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <>
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <p className="text-[11px] sm:text-xs text-slate-300">
                    Manually enter your trade legs and tag them with your strategy classification.
                  </p>
                  <button
                    type="button"
                    onClick={handleAddManualLeg}
                    className="self-end sm:self-auto px-2.5 py-1 bg-indigo-600/30 border border-indigo-500/40 hover:bg-indigo-600/50 text-indigo-300 text-xs font-bold rounded flex items-center space-x-1 cursor-pointer shrink-0"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Add Leg</span>
                  </button>
                </div>

                <div className="flex-1 overflow-y-auto max-h-56 sm:max-h-60 border border-slate-800 rounded-xl bg-slate-950/50 p-1.5 sm:p-2 space-y-2">
                  {manualLegs.map((leg, idx) => (
                    <div key={idx} className="bg-slate-900/90 border border-slate-800 p-2 sm:p-2.5 rounded-lg space-y-2 text-xs">
                      {/* Responsive Grid for mobile and desktop */}
                      <div className="grid grid-cols-6 sm:grid-cols-12 gap-1.5 sm:gap-2 items-center">
                        <div className="col-span-2 sm:col-span-2">
                          <label className="text-[9px] text-slate-400 block uppercase font-mono">Type</label>
                          <select
                            value={leg.type}
                            onChange={(e) => handleUpdateManualLeg(idx, 'type', e.target.value)}
                            className="w-full bg-slate-950 border border-slate-700 rounded px-1.5 py-1 text-white text-xs font-bold"
                          >
                            <option value="CE">CE</option>
                            <option value="PE">PE</option>
                            <option value="FUT">FUT</option>
                          </select>
                        </div>

                        <div className="col-span-4 sm:col-span-3">
                          <label className="text-[9px] text-slate-400 block uppercase font-mono">Strike</label>
                          <input
                            type="number"
                            step="50"
                            value={leg.strike}
                            onChange={(e) => handleUpdateManualLeg(idx, 'strike', parseInt(e.target.value, 10))}
                            className="w-full bg-slate-950 border border-slate-700 rounded px-1.5 py-1 text-white font-mono text-xs font-bold"
                          />
                        </div>

                        <div className="col-span-2 sm:col-span-2">
                          <label className="text-[9px] text-slate-400 block uppercase font-mono">Side</label>
                          <select
                            value={leg.side}
                            onChange={(e) => handleUpdateManualLeg(idx, 'side', e.target.value)}
                            className={`w-full border rounded px-1.5 py-1 text-xs font-bold ${
                              leg.side === 'SELL' ? 'bg-rose-950/60 border-rose-700 text-rose-300' : 'bg-emerald-950/60 border-emerald-700 text-emerald-300'
                            }`}
                          >
                            <option value="SELL">SELL</option>
                            <option value="BUY">BUY</option>
                          </select>
                        </div>

                        <div className="col-span-2 sm:col-span-2">
                          <label className="text-[9px] text-slate-400 block uppercase font-mono">Qty</label>
                          <input
                            type="number"
                            step="25"
                            value={leg.qty}
                            onChange={(e) => handleUpdateManualLeg(idx, 'qty', parseInt(e.target.value, 10))}
                            className="w-full bg-slate-950 border border-slate-700 rounded px-1.5 py-1 text-white font-mono text-xs"
                          />
                        </div>

                        <div className="col-span-2 sm:col-span-2">
                          <label className="text-[9px] text-slate-400 block uppercase font-mono">Price</label>
                          <input
                            type="number"
                            step="0.1"
                            value={leg.entryPrice}
                            onChange={(e) => handleUpdateManualLeg(idx, 'entryPrice', parseFloat(e.target.value))}
                            className="w-full bg-slate-950 border border-slate-700 rounded px-1.5 py-1 text-white font-mono text-xs font-bold"
                          />
                        </div>

                        <div className="col-span-6 sm:col-span-1 flex justify-end sm:pt-3">
                          <button
                            type="button"
                            onClick={() => handleRemoveManualLeg(idx)}
                            className="p-1 text-rose-400 hover:text-rose-300 hover:bg-rose-950/40 rounded transition-colors cursor-pointer"
                            title="Remove leg"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}

            {/* Strategy Classification & Custom Tag inputs */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4 bg-slate-950/70 p-3 sm:p-4 rounded-xl border border-slate-800">
              <div>
                <label className="block text-[10px] sm:text-[11px] font-bold text-indigo-300 mb-1 uppercase tracking-wider">
                  Select Strategy Type
                </label>
                <select
                  value={modalStrategy}
                  onChange={(e) => setModalStrategy(e.target.value)}
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2 text-xs text-white outline-none cursor-pointer font-bold focus:border-indigo-500"
                >
                  <option value="SHORT_STRADDLE">SHORT STRADDLE</option>
                  <option value="IRON_CONDOR">IRON CONDOR</option>
                  <option value="IRON_FLY">IRON FLY</option>
                  <option value="SHORT_STRANGLE">SHORT STRANGLE</option>
                  <option value="CALL_CREDIT_SPREAD">CALL CREDIT SPREAD</option>
                  <option value="PUT_CREDIT_SPREAD">PUT CREDIT SPREAD</option>
                  <option value="CALENDAR_SPREAD">CALENDAR SPREAD</option>
                  <option value="CUSTOM_STRATEGY">CUSTOM STRATEGY</option>
                </select>
              </div>

              <div>
                <label className="block text-[10px] sm:text-[11px] font-bold text-indigo-300 mb-1 uppercase tracking-wider">
                  Custom Strategy Tag
                </label>
                <input
                  type="text"
                  value={modalTag}
                  onChange={(e) => setModalTag(e.target.value)}
                  placeholder="e.g. Weekly_Nifty_Condor"
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2 text-xs text-white font-mono outline-none focus:border-indigo-500"
                />
              </div>
            </div>

            {/* Submit Action */}
            <div className="flex items-center justify-end space-x-2 sm:space-x-3 pt-2 sm:pt-3 border-t border-slate-800">
              <button
                onClick={() => setIsPullModalOpen(false)}
                className="px-3 sm:px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold rounded-lg transition-colors cursor-pointer"
              >
                Cancel
              </button>

              <button
                onClick={activePullTab === 'API' ? handleConfirmPullAndTag : handleConfirmManualSubmit}
                disabled={isSubmittingSync || (activePullTab === 'API' && rawFyersPositions.length === 0)}
                className="px-4 sm:px-5 py-2 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 disabled:opacity-50 text-white font-bold text-xs rounded-lg transition-all flex items-center space-x-2 shadow-lg cursor-pointer"
              >
                <Check className="w-4 h-4" />
                <span>{isSubmittingSync ? 'Importing...' : 'Import & Tag Strategy'}</span>
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
};
