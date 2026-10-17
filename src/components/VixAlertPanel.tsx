import React, { useState } from 'react';
import { 
  AlertTriangle, 
  Flame, 
  ShieldCheck, 
  Sliders, 
  Zap, 
  ArrowUpRight, 
  ArrowDownRight, 
  Check, 
  Info, 
  TrendingUp,
  RefreshCw,
  ChevronDown,
  ChevronUp
} from 'lucide-react';
import { VixData, Settings } from '../types';

interface VixAlertPanelProps {
  vixData?: VixData | null;
  settings?: Settings | null;
  spotPrice: number;
  onRefreshDashboard?: () => void;
  onUpdateSettings?: (updatedSettings: Partial<Settings>) => Promise<any>;
}

export const VixAlertPanel: React.FC<VixAlertPanelProps> = ({
  vixData,
  settings,
  spotPrice,
  onRefreshDashboard,
  onUpdateSettings
}) => {
  const currentVix = vixData?.vix || 14.5;
  const currentThreshold = settings?.vixThreshold ?? (vixData?.threshold ?? 15.5);
  const isHighVol = currentVix >= currentThreshold;
  
  const [thresholdInput, setThresholdInput] = useState<number>(currentThreshold);
  const [isUpdatingThreshold, setIsUpdatingThreshold] = useState<boolean>(false);
  const [isApplyingCondor, setIsApplyingCondor] = useState<boolean>(false);
  const [actionSuccessMsg, setActionSuccessMsg] = useState<string | null>(null);
  const [isExpanded, setIsExpanded] = useState<boolean>(isHighVol);

  // Sync state if settings update
  React.useEffect(() => {
    if (settings?.vixThreshold !== undefined) {
      setThresholdInput(settings.vixThreshold);
    }
  }, [settings?.vixThreshold]);

  // If high volatility suddenly triggers, auto-expand
  React.useEffect(() => {
    if (isHighVol) {
      setIsExpanded(true);
    }
  }, [isHighVol]);

  const handleSaveThreshold = async (newVal: number) => {
    const val = Math.max(8, Math.min(40, Math.round(newVal * 10) / 10));
    setThresholdInput(val);
    setIsUpdatingThreshold(true);
    try {
      if (onUpdateSettings) {
        await onUpdateSettings({ vixThreshold: val });
      } else {
        await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ vixThreshold: val })
        });
      }
      setActionSuccessMsg(`VIX threshold updated to ${val.toFixed(1)}`);
      if (onRefreshDashboard) onRefreshDashboard();
    } catch (err: any) {
      alert(`Failed to save threshold: ${err.message}`);
    } finally {
      setIsUpdatingThreshold(false);
      setTimeout(() => setActionSuccessMsg(null), 4000);
    }
  };

  const handleApplyVixCondor = async () => {
    if (!vixData) return;
    setIsApplyingCondor(true);
    try {
      const res = await fetch('/api/settings/apply-vix-condor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recommendedStrikeBuffer: vixData.recommendedStrikeBuffer,
          recommendedWingWidth: vixData.recommendedWingWidth
        })
      });
      const data = await res.json();
      if (data.success) {
        setActionSuccessMsg(`Applied! Buffer: ${vixData.recommendedStrikeBuffer} pts, Wings: ${vixData.recommendedWingWidth} pts`);
        if (onRefreshDashboard) onRefreshDashboard();
      } else {
        alert(data.error || 'Failed to apply recommended Condor structure');
      }
    } catch (err: any) {
      alert(`Error applying structure: ${err.message}`);
    } finally {
      setIsApplyingCondor(false);
      setTimeout(() => setActionSuccessMsg(null), 5000);
    }
  };

  const recommendedBuffer = vixData?.recommendedStrikeBuffer || 350;
  const recommendedWings = vixData?.recommendedWingWidth || 250;
  const strikes = vixData?.strikes || {
    shortCall: Math.round(spotPrice / 50) * 50 + recommendedBuffer,
    longCall: Math.round(spotPrice / 50) * 50 + recommendedBuffer + recommendedWings,
    shortPut: Math.round(spotPrice / 50) * 50 - recommendedBuffer,
    longPut: Math.round(spotPrice / 50) * 50 - recommendedBuffer - recommendedWings,
  };

  const currentBuffer = settings?.strikeDistance || 500;
  const currentWings = settings?.wingBuffer || 300;

  return (
    <div className={`rounded-2xl transition-all duration-200 border-2 overflow-hidden shadow-xl mb-5 ${
      isHighVol
        ? 'bg-gradient-to-r from-rose-950/80 via-slate-900 to-amber-950/70 border-rose-500/70 shadow-rose-950/40'
        : 'bg-slate-900/90 border-slate-800 shadow-slate-950/30'
    }`}>
      {/* Top Banner Header */}
      <div className="p-3.5 sm:p-4 flex flex-col md:flex-row items-start md:items-center justify-between gap-3 border-b border-slate-800/80">
        <div className="flex items-center space-x-3 min-w-0">
          <div className={`p-2.5 rounded-xl border shrink-0 ${
            isHighVol 
              ? 'bg-rose-500/20 text-rose-400 border-rose-500/40 animate-pulse'
              : 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
          }`}>
            {isHighVol ? (
              <Flame className="w-5 h-5 text-rose-400 fill-rose-400/20" />
            ) : (
              <ShieldCheck className="w-5 h-5 text-emerald-400" />
            )}
          </div>

          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-bold text-slate-100 text-sm tracking-wide flex items-center gap-1.5">
                <span>INDIA VIX:</span>
                <span className={`font-mono text-base font-extrabold ${isHighVol ? 'text-rose-300' : 'text-emerald-300'}`}>
                  {currentVix.toFixed(2)}
                </span>
              </span>

              {vixData?.change !== undefined && (
                <span className={`text-[11px] font-mono font-semibold px-2 py-0.5 rounded-full flex items-center gap-0.5 ${
                  vixData.change >= 0 
                    ? 'bg-rose-500/15 text-rose-300 border border-rose-500/30' 
                    : 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                }`}>
                  {vixData.change >= 0 ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
                  <span>{vixData.change >= 0 ? '+' : ''}{vixData.change.toFixed(2)} ({vixData.pctChange >= 0 ? '+' : ''}{vixData.pctChange.toFixed(2)}%)</span>
                </span>
              )}

              <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border ${
                isHighVol
                  ? 'bg-rose-500/20 text-rose-300 border-rose-500/40'
                  : 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30'
              }`}>
                {isHighVol ? '⚡ Volatility Spike Alert' : '🟢 Normal Volatility Regime'}
              </span>
            </div>

            <p className="text-xs text-slate-400 mt-0.5">
              {isHighVol 
                ? `Exceeds your ${currentThreshold.toFixed(1)} threshold by +${(currentVix - currentThreshold).toFixed(2)} pts — Conservative Condor Recommended`
                : `Below your limit of ${currentThreshold.toFixed(1)} — Balanced Iron Condor parameters active`}
            </p>
          </div>
        </div>

        {/* Right Action & Threshold Controls */}
        <div className="flex items-center gap-2 self-stretch md:self-auto justify-between md:justify-end shrink-0">
          {/* Quick Threshold Presets */}
          <div className="flex items-center space-x-1 bg-slate-950/80 p-1 rounded-xl border border-slate-800">
            <span className="text-[10px] font-bold text-slate-400 px-1.5 uppercase">Limit:</span>
            {[14.0, 15.5, 17.0, 19.0].map((preset) => (
              <button
                key={preset}
                onClick={() => handleSaveThreshold(preset)}
                disabled={isUpdatingThreshold}
                className={`text-[10px] font-mono px-2 py-0.5 rounded-lg font-bold transition-all ${
                  Math.abs(currentThreshold - preset) < 0.2
                    ? 'bg-indigo-600 text-white shadow-sm'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
                }`}
              >
                {preset.toFixed(1)}
              </button>
            ))}
          </div>

          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="p-1.5 rounded-xl bg-slate-800/80 hover:bg-slate-700 text-slate-300 border border-slate-700/60 transition-colors flex items-center space-x-1 text-xs px-2.5 cursor-pointer"
          >
            <span className="text-[11px] font-semibold">{isExpanded ? 'Less' : 'Details'}</span>
            {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      {/* Action Notification Toast */}
      {actionSuccessMsg && (
        <div className="bg-emerald-950/90 border-b border-emerald-500/50 px-4 py-2 text-xs font-semibold text-emerald-200 flex items-center justify-between animate-fadeIn">
          <div className="flex items-center space-x-2">
            <Check className="w-4 h-4 text-emerald-400" />
            <span>{actionSuccessMsg}</span>
          </div>
          <button onClick={() => setActionSuccessMsg(null)} className="text-emerald-400 hover:text-white">✕</button>
        </div>
      )}

      {/* Expanded Recommendation Card Body */}
      {isExpanded && (
        <div className="p-4 sm:p-5 space-y-4 bg-slate-950/50">
          {/* Main Comparison Grid */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {/* Box 1: Recommended Strike Buffer */}
            <div className={`p-3.5 rounded-xl border ${
              isHighVol
                ? 'bg-rose-950/30 border-rose-500/40 text-rose-200'
                : 'bg-slate-900 border-slate-800 text-slate-200'
            }`}>
              <div className="flex items-center justify-between text-xs text-slate-400 mb-1">
                <span className="font-semibold uppercase tracking-wider text-[10px]">Short Strike Buffer</span>
                <span className="font-mono text-[10px] text-slate-500">Current: {currentBuffer} pts</span>
              </div>
              <div className="flex items-baseline space-x-2">
                <span className="text-xl font-bold font-mono text-white">±{recommendedBuffer} pts</span>
                <span className="text-[11px] font-semibold text-indigo-400">OTM</span>
              </div>
              <p className="text-[11px] text-slate-400 mt-1 leading-snug">
                {isHighVol 
                  ? `Widened by +${recommendedBuffer - 200} pts vs baseline to absorb ±${Math.round((spotPrice * (currentVix / 100)) / Math.sqrt(52))} pt weekly 1σ moves.`
                  : 'Standard distance to capture optimal Theta decay with safe Delta neutral zone.'}
              </p>
            </div>

            {/* Box 2: Recommended Wing Width */}
            <div className={`p-3.5 rounded-xl border ${
              isHighVol
                ? 'bg-amber-950/30 border-amber-500/40 text-amber-200'
                : 'bg-slate-900 border-slate-800 text-slate-200'
            }`}>
              <div className="flex items-center justify-between text-xs text-slate-400 mb-1">
                <span className="font-semibold uppercase tracking-wider text-[10px]">Protection Wing Width</span>
                <span className="font-mono text-[10px] text-slate-500">Current: {currentWings} pts</span>
              </div>
              <div className="flex items-baseline space-x-2">
                <span className="text-xl font-bold font-mono text-white">{recommendedWings} pts</span>
                <span className="text-[11px] font-semibold text-amber-300">Cap Risk</span>
              </div>
              <p className="text-[11px] text-slate-400 mt-1 leading-snug">
                {isHighVol
                  ? `Expanded to ${recommendedWings} pts to secure richer net credit while shielding max risk.`
                  : 'Balanced wing spread maintains minimal debit cost for long protective legs.'}
              </p>
            </div>

            {/* Box 3: Target Strikes */}
            <div className="p-3.5 rounded-xl bg-slate-900 border border-slate-800 text-slate-200">
              <div className="flex items-center justify-between text-xs text-slate-400 mb-1">
                <span className="font-semibold uppercase tracking-wider text-[10px]">Target Strikes (Spot {spotPrice})</span>
                <span className="text-[10px] font-mono text-emerald-400">NSE:NIFTY</span>
              </div>
              <div className="space-y-1 font-mono text-xs">
                <div className="flex items-center justify-between text-slate-300">
                  <span className="text-rose-400">Call Wing:</span>
                  <span>Short {strikes.shortCall} / Long {strikes.longCall}</span>
                </div>
                <div className="flex items-center justify-between text-slate-300">
                  <span className="text-emerald-400">Put Wing:</span>
                  <span>Short {strikes.shortPut} / Long {strikes.longPut}</span>
                </div>
              </div>
              <div className="mt-1.5 pt-1.5 border-t border-slate-800 flex justify-between text-[10px] text-slate-400 font-mono">
                <span>Profit Zone:</span>
                <span className="text-indigo-300 font-bold">{strikes.shortPut} – {strikes.shortCall} ({recommendedBuffer * 2} pts)</span>
              </div>
            </div>
          </div>

          {/* Actionable Strategy Recommendations & 1-Click Apply */}
          <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-3.5 flex flex-col md:flex-row items-start md:items-center justify-between gap-3">
            <div className="space-y-1 text-xs">
              <div className="flex items-center space-x-1.5 font-bold text-slate-200">
                <Zap className="w-3.5 h-3.5 text-amber-400 fill-amber-400" />
                <span>Strategic Volatility Adjustment Playbook:</span>
              </div>
              <p className="text-[11px] text-slate-300 leading-relaxed max-w-2xl">
                {vixData?.strategySuggestion || (isHighVol 
                  ? 'High volatility detected. Widen short strikes to 1.2σ, expand wing cushions, and reduce position sizing to defend against gamma gaps.' 
                  : 'Volatility is within normal range. Standard Condor parameters offer balanced premium harvest.')}
              </p>
            </div>

            <div className="flex items-center space-x-2 shrink-0 self-end md:self-auto">
              <button
                onClick={handleApplyVixCondor}
                disabled={isApplyingCondor}
                className={`px-3.5 py-2 rounded-xl text-xs font-bold transition-all shadow-lg flex items-center space-x-2 cursor-pointer ${
                  isHighVol
                    ? 'bg-rose-600 hover:bg-rose-500 text-white shadow-rose-950/40 border border-rose-400/40'
                    : 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-indigo-950/40 border border-indigo-400/30'
                }`}
                title="Update your bot settings with these recommended strike distance and wing buffer parameters"
              >
                <Zap className="w-3.5 h-3.5 text-amber-300 fill-amber-300 shrink-0" />
                <span>{isApplyingCondor ? 'Applying...' : 'Apply VIX Structure to Bot'}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
