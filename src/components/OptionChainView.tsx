import React, { useEffect, useState } from 'react';
import { Layers, RefreshCw, Eye } from 'lucide-react';
import { OptionChainItem } from '../types';

export const OptionChainView: React.FC = () => {
  const [data, setData] = useState<{ spotPrice: number; items: OptionChainItem[] } | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  const fetchOptionChain = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/market/option-chain');
      const contentType = res.headers.get('content-type');
      if (res.ok && contentType && contentType.includes('application/json')) {
        const json = await res.json();
        setData(json);
      }
    } catch (err: any) {
      console.warn('Option chain fetch notice:', err?.message || err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchOptionChain();
    const interval = setInterval(fetchOptionChain, 5000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="space-y-4 pb-12">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between bg-slate-900 border border-slate-800 rounded-xl p-3.5 sm:p-4 gap-3">
        <div className="min-w-0">
          <h2 className="text-sm sm:text-base font-bold text-slate-100 flex items-center space-x-2">
            <Layers className="w-4 h-4 sm:w-5 sm:h-5 text-indigo-400 shrink-0" />
            <span className="truncate">NIFTY 50 OPTION CHAIN</span>
          </h2>
          <p className="text-[11px] sm:text-xs text-slate-400 mt-0.5">
            Real-time CE &amp; PE pricing, Open Interest (OI), and Implied Volatility (IV)
          </p>
        </div>

        <div className="flex items-center justify-between sm:justify-end space-x-3 shrink-0 border-t sm:border-t-0 pt-2 sm:pt-0 border-slate-800/80">
          <div className="text-left sm:text-right">
            <span className="text-[10px] text-slate-400 block uppercase font-semibold">Spot Price</span>
            <span className="text-sm sm:text-base font-bold font-mono text-emerald-400">
              ₹{data?.spotPrice.toLocaleString('en-IN') || '---'}
            </span>
          </div>

          <button
            onClick={fetchOptionChain}
            disabled={loading}
            className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors border border-slate-700 cursor-pointer"
            title="Refresh Option Chain"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin text-indigo-400' : ''}`} />
          </button>
        </div>
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-center text-xs font-mono">
            <thead>
              <tr className="bg-slate-950 text-slate-400 border-b border-slate-800 uppercase text-[10px]">
                <th colSpan={3} className="py-2.5 bg-emerald-950/20 text-emerald-400 border-r border-slate-800">
                  CALL OPTIONS (CE)
                </th>
                <th className="py-2.5 bg-slate-900 text-slate-200">STRIKE</th>
                <th colSpan={3} className="py-2.5 bg-rose-950/20 text-rose-400 border-l border-slate-800">
                  PUT OPTIONS (PE)
                </th>
              </tr>
              <tr className="border-b border-slate-800 text-slate-500 text-[10px]">
                <th className="py-2">OI</th>
                <th className="py-2">IV %</th>
                <th className="py-2 border-r border-slate-800">LTP (₹)</th>
                <th className="py-2 font-bold text-slate-300">PRICE</th>
                <th className="py-2 border-l border-slate-800">LTP (₹)</th>
                <th className="py-2">IV %</th>
                <th className="py-2">OI</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {data?.items.map((item) => {
                const isAtm = data.spotPrice >= item.strike - 50 && data.spotPrice < item.strike + 50;
                const isCeItm = item.strike < data.spotPrice;
                const isPeItm = item.strike > data.spotPrice;

                return (
                  <tr
                    key={item.strike}
                    className={`${
                      isAtm ? 'bg-indigo-950/50 font-bold border-y-2 border-indigo-500' : 'hover:bg-slate-800/40'
                    }`}
                  >
                    {/* CE Columns */}
                    <td className={`py-2 text-slate-400 ${isCeItm ? 'bg-emerald-950/10' : ''}`}>
                      {(item.ce.oi / 1000).toFixed(0)}k
                    </td>
                    <td className={`py-2 text-slate-500 ${isCeItm ? 'bg-emerald-950/10' : ''}`}>
                      {item.ce.iv}%
                    </td>
                    <td className={`py-2 font-bold border-r border-slate-800 text-emerald-400 ${
                      isCeItm ? 'bg-emerald-950/20' : ''
                    }`}>
                      ₹{item.ce.ltp}
                    </td>

                    {/* STRIKE */}
                    <td className={`py-2 font-bold font-mono text-slate-100 ${isAtm ? 'text-indigo-400 text-sm' : ''}`}>
                      {item.strike}
                      {isAtm && <span className="ml-1 text-[9px] bg-indigo-500 text-white px-1 py-0.2 rounded">ATM</span>}
                    </td>

                    {/* PE Columns */}
                    <td className={`py-2 font-bold border-l border-slate-800 text-rose-400 ${
                      isPeItm ? 'bg-rose-950/20' : ''
                    }`}>
                      ₹{item.pe.ltp}
                    </td>
                    <td className={`py-2 text-slate-500 ${isPeItm ? 'bg-rose-950/10' : ''}`}>
                      {item.pe.iv}%
                    </td>
                    <td className={`py-2 text-slate-400 ${isPeItm ? 'bg-rose-950/10' : ''}`}>
                      {(item.pe.oi / 1000).toFixed(0)}k
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
