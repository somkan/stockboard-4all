import React, { useEffect, useState, useMemo } from 'react';
import { 
  FileText, 
  Filter, 
  Calendar, 
  Search, 
  RefreshCw, 
  ArrowUpRight, 
  ArrowDownRight,
  Download,
  XCircle,
  Clock,
  TrendingUp,
  TrendingDown,
  ShieldCheck,
  Zap,
  Activity
} from 'lucide-react';
import { TradeLogRecord, TradingMode } from '../types';
import { User } from '../firebase';

interface TradeLogViewProps {
  currentUser?: User | null;
}

export const TradeLogView: React.FC<TradeLogViewProps> = ({ currentUser }) => {
  const [logs, setLogs] = useState<TradeLogRecord[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Filters State
  const [actionFilter, setActionFilter] = useState<string>('ALL');
  const [modeFilter, setModeFilter] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [startDate, setStartDate] = useState<string>('');
  const [endDate, setEndDate] = useState<string>('');
  const [quickDatePreset, setQuickDatePreset] = useState<string>('ALL_TIME');

  // Set quick date preset
  const applyQuickDatePreset = (preset: string) => {
    setQuickDatePreset(preset);
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];

    if (preset === 'ALL_TIME') {
      setStartDate('');
      setEndDate('');
    } else if (preset === 'TODAY') {
      setStartDate(todayStr);
      setEndDate(todayStr);
    } else if (preset === 'YESTERDAY') {
      const yest = new Date(now);
      yest.setDate(yest.getDate() - 1);
      const yestStr = yest.toISOString().split('T')[0];
      setStartDate(yestStr);
      setEndDate(yestStr);
    } else if (preset === 'LAST_7_DAYS') {
      const past7 = new Date(now);
      past7.setDate(past7.getDate() - 7);
      setStartDate(past7.toISOString().split('T')[0]);
      setEndDate(todayStr);
    } else if (preset === 'LAST_30_DAYS') {
      const past30 = new Date(now);
      past30.setDate(past30.getDate() - 30);
      setStartDate(past30.toISOString().split('T')[0]);
      setEndDate(todayStr);
    }
  };

  const fetchTradeLogs = async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const params = new URLSearchParams();
      if (actionFilter && actionFilter !== 'ALL') params.append('action', actionFilter);
      if (modeFilter && modeFilter !== 'ALL') params.append('mode', modeFilter);
      if (searchQuery.trim()) params.append('search', searchQuery.trim());
      if (startDate) params.append('startDate', startDate);
      if (endDate) params.append('endDate', endDate);

      const headers: Record<string, string> = {
        'Content-Type': 'application/json'
      };
      if (currentUser?.email) {
        headers['X-User-Email'] = currentUser.email;
      }

      const res = await fetch(`/api/logs?${params.toString()}`, { headers });
      const contentType = res.headers.get('content-type');
      if (res.ok && contentType && contentType.includes('application/json')) {
        const data = await res.json();
        if (Array.isArray(data)) {
          setLogs(data);
        } else {
          setLogs([]);
        }
      } else {
        const errText = await res.text();
        setErrorMsg(`Failed to load logs: ${errText || res.statusText}`);
      }
    } catch (err: any) {
      console.warn('Trade logs load notice:', err?.message || err);
      setErrorMsg(err?.message || 'Network error fetching trade logs');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTradeLogs();
  }, [actionFilter, modeFilter, startDate, endDate]);

  // Client-side instant filter fallback for robust live search
  const filteredLogs = useMemo(() => {
    return logs.filter((log) => {
      // 1. Action Filter
      if (actionFilter !== 'ALL') {
        const act = actionFilter.toUpperCase();
        if (act === 'ALL_ADJUSTMENTS') {
          const isAdj = log.action.includes('SCENARIO') || 
                        log.action.includes('ADJUST') || 
                        log.action.includes('LOCK') || 
                        log.action.includes('WING') || 
                        log.action.includes('ROLL');
          if (!isAdj) return false;
        } else if (act === 'ALL_EXITS') {
          const isExit = log.action.includes('EXIT') || log.action.includes('CLOSE') || log.action.includes('SQUARE');
          if (!isExit) return false;
        } else if (act === 'ALL_ENTRIES') {
          const isEntry = log.action.includes('ENTRY') || log.action.includes('OPPORTUNITY');
          if (!isEntry) return false;
        } else {
          if (log.action !== actionFilter && !log.action.toUpperCase().includes(act)) {
            return false;
          }
        }
      }

      // 2. Mode Filter
      if (modeFilter !== 'ALL') {
        if ((log.mode || 'PAPER').toUpperCase() !== modeFilter.toUpperCase()) {
          return false;
        }
      }

      // 3. Search Query
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        const matches = 
          (log.notes && log.notes.toLowerCase().includes(q)) ||
          (log.strategy && log.strategy.toLowerCase().includes(q)) ||
          (log.symbol && log.symbol.toLowerCase().includes(q)) ||
          (log.action && log.action.toLowerCase().includes(q)) ||
          (log.id && log.id.toLowerCase().includes(q));
        if (!matches) return false;
      }

      // 4. Date Range
      if (startDate) {
        const start = new Date(startDate);
        start.setHours(0, 0, 0, 0);
        if (new Date(log.timestamp) < start) return false;
      }
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        if (new Date(log.timestamp) > end) return false;
      }

      return true;
    });
  }, [logs, actionFilter, modeFilter, searchQuery, startDate, endDate]);

  // Summary Metrics
  const metrics = useMemo(() => {
    let totalPnl = 0;
    let liveCount = 0;
    let paperCount = 0;
    let profitCount = 0;
    let lossCount = 0;

    filteredLogs.forEach(l => {
      totalPnl += (l.pnl || 0);
      if (l.mode === 'LIVE') liveCount++;
      else paperCount++;

      if (l.pnl > 0) profitCount++;
      else if (l.pnl < 0) lossCount++;
    });

    return {
      totalPnl: Math.round(totalPnl),
      totalCount: filteredLogs.length,
      liveCount,
      paperCount,
      profitCount,
      lossCount
    };
  }, [filteredLogs]);

  // Export to CSV
  const handleExportCSV = () => {
    if (filteredLogs.length === 0) return;
    const headers = ['Timestamp', 'Action', 'Strategy', 'Symbol', 'Spot Price', 'Quantity', 'Realized PnL', 'Mode', 'Notes'];
    const rows = filteredLogs.map(l => [
      `"${new Date(l.timestamp).toLocaleString('en-IN')}"`,
      `"${l.action}"`,
      `"${l.strategy}"`,
      `"${l.symbol}"`,
      l.price,
      l.quantity,
      l.pnl,
      `"${l.mode || 'PAPER'}"`,
      `"${(l.notes || '').replace(/"/g, '""')}"`
    ]);

    const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map(e => e.join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `Stockboard_Trade_Logs_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleResetFilters = () => {
    setActionFilter('ALL');
    setModeFilter('ALL');
    setSearchQuery('');
    setStartDate('');
    setEndDate('');
    setQuickDatePreset('ALL_TIME');
  };

  const hasActiveFilters = actionFilter !== 'ALL' || modeFilter !== 'ALL' || searchQuery.trim() !== '' || startDate !== '' || endDate !== '';

  return (
    <div className="space-y-4 pb-12">
      
      {/* 1. Header & Summary Statistics Banner */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-3.5 sm:p-5 shadow-lg">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 sm:gap-4">
          <div>
            <div className="flex items-center space-x-2 sm:space-x-2.5">
              <div className="p-1.5 sm:p-2 bg-indigo-500/10 border border-indigo-500/20 rounded-lg text-indigo-400 shrink-0">
                <FileText className="w-4 h-4 sm:w-5 sm:h-5" />
              </div>
              <div className="min-w-0">
                <h2 className="text-xs sm:text-base font-bold text-slate-100 flex flex-wrap items-center gap-1.5">
                  <span>TRADE EXECUTION &amp; STRATEGY HISTORY</span>
                  <span className="text-[9px] sm:text-[11px] font-normal text-indigo-400 bg-indigo-500/10 border border-indigo-500/20 px-1.5 sm:px-2 py-0.5 rounded-full whitespace-nowrap">
                    Persistent History
                  </span>
                </h2>
                <p className="text-[11px] sm:text-xs text-slate-400 mt-0.5">
                  Complete audit trail of all previous day &amp; live trades, Short Straddles, Scenario 1–3 No-Loss locks, and exits
                </p>
              </div>
            </div>
          </div>

          {/* Quick Metrics Strip */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
            <div className="bg-slate-950/70 border border-slate-800/80 px-3 py-2 rounded-lg">
              <span className="text-[10px] uppercase font-bold text-slate-400 block">Total Logs</span>
              <span className="text-sm font-bold text-slate-100 font-mono">{metrics.totalCount}</span>
            </div>

            <div className="bg-slate-950/70 border border-slate-800/80 px-3 py-2 rounded-lg">
              <span className="text-[10px] uppercase font-bold text-slate-400 block">Realized P&amp;L</span>
              <span className={`text-sm font-bold font-mono ${metrics.totalPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                {metrics.totalPnl >= 0 ? '+' : ''}₹{metrics.totalPnl.toLocaleString('en-IN')}
              </span>
            </div>

            <div className="bg-slate-950/70 border border-slate-800/80 px-3 py-2 rounded-lg">
              <span className="text-[10px] uppercase font-bold text-slate-400 block">Live vs Paper</span>
              <span className="text-xs font-semibold text-slate-200">
                <span className="text-rose-400">{metrics.liveCount} Live</span> / <span className="text-amber-400">{metrics.paperCount} Paper</span>
              </span>
            </div>

            <div className="bg-slate-950/70 border border-slate-800/80 px-3 py-2 rounded-lg">
              <span className="text-[10px] uppercase font-bold text-slate-400 block">Export</span>
              <button
                onClick={handleExportCSV}
                disabled={filteredLogs.length === 0}
                className="flex items-center space-x-1 text-xs font-semibold text-indigo-400 hover:text-indigo-300 disabled:opacity-40 transition-colors"
                title="Download CSV report of current filtered logs"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Export CSV</span>
              </button>
            </div>
          </div>
        </div>

        {/* Quick Date Presets Strip */}
        <div className="mt-4 pt-3 border-t border-slate-800 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="text-slate-400 text-[11px] font-medium mr-1 flex items-center">
              <Clock className="w-3.5 h-3.5 mr-1 text-slate-500" />
              Timeframe:
            </span>
            {[
              { id: 'ALL_TIME', label: 'All History' },
              { id: 'TODAY', label: 'Today' },
              { id: 'YESTERDAY', label: 'Yesterday' },
              { id: 'LAST_7_DAYS', label: 'Last 7 Days' },
              { id: 'LAST_30_DAYS', label: 'Last 30 Days' }
            ].map((preset) => (
              <button
                key={preset.id}
                onClick={() => applyQuickDatePreset(preset.id)}
                className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-all ${
                  quickDatePreset === preset.id
                    ? 'bg-indigo-600 text-white font-semibold shadow-sm shadow-indigo-600/30'
                    : 'bg-slate-800/80 text-slate-400 hover:text-slate-200 hover:bg-slate-700/80'
                }`}
              >
                {preset.label}
              </button>
            ))}
          </div>

          {hasActiveFilters && (
            <button
              onClick={handleResetFilters}
              className="flex items-center space-x-1 text-[11px] font-medium text-rose-400 hover:text-rose-300 transition-colors px-2 py-1 bg-rose-500/10 hover:bg-rose-500/20 rounded-md border border-rose-500/20"
            >
              <XCircle className="w-3.5 h-3.5" />
              <span>Reset All Filters</span>
            </button>
          )}
        </div>
      </div>

      {/* 2. Comprehensive Filter Controls Bar */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 shadow-sm">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-12 gap-3">
          
          {/* Keyword Search Input */}
          <div className="lg:col-span-4 relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search notes, symbols, strategies, IDs..."
              className="w-full bg-slate-800 text-slate-200 border border-slate-700 text-xs rounded-lg pl-9 pr-3 py-2 outline-none focus:border-indigo-500 placeholder-slate-500"
            />
          </div>

          {/* Action Category Filter */}
          <div className="lg:col-span-3">
            <select
              value={actionFilter}
              onChange={(e) => {
                setActionFilter(e.target.value);
                setQuickDatePreset('CUSTOM');
              }}
              className="w-full bg-slate-800 text-slate-200 border border-slate-700 text-xs rounded-lg px-3 py-2 outline-none focus:border-indigo-500"
            >
              <option value="ALL">All Action Types</option>
              <option value="ALL_ADJUSTMENTS">⚡ All Strategy Adjustments (Scenarios &amp; Wings)</option>
              <option value="ALL_ENTRIES">🎯 All Initial Entries &amp; Opportunities</option>
              <option value="ALL_EXITS">🚪 All Exits &amp; Square Offs</option>
              <option value="ENTRY">ENTRY (Short Straddle)</option>
              <option value="WING_ADDITION">WING_ADDITION (Iron Condor Lock)</option>
              <option value="DEFENSIVE_ROLL">DEFENSIVE_ROLL (Strike Shift)</option>
              <option value="SCENARIO_1_NO_LOSS_LOCK">Scenario 1: No Loss Lock (DTE &lt; 5d)</option>
              <option value="SCENARIO_2_ROLL_AND_LOCK_NO_LOSS">Scenario 2: Roll &amp; Lock (DTE &ge; 5d)</option>
              <option value="SCENARIO_3_RULE1_RULE2_SELL_POSITIVE_LEG">Scenario 3: Rule 1 &amp; 2 Sell Positive Leg</option>
              <option value="SCENARIO_3_LOCK_NO_LOSS_TRADE">Scenario 3: Target Recovery No Loss Lock</option>
              <option value="EXIT_PROFIT">EXIT_PROFIT</option>
              <option value="EXIT_STOPLOSS">EXIT_STOPLOSS</option>
              <option value="FYERS_LIVE_TRADE">FYERS_LIVE_TRADE</option>
            </select>
          </div>

          {/* Mode Filter */}
          <div className="lg:col-span-2">
            <select
              value={modeFilter}
              onChange={(e) => setModeFilter(e.target.value)}
              className="w-full bg-slate-800 text-slate-200 border border-slate-700 text-xs rounded-lg px-3 py-2 outline-none focus:border-indigo-500"
            >
              <option value="ALL">All Modes</option>
              <option value="LIVE">Live Broker (LIVE)</option>
              <option value="PAPER">Paper Simulation (PAPER)</option>
            </select>
          </div>

          {/* Date Picker Range */}
          <div className="lg:col-span-2 flex items-center space-x-1.5">
            <input
              type="date"
              value={startDate}
              onChange={(e) => {
                setStartDate(e.target.value);
                setQuickDatePreset('CUSTOM');
              }}
              className="w-1/2 bg-slate-800 text-slate-200 border border-slate-700 text-[11px] rounded-lg px-2 py-2 outline-none focus:border-indigo-500"
              title="Start Date"
            />
            <span className="text-slate-500 text-xs">-</span>
            <input
              type="date"
              value={endDate}
              onChange={(e) => {
                setEndDate(e.target.value);
                setQuickDatePreset('CUSTOM');
              }}
              className="w-1/2 bg-slate-800 text-slate-200 border border-slate-700 text-[11px] rounded-lg px-2 py-2 outline-none focus:border-indigo-500"
              title="End Date"
            />
          </div>

          {/* Refresh Button */}
          <div className="lg:col-span-1 flex items-center justify-end">
            <button
              onClick={fetchTradeLogs}
              disabled={loading}
              className="w-full sm:w-auto p-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white transition-colors flex items-center justify-center cursor-pointer shadow-sm shadow-indigo-600/20"
              title="Refresh logs & sync Fyers tradebook"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>

        </div>

        {errorMsg && (
          <div className="mt-3 p-2.5 bg-rose-500/10 border border-rose-500/20 rounded-lg text-rose-400 text-xs">
            {errorMsg}
          </div>
        )}
      </div>

      {/* 3. Trade Log Table with Word-Wrapped Execution Notes */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-lg">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs font-mono">
            <thead>
              <tr className="bg-slate-950 text-slate-400 border-b border-slate-800 uppercase text-[10px] tracking-wider">
                <th className="py-3 px-4 whitespace-nowrap">DATE &amp; TIME (IST)</th>
                <th className="py-3 px-4 whitespace-nowrap">ACTION TYPE</th>
                <th className="py-3 px-4 whitespace-nowrap">STRATEGY</th>
                <th className="py-3 px-4 whitespace-nowrap">SPOT PRICE</th>
                <th className="py-3 px-4 whitespace-nowrap">QTY</th>
                <th className="py-3 px-4 whitespace-nowrap">REALIZED P&amp;L</th>
                <th className="py-3 px-4 whitespace-nowrap">MODE</th>
                <th className="py-3 px-4 min-w-[280px]">EXECUTION NOTES &amp; AUDIT TRAIL</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 font-sans">
              {filteredLogs.length > 0 ? (
                filteredLogs.map((log) => {
                  const isPositive = (log.pnl || 0) >= 0;
                  const isScenario = log.action.includes('SCENARIO');
                  const isLock = log.action.includes('LOCK') || log.action === 'WING_ADDITION';
                  const isRoll = log.action.includes('ROLL');
                  const isExit = log.action.includes('EXIT');

                  return (
                    <tr key={log.id} className="hover:bg-slate-800/40 transition-colors">
                      {/* Date & Time */}
                      <td className="py-3 px-4 text-slate-400 text-[11px] whitespace-nowrap font-mono">
                        <div>{new Date(log.timestamp).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}</div>
                        <div className="text-[10px] text-slate-500">{new Date(log.timestamp).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</div>
                      </td>

                      {/* Action Type Badge */}
                      <td className="py-3 px-4 whitespace-nowrap">
                        <span className={`px-2.5 py-1 rounded text-[10px] font-bold inline-flex items-center space-x-1 ${
                          isLock
                            ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30'
                            : isScenario
                            ? 'bg-indigo-500/10 text-indigo-400 border border-indigo-500/30'
                            : log.action === 'ENTRY'
                            ? 'bg-blue-500/10 text-blue-400 border border-blue-500/30'
                            : isRoll
                            ? 'bg-amber-500/10 text-amber-400 border border-amber-500/30'
                            : log.action === 'EXIT_PROFIT'
                            ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                            : isExit
                            ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                            : 'bg-slate-800 text-slate-300 border border-slate-700'
                        }`}>
                          <span>{log.action}</span>
                        </span>
                      </td>

                      {/* Strategy */}
                      <td className="py-3 px-4 text-slate-200 font-semibold whitespace-nowrap text-xs">
                        {log.strategy}
                      </td>

                      {/* Spot Price */}
                      <td className="py-3 px-4 text-slate-300 font-mono whitespace-nowrap">
                        ₹{log.price ? log.price.toLocaleString('en-IN') : '0'}
                      </td>

                      {/* Quantity */}
                      <td className="py-3 px-4 text-slate-300 font-mono whitespace-nowrap">
                        {log.quantity}
                      </td>

                      {/* Realized P&L */}
                      <td className={`py-3 px-4 font-bold font-mono whitespace-nowrap ${log.pnl > 0 ? 'text-emerald-400' : log.pnl < 0 ? 'text-rose-400' : 'text-slate-400'}`}>
                        {log.pnl !== 0 ? `${log.pnl > 0 ? '+' : ''}₹${log.pnl.toLocaleString('en-IN')}` : '₹0'}
                      </td>

                      {/* Mode */}
                      <td className="py-3 px-4 whitespace-nowrap">
                        <span className={`text-[10px] uppercase font-bold px-2 py-0.5 rounded border ${
                          log.mode === 'LIVE'
                            ? 'bg-rose-500/10 text-rose-400 border-rose-500/30'
                            : 'bg-amber-500/10 text-amber-400 border-amber-500/30'
                        }`}>
                          {log.mode || 'PAPER'}
                        </span>
                      </td>

                      {/* Execution Notes with Word Wrapping */}
                      <td className="py-3 px-4 text-slate-300 text-[11px] whitespace-normal break-words leading-relaxed min-w-[280px] max-w-xl">
                        <p className="text-slate-300">{log.notes || 'Execution recorded without specific parameters'}</p>
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={8} className="text-center py-12 text-slate-500">
                    <div className="flex flex-col items-center justify-center space-y-2">
                      <FileText className="w-8 h-8 text-slate-600" />
                      <p className="text-sm font-medium text-slate-400">No trade logs match the selected filter parameters.</p>
                      {hasActiveFilters && (
                        <button
                          onClick={handleResetFilters}
                          className="text-xs text-indigo-400 hover:text-indigo-300 underline cursor-pointer"
                        >
                          Clear filters to view all trade history
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

    </div>
  );
};
