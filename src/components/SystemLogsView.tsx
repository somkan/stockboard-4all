import React, { useEffect, useState } from 'react';
import { Terminal, Search, RefreshCw, AlertCircle, CheckCircle2, Info } from 'lucide-react';
import { SystemLog } from '../types';

export const SystemLogsView: React.FC = () => {
  const [logs, setLogs] = useState<SystemLog[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState<string>('');
  const [levelFilter, setLevelFilter] = useState<string>('');

  const fetchSystemLogs = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/system-logs');
      if (!res.ok) {
        throw new Error(`Server returned HTTP ${res.status}`);
      }
      const contentType = res.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        const data = await res.json();
        if (Array.isArray(data)) {
          setLogs(data);
          setError(null);
        }
      }
    } catch (err: any) {
      console.warn('System audit logs update notice:', err?.message || err);
      setError(err?.message || 'Unable to connect to system logs endpoint');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSystemLogs();
    const interval = setInterval(fetchSystemLogs, 3000);
    return () => clearInterval(interval);
  }, []);

  const filteredLogs = logs.filter(log => {
    const matchesSearch = log.message.toLowerCase().includes(search.toLowerCase()) ||
      (log.metadata && JSON.stringify(log.metadata).toLowerCase().includes(search.toLowerCase()));
    const matchesLevel = !levelFilter || log.level === levelFilter;
    return matchesSearch && matchesLevel;
  });

  return (
    <div className="space-y-4 pb-12">
      
      {/* Header & Controls */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-3.5 sm:p-4 flex flex-col md:flex-row md:items-center justify-between gap-3 sm:gap-4">
        <div className="min-w-0">
          <h2 className="text-sm sm:text-base font-bold text-slate-100 flex items-center space-x-2">
            <Terminal className="w-4 h-4 sm:w-5 sm:h-5 text-indigo-400 shrink-0" />
            <span className="truncate">REAL-TIME SYSTEM AUDIT LOGS</span>
          </h2>
          <p className="text-[11px] sm:text-xs text-slate-400 mt-0.5">
            Winston logging engine monitoring strategy triggers, API calls, and risk alerts
          </p>
        </div>

        <div className="flex flex-wrap sm:flex-nowrap items-center gap-2">
          {/* Search Box */}
          <div className="relative flex-1 sm:flex-initial min-w-[130px]">
            <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-2.5" />
            <input
              type="text"
              placeholder="Filter logs..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full bg-slate-800 text-slate-200 text-xs pl-8 pr-3 py-1.5 rounded-lg border border-slate-700 outline-none focus:border-indigo-500"
            />
          </div>

          {/* Level Filter */}
          <select
            value={levelFilter}
            onChange={(e) => setLevelFilter(e.target.value)}
            className="bg-slate-800 text-slate-200 border border-slate-700 text-xs rounded-lg px-2.5 sm:px-3 py-1.5 outline-none focus:border-indigo-500 cursor-pointer shrink-0"
          >
            <option value="">All Levels</option>
            <option value="info">Info</option>
            <option value="success">Success</option>
            <option value="warn">Warn</option>
            <option value="error">Error</option>
          </select>

          <button
            onClick={fetchSystemLogs}
            className="p-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition-colors cursor-pointer shrink-0"
            title="Refresh logs"
          >
            <RefreshCw className={`w-3.5 h-3.5 sm:w-4 sm:h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Terminal View */}
      <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 font-mono text-xs overflow-x-auto max-h-[600px] overflow-y-auto space-y-2">
        {filteredLogs.length > 0 ? (
          filteredLogs.map((log) => (
            <div key={log.id} className="flex items-start space-x-3 py-1 border-b border-slate-900/60 leading-relaxed">
              <span className="text-slate-500 text-[10px] shrink-0 pt-0.5">
                [{new Date(log.timestamp).toLocaleTimeString('en-IN')}]
              </span>

              <span className={`px-1.5 py-0.2 rounded text-[10px] font-bold uppercase shrink-0 ${
                log.level === 'error'
                  ? 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
                  : log.level === 'warn'
                  ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                  : log.level === 'success'
                  ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                  : 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/30'
              }`}>
                {log.level}
              </span>

              <div className="flex-1 min-w-0">
                <span className="text-slate-200">{log.message}</span>
                {log.metadata && (
                  <span className="text-slate-400 block text-[10px] mt-0.5 font-mono truncate">
                    {JSON.stringify(log.metadata)}
                  </span>
                )}
              </div>
            </div>
          ))
        ) : error ? (
          <div className="text-center py-12 text-slate-400 space-y-2">
            <p className="text-amber-400 font-semibold">Unable to sync audit logs: {error}</p>
            <p className="text-xs text-slate-500">The server may be starting or re-establishing connection. Click refresh or wait a moment.</p>
          </div>
        ) : (
          <div className="text-center py-12 text-slate-600">No system audit logs found.</div>
        )}
      </div>

    </div>
  );
};
