import React, { useState, useMemo } from 'react';
import {
  ResponsiveContainer,
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine
} from 'recharts';
import { ShieldCheck, AlertTriangle, RefreshCw, Zap, TrendingUp, TrendingDown } from 'lucide-react';

export interface PayoffPoint {
  spot: number;
  pnl: number;
  t0Pnl?: number;
}

export interface PayoffLeg {
  symbol: string;
  side: 'BUY' | 'SELL';
  strike?: number;
  qty: number;
  estimatedPrice?: number;
  optionType?: 'CE' | 'PE' | 'FUT' | 'SPOT';
}

interface PayoffChartProps {
  spotPrice: number;
  breakevenLower?: number;
  breakevenUpper?: number;
  legs?: PayoffLeg[];
  payoffPoints?: PayoffPoint[];
  expectedProfit?: number;
  maxRisk?: number;
  winProbabilityPct?: number;
  title?: string;
}

export const PayoffChart: React.FC<PayoffChartProps> = ({
  spotPrice,
  breakevenLower,
  breakevenUpper,
  legs = [],
  payoffPoints: externalPayoffPoints,
  expectedProfit = 0,
  maxRisk = 0,
  winProbabilityPct = 75,
  title = 'Interactive Payoff & Risk Profile'
}) => {
  // State for dynamic simulated spot price
  const [simulatedSpot, setSimulatedSpot] = useState<number>(spotPrice);

  // Sync simulated spot when initial spotPrice prop changes if user hasn't modified it heavily
  React.useEffect(() => {
    setSimulatedSpot(spotPrice);
  }, [spotPrice]);

  // Determine strike range bounds
  const strikeList = useMemo(() => {
    return legs.map(l => l.strike).filter((s): s is number => typeof s === 'number' && s > 0);
  }, [legs]);

  const minStrike = strikeList.length > 0 ? Math.min(...strikeList) : spotPrice - 1000;
  const maxStrike = strikeList.length > 0 ? Math.max(...strikeList) : spotPrice + 1000;

  const chartMinSpot = Math.round(Math.min(minStrike - 600, (breakevenLower || spotPrice - 1000) - 400, spotPrice - 1200) / 50) * 50;
  const chartMaxSpot = Math.round(Math.max(maxStrike + 600, (breakevenUpper || spotPrice + 1000) + 400, spotPrice + 1200) / 50) * 50;

  // Generate dense payoff curve (step size 25 pts) if not provided or to ensure smooth curve
  const chartData = useMemo(() => {
    const points: (PayoffPoint & { profitPnl: number; lossPnl: number })[] = [];
    const step = 25;

    // Helper to calculate expiry PnL for a given spot level
    const calculatePnlAtSpot = (s: number) => {
      if (externalPayoffPoints && externalPayoffPoints.length >= 5 && legs.length === 0) {
        // Find nearest point interpolation
        const exact = externalPayoffPoints.find(p => p.spot === s);
        if (exact) return exact.pnl;
      }

      if (legs.length === 0) return 0;

      let netPnl = 0;
      for (const leg of legs) {
        const qty = leg.qty;
        const entryPrice = leg.estimatedPrice || 0;
        const strike = leg.strike || spotPrice;

        if (leg.optionType === 'CE') {
          const expiryVal = Math.max(0, s - strike);
          const legPnl = leg.side === 'SELL' ? (entryPrice - expiryVal) * qty : (expiryVal - entryPrice) * qty;
          netPnl += legPnl;
        } else if (leg.optionType === 'PE') {
          const expiryVal = Math.max(0, strike - s);
          const legPnl = leg.side === 'SELL' ? (entryPrice - expiryVal) * qty : (expiryVal - entryPrice) * qty;
          netPnl += legPnl;
        } else if (leg.optionType === 'FUT') {
          const legPnl = leg.side === 'SELL' ? (entryPrice - s) * qty : (s - entryPrice) * qty;
          netPnl += legPnl;
        }
      }
      return Math.round(netPnl);
    };

    for (let s = chartMinSpot; s <= chartMaxSpot; s += step) {
      const pnl = calculatePnlAtSpot(s);
      // T+0 estimation (softened curve representing 60% decay before expiry)
      const t0Pnl = Math.round(pnl * 0.65);

      points.push({
        spot: s,
        pnl,
        t0Pnl,
        profitPnl: pnl >= 0 ? pnl : 0,
        lossPnl: pnl < 0 ? pnl : 0
      });
    }

    return points;
  }, [legs, externalPayoffPoints, spotPrice, chartMinSpot, chartMaxSpot]);

  // Calculate projected PnL at the currently selected simulated spot level
  const simulatedPnlInfo = useMemo(() => {
    const spotStep = Math.round(simulatedSpot / 25) * 25;
    const match = chartData.find(p => p.spot === spotStep) || chartData.find(p => Math.abs(p.spot - simulatedSpot) < 25);
    
    let pnl = match ? match.pnl : 0;
    const diffPts = simulatedSpot - spotPrice;
    const diffPct = (diffPts / spotPrice) * 100;

    let inProfitZone = pnl >= 0;
    let isBreakeven = false;

    if (breakevenLower && breakevenUpper) {
      if (simulatedSpot < breakevenLower || simulatedSpot > breakevenUpper) {
        inProfitZone = false;
      } else {
        inProfitZone = true;
      }
    }

    return {
      pnl,
      diffPts,
      diffPct,
      inProfitZone,
      isBreakeven
    };
  }, [simulatedSpot, spotPrice, chartData, breakevenLower, breakevenUpper]);

  return (
    <div className="bg-slate-950 border border-slate-800 rounded-2xl p-4 sm:p-5 space-y-4 shadow-2xl font-sans">
      {/* Header Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-3">
        <div>
          <h3 className="text-sm font-bold text-slate-100 flex items-center space-x-2">
            <Zap className="w-4 h-4 text-amber-400 animate-pulse" />
            <span>{title}</span>
          </h3>
          <p className="text-[11px] text-slate-400">
            Interactive expiry payoff graph with live embedded spot level tracking
          </p>
        </div>

        <div className="flex items-center space-x-2 text-xs font-mono">
          <span className="px-2.5 py-1 rounded-lg bg-slate-900 border border-slate-800 text-slate-300">
            Current Spot: <strong className="text-cyan-400">₹{spotPrice.toLocaleString('en-IN')}</strong>
          </span>
          <button
            onClick={() => setSimulatedSpot(spotPrice)}
            className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-[11px] flex items-center space-x-1 transition-colors cursor-pointer"
            title="Reset to current market spot"
          >
            <RefreshCw className="w-3 h-3" />
            <span>Reset</span>
          </button>
        </div>
      </div>

      {/* DYNAMIC SPOT PRICE CONTROLLER SLIDER */}
      <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-3.5 space-y-2.5">
        <div className="flex items-center justify-between text-xs font-mono">
          <div className="flex items-center space-x-2">
            <span className="text-slate-400">Move Spot Level:</span>
            <span className="text-amber-300 font-bold text-sm">₹{simulatedSpot.toLocaleString('en-IN')}</span>
            <span className={`text-[11px] font-bold ${simulatedPnlInfo.diffPts >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
              ({simulatedPnlInfo.diffPts >= 0 ? '+' : ''}{simulatedPnlInfo.diffPts.toFixed(1)} pts / {simulatedPnlInfo.diffPct.toFixed(2)}%)
            </span>
          </div>

          <div className="flex items-center space-x-1">
            <span className="text-slate-400 text-[11px]">Projected Expiry P&L:</span>
            <span className={`text-sm font-bold px-2 py-0.5 rounded ${
              simulatedPnlInfo.pnl >= 0 ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
            }`}>
              {simulatedPnlInfo.pnl >= 0 ? '+' : ''}₹{simulatedPnlInfo.pnl.toLocaleString('en-IN')}
            </span>
          </div>
        </div>

        {/* Range Slider */}
        <div className="flex items-center space-x-3">
          <span className="text-[10px] font-mono text-slate-500">{chartMinSpot}</span>
          <input
            type="range"
            min={chartMinSpot}
            max={chartMaxSpot}
            step={10}
            value={simulatedSpot}
            onChange={(e) => setSimulatedSpot(Number(e.target.value))}
            className="w-full h-2 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-indigo-500 focus:outline-none"
          />
          <span className="text-[10px] font-mono text-slate-500">{chartMaxSpot}</span>
        </div>

        {/* Quick Shift Presets */}
        <div className="flex flex-wrap items-center justify-between gap-1.5 pt-1 text-[11px] font-mono">
          <div className="flex items-center space-x-1.5">
            <button
              onClick={() => setSimulatedSpot(prev => Math.max(chartMinSpot, prev - 200))}
              className="px-2 py-0.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded text-[10px] transition-colors"
            >
              -200
            </button>
            <button
              onClick={() => setSimulatedSpot(prev => Math.max(chartMinSpot, prev - 100))}
              className="px-2 py-0.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded text-[10px] transition-colors"
            >
              -100
            </button>
            <button
              onClick={() => setSimulatedSpot(prev => Math.max(chartMinSpot, prev - 50))}
              className="px-2 py-0.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded text-[10px] transition-colors"
            >
              -50
            </button>
            <button
              onClick={() => setSimulatedSpot(spotPrice)}
              className="px-2 py-0.5 bg-indigo-900/40 border border-indigo-700/50 text-indigo-300 rounded text-[10px] font-bold"
            >
              ATM Spot
            </button>
            <button
              onClick={() => setSimulatedSpot(prev => Math.min(chartMaxSpot, prev + 50))}
              className="px-2 py-0.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded text-[10px] transition-colors"
            >
              +50
            </button>
            <button
              onClick={() => setSimulatedSpot(prev => Math.min(chartMaxSpot, prev + 100))}
              className="px-2 py-0.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded text-[10px] transition-colors"
            >
              +100
            </button>
            <button
              onClick={() => setSimulatedSpot(prev => Math.min(chartMaxSpot, prev + 200))}
              className="px-2 py-0.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded text-[10px] transition-colors"
            >
              +200
            </button>
          </div>

          {(breakevenLower || breakevenUpper) && (
            <div className="flex items-center space-x-1.5">
              {breakevenLower && (
                <button
                  onClick={() => setSimulatedSpot(breakevenLower)}
                  className="px-2 py-0.5 bg-amber-950/40 border border-amber-800/40 text-amber-300 rounded text-[10px]"
                >
                  Lower BE ({breakevenLower})
                </button>
              )}
              {breakevenUpper && (
                <button
                  onClick={() => setSimulatedSpot(breakevenUpper)}
                  className="px-2 py-0.5 bg-amber-950/40 border border-amber-800/40 text-amber-300 rounded text-[10px]"
                >
                  Upper BE ({breakevenUpper})
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* RECHARTS INTERACTIVE PAYOFF GRAPH */}
      <div className="h-72 w-full pt-2 relative bg-slate-900/40 rounded-xl p-2 border border-slate-800/80">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chartData} margin={{ top: 15, right: 25, left: 15, bottom: 5 }}>
            <defs>
              <linearGradient id="payoffProfitGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#10b981" stopOpacity={0.5} />
                <stop offset="95%" stopColor="#10b981" stopOpacity={0.05} />
              </linearGradient>
              <linearGradient id="payoffLossGrad" x1="0" y1="1" x2="0" y2="0">
                <stop offset="5%" stopColor="#f43f5e" stopOpacity={0.5} />
                <stop offset="95%" stopColor="#f43f5e" stopOpacity={0.05} />
              </linearGradient>
            </defs>

            <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />

            <XAxis
              dataKey="spot"
              stroke="#64748b"
              tick={{ fontSize: 10, fill: '#94a3b8' }}
              domain={[chartMinSpot, chartMaxSpot]}
              type="number"
              tickFormatter={(v) => `₹${v}`}
            />

            <YAxis
              stroke="#64748b"
              tick={{ fontSize: 10, fill: '#94a3b8' }}
              tickFormatter={(v) => `₹${v >= 0 ? '+' : ''}${v}`}
            />

            <Tooltip
              contentStyle={{
                backgroundColor: '#0f172a',
                borderColor: '#334155',
                borderRadius: '12px',
                fontSize: '12px',
                color: '#f8fafc',
                boxShadow: '0 20px 25px -5px rgba(0,0,0,0.5)'
              }}
              formatter={(val: any) => [
                `₹${Number(val).toLocaleString('en-IN')}`,
                'Expiry P&L'
              ]}
              labelFormatter={(label: any) => `Spot Level: ₹${Number(label).toLocaleString('en-IN')}`}
            />

            {/* Zero PnL Reference Line */}
            <ReferenceLine y={0} stroke="#64748b" strokeWidth={1.5} strokeDasharray="4 4" />

            {/* Actual Live Spot Price Line */}
            {spotPrice && (
              <ReferenceLine
                x={Math.round(spotPrice / 25) * 25}
                stroke="#06b6d4"
                strokeWidth={2}
                strokeDasharray="2 2"
                label={{
                  value: `Live: ${spotPrice}`,
                  position: 'top',
                  fill: '#06b6d4',
                  fontSize: 10,
                  fontWeight: 'bold'
                }}
              />
            )}

            {/* DYNAMIC MOVING SIMULATED SPOT LINE */}
            <ReferenceLine
              x={Math.round(simulatedSpot / 25) * 25}
              stroke="#f59e0b"
              strokeWidth={3}
              label={{
                value: `Simulated: ${simulatedSpot}`,
                position: 'insideTopRight',
                fill: '#f59e0b',
                fontSize: 11,
                fontWeight: 'bold'
              }}
            />

            {/* Lower Breakeven Line */}
            {breakevenLower && (
              <ReferenceLine
                x={Math.round(breakevenLower / 25) * 25}
                stroke="#10b981"
                strokeWidth={1.5}
                strokeDasharray="3 3"
                label={{
                  value: `L-BE: ${breakevenLower}`,
                  position: 'bottom',
                  fill: '#10b981',
                  fontSize: 9
                }}
              />
            )}

            {/* Upper Breakeven Line */}
            {breakevenUpper && (
              <ReferenceLine
                x={Math.round(breakevenUpper / 25) * 25}
                stroke="#10b981"
                strokeWidth={1.5}
                strokeDasharray="3 3"
                label={{
                  value: `U-BE: ${breakevenUpper}`,
                  position: 'bottom',
                  fill: '#10b981',
                  fontSize: 9
                }}
              />
            )}

            {/* Legs Strike Lines */}
            {legs.map((leg, idx) => {
              if (!leg.strike) return null;
              const strikeRounded = Math.round(leg.strike / 25) * 25;
              const isCall = leg.optionType === 'CE';
              return (
                <ReferenceLine
                  key={idx}
                  x={strikeRounded}
                  stroke={leg.side === 'SELL' ? '#f43f5e' : '#3b82f6'}
                  strokeWidth={1}
                  strokeDasharray="2 2"
                  label={{
                    value: `${leg.side} ${leg.strike}${leg.optionType || ''}`,
                    position: isCall ? 'insideTopLeft' : 'insideBottomRight',
                    fill: leg.side === 'SELL' ? '#f43f5e' : '#60a5fa',
                    fontSize: 8
                  }}
                />
              );
            })}

            {/* Profit Area */}
            <Area
              type="monotone"
              dataKey="profitPnl"
              stroke="#10b981"
              strokeWidth={2}
              fill="url(#payoffProfitGrad)"
              baseValue={0}
            />

            {/* Loss Area */}
            <Area
              type="monotone"
              dataKey="lossPnl"
              stroke="#f43f5e"
              strokeWidth={2}
              fill="url(#payoffLossGrad)"
              baseValue={0}
            />

            {/* Main Expiry Payoff Line */}
            <Line
              type="monotone"
              dataKey="pnl"
              stroke="#38bdf8"
              strokeWidth={2.5}
              dot={false}
              activeDot={{ r: 6, fill: '#f59e0b', stroke: '#ffffff', strokeWidth: 2 }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* FOOTER STATS SUMMARY */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-xs font-mono pt-1">
        <div className="bg-slate-900/90 p-2.5 rounded-xl border border-slate-800">
          <span className="text-[10px] text-slate-500 block">Max Profit</span>
          <span className="font-bold text-emerald-400">+₹{expectedProfit.toLocaleString('en-IN')}</span>
        </div>

        <div className="bg-slate-900/90 p-2.5 rounded-xl border border-slate-800">
          <span className="text-[10px] text-slate-500 block">Max Risk</span>
          <span className="font-bold text-rose-400">
            {maxRisk === 0 ? 'RISK FREE (Capped)' : `₹${maxRisk.toLocaleString('en-IN')}`}
          </span>
        </div>

        <div className="bg-slate-900/90 p-2.5 rounded-xl border border-slate-800">
          <span className="text-[10px] text-slate-500 block">Lower Breakeven</span>
          <span className="font-bold text-amber-300">
            {breakevenLower ? `₹${breakevenLower}` : 'N/A'}
          </span>
        </div>

        <div className="bg-slate-900/90 p-2.5 rounded-xl border border-slate-800">
          <span className="text-[10px] text-slate-500 block">Upper Breakeven</span>
          <span className="font-bold text-amber-300">
            {breakevenUpper ? `₹${breakevenUpper}` : 'N/A'}
          </span>
        </div>
      </div>
    </div>
  );
};
