import React, { useEffect, useState, useCallback } from 'react';
import { 
  LineChart, Line, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine 
} from 'recharts';
import { 
  TrendingUp, TrendingDown, Play, RotateCcw, AlertTriangle, CheckCircle2, ShieldCheck, 
  BarChart2, Zap, Sliders, Calendar, ArrowUpRight, ArrowDownRight, Info, Award, RefreshCw, ChevronDown, ChevronUp, Layers
} from 'lucide-react';
import { Settings } from '../types';

export interface BacktestAdjustment {
  id: string;
  time: string;
  type: 'ROLL_UP_PUT' | 'ROLL_DOWN_CALL' | 'WING_DEFENSE' | 'PROFIT_LOCK';
  title: string;
  triggerSpot: number;
  triggerCondition: string;
  description: string;
  oldSpread: string;
  newSpread: string;
  freshCreditCollected: number;
  realizedPnlOnClosedLegs: number;
}

export interface BacktestDailyResult {
  dayIndex: number;
  dateStr: string;
  dayOfWeek: string;
  openSpot: number;
  highSpot: number;
  lowSpot: number;
  closeSpot: number;
  spotRangePts: number;
  strategyEntered: string;
  shortCeStrike: number;
  shortPeStrike: number;
  longCeStrike: number;
  longPeStrike: number;
  creditCollected: number;
  finalPnl: number;
  pnlPct: number;
  maxProfitReached: number;
  maxDrawdown: number;
  exitTime: string;
  exitReason: 'TARGET_PROFIT' | 'STOP_LOSS' | '3:15 PM EOD EXIT' | 'DEFENSIVE_ADJUSTED';
  adjustmentMade: boolean;
  adjustmentsCount: number;
  adjustments: BacktestAdjustment[];
  adjustmentSummary: string;
  adjustmentDetails?: string;
}

interface EquityCurvePoint {
  timestamp: string;
  dayName: string;
  timeStr: string;
  spotPrice: number;
  intradayPnl: number;
  cumulativePnl: number;
}

interface BacktestData {
  settingsUsed: {
    strikeDistance: number;
    wingBuffer: number;
    quantity: number;
    perTradeMaxLossPct: number;
    targetProfitPct: number;
    capital: number;
  };
  summary: {
    totalPnl: number;
    returnPct: number;
    winRate: number;
    totalDays: number;
    winningDays: number;
    losingDays: number;
    maxDrawdown: number;
    maxDrawdownPct: number;
    avgDailyPnl: number;
    totalCreditCollected: number;
    totalAdjustments: number;
    sessionsWithAdjustments: number;
    adjustmentSuccessRate: number;
    capital: number;
  };
  dailyBreakdown: BacktestDailyResult[];
  equityCurve: EquityCurvePoint[];
  insights: string[];
}

interface SimulationViewProps {
  settings: Settings | null;
}

export const SimulationView: React.FC<SimulationViewProps> = ({ settings }) => {
  const [data, setData] = useState<BacktestData | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedDayIndex, setExpandedDayIndex] = useState<number | null>(null);

  // Custom Simulator Parameters
  const [strikeDistance, setStrikeDistance] = useState<number>(settings?.strikeDistance || 300);
  const [wingBuffer, setWingBuffer] = useState<number>(settings?.wingBuffer || 200);
  const [quantity, setQuantity] = useState<number>(settings?.defaultQuantity || 75);
  const [perTradeMaxLossPct, setPerTradeMaxLossPct] = useState<number>(settings?.perTradeMaxLossPct || 2.0);
  const [showParameters, setShowParameters] = useState<boolean>(false);

  // Sync settings when loaded
  useEffect(() => {
    if (settings) {
      setStrikeDistance(settings.strikeDistance || 300);
      setWingBuffer(settings.wingBuffer || 200);
      setQuantity(settings.defaultQuantity || 75);
      setPerTradeMaxLossPct(settings.perTradeMaxLossPct || 2.0);
    }
  }, [settings]);

  const fetchBacktest = useCallback(async (params?: Partial<Settings>) => {
    setLoading(true);
    setError(null);
    try {
      let res: Response;
      if (params) {
        res = await fetch('/api/simulation/backtest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(params)
        });
      } else {
        res = await fetch('/api/simulation/backtest');
      }

      if (!res.ok) {
        throw new Error(`Server returned HTTP ${res.status}`);
      }

      const text = await res.text();
      let json: BacktestData;
      try {
        json = JSON.parse(text);
      } catch (parseErr) {
        throw new Error(`Simulation response was not valid JSON (${text.slice(0, 40)}...)`);
      }

      setData(json);
    } catch (err: any) {
      console.warn('Simulation backtest load notice:', err.message || err);
      setError(err.message || 'Failed to load simulation data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchBacktest();
  }, [fetchBacktest]);

  const handleApplyCustomParams = (e: React.FormEvent) => {
    e.preventDefault();
    fetchBacktest({
      strikeDistance,
      wingBuffer,
      defaultQuantity: quantity,
      perTradeMaxLossPct
    });
  };

  const handleResetToCurrent = () => {
    if (settings) {
      setStrikeDistance(settings.strikeDistance || 300);
      setWingBuffer(settings.wingBuffer || 200);
      setQuantity(settings.defaultQuantity || 75);
      setPerTradeMaxLossPct(settings.perTradeMaxLossPct || 2.0);
    }
    fetchBacktest();
  };

  if (loading && !data) {
    return (
      <div className="flex flex-col items-center justify-center py-24 space-y-4">
        <div className="relative">
          <div className="w-12 h-12 rounded-full border-4 border-indigo-500/20 border-t-indigo-500 animate-spin"></div>
          <Zap className="w-5 h-5 text-indigo-400 absolute top-3 left-3 animate-pulse" />
        </div>
        <p className="text-sm font-semibold text-slate-300">Simulating 5-Day Historical Iron Condor Strategy...</p>
        <p className="text-xs text-slate-500">Calculating Black-Scholes option decay & NIFTY50 intraday ticks</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-rose-950/30 border border-rose-800/50 rounded-2xl p-6 text-center space-y-3 my-6">
        <AlertTriangle className="w-8 h-8 text-rose-400 mx-auto" />
        <h3 className="text-base font-bold text-slate-100">Simulation Error</h3>
        <p className="text-xs text-slate-400">{error}</p>
        <button
          onClick={() => fetchBacktest()}
          className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-xs font-semibold rounded-lg text-slate-200"
        >
          Retry Simulation
        </button>
      </div>
    );
  }

  const summary = data?.summary;
  const breakdown = data?.dailyBreakdown || [];
  const equityCurve = data?.equityCurve || [];
  const isPositive = (summary?.totalPnl || 0) >= 0;

  return (
    <div className="space-y-6 pb-12">
      
      {/* Title & Controls Header */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 sm:p-5 md:p-6 shadow-xl flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <div className="p-1.5 sm:p-2 bg-indigo-500/10 border border-indigo-500/20 rounded-xl text-indigo-400 shrink-0">
              <BarChart2 className="w-4 h-4 sm:w-5 sm:h-5" />
            </div>
            <h2 className="text-base sm:text-lg font-bold text-slate-100 tracking-tight">5-Day Strategy Simulator</h2>
            <span className="text-[9px] sm:text-[10px] font-mono font-bold bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 px-2 py-0.5 rounded-full uppercase shrink-0">
              NIFTY50 Backtest
            </span>
          </div>
          <p className="text-[11px] sm:text-xs text-slate-400 mt-1">
            Simulates how your Iron Condor parameters would have performed across the last 5 NIFTY trading sessions.
          </p>
        </div>

        <div className="flex flex-wrap sm:flex-nowrap items-center gap-2 sm:gap-3 shrink-0">
          <button
            onClick={() => setShowParameters(!showParameters)}
            className={`flex items-center space-x-1.5 sm:space-x-2 px-3 sm:px-3.5 py-2 rounded-xl text-xs font-semibold border transition-all cursor-pointer ${
              showParameters
                ? 'bg-indigo-600 text-white border-indigo-500 shadow-md shadow-indigo-600/30'
                : 'bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-750'
            }`}
          >
            <Sliders className="w-3.5 h-3.5 sm:w-4 sm:h-4 shrink-0" />
            <span>{showParameters ? 'Hide Settings' : 'Adjust Settings'}</span>
          </button>

          <button
            onClick={() => fetchBacktest()}
            disabled={loading}
            className="flex items-center space-x-1.5 sm:space-x-2 bg-gradient-to-r from-indigo-600 to-blue-600 hover:from-indigo-500 hover:to-blue-500 text-white px-3.5 sm:px-4 py-2 rounded-xl text-xs font-bold transition-all shadow-lg shadow-indigo-500/20 disabled:opacity-50 cursor-pointer shrink-0"
          >
            <Play className={`w-3.5 h-3.5 shrink-0 ${loading ? 'animate-spin' : ''}`} />
            <span>Re-Run Backtest</span>
          </button>
        </div>
      </div>

      {/* PARAMETER ADJUSTER PANEL */}
      {showParameters && (
        <form onSubmit={handleApplyCustomParams} className="bg-slate-900/90 border border-indigo-500/30 rounded-2xl p-5 space-y-4 animate-in fade-in zoom-in duration-150">
          <div className="flex items-center justify-between border-b border-slate-800 pb-3">
            <div className="flex items-center space-x-2">
              <Zap className="w-4 h-4 text-indigo-400" />
              <h3 className="text-xs font-bold text-slate-200 uppercase tracking-wider">Custom Backtest Parameters</h3>
            </div>
            <button
              type="button"
              onClick={handleResetToCurrent}
              className="text-[11px] text-slate-400 hover:text-indigo-400 flex items-center space-x-1 transition-colors"
            >
              <RotateCcw className="w-3 h-3" />
              <span>Reset to Current Strategy Defaults</span>
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <label className="block text-[11px] font-semibold text-slate-400 mb-1">
                Short Strike Distance (pts)
              </label>
              <input
                type="number"
                step="50"
                value={strikeDistance}
                onChange={(e) => setStrikeDistance(Number(e.target.value))}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2 text-xs font-mono text-slate-100 focus:border-indigo-500 outline-none"
              />
              <span className="text-[10px] text-slate-500">Distance from ATM to Short legs</span>
            </div>

            <div>
              <label className="block text-[11px] font-semibold text-slate-400 mb-1">
                Wing Protection Buffer (pts)
              </label>
              <input
                type="number"
                step="50"
                value={wingBuffer}
                onChange={(e) => setWingBuffer(Number(e.target.value))}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2 text-xs font-mono text-slate-100 focus:border-indigo-500 outline-none"
              />
              <span className="text-[10px] text-slate-500">Distance from Short to Long wings</span>
            </div>

            <div>
              <label className="block text-[11px] font-semibold text-slate-400 mb-1">
                Order Quantity (Shares)
              </label>
              <input
                type="number"
                step="25"
                value={quantity}
                onChange={(e) => setQuantity(Number(e.target.value))}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2 text-xs font-mono text-slate-100 focus:border-indigo-500 outline-none"
              />
              <span className="text-[10px] text-slate-500">1 NIFTY Lot = 75 Qty</span>
            </div>

            <div>
              <label className="block text-[11px] font-semibold text-slate-400 mb-1">
                Per-Trade Max Loss SL (%)
              </label>
              <input
                type="number"
                step="0.5"
                value={perTradeMaxLossPct}
                onChange={(e) => setPerTradeMaxLossPct(Number(e.target.value))}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2 text-xs font-mono text-slate-100 focus:border-indigo-500 outline-none"
              />
              <span className="text-[10px] text-slate-500">Max portfolio risk limit per trade</span>
            </div>
          </div>

          <div className="flex justify-end pt-2">
            <button
              type="submit"
              disabled={loading}
              className="bg-indigo-600 hover:bg-indigo-500 text-white font-bold px-5 py-2 rounded-xl text-xs transition-all shadow"
            >
              {loading ? 'Simulating...' : 'Run Custom Simulation'}
            </button>
          </div>
        </form>
      )}

      {/* KEY METRICS SUMMARY CARDS */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3 sm:gap-4">
        
        {/* Total Return */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-1 relative overflow-hidden">
          <div className="flex items-center justify-between text-slate-400 text-xs font-medium">
            <span>5-Day Total Return</span>
            {isPositive ? (
              <TrendingUp className="w-4 h-4 text-emerald-400" />
            ) : (
              <TrendingDown className="w-4 h-4 text-rose-400" />
            )}
          </div>
          <div className="flex items-baseline space-x-2">
            <span className={`text-xl font-black ${isPositive ? 'text-emerald-400' : 'text-rose-400'}`}>
              {isPositive ? '+' : ''}₹{(summary?.totalPnl || 0).toLocaleString('en-IN')}
            </span>
            <span className={`text-xs font-bold ${isPositive ? 'text-emerald-400' : 'text-rose-400'}`}>
              ({isPositive ? '+' : ''}{summary?.returnPct}%)
            </span>
          </div>
          <p className="text-[10px] text-slate-500">On ₹{((summary?.capital || 500000) / 100000).toFixed(1)}L Capital</p>
          <div className={`absolute bottom-0 left-0 right-0 h-1 ${isPositive ? 'bg-emerald-500' : 'bg-rose-500'}`} />
        </div>

        {/* Win Rate */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-1 relative">
          <div className="flex items-center justify-between text-slate-400 text-xs font-medium">
            <span>Strategy Win Rate</span>
            <Award className="w-4 h-4 text-indigo-400" />
          </div>
          <div className="flex items-baseline space-x-2">
            <span className="text-xl font-black text-slate-100">{summary?.winRate}%</span>
            <span className="text-xs text-slate-400">({summary?.winningDays}/{summary?.totalDays} Days)</span>
          </div>
          <p className="text-[10px] text-slate-500">Profitable vs Total Sessions</p>
          <div className="absolute bottom-0 left-0 right-0 h-1 bg-indigo-500" />
        </div>

        {/* Total Adjustments Made */}
        <div className="bg-slate-900 border border-amber-500/30 rounded-2xl p-4 space-y-1 relative bg-gradient-to-b from-amber-500/5 to-transparent">
          <div className="flex items-center justify-between text-slate-400 text-xs font-medium">
            <span className="text-amber-300 font-semibold">Adjustments Executed</span>
            <RefreshCw className="w-4 h-4 text-amber-400" />
          </div>
          <div className="flex items-baseline space-x-2">
            <span className="text-xl font-black text-amber-300">{summary?.totalAdjustments ?? 0}</span>
            <span className="text-xs font-semibold text-slate-300">
              ({summary?.sessionsWithAdjustments ?? 0}/5 Days)
            </span>
          </div>
          <p className="text-[10px] text-amber-400/80 font-medium">
            Defense Win Rate: {summary?.adjustmentSuccessRate ?? 100}%
          </p>
          <div className="absolute bottom-0 left-0 right-0 h-1 bg-amber-500" />
        </div>

        {/* Max Intraday Drawdown */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-1 relative">
          <div className="flex items-center justify-between text-slate-400 text-xs font-medium">
            <span>Max Intraday Drawdown</span>
            <ShieldCheck className="w-4 h-4 text-amber-400" />
          </div>
          <div className="flex items-baseline space-x-2">
            <span className="text-xl font-black text-rose-400">
              ₹{(summary?.maxDrawdown || 0).toLocaleString('en-IN')}
            </span>
            <span className="text-xs font-bold text-rose-400">
              ({summary?.maxDrawdownPct}%)
            </span>
          </div>
          <p className="text-[10px] text-slate-500">Peak-to-trough max loss</p>
          <div className="absolute bottom-0 left-0 right-0 h-1 bg-rose-500" />
        </div>

        {/* Total Credit Collected */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-1 relative">
          <div className="flex items-center justify-between text-slate-400 text-xs font-medium">
            <span>Total Credit Collected</span>
            <Zap className="w-4 h-4 text-teal-400" />
          </div>
          <div className="text-xl font-black text-slate-100">
            ₹{(summary?.totalCreditCollected || 0).toLocaleString('en-IN')}
          </div>
          <p className="text-[10px] text-slate-500">Net premium received upfront</p>
          <div className="absolute bottom-0 left-0 right-0 h-1 bg-teal-500" />
        </div>

        {/* Average Daily P&L */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-1 relative">
          <div className="flex items-center justify-between text-slate-400 text-xs font-medium">
            <span>Avg Daily Return</span>
            <Calendar className="w-4 h-4 text-blue-400" />
          </div>
          <div className="text-xl font-black text-slate-100">
            {summary?.avgDailyPnl && summary.avgDailyPnl >= 0 ? '+' : ''}₹{(summary?.avgDailyPnl || 0).toLocaleString('en-IN')}
          </div>
          <p className="text-[10px] text-slate-500">Average P&L per trading day</p>
          <div className="absolute bottom-0 left-0 right-0 h-1 bg-blue-500" />
        </div>

      </div>

      {/* 5-DAY CUMULATIVE EQUITY CURVE CHART */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4 shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-800 pb-3">
          <div>
            <h3 className="text-sm font-bold text-slate-100">5-Day Intraday Equity Curve & Cumulative P&L</h3>
            <p className="text-xs text-slate-400">Tracks tick-by-tick MTM profit/loss trajectory across all 5 trading sessions</p>
          </div>
          <div className="flex items-center space-x-3 text-xs">
            <div className="flex items-center space-x-1.5">
              <span className="w-3 h-3 rounded-full bg-emerald-500 inline-block"></span>
              <span className="text-slate-300">Cumulative Strategy P&L (₹)</span>
            </div>
          </div>
        </div>

        <div className="h-72 w-full pt-2">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={equityCurve} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="pnlColor" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#10b981" stopOpacity={0.4} />
                  <stop offset="95%" stopColor="#10b981" stopOpacity={0.0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis 
                dataKey="timestamp" 
                stroke="#64748b" 
                tick={{ fontSize: 10 }} 
                tickFormatter={(val) => {
                  // e.g. "2026-08-08 09:15" -> "08 Aug 09:15"
                  const parts = val.split(' ');
                  if (parts.length === 2) {
                    const dateParts = parts[0].split('-');
                    return `${dateParts[2]}/${dateParts[1]} ${parts[1]}`;
                  }
                  return val;
                }}
              />
              <YAxis stroke="#64748b" tick={{ fontSize: 10 }} tickFormatter={(val) => `₹${val}`} />
              <Tooltip 
                contentStyle={{ backgroundColor: '#0f172a', borderColor: '#334155', borderRadius: '12px', fontSize: '12px' }}
                labelStyle={{ color: '#94a3b8', fontWeight: 'bold' }}
                formatter={(val: any, name: any) => [
                  `₹${Number(val).toLocaleString('en-IN')}`,
                  name === 'cumulativePnl' ? 'Cumulative P&L' : 'Spot Price'
                ]}
              />
              <ReferenceLine y={0} stroke="#475569" strokeDasharray="3 3" />
              <Area 
                type="monotone" 
                dataKey="cumulativePnl" 
                stroke="#10b981" 
                strokeWidth={2.5} 
                fillOpacity={1} 
                fill="url(#pnlColor)" 
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* DAY-BY-DAY BREAKDOWN TABLE WITH ADJUSTMENT AUDIT LOG */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4 shadow-xl">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-800 pb-3">
          <div>
            <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
              <span>Day-by-Day Session Breakdown</span>
              <span className="bg-indigo-500/20 text-indigo-300 text-[10px] px-2 py-0.5 rounded font-mono font-normal">
                Includes Trade Adjustments Log
              </span>
            </h3>
            <p className="text-xs text-slate-400">Detailed performance metrics, strikes entered, rolling adjustments triggered, and exit logs</p>
          </div>
          <span className="text-xs text-slate-400 font-mono bg-slate-950 border border-slate-800 px-3 py-1 rounded-lg self-start sm:self-auto">
            5 Trading Sessions Analyzed
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-800 text-slate-400 text-[11px] uppercase tracking-wider font-semibold">
                <th className="py-3 px-3">Session Date</th>
                <th className="py-3 px-3">NIFTY Spot Range</th>
                <th className="py-3 px-3">Initial Strikes</th>
                <th className="py-3 px-3 text-center">Adjustments Executed</th>
                <th className="py-3 px-3 text-right">Credit Collected</th>
                <th className="py-3 px-3 text-right">Intraday High</th>
                <th className="py-3 px-3 text-right">Final Day P&L</th>
                <th className="py-3 px-3 text-center">Exit Trigger</th>
                <th className="py-3 px-3 text-center">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 font-mono">
              {breakdown.map((day) => {
                const isDayWin = day.finalPnl >= 0;
                const isExpanded = expandedDayIndex === day.dayIndex;
                const hasAdjustments = (day.adjustmentsCount || 0) > 0;

                return (
                  <React.Fragment key={day.dayIndex}>
                    <tr className={`hover:bg-slate-800/40 transition-colors ${isExpanded ? 'bg-slate-800/30' : ''}`}>
                      
                      {/* Session Date */}
                      <td className="py-3 px-3 font-sans">
                        <div className="font-bold text-slate-200">{day.dayOfWeek}, {day.dateStr}</div>
                        <span className="text-[10px] text-slate-500">Day #{day.dayIndex}</span>
                      </td>

                      {/* NIFTY Spot Range */}
                      <td className="py-3 px-3">
                        <div className="text-slate-200 font-semibold">₹{day.openSpot} → ₹{day.closeSpot}</div>
                        <span className="text-[10px] text-slate-400 font-sans">
                          Range: {day.spotRangePts} pts (L: ₹{day.lowSpot} | H: ₹{day.highSpot})
                        </span>
                      </td>

                      {/* Iron Condor Strikes */}
                      <td className="py-3 px-3 font-sans">
                        <div className="flex items-center space-x-1 text-[11px]">
                          <span className="text-rose-400 font-bold">CE: {day.shortCeStrike}</span>
                          <span className="text-slate-600">|</span>
                          <span className="text-emerald-400 font-bold">PE: {day.shortPeStrike}</span>
                        </div>
                        <div className="text-[10px] text-slate-500">
                          Wings: {day.longCeStrike} CE / {day.longPeStrike} PE
                        </div>
                      </td>

                      {/* Adjustments Executed Badge & Count */}
                      <td className="py-3 px-3 text-center font-sans">
                        <div className="flex flex-col items-center justify-center space-y-0.5">
                          {hasAdjustments ? (
                            <button
                              type="button"
                              onClick={() => setExpandedDayIndex(isExpanded ? null : day.dayIndex)}
                              className="bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/40 text-amber-300 text-[11px] font-bold px-2.5 py-0.5 rounded-full inline-flex items-center gap-1.5 transition-colors cursor-pointer"
                            >
                              <RefreshCw className="w-3 h-3 text-amber-400" />
                              <span>{day.adjustmentsCount} Adjustment{day.adjustmentsCount > 1 ? 's' : ''}</span>
                            </button>
                          ) : (
                            <span className="bg-slate-800 text-slate-400 border border-slate-700/80 text-[10px] font-semibold px-2 py-0.5 rounded-full inline-flex items-center gap-1">
                              <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                              <span>0 Adjustments</span>
                            </span>
                          )}
                          <span className="text-[10px] text-slate-500">
                            {hasAdjustments ? 'Rolls executed' : 'Held in corridor'}
                          </span>
                        </div>
                      </td>

                      {/* Credit Collected */}
                      <td className="py-3 px-3 text-right text-slate-200 font-bold">
                        ₹{day.creditCollected.toLocaleString('en-IN')}
                      </td>

                      {/* Intraday High */}
                      <td className="py-3 px-3 text-right text-emerald-400 font-semibold">
                        +₹{day.maxProfitReached.toLocaleString('en-IN')}
                      </td>

                      {/* Final Day P&L */}
                      <td className="py-3 px-3 text-right">
                        <div className={`text-sm font-bold ${isDayWin ? 'text-emerald-400' : 'text-rose-400'}`}>
                          {isDayWin ? '+' : ''}₹{day.finalPnl.toLocaleString('en-IN')}
                        </div>
                        <span className={`text-[10px] font-sans font-semibold ${isDayWin ? 'text-emerald-400' : 'text-rose-400'}`}>
                          ({isDayWin ? '+' : ''}{day.pnlPct}%)
                        </span>
                      </td>

                      {/* Exit Trigger Badge */}
                      <td className="py-3 px-3 text-center font-sans">
                        <div className="flex flex-col items-center space-y-1">
                          <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide border inline-flex items-center space-x-1 ${
                            day.exitReason === 'TARGET_PROFIT'
                              ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                              : day.exitReason === 'STOP_LOSS'
                              ? 'bg-rose-500/10 text-rose-400 border-rose-500/30'
                              : day.exitReason === 'DEFENSIVE_ADJUSTED'
                              ? 'bg-amber-500/10 text-amber-400 border-amber-500/30'
                              : 'bg-blue-500/10 text-blue-400 border-blue-500/30'
                          }`}>
                            {day.exitReason === 'TARGET_PROFIT' && <CheckCircle2 className="w-3 h-3" />}
                            {day.exitReason === 'STOP_LOSS' && <AlertTriangle className="w-3 h-3" />}
                            <span>{day.exitReason.replace(/_/g, ' ')}</span>
                          </span>
                          <span className="text-[10px] text-slate-500">at {day.exitTime} IST</span>
                        </div>
                      </td>

                      {/* Expand / Collapse Button */}
                      <td className="py-3 px-3 text-center font-sans">
                        <button
                          type="button"
                          onClick={() => setExpandedDayIndex(isExpanded ? null : day.dayIndex)}
                          className="p-1 text-slate-400 hover:text-slate-100 hover:bg-slate-800 rounded transition-colors cursor-pointer"
                          title="View trade adjustment audit log"
                        >
                          {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                        </button>
                      </td>

                    </tr>

                    {/* EXPANDABLE ROW FOR ADJUSTMENT LOG DETAILS */}
                    {isExpanded && (
                      <tr className="bg-slate-950/90 border-b border-slate-800">
                        <td colSpan={9} className="p-4 font-sans space-y-3">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center space-x-2">
                              <Layers className="w-4 h-4 text-indigo-400" />
                              <h4 className="text-xs font-bold text-slate-200 uppercase tracking-wide">
                                Trade Audit & Adjustment Logs — {day.dayOfWeek}, {day.dateStr} (Day #{day.dayIndex})
                              </h4>
                            </div>
                            <span className="text-[11px] font-mono text-slate-400">
                              {day.adjustmentsCount || 0} Adjustment Event{(day.adjustmentsCount || 0) !== 1 ? 's' : ''} Triggered
                            </span>
                          </div>

                          {day.adjustments && day.adjustments.length > 0 ? (
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1">
                              {day.adjustments.map((adj, adjIdx) => (
                                <div key={adjIdx} className="bg-slate-900 border border-amber-500/30 rounded-xl p-3 space-y-2">
                                  <div className="flex items-center justify-between border-b border-slate-800 pb-1.5">
                                    <span className="text-xs font-bold text-amber-300 flex items-center gap-1.5">
                                      <RefreshCw className="w-3.5 h-3.5 text-amber-400" />
                                      {adj.title}
                                    </span>
                                    <span className="text-[10px] font-mono text-slate-400 bg-slate-950 px-2 py-0.5 rounded border border-slate-800">
                                      {adj.time}
                                    </span>
                                  </div>

                                  <p className="text-xs text-slate-300 leading-relaxed">
                                    {adj.description}
                                  </p>

                                  <div className="grid grid-cols-2 gap-2 text-[11px] font-mono pt-1">
                                    <div className="bg-slate-950/70 p-2 rounded border border-slate-800">
                                      <div className="text-slate-500 text-[10px] uppercase font-sans">Trigger Condition</div>
                                      <div className="text-slate-200 font-semibold">{adj.triggerCondition}</div>
                                    </div>
                                    <div className="bg-slate-950/70 p-2 rounded border border-slate-800">
                                      <div className="text-slate-500 text-[10px] uppercase font-sans">Credit / Profit Impact</div>
                                      <div className="text-emerald-400 font-bold">
                                        +₹{adj.freshCreditCollected.toLocaleString('en-IN')} Fresh Credit
                                      </div>
                                    </div>
                                  </div>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div className="bg-slate-900 border border-slate-800 rounded-xl p-3.5 text-xs text-slate-400 flex items-center space-x-2">
                              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                              <span>
                                No defensive adjustments were needed for this session. Spot stayed comfortably within the protective corridor throughout the day.
                              </span>
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* STRATEGY INSIGHTS & AI RECOMMENDATIONS */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-3 shadow-xl">
        <div className="flex items-center space-x-2 border-b border-slate-800 pb-3">
          <Info className="w-5 h-5 text-indigo-400" />
          <h3 className="text-sm font-bold text-slate-100">Backtest Strategy Insights & Analysis</h3>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-1">
          {data?.insights.map((insight, idx) => (
            <div key={idx} className="p-3.5 rounded-xl bg-slate-950/60 border border-slate-800/80 flex items-start space-x-3 text-xs leading-relaxed text-slate-300">
              <div className="p-1.5 rounded-lg bg-indigo-500/10 text-indigo-400 shrink-0 mt-0.5">
                <ShieldCheck className="w-4 h-4" />
              </div>
              <div>{insight}</div>
            </div>
          ))}
        </div>
      </div>

    </div>
  );
};
