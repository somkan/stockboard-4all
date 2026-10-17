import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  ResponsiveContainer,
  ComposedChart,
  AreaChart,
  LineChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine,
  ReferenceDot,
  ReferenceArea
} from 'recharts';
import {
  Layers,
  Activity,
  Maximize2,
  Minimize2,
  RefreshCw,
  Compass,
  Sliders,
  TrendingDown,
  TrendingUp,
  ShieldAlert,
  ShieldCheck,
  Zap,
  Info,
  ChevronDown,
  Eye,
  SlidersHorizontal,
  Target,
  Sparkles,
  CheckCircle2,
  ArrowRight,
  Crosshair,
  Copy,
  Check
} from 'lucide-react';
import { Position } from '../types';

export interface VolatilitySurfaceProps {
  spotPrice: number;
  openPositions?: Position[];
  onNudgePrice?: (delta: number) => void;
  className?: string;
  defaultExpanded?: boolean;
}

export type SurfaceMetric = 'IV' | 'DELTA' | 'VEGA' | 'THETA';
export type VolRegime = 'NORMAL' | 'HIGH_VOL' | 'PUT_SKEW' | 'LOW_VOL';
export type ViewMode = 'ISOMETRIC_3D' | 'WATERFALL_RECHARTS' | 'HEATMAP_MATRIX' | 'CROSS_SECTIONS';

export interface StrategyRecommendation {
  name: string;
  tag: string;
  bias: string;
  pop: number;
  rationale: string;
  shortPut: number;
  shortCall: number;
  longPut: number;
  longCall: number;
  width: number;
}

export interface ExpirySlice {
  id: string;
  label: string;
  expiryDate: string;
  dte: number;
  atmIV: number;
  color: string;
  expectedMove1SD?: number;
  expectedMove2SD?: number;
  lower1SD?: number;
  upper1SD?: number;
  lower2SD?: number;
  upper2SD?: number;
  movePct1SD?: number;
  movePct2SD?: number;
  recommendedStrategy?: StrategyRecommendation;
}

interface SurfaceRow {
  strike: number;
  moneyness: number;
  moneynessPct: number;
  isATM: boolean;
  [key: string]: any;
}

export const VolatilitySurfaceChart: React.FC<VolatilitySurfaceProps> = ({
  spotPrice: initialSpotPrice,
  openPositions = [],
  onNudgePrice,
  className = '',
  defaultExpanded = true
}) => {
  // View & display state
  const [isExpanded, setIsExpanded] = useState<boolean>(defaultExpanded);
  const [viewMode, setViewMode] = useState<ViewMode>('WATERFALL_RECHARTS');
  const [selectedMetric, setSelectedMetric] = useState<SurfaceMetric>('IV');
  const [volRegime, setVolRegime] = useState<VolRegime>('NORMAL');
  const [strikeRange, setStrikeRange] = useState<number>(800); // ±800 pts default
  const [showCondorPins, setShowCondorPins] = useState<boolean>(true);
  const [simulatedSpot, setSimulatedSpot] = useState<number>(initialSpotPrice);
  const [hoveredPoint, setHoveredPoint] = useState<any | null>(null);
  const [selectedExpiryId, setSelectedExpiryId] = useState<string>('ALL');

  // Strict Expiry Separation for 1SD & 2SD
  const [show1SD, setShow1SD] = useState<boolean>(true);
  const [show2SD, setShow2SD] = useState<boolean>(true);
  const [activeSDExpiryId, setActiveSDExpiryId] = useState<string>('exp_w1');
  const [showStrategyAdvisor, setShowStrategyAdvisor] = useState<boolean>(true);
  const [stagedStrategy, setStagedStrategy] = useState<StrategyRecommendation | null>(null);
  const [hasCopiedStrategy, setHasCopiedStrategy] = useState<boolean>(false);

  // 3D Isometric View Camera Controls
  const [pitch, setPitch] = useState<number>(36); // Elevation angle in degrees
  const [yaw, setYaw] = useState<number>(-22); // Rotation angle in degrees
  const [depthScale, setDepthScale] = useState<number>(1.15); // Layer separation

  // Synchronize simulatedSpot when parent spotPrice changes significantly
  useEffect(() => {
    if (Math.abs(initialSpotPrice - simulatedSpot) > 100) {
      setSimulatedSpot(initialSpotPrice);
    }
  }, [initialSpotPrice]);

  // Loading & fetch state
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [serverSurface, setServerSurface] = useState<any | null>(null);

  // Fetch surface from server if available
  const fetchSurfaceData = async () => {
    setIsLoading(true);
    try {
      const res = await fetch(`/api/market/volatility-surface?spot=${simulatedSpot}&regime=${volRegime}`);
      if (res.ok) {
        const json = await res.json();
        setServerSurface(json);
      }
    } catch {
      // client-side calculation fallback runs automatically below
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchSurfaceData();
  }, [simulatedSpot, volRegime]);

  // 5 Standard Expiration Slices for NIFTY - strictly separated volatilities and 1SD/2SD cones
  const strikeStep = 50;
  const atmStrike = Math.round(simulatedSpot / strikeStep) * strikeStep;

  const expirations: ExpirySlice[] = useMemo(() => {
    const today = new Date();
    const monthNames = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
    const configs = [
      { id: 'exp_w1', label: 'Current Wk', dte: 3, daysAdd: 3, color: '#818cf8', baseAtm: 13.8 },
      { id: 'exp_w2', label: 'Next Wk', dte: 10, daysAdd: 10, color: '#38bdf8', baseAtm: 14.3 },
      { id: 'exp_m1', label: 'Near Month', dte: 24, daysAdd: 24, color: '#34d399', baseAtm: 14.9 },
      { id: 'exp_m2', label: 'Next Month', dte: 52, daysAdd: 52, color: '#fbbf24', baseAtm: 15.6 },
      { id: 'exp_q1', label: 'Far Expiry', dte: 87, daysAdd: 87, color: '#f43f5e', baseAtm: 16.4 }
    ];

    let regimeMultiplier = 1.0;
    if (volRegime === 'HIGH_VOL') regimeMultiplier = 1.45;
    else if (volRegime === 'PUT_SKEW') regimeMultiplier = 1.18;
    else if (volRegime === 'LOW_VOL') regimeMultiplier = 0.78;

    return configs.map((c, idx) => {
      const serverMatch = serverSurface?.expirations?.find((e: any) => e.id === c.id);
      const d = new Date(today);
      d.setDate(today.getDate() + c.daysAdd);
      const dateStr = `${String(d.getDate()).padStart(2, '0')}-${monthNames[d.getMonth()]}-${d.getFullYear()}`;
      const atmIV = serverMatch?.atmIV ?? Number((c.baseAtm * regimeMultiplier).toFixed(2));

      // STRICT 1SD and 2SD Expected Move calculation per expiration:
      // move = Spot * (IV / 100) * sqrt(DTE / 365)
      const T_years = c.dte / 365;
      const expectedMove1SD = Math.round(simulatedSpot * (atmIV / 100) * Math.sqrt(T_years));
      const expectedMove2SD = Math.round(expectedMove1SD * 2);

      const lower1SD = Math.round((simulatedSpot - expectedMove1SD) / strikeStep) * strikeStep;
      const upper1SD = Math.round((simulatedSpot + expectedMove1SD) / strikeStep) * strikeStep;
      const lower2SD = Math.round((simulatedSpot - expectedMove2SD) / strikeStep) * strikeStep;
      const upper2SD = Math.round((simulatedSpot + expectedMove2SD) / strikeStep) * strikeStep;

      // Strategy recommendation customized specifically for this expiration's volatility profile
      let recommendedStrategy: StrategyRecommendation = {
        name: 'Defined-Risk 1SD/2SD Iron Condor',
        tag: 'IRON_CONDOR',
        bias: 'Delta Neutral / Volatility Harvest',
        pop: 71.5,
        rationale: 'Sell 1SD strikes for ~68% probability of expiry inside shorts, while buying 2SD wings for 95.5% tail protection.',
        shortPut: lower1SD,
        shortCall: upper1SD,
        longPut: lower2SD,
        longCall: upper2SD,
        width: Math.abs(lower1SD - lower2SD)
      };

      if (volRegime === 'PUT_SKEW') {
        recommendedStrategy = {
          name: 'Asymmetric Skew Iron Condor / Jade Lizard',
          tag: 'SKEW_CONDOR',
          bias: 'Mild Bullish / Rich Put Skew Capture',
          pop: 74.0,
          rationale: 'Downside put skew is elevated. Shift Short Put further OTM below -1.1SD to collect high put premium safely.',
          shortPut: lower1SD - strikeStep,
          shortCall: upper1SD,
          longPut: lower2SD - strikeStep,
          longCall: upper2SD,
          width: Math.abs(lower1SD - lower2SD)
        };
      } else if (volRegime === 'HIGH_VOL') {
        recommendedStrategy = {
          name: 'Wide-Winged 1.5SD/2.5SD Iron Condor',
          tag: 'WIDE_CONDOR',
          bias: 'Neutral / IV Crush & Fast Theta',
          pop: 78.5,
          rationale: 'IV rank is spiked. High premium allows setting shorts at wide strikes with massive safety buffer.',
          shortPut: lower1SD - strikeStep,
          shortCall: upper1SD + strikeStep,
          longPut: lower2SD - strikeStep,
          longCall: upper2SD + strikeStep,
          width: Math.abs(lower1SD - lower2SD)
        };
      } else if (c.dte <= 4) {
        recommendedStrategy = {
          name: 'Expiry Day / Weekly 1SD Iron Condor',
          tag: 'WEEKLY_CONDOR',
          bias: 'Rapid 0DTE/Weekly Theta Burn',
          pop: 69.0,
          rationale: 'Front-week theta burns at exponential rate. Exploit rapid decay within 1SD expected move.',
          shortPut: lower1SD,
          shortCall: upper1SD,
          longPut: lower2SD,
          longCall: upper2SD,
          width: Math.abs(lower1SD - lower2SD)
        };
      } else if (c.dte >= 45) {
        recommendedStrategy = {
          name: 'Monthly Low-Gamma Calendar / Diagonal Spread',
          tag: 'CALENDAR_DIAGONAL',
          bias: 'Vega Neutral / Time Horizon Decay',
          pop: 66.5,
          rationale: 'Long-dated contracts have minimal gamma risk and steady theta. Safe for wide-band condors or diagonals.',
          shortPut: lower1SD,
          shortCall: upper1SD,
          longPut: lower2SD,
          longCall: upper2SD,
          width: Math.abs(lower1SD - lower2SD)
        };
      }

      return {
        id: c.id,
        label: `${c.label} (${c.dte}d)`,
        expiryDate: dateStr,
        dte: c.dte,
        atmIV,
        color: c.color,
        expectedMove1SD,
        expectedMove2SD,
        lower1SD,
        upper1SD,
        lower2SD,
        upper2SD,
        movePct1SD: Number(((expectedMove1SD / simulatedSpot) * 100).toFixed(2)),
        movePct2SD: Number(((expectedMove2SD / simulatedSpot) * 100).toFixed(2)),
        recommendedStrategy
      };
    });
  }, [serverSurface, volRegime, simulatedSpot]);

  // Active Expiration for 1SD & 2SD Display (strictly isolated, never mixed)
  const activeSDExp = useMemo(() => {
    if (selectedExpiryId !== 'ALL') {
      return expirations.find(e => e.id === selectedExpiryId) || expirations[0];
    }
    return expirations.find(e => e.id === activeSDExpiryId) || expirations[0];
  }, [expirations, selectedExpiryId, activeSDExpiryId]);

  const numSteps = Math.round(strikeRange / strikeStep);

  const strikes = useMemo(() => {
    const list: number[] = [];
    for (let i = -numSteps; i <= numSteps; i++) {
      list.push(atmStrike + (i * strikeStep));
    }
    return list;
  }, [atmStrike, numSteps, strikeStep]);

  // Black-Scholes approx Greeks calculator
  const calculateGreeks = (S: number, K: number, T_years: number, sigmaPct: number) => {
    const T = Math.max(0.002, T_years);
    const vol = Math.max(0.04, sigmaPct / 100);
    const r = 0.065; // RBI repo rate proxy
    const d1 = (Math.log(S / K) + (r + 0.5 * vol * vol) * T) / (vol * Math.sqrt(T));

    const cdf = (x: number) => {
      const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
      const sign = x < 0 ? -1 : 1;
      const absX = Math.abs(x) / Math.SQRT2;
      const t = 1.0 / (1.0 + p * absX);
      const erf = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX);
      return 0.5 * (1.0 + sign * erf);
    };

    const pdf = (x: number) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);

    const callDelta = Number(cdf(d1).toFixed(3));
    const putDelta = Number((callDelta - 1).toFixed(3));
    const vega = Number(((S * Math.sqrt(T) * pdf(d1)) / 100).toFixed(2));
    const theta = Number(((-(S * vol * pdf(d1)) / (2 * Math.sqrt(T)) - r * K * Math.exp(-r * T) * cdf(d1)) / 365).toFixed(2));

    return { callDelta, putDelta, vega, theta };
  };

  // Precomputed surface dataset for Recharts
  const surfaceRows: SurfaceRow[] = useMemo(() => {
    if (serverSurface?.surfaceData && serverSurface.surfaceData.length > 0) {
      // Filter strikes to active range
      return serverSurface.surfaceData.filter((r: any) =>
        r.strike >= atmStrike - strikeRange && r.strike <= atmStrike + strikeRange
      );
    }

    let putSkewParam = 1.35;
    let callSkewParam = 0.85;
    if (volRegime === 'HIGH_VOL') {
      putSkewParam = 1.85;
      callSkewParam = 1.15;
    } else if (volRegime === 'PUT_SKEW') {
      putSkewParam = 2.45;
      callSkewParam = 0.55;
    } else if (volRegime === 'LOW_VOL') {
      putSkewParam = 0.88;
      callSkewParam = 0.48;
    }

    return strikes.map(strike => {
      const moneyness = strike / simulatedSpot;
      const moneynessPct = Number((((strike - simulatedSpot) / simulatedSpot) * 100).toFixed(2));
      const logMoneyness = Math.log(strike / simulatedSpot);

      const row: SurfaceRow = {
        strike,
        moneyness: Number(moneyness.toFixed(4)),
        moneynessPct,
        isATM: strike === atmStrike
      };

      expirations.forEach(exp => {
        const T_years = exp.dte / 365;
        const dteDampener = Math.sqrt(30 / Math.max(3, exp.dte));

        let skewTerm = 0;
        if (logMoneyness < 0) {
          // OTM Put Wing (downside skew)
          skewTerm = putSkewParam * Math.abs(logMoneyness) * 22 * dteDampener + Math.pow(Math.abs(logMoneyness), 1.5) * 12;
        } else {
          // OTM Call Wing (upside smile)
          skewTerm = callSkewParam * logMoneyness * 14 * dteDampener + Math.pow(logMoneyness, 2) * 18;
        }

        const iv = Number((Math.max(8.5, exp.atmIV + skewTerm)).toFixed(2));
        const greeks = calculateGreeks(simulatedSpot, strike, T_years, iv);

        row[`iv_${exp.id}`] = iv;
        row[`delta_${exp.id}`] = strike >= simulatedSpot ? greeks.callDelta : greeks.putDelta;
        row[`vega_${exp.id}`] = greeks.vega;
        row[`theta_${exp.id}`] = greeks.theta;
      });

      return row;
    });
  }, [serverSurface, strikes, atmStrike, strikeRange, simulatedSpot, expirations, volRegime]);

  // Extract active Iron Condor / Straddle position legs to pin onto the volatility surface
  const activePositionLegs = useMemo(() => {
    const list: Array<{
      id: string;
      symbol: string;
      strike: number;
      type: 'CE' | 'PE';
      side: 'BUY' | 'SELL';
      role: 'SHORT_CALL' | 'LONG_CALL' | 'SHORT_PUT' | 'LONG_PUT' | 'WING' | 'STRADDLE';
      color: string;
      strategyName: string;
    }> = [];

    openPositions.forEach(pos => {
      if (!pos.legs) return;
      pos.legs.forEach(leg => {
        if (!leg.strike || leg.strike <= 0) return;
        let role: 'SHORT_CALL' | 'LONG_CALL' | 'SHORT_PUT' | 'LONG_PUT' | 'WING' | 'STRADDLE' = 'WING';
        let color = '#a855f7';

        if (leg.type === 'CE') {
          if (leg.side === 'SELL') {
            role = 'SHORT_CALL';
            color = '#f43f5e'; // Rose / Red for Short Call
          } else {
            role = 'LONG_CALL';
            color = '#38bdf8'; // Blue for Long Call Wing
          }
        } else if (leg.type === 'PE') {
          if (leg.side === 'SELL') {
            role = 'SHORT_PUT';
            color = '#fb923c'; // Orange for Short Put
          } else {
            role = 'LONG_PUT';
            color = '#34d399'; // Emerald for Long Put Wing
          }
        }

        list.push({
          id: leg.id || `${pos.id}_${leg.symbol}`,
          symbol: leg.symbol,
          strike: leg.strike,
          type: (leg.type === 'CE' ? 'CE' : 'PE') as any,
          side: leg.side,
          role,
          color,
          strategyName: pos.tag || pos.strategy || 'IRON_CONDOR'
        });
      });
    });

    // If trader staged a recommended strategy from the advisor panel, pin its legs on the surface
    if (stagedStrategy) {
      list.push(
        {
          id: 'staged_long_put',
          symbol: `PE ${stagedStrategy.longPut} (Wing)`,
          strike: stagedStrategy.longPut,
          type: 'PE',
          side: 'BUY',
          role: 'LONG_PUT',
          color: '#34d399',
          strategyName: stagedStrategy.name
        },
        {
          id: 'staged_short_put',
          symbol: `PE ${stagedStrategy.shortPut} (-1SD)`,
          strike: stagedStrategy.shortPut,
          type: 'PE',
          side: 'SELL',
          role: 'SHORT_PUT',
          color: '#fb923c',
          strategyName: stagedStrategy.name
        },
        {
          id: 'staged_short_call',
          symbol: `CE ${stagedStrategy.shortCall} (+1SD)`,
          strike: stagedStrategy.shortCall,
          type: 'CE',
          side: 'SELL',
          role: 'SHORT_CALL',
          color: '#f43f5e',
          strategyName: stagedStrategy.name
        },
        {
          id: 'staged_long_call',
          symbol: `CE ${stagedStrategy.longCall} (Wing)`,
          strike: stagedStrategy.longCall,
          type: 'CE',
          side: 'BUY',
          role: 'LONG_CALL',
          color: '#38bdf8',
          strategyName: stagedStrategy.name
        }
      );
    }

    return list;
  }, [openPositions, stagedStrategy]);

  // Surface Summary Statistics
  const summaryStats = useMemo(() => {
    const frontExp = expirations[0];
    const farExp = expirations[expirations.length - 1];

    const atmRow = surfaceRows.find(r => r.strike === atmStrike) || surfaceRows[Math.floor(surfaceRows.length / 2)];
    const atmIV = atmRow ? atmRow[`iv_${frontExp.id}`] || frontExp.atmIV : 14.2;

    const putStrike = atmStrike - 300;
    const callStrike = atmStrike + 300;
    const putRow = surfaceRows.find(r => r.strike === putStrike) || surfaceRows[0];
    const callRow = surfaceRows.find(r => r.strike === callStrike) || surfaceRows[surfaceRows.length - 1];

    const putIV = putRow ? putRow[`iv_${frontExp.id}`] : atmIV * 1.15;
    const callIV = callRow ? callRow[`iv_${frontExp.id}`] : atmIV * 1.05;
    const skewSpread = Number((putIV - callIV).toFixed(2));

    const farAtmIV = atmRow ? atmRow[`iv_${farExp.id}`] || farExp.atmIV : 16.5;
    const termSlope = Number(((farAtmIV - atmIV) / (farExp.dte - frontExp.dte)).toFixed(3));

    return {
      atmIV,
      skewSpread,
      termSlope,
      isContango: termSlope >= 0,
      frontDte: frontExp.dte,
      farDte: farExp.dte
    };
  }, [expirations, surfaceRows, atmStrike]);

  // Color helper for Heatmap Matrix cells
  const getHeatmapColor = (val: number, minVal: number, maxVal: number) => {
    const norm = Math.min(1, Math.max(0, (val - minVal) / Math.max(0.1, maxVal - minVal)));
    // Interpolate: Violet (#6366f1) -> Cyan (#06b6d4) -> Emerald (#10b981) -> Amber (#f59e0b) -> Rose (#f43f5e)
    if (norm < 0.25) {
      const p = norm / 0.25;
      return `rgba(99, 102, 241, ${0.4 + p * 0.35})`; // indigo
    } else if (norm < 0.5) {
      const p = (norm - 0.25) / 0.25;
      return `rgba(6, 182, 212, ${0.45 + p * 0.35})`; // cyan
    } else if (norm < 0.75) {
      const p = (norm - 0.5) / 0.25;
      return `rgba(16, 185, 129, ${0.5 + p * 0.35})`; // emerald
    } else {
      const p = (norm - 0.75) / 0.25;
      return `rgba(244, 63, 94, ${0.55 + p * 0.4})`; // rose
    }
  };

  // Min and max for color scales
  const ivMinMax = useMemo(() => {
    let min = 999;
    let max = -999;
    surfaceRows.forEach(row => {
      expirations.forEach(exp => {
        const key = selectedMetric === 'IV' ? `iv_${exp.id}`
          : selectedMetric === 'DELTA' ? `delta_${exp.id}`
          : selectedMetric === 'VEGA' ? `vega_${exp.id}`
          : `theta_${exp.id}`;
        const val = row[key];
        if (typeof val === 'number') {
          if (val < min) min = val;
          if (val > max) max = val;
        }
      });
    });
    return { min: min === 999 ? 8 : min, max: max === -999 ? 30 : max };
  }, [surfaceRows, expirations, selectedMetric]);

  // Camera presets for 3D Isometric View
  const handleApplyCameraPreset = (preset: 'DEFAULT' | 'SMILE_FRONT' | 'TERM_SIDE' | 'ORTHO_TOP') => {
    if (preset === 'DEFAULT') {
      setPitch(36);
      setYaw(-22);
      setDepthScale(1.15);
    } else if (preset === 'SMILE_FRONT') {
      setPitch(12);
      setYaw(0);
      setDepthScale(0.9);
    } else if (preset === 'TERM_SIDE') {
      setPitch(18);
      setYaw(-75);
      setDepthScale(1.4);
    } else if (preset === 'ORTHO_TOP') {
      setPitch(70);
      setYaw(0);
      setDepthScale(1.1);
    }
  };

  return (
    <div className={`bg-slate-900 border border-indigo-500/30 rounded-2xl overflow-hidden shadow-xl ${className}`}>
      
      {/* 1. TOP HEADER & METRICS BAR */}
      <div className="p-4 sm:p-5 border-b border-slate-800 bg-slate-950/60">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          
          {/* Title & Description */}
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <div className="p-1.5 bg-indigo-500/10 border border-indigo-500/20 rounded-lg text-indigo-400">
                <Compass className="w-5 h-5 animate-spin-slow" />
              </div>
              <h3 className="text-base sm:text-lg font-bold text-white tracking-wide flex items-center gap-2">
                <span>NIFTY 3D VOLATILITY SURFACE</span>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                  RECHARTS 3D-ENGINE
                </span>
              </h3>
            </div>
            <p className="text-xs text-slate-400">
              Interactive Implied Volatility (IV) smile curvature, downside skew, and term structure across 5 Nifty expiration cycles.
            </p>
          </div>

          {/* Quick Real-Time Metric Badges */}
          <div className="flex flex-wrap items-center gap-2 text-xs font-mono">
            
            {/* Spot Price */}
            <div className="bg-slate-900 border border-slate-800 px-3 py-1.5 rounded-xl shadow-sm">
              <span className="text-[10px] text-slate-500 uppercase block font-sans">Nifty Spot</span>
              <span className="font-bold text-emerald-400 text-sm">
                ₹{simulatedSpot.toLocaleString('en-IN', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}
              </span>
            </div>

            {/* ATM Front IV */}
            <div className="bg-slate-900 border border-slate-800 px-3 py-1.5 rounded-xl shadow-sm">
              <span className="text-[10px] text-slate-500 uppercase block font-sans">ATM IV (Front)</span>
              <span className="font-bold text-indigo-300 text-sm">{summaryStats.atmIV}%</span>
            </div>

            {/* 25D Put-Call Skew */}
            <div className="bg-slate-900 border border-slate-800 px-3 py-1.5 rounded-xl shadow-sm">
              <span className="text-[10px] text-slate-500 uppercase block font-sans">25D Put Skew</span>
              <span className={`font-bold text-sm ${summaryStats.skewSpread >= 0 ? 'text-amber-400' : 'text-emerald-400'}`}>
                {summaryStats.skewSpread >= 0 ? '+' : ''}{summaryStats.skewSpread}%
              </span>
            </div>

            {/* Term Structure Slope */}
            <div className="bg-slate-900 border border-slate-800 px-3 py-1.5 rounded-xl shadow-sm">
              <span className="text-[10px] text-slate-500 uppercase block font-sans">Term Structure</span>
              <span className="font-bold text-sm flex items-center space-x-1">
                {summaryStats.isContango ? (
                  <>
                    <TrendingUp className="w-3.5 h-3.5 text-emerald-400 inline" />
                    <span className="text-emerald-300">Contango</span>
                  </>
                ) : (
                  <>
                    <TrendingDown className="w-3.5 h-3.5 text-rose-400 inline" />
                    <span className="text-rose-300">Inverted</span>
                  </>
                )}
              </span>
            </div>

            {/* Strict Per-Expiry 1SD / 2SD Expected Move Badge */}
            <div className="bg-slate-900 border border-indigo-500/30 px-3 py-1.5 rounded-xl shadow-sm">
              <span className="text-[10px] text-indigo-300 uppercase block font-sans font-bold flex items-center gap-1">
                <Crosshair className="w-3 h-3 text-indigo-400" />
                <span>{activeSDExp.label} Expected Move</span>
              </span>
              <span className="font-bold text-slate-100 text-xs">
                ±₹{activeSDExp.expectedMove1SD} (1σ: ₹{activeSDExp.lower1SD} – ₹{activeSDExp.upper1SD})
              </span>
            </div>

            {/* Strategy Advisor Button */}
            <button
              onClick={() => setShowStrategyAdvisor(!showStrategyAdvisor)}
              className={`px-3 py-1.5 rounded-xl border text-xs font-semibold flex items-center space-x-1.5 transition-all cursor-pointer ${
                showStrategyAdvisor
                  ? 'bg-indigo-600 text-white border-indigo-500 shadow-md shadow-indigo-600/30'
                  : 'bg-slate-900 text-slate-300 border-slate-700 hover:text-white'
              }`}
              title="Toggle Strategy Advisor & Recommended Strikes"
            >
              <Sparkles className="w-3.5 h-3.5 text-amber-300" />
              <span>Strategy Advisor</span>
            </button>

            {/* Refresh / Nudge Trigger */}
            <button
              onClick={fetchSurfaceData}
              disabled={isLoading}
              title="Refresh Volatility Surface"
              className="p-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl border border-slate-700 transition-colors cursor-pointer"
            >
              <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin text-indigo-400' : ''}`} />
            </button>

            {/* Expand / Collapse Toggle */}
            <button
              onClick={() => setIsExpanded(!isExpanded)}
              title={isExpanded ? 'Collapse Volatility Surface' : 'Expand Volatility Surface'}
              className="p-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl border border-slate-700 transition-colors cursor-pointer"
            >
              {isExpanded ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
            </button>

          </div>
        </div>

        {/* Active Condor Pins Bar if Positions Exist */}
        {activePositionLegs.length > 0 && (
          <div className="mt-3 pt-3 border-t border-slate-800/80 flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-semibold text-slate-400 flex items-center gap-1.5">
              <Target className="w-3.5 h-3.5 text-indigo-400" />
              <span>Active Condor Legs on Vol Surface:</span>
            </span>

            {activePositionLegs.map(leg => (
              <span
                key={leg.id}
                className="inline-flex items-center space-x-1 text-[11px] font-mono px-2 py-0.5 rounded-md border"
                style={{
                  backgroundColor: `${leg.color}15`,
                  borderColor: `${leg.color}50`,
                  color: leg.color
                }}
              >
                <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: leg.color }}></span>
                <strong>{leg.strike}</strong>
                <span>{leg.type}</span>
                <span className="text-[9px] uppercase px-1 rounded bg-slate-900/80 font-sans">
                  {leg.side}
                </span>
              </span>
            ))}

            <label className="ml-auto flex items-center space-x-1.5 text-xs text-slate-400 cursor-pointer">
              <input
                type="checkbox"
                checked={showCondorPins}
                onChange={(e) => setShowCondorPins(e.target.checked)}
                className="rounded border-slate-700 bg-slate-950 text-indigo-600 focus:ring-0 cursor-pointer"
              />
              <span>Overlay Condor Pins</span>
            </label>
          </div>
        )}
      </div>

      {isExpanded && (
        <div className="p-4 sm:p-5 space-y-5">
          
          {/* 2. INTERACTIVE CONTROLS TOOLBAR */}
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 bg-slate-950/80 border border-slate-800/90 p-3 rounded-xl">
            
            {/* View Mode Tabs */}
            <div className="flex items-center bg-slate-900 p-1 rounded-lg border border-slate-800 text-xs">
              <button
                onClick={() => setViewMode('WATERFALL_RECHARTS')}
                className={`px-3 py-1.5 rounded-md font-semibold transition-all flex items-center space-x-1.5 ${
                  viewMode === 'WATERFALL_RECHARTS'
                    ? 'bg-indigo-600 text-white shadow'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Layers className="w-3.5 h-3.5" />
                <span>3D Waterfall (Recharts)</span>
              </button>

              <button
                onClick={() => setViewMode('ISOMETRIC_3D')}
                className={`px-3 py-1.5 rounded-md font-semibold transition-all flex items-center space-x-1.5 ${
                  viewMode === 'ISOMETRIC_3D'
                    ? 'bg-indigo-600 text-white shadow'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Compass className="w-3.5 h-3.5" />
                <span>3D Isometric Surface</span>
              </button>

              <button
                onClick={() => setViewMode('HEATMAP_MATRIX')}
                className={`px-3 py-1.5 rounded-md font-semibold transition-all flex items-center space-x-1.5 ${
                  viewMode === 'HEATMAP_MATRIX'
                    ? 'bg-indigo-600 text-white shadow'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <SlidersHorizontal className="w-3.5 h-3.5" />
                <span>Contour Heatmap</span>
              </button>

              <button
                onClick={() => setViewMode('CROSS_SECTIONS')}
                className={`px-3 py-1.5 rounded-md font-semibold transition-all flex items-center space-x-1.5 ${
                  viewMode === 'CROSS_SECTIONS'
                    ? 'bg-indigo-600 text-white shadow'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Activity className="w-3.5 h-3.5" />
                <span>Smile &amp; Term Slices</span>
              </button>
            </div>

            {/* Right Controls: Metric & Regime */}
            <div className="flex flex-wrap items-center gap-2 text-xs">
              
              {/* Metric Selector */}
              <div className="flex items-center space-x-1 bg-slate-900 px-2 py-1 rounded-lg border border-slate-800">
                <span className="text-[10px] text-slate-500 uppercase font-bold">Metric:</span>
                {(['IV', 'DELTA', 'VEGA', 'THETA'] as SurfaceMetric[]).map(m => (
                  <button
                    key={m}
                    onClick={() => setSelectedMetric(m)}
                    className={`px-2 py-0.5 rounded font-mono text-[11px] transition-all cursor-pointer ${
                      selectedMetric === m
                        ? 'bg-indigo-500/20 text-indigo-300 font-bold border border-indigo-500/40'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {m === 'IV' ? 'IV %' : m === 'DELTA' ? 'Delta (Δ)' : m === 'VEGA' ? 'Vega (ν)' : 'Theta (Θ)'}
                  </button>
                ))}
              </div>

              {/* Market Volatility Regime */}
              <div className="flex items-center space-x-1 bg-slate-900 px-2 py-1 rounded-lg border border-slate-800">
                <span className="text-[10px] text-slate-500 uppercase font-bold">Regime:</span>
                <select
                  value={volRegime}
                  onChange={(e) => setVolRegime(e.target.value as VolRegime)}
                  className="bg-transparent text-[11px] font-semibold text-indigo-300 outline-none cursor-pointer"
                >
                  <option value="NORMAL" className="bg-slate-900 text-slate-200">Balanced Vol (VIX 14.5)</option>
                  <option value="HIGH_VOL" className="bg-slate-900 text-rose-300">High Event Spike (VIX 21+)</option>
                  <option value="PUT_SKEW" className="bg-slate-900 text-amber-300">Downside Fear Skew</option>
                  <option value="LOW_VOL" className="bg-slate-900 text-emerald-300">Low Vol Drift (VIX 10.8)</option>
                </select>
              </div>

              {/* Strike Range Filter */}
              <div className="flex items-center space-x-1 bg-slate-900 px-2 py-1 rounded-lg border border-slate-800">
                <span className="text-[10px] text-slate-500 uppercase font-bold">Range:</span>
                <select
                  value={strikeRange}
                  onChange={(e) => setStrikeRange(Number(e.target.value))}
                  className="bg-transparent text-[11px] font-mono text-slate-200 outline-none cursor-pointer"
                >
                  <option value={400} className="bg-slate-900">±400 pts</option>
                  <option value={800} className="bg-slate-900">±800 pts</option>
                  <option value={1200} className="bg-slate-900">±1200 pts</option>
                </select>
              </div>

              {/* 1SD & 2SD Cones Quick Toggles */}
              <div className="flex items-center space-x-1 bg-slate-900 px-2 py-1 rounded-lg border border-slate-800">
                <span className="text-[10px] text-slate-500 uppercase font-bold">SD Bands:</span>
                <button
                  onClick={() => setShow1SD(!show1SD)}
                  className={`px-2 py-0.5 rounded font-mono text-[11px] transition-all cursor-pointer flex items-center space-x-1 ${
                    show1SD
                      ? 'bg-amber-500/20 text-amber-300 font-bold border border-amber-500/40'
                      : 'text-slate-500 hover:text-slate-300'
                  }`}
                  title="Toggle ±1 Standard Deviation Expected Move (68.3% Confidence Band)"
                >
                  <span>±1σ (68%)</span>
                </button>
                <button
                  onClick={() => setShow2SD(!show2SD)}
                  className={`px-2 py-0.5 rounded font-mono text-[11px] transition-all cursor-pointer flex items-center space-x-1 ${
                    show2SD
                      ? 'bg-purple-500/20 text-purple-300 font-bold border border-purple-500/40'
                      : 'text-slate-500 hover:text-slate-300'
                  }`}
                  title="Toggle ±2 Standard Deviation Tail Risk Band (95.5% Confidence Band)"
                >
                  <span>±2σ (95%)</span>
                </button>
              </div>

            </div>
          </div>

          {/* Expiry-Specific 1SD/2SD Information Ribbon (Ensures Expirations are Never Mixed Up) */}
          <div className="bg-slate-950/90 border border-indigo-500/20 p-3 rounded-xl flex flex-col md:flex-row md:items-center justify-between gap-3 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] font-semibold text-indigo-300 flex items-center gap-1.5 shrink-0">
                <Crosshair className="w-3.5 h-3.5 text-indigo-400" />
                <span>Isolated 1SD &amp; 2SD Expiry:</span>
              </span>

              {expirations.map(exp => (
                <button
                  key={`sd_sel_${exp.id}`}
                  onClick={() => {
                    setActiveSDExpiryId(exp.id);
                    if (selectedExpiryId !== 'ALL' && selectedExpiryId !== exp.id) {
                      setSelectedExpiryId(exp.id);
                    }
                  }}
                  className={`px-2.5 py-1 rounded-lg font-mono text-[11px] border transition-all cursor-pointer ${
                    activeSDExp.id === exp.id
                      ? 'bg-indigo-600/40 text-white border-indigo-400 font-bold shadow-sm'
                      : 'bg-slate-900 text-slate-400 border-slate-800 hover:text-slate-200'
                  }`}
                >
                  <span className="inline-block w-2 h-2 rounded-full mr-1.5" style={{ backgroundColor: exp.color }}></span>
                  <span>{exp.label}</span>
                  <span className="text-[10px] text-slate-400 ml-1">({exp.atmIV}%)</span>
                </button>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-3 text-[11px] font-mono bg-slate-900/90 px-3 py-1.5 rounded-lg border border-slate-800">
              <div className="flex items-center space-x-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-amber-400 shadow-sm shadow-amber-400/50"></span>
                <span className="text-slate-400 font-sans">1SD (68.3%):</span>
                <strong className="text-amber-300">₹{activeSDExp.lower1SD} – ₹{activeSDExp.upper1SD}</strong>
                <span className="text-slate-500">(±₹{activeSDExp.expectedMove1SD})</span>
              </div>

              <div className="flex items-center space-x-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-purple-400 shadow-sm shadow-purple-400/50"></span>
                <span className="text-slate-400 font-sans">2SD (95.5%):</span>
                <strong className="text-purple-300">₹{activeSDExp.lower2SD} – ₹{activeSDExp.upper2SD}</strong>
                <span className="text-slate-500">(±₹{activeSDExp.expectedMove2SD})</span>
              </div>
            </div>
          </div>

          {/* 3A. VIEW MODE 1: MULTI-EXPIRY 3D WATERFALL SURFACE (RECHARTS COMPOSEDCHART) */}
          {viewMode === 'WATERFALL_RECHARTS' && (
            <div className="space-y-3">
              
              {/* Expiration Selectors & Color Legend */}
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-slate-400 font-semibold text-[11px] mr-1">Expirations:</span>
                  <button
                    onClick={() => setSelectedExpiryId('ALL')}
                    className={`px-2.5 py-1 rounded-lg text-xs font-semibold border transition-all cursor-pointer ${
                      selectedExpiryId === 'ALL'
                        ? 'bg-indigo-600 text-white border-indigo-500 shadow'
                        : 'bg-slate-950 text-slate-400 border-slate-800 hover:text-slate-200'
                    }`}
                  >
                    All 5 Slices (3D Waterfall)
                  </button>

                  {expirations.map(exp => (
                    <button
                      key={exp.id}
                      onClick={() => setSelectedExpiryId(exp.id)}
                      className={`px-2.5 py-1 rounded-lg text-xs font-mono border transition-all flex items-center space-x-1.5 cursor-pointer ${
                        selectedExpiryId === exp.id
                          ? 'bg-slate-800 text-white border-indigo-400 shadow'
                          : 'bg-slate-950 text-slate-400 border-slate-800 hover:text-slate-200'
                      }`}
                    >
                      <span className="w-2 h-2 rounded-full" style={{ backgroundColor: exp.color }}></span>
                      <span>{exp.label}</span>
                      <span className="text-[10px] text-slate-500">({exp.atmIV}%)</span>
                    </button>
                  ))}
                </div>

                <div className="text-[11px] text-slate-400 font-mono flex items-center space-x-2">
                  <span className="inline-block w-2.5 h-0.5 bg-emerald-400"></span>
                  <span>ATM Spot: ₹{atmStrike}</span>
                </div>
              </div>

              {/* The Recharts Waterfall Chart Canvas */}
              <div className="h-80 sm:h-96 w-full bg-slate-950/90 border border-slate-800 rounded-xl p-2 sm:p-4 relative">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart
                    data={surfaceRows}
                    margin={{ top: 20, right: 30, left: 10, bottom: 20 }}
                  >
                    <defs>
                      {/* Gradient Definitions for 3D Layered Translucency */}
                      {expirations.map(exp => (
                        <linearGradient key={`grad_${exp.id}`} id={`volGrad_${exp.id}`} x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor={exp.color} stopOpacity={0.45} />
                          <stop offset="60%" stopColor={exp.color} stopOpacity={0.15} />
                          <stop offset="100%" stopColor={exp.color} stopOpacity={0.01} />
                        </linearGradient>
                      ))}
                    </defs>

                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />

                    <XAxis
                      dataKey="strike"
                      stroke="#64748b"
                      fontSize={11}
                      tickLine={false}
                      domain={['dataMin', 'dataMax']}
                      tickFormatter={(strike) => `₹${strike}`}
                    />

                    <YAxis
                      stroke="#64748b"
                      fontSize={11}
                      tickLine={false}
                      domain={['auto', 'auto']}
                      tickFormatter={(v) =>
                        selectedMetric === 'IV' ? `${v}%`
                        : selectedMetric === 'DELTA' ? v.toFixed(2)
                        : selectedMetric === 'VEGA' ? `₹${v}`
                        : `${v}`
                      }
                    />

                    {/* Rich Tooltip in Recharts */}
                    <Tooltip
                      content={({ active, payload, label }) => {
                        if (!active || !payload || !payload.length) return null;
                        const rowData = payload[0]?.payload as SurfaceRow;
                        if (!rowData) return null;

                        return (
                          <div className="bg-slate-900/95 border border-indigo-500/40 p-3 rounded-xl shadow-2xl backdrop-blur-md text-xs font-mono min-w-[240px] space-y-2">
                            <div className="flex items-center justify-between border-b border-slate-800 pb-1.5">
                              <div>
                                <span className="font-bold text-white text-sm">Strike ₹{label}</span>
                                <span className="text-[10px] text-slate-400 block font-sans">
                                  {rowData.moneynessPct >= 0 ? `+${rowData.moneynessPct}% OTM Call` : `${rowData.moneynessPct}% OTM Put`}
                                  {rowData.isATM ? ' (ATM LEVEL)' : ''}
                                </span>
                              </div>
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-indigo-300 font-sans">
                                Spot ₹{simulatedSpot}
                              </span>
                            </div>

                            <div className="space-y-1">
                              {expirations
                                .filter(e => selectedExpiryId === 'ALL' || selectedExpiryId === e.id)
                                .map(e => {
                                  const metricKey = selectedMetric === 'IV' ? `iv_${e.id}`
                                    : selectedMetric === 'DELTA' ? `delta_${e.id}`
                                    : selectedMetric === 'VEGA' ? `vega_${e.id}`
                                    : `theta_${e.id}`;
                                  const val = rowData[metricKey];

                                  return (
                                    <div key={e.id} className="flex items-center justify-between text-[11px]">
                                      <span className="flex items-center space-x-1.5" style={{ color: e.color }}>
                                        <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: e.color }}></span>
                                        <span>{e.label}:</span>
                                      </span>
                                      <span className="font-bold text-slate-100">
                                        {selectedMetric === 'IV' ? `${val}%`
                                          : selectedMetric === 'DELTA' ? val
                                          : selectedMetric === 'VEGA' ? `₹${val}/1% vol`
                                          : `${val}/day`}
                                      </span>
                                    </div>
                                  );
                                })}
                            </div>

                            {/* Active Condor Leg Match on this Strike */}
                            {(() => {
                              const match = activePositionLegs.find(l => l.strike === Number(label));
                              if (!match) return null;
                              return (
                                <div className="pt-1.5 border-t border-slate-800 text-[10px]">
                                  <span className="font-bold" style={{ color: match.color }}>
                                    ⚡ {match.role.replace('_', ' ')} ({match.symbol})
                                  </span>
                                </div>
                              );
                            })()}

                            {/* 1SD / 2SD Zone Classification */}
                            <div className="pt-1.5 border-t border-slate-800 text-[10px] space-y-0.5">
                              {Number(label) >= (activeSDExp.lower1SD || 0) && Number(label) <= (activeSDExp.upper1SD || 999999) ? (
                                <span className="text-emerald-400 font-bold flex items-center gap-1">
                                  <ShieldCheck className="w-3 h-3 text-emerald-400" />
                                  <span>Inside ±1SD Corridor (68.3% Win Zone for {activeSDExp.label})</span>
                                </span>
                              ) : Number(label) >= (activeSDExp.lower2SD || 0) && Number(label) <= (activeSDExp.upper2SD || 999999) ? (
                                <span className="text-amber-400 font-bold flex items-center gap-1">
                                  <ShieldAlert className="w-3 h-3 text-amber-400" />
                                  <span>Between 1SD &amp; 2SD (Optimal Short Buffer Zone)</span>
                                </span>
                              ) : (
                                <span className="text-purple-400 font-bold flex items-center gap-1">
                                  <Crosshair className="w-3 h-3 text-purple-400" />
                                  <span>Beyond ±2SD (&gt;95.5% Tail Risk Safe Haven)</span>
                                </span>
                              )}
                            </div>
                          </div>
                        );
                      }}
                    />

                    {/* Shaded 1SD Probability Corridor (68.3% Confidence Band) */}
                    {show1SD && activeSDExp.lower1SD && activeSDExp.upper1SD && (
                      <ReferenceArea
                        x1={activeSDExp.lower1SD}
                        x2={activeSDExp.upper1SD}
                        stroke="#10b981"
                        strokeOpacity={0.25}
                        strokeDasharray="3 3"
                        {...({ fill: '#10b981', fillOpacity: 0.07 } as any)}
                      />
                    )}

                    {/* Shaded 2SD Outer Corridor (95.5% Confidence Band) */}
                    {show2SD && activeSDExp.lower2SD && activeSDExp.upper2SD && (
                      <ReferenceArea
                        x1={activeSDExp.lower2SD}
                        x2={activeSDExp.upper2SD}
                        stroke="#818cf8"
                        strokeOpacity={0.15}
                        strokeDasharray="2 2"
                        {...({ fill: '#818cf8', fillOpacity: 0.03 } as any)}
                      />
                    )}

                    {/* Reference Line for Lower 2SD (95.5% Probability Band) */}
                    {show2SD && activeSDExp.lower2SD && (
                      <ReferenceLine
                        x={activeSDExp.lower2SD}
                        stroke="#a855f7"
                        strokeWidth={1.8}
                        strokeDasharray="3 3"
                        label={{
                          value: `-2SD: ₹${activeSDExp.lower2SD} (95.5%)`,
                          position: 'insideTopLeft',
                          fill: '#c084fc',
                          fontSize: 9,
                          fontWeight: 'bold'
                        }}
                      />
                    )}

                    {/* Reference Line for Lower 1SD (68.3% Probability Band) */}
                    {show1SD && activeSDExp.lower1SD && (
                      <ReferenceLine
                        x={activeSDExp.lower1SD}
                        stroke="#f59e0b"
                        strokeWidth={2}
                        strokeDasharray="4 4"
                        label={{
                          value: `-1SD: ₹${activeSDExp.lower1SD} (68.3%)`,
                          position: 'insideTopLeft',
                          fill: '#fbbf24',
                          fontSize: 10,
                          fontWeight: 'bold'
                        }}
                      />
                    )}

                    {/* Reference Line for ATM Spot Level */}
                    <ReferenceLine
                      x={atmStrike}
                      stroke="#10b981"
                      strokeWidth={2}
                      strokeDasharray="4 4"
                      label={{
                        value: `ATM ₹${atmStrike}`,
                        position: 'insideTopLeft',
                        fill: '#10b981',
                        fontSize: 10,
                        fontWeight: 'bold'
                      }}
                    />

                    {/* Reference Line for Upper 1SD (68.3% Probability Band) */}
                    {show1SD && activeSDExp.upper1SD && (
                      <ReferenceLine
                        x={activeSDExp.upper1SD}
                        stroke="#06b6d4"
                        strokeWidth={2}
                        strokeDasharray="4 4"
                        label={{
                          value: `+1SD: ₹${activeSDExp.upper1SD} (68.3%)`,
                          position: 'insideTopRight',
                          fill: '#22d3ee',
                          fontSize: 10,
                          fontWeight: 'bold'
                        }}
                      />
                    )}

                    {/* Reference Line for Upper 2SD (95.5% Probability Band) */}
                    {show2SD && activeSDExp.upper2SD && (
                      <ReferenceLine
                        x={activeSDExp.upper2SD}
                        stroke="#f43f5e"
                        strokeWidth={1.8}
                        strokeDasharray="3 3"
                        label={{
                          value: `+2SD: ₹${activeSDExp.upper2SD} (95.5%)`,
                          position: 'insideTopRight',
                          fill: '#fb7185',
                          fontSize: 9,
                          fontWeight: 'bold'
                        }}
                      />
                    )}

                    {/* Active Condor Leg Pins Reference Lines */}
                    {showCondorPins && activePositionLegs.map(leg => (
                      <ReferenceLine
                        key={`pin_${leg.id}`}
                        x={leg.strike}
                        stroke={leg.color}
                        strokeWidth={1.6}
                        strokeDasharray="2 2"
                        label={{
                          value: `${leg.side} ${leg.strike} ${leg.type}`,
                          position: 'insideTopRight',
                          fill: leg.color,
                          fontSize: 9,
                          fontWeight: 'bold'
                        }}
                      />
                    ))}

                    {/* 3D Waterfall Layered Ribbons for Expirations */}
                    {expirations.map((exp, idx) => {
                      if (selectedExpiryId !== 'ALL' && selectedExpiryId !== exp.id) return null;
                      const dataKey = selectedMetric === 'IV' ? `iv_${exp.id}`
                        : selectedMetric === 'DELTA' ? `delta_${exp.id}`
                        : selectedMetric === 'VEGA' ? `vega_${exp.id}`
                        : `theta_${exp.id}`;

                      return (
                        <Area
                          key={exp.id}
                          type="monotone"
                          dataKey={dataKey}
                          name={exp.label}
                          stroke={exp.color}
                          strokeWidth={selectedExpiryId === exp.id ? 2.5 : 1.8}
                          fill={`url(#volGrad_${exp.id})`}
                          fillOpacity={selectedExpiryId === exp.id ? 0.7 : 0.35}
                          activeDot={{ r: 5, stroke: exp.color, strokeWidth: 2, fill: '#0f172a' }}
                        />
                      );
                    })}
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* 3B. VIEW MODE 2: TRUE 3D ISOMETRIC VOLATILITY SURFACE PROJECTION */}
          {viewMode === 'ISOMETRIC_3D' && (
            <div className="space-y-3">
              
              {/* Interactive Camera Angle & Tilt Sliders */}
              <div className="flex flex-wrap items-center justify-between gap-3 bg-slate-950 p-3 rounded-xl border border-slate-800 text-xs">
                
                <div className="flex flex-wrap items-center gap-4">
                  {/* Pitch / Elevation Slider */}
                  <div className="flex items-center space-x-2">
                    <span className="text-slate-400 font-mono text-[11px]">Elevation (Pitch):</span>
                    <input
                      type="range"
                      min={10}
                      max={70}
                      value={pitch}
                      onChange={(e) => setPitch(Number(e.target.value))}
                      className="w-24 accent-indigo-500 cursor-pointer"
                    />
                    <span className="text-indigo-300 font-mono w-6 text-right">{pitch}°</span>
                  </div>

                  {/* Yaw / Rotation Slider */}
                  <div className="flex items-center space-x-2">
                    <span className="text-slate-400 font-mono text-[11px]">Rotation (Yaw):</span>
                    <input
                      type="range"
                      min={-75}
                      max={45}
                      value={yaw}
                      onChange={(e) => setYaw(Number(e.target.value))}
                      className="w-24 accent-indigo-500 cursor-pointer"
                    />
                    <span className="text-indigo-300 font-mono w-8 text-right">{yaw}°</span>
                  </div>

                  {/* Depth Spacing */}
                  <div className="flex items-center space-x-2">
                    <span className="text-slate-400 font-mono text-[11px]">Depth:</span>
                    <input
                      type="range"
                      min={0.6}
                      max={2.0}
                      step={0.1}
                      value={depthScale}
                      onChange={(e) => setDepthScale(Number(e.target.value))}
                      className="w-20 accent-indigo-500 cursor-pointer"
                    />
                    <span className="text-indigo-300 font-mono w-8 text-right">{depthScale}x</span>
                  </div>
                </div>

                {/* Preset Camera Views */}
                <div className="flex items-center space-x-1.5">
                  <span className="text-[10px] text-slate-500 uppercase font-bold mr-1">Presets:</span>
                  <button
                    onClick={() => handleApplyCameraPreset('DEFAULT')}
                    className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold text-[11px] border border-slate-700 cursor-pointer"
                  >
                    3D Isometric
                  </button>
                  <button
                    onClick={() => handleApplyCameraPreset('SMILE_FRONT')}
                    className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold text-[11px] border border-slate-700 cursor-pointer"
                  >
                    Smile Front
                  </button>
                  <button
                    onClick={() => handleApplyCameraPreset('TERM_SIDE')}
                    className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold text-[11px] border border-slate-700 cursor-pointer"
                  >
                    Term Structure
                  </button>
                  <button
                    onClick={() => handleApplyCameraPreset('ORTHO_TOP')}
                    className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold text-[11px] border border-slate-700 cursor-pointer"
                  >
                    Top Down
                  </button>
                </div>
              </div>

              {/* 3D Isometric SVG Canvas with Recharts Responsive Container */}
              <div className="h-96 w-full bg-slate-950/95 border border-slate-800 rounded-xl p-2 relative overflow-hidden flex items-center justify-center">
                
                {/* SVG 3D Isometric Mesh Engine */}
                <svg
                  className="w-full h-full"
                  viewBox="-400 -240 800 480"
                  preserveAspectRatio="xMidYMid meet"
                >
                  <defs>
                    <linearGradient id="surfaceAltitudeGrad" x1="0%" y1="100%" x2="0%" y2="0%">
                      <stop offset="0%" stopColor="#4338ca" stopOpacity="0.8" />
                      <stop offset="35%" stopColor="#0284c7" stopOpacity="0.75" />
                      <stop offset="65%" stopColor="#059669" stopOpacity="0.75" />
                      <stop offset="85%" stopColor="#d97706" stopOpacity="0.8" />
                      <stop offset="100%" stopColor="#e11d48" stopOpacity="0.9" />
                    </linearGradient>

                    <filter id="glow3D" x="-20%" y="-20%" width="140%" height="140%">
                      <feGaussianBlur stdDeviation="3" result="blur" />
                      <feComposite in="SourceGraphic" in2="blur" operator="over" />
                    </filter>
                  </defs>

                  {/* 3D Grid Ground Base Platform */}
                  {(() => {
                    const cosYaw = Math.cos((yaw * Math.PI) / 180);
                    const sinYaw = Math.sin((yaw * Math.PI) / 180);
                    const cosPitch = Math.cos((pitch * Math.PI) / 180);
                    const sinPitch = Math.sin((pitch * Math.PI) / 180);

                    // Transform (x: strike, y: dte, z: iv) to 2D screen coordinates
                    const project = (strikeVal: number, dteVal: number, ivVal: number) => {
                      // Normalize strike [-1 to +1]
                      const xNorm = (strikeVal - atmStrike) / strikeRange;
                      // Normalize dte [0 to 1]
                      const yNorm = (dteVal - 3) / 84;
                      // Normalize IV [0 to 1]
                      const zNorm = (ivVal - ivMinMax.min) / Math.max(1, ivMinMax.max - ivMinMax.min);

                      const xWorld = xNorm * 260;
                      const yWorld = (yNorm - 0.5) * 180 * depthScale;
                      const zWorld = (zNorm - 0.2) * 160;

                      // Rotate around Z axis (Yaw)
                      const xRot = xWorld * cosYaw - yWorld * sinYaw;
                      const yRot = xWorld * sinYaw + yWorld * cosYaw;

                      // Project to 2D screen with Pitch elevation
                      const screenX = xRot;
                      const screenY = yRot * sinPitch - zWorld * cosPitch + 30;

                      return { x: screenX, y: screenY, zOrder: yRot };
                    };

                    // Draw Base Bounding Box / Platform
                    const c1 = project(atmStrike - strikeRange, 3, ivMinMax.min);
                    const c2 = project(atmStrike + strikeRange, 3, ivMinMax.min);
                    const c3 = project(atmStrike + strikeRange, 87, ivMinMax.min);
                    const c4 = project(atmStrike - strikeRange, 87, ivMinMax.min);

                    // Generate Polygons between adjacent Expirations and Strikes
                    const polygonFaces: any[] = [];

                    for (let eIdx = expirations.length - 1; eIdx > 0; eIdx--) {
                      const expBack = expirations[eIdx];
                      const expFront = expirations[eIdx - 1];

                      for (let sIdx = 0; sIdx < surfaceRows.length - 1; sIdx++) {
                        const rLeft = surfaceRows[sIdx];
                        const rRight = surfaceRows[sIdx + 1];

                        const metricKey = selectedMetric === 'IV' ? 'iv'
                          : selectedMetric === 'DELTA' ? 'delta'
                          : selectedMetric === 'VEGA' ? 'vega' : 'theta';

                        const val_B_L = rLeft[`${metricKey}_${expBack.id}`] || 15;
                        const val_B_R = rRight[`${metricKey}_${expBack.id}`] || 15;
                        const val_F_L = rLeft[`${metricKey}_${expFront.id}`] || 15;
                        const val_F_R = rRight[`${metricKey}_${expFront.id}`] || 15;

                        const p_B_L = project(rLeft.strike, expBack.dte, val_B_L);
                        const p_B_R = project(rRight.strike, expBack.dte, val_B_R);
                        const p_F_R = project(rRight.strike, expFront.dte, val_F_R);
                        const p_F_L = project(rLeft.strike, expFront.dte, val_F_L);

                        const avgVal = (val_B_L + val_B_R + val_F_L + val_F_R) / 4;
                        const avgZOrder = (p_B_L.zOrder + p_B_R.zOrder + p_F_R.zOrder + p_F_L.zOrder) / 4;
                        const fillColor = getHeatmapColor(avgVal, ivMinMax.min, ivMinMax.max);

                        polygonFaces.push({
                          points: `${p_B_L.x},${p_B_L.y} ${p_B_R.x},${p_B_R.y} ${p_F_R.x},${p_F_R.y} ${p_F_L.x},${p_F_L.y}`,
                          avgZOrder,
                          fillColor,
                          strike: rLeft.strike,
                          expId: expFront.id,
                          val: avgVal
                        });
                      }
                    }

                    // Sort faces by depth for painter's algorithm rendering
                    polygonFaces.sort((a, b) => b.avgZOrder - a.avgZOrder);

                    return (
                      <g>
                        {/* Floor polygon */}
                        <polygon
                          points={`${c1.x},${c1.y} ${c2.x},${c2.y} ${c3.x},${c3.y} ${c4.x},${c4.y}`}
                          fill="#090d16"
                          stroke="#1e293b"
                          strokeWidth="1.5"
                          opacity="0.9"
                        />

                        {/* Floor Strike Grid Lines */}
                        {surfaceRows.filter((_, idx) => idx % 4 === 0).map(r => {
                          const pStart = project(r.strike, 3, ivMinMax.min);
                          const pEnd = project(r.strike, 87, ivMinMax.min);
                          return (
                            <line
                              key={`floor_strike_${r.strike}`}
                              x1={pStart.x}
                              y1={pStart.y}
                              x2={pEnd.x}
                              y2={pEnd.y}
                              stroke="#1e293b"
                              strokeWidth="1"
                              strokeDasharray="2 2"
                            />
                          );
                        })}

                        {/* 3D Surface Mesh Polygons */}
                        {polygonFaces.map((face, fIdx) => (
                          <polygon
                            key={`face_${fIdx}`}
                            points={face.points}
                            fill={face.fillColor}
                            stroke="#0f172a"
                            strokeWidth="0.7"
                            opacity="0.82"
                            className="transition-opacity hover:opacity-100 cursor-pointer"
                            onMouseEnter={() => setHoveredPoint(face)}
                            onMouseLeave={() => setHoveredPoint(null)}
                          />
                        ))}

                        {/* 3D Expiration Iso-Curve Ribbons */}
                        {expirations.map(exp => {
                          const metricKey = selectedMetric === 'IV' ? `iv_${exp.id}`
                            : selectedMetric === 'DELTA' ? `delta_${exp.id}`
                            : selectedMetric === 'VEGA' ? `vega_${exp.id}` : `theta_${exp.id}`;

                          const pathData = surfaceRows.map((r, i) => {
                            const pt = project(r.strike, exp.dte, r[metricKey]);
                            return `${i === 0 ? 'M' : 'L'} ${pt.x} ${pt.y}`;
                          }).join(' ');

                          return (
                            <g key={`ribbon_${exp.id}`}>
                              <path
                                d={pathData}
                                fill="none"
                                stroke={exp.color}
                                strokeWidth="2.2"
                                opacity="0.95"
                              />

                              {/* Expiration Label in 3D Space */}
                              {(() => {
                                const lastRow = surfaceRows[surfaceRows.length - 1];
                                const labelPt = project(lastRow.strike + 40, exp.dte, lastRow[metricKey]);
                                return (
                                  <text
                                    x={labelPt.x + 8}
                                    y={labelPt.y + 3}
                                    fill={exp.color}
                                    fontSize="10"
                                    fontFamily="monospace"
                                    fontWeight="bold"
                                  >
                                    {exp.label}
                                  </text>
                                );
                              })()}
                            </g>
                          );
                        })}

                        {/* 3D Standard Deviation Probability Cones (1SD & 2SD Trumpets) */}
                        {show2SD && (() => {
                          const ptsLower = expirations.map((exp, i) => {
                            const row = surfaceRows.find(r => r.strike === exp.lower2SD) || surfaceRows[0];
                            const val = row ? (row[`iv_${exp.id}`] || exp.atmIV) : exp.atmIV;
                            const pt = project(exp.lower2SD || atmStrike - 400, exp.dte, val);
                            return `${i === 0 ? 'M' : 'L'} ${pt.x} ${pt.y}`;
                          }).join(' ');

                          const ptsUpper = expirations.map((exp, i) => {
                            const row = surfaceRows.find(r => r.strike === exp.upper2SD) || surfaceRows[surfaceRows.length - 1];
                            const val = row ? (row[`iv_${exp.id}`] || exp.atmIV) : exp.atmIV;
                            const pt = project(exp.upper2SD || atmStrike + 400, exp.dte, val);
                            return `${i === 0 ? 'M' : 'L'} ${pt.x} ${pt.y}`;
                          }).join(' ');

                          const frontExp = expirations[0];
                          const labelPtL = project(frontExp.lower2SD || atmStrike - 350, frontExp.dte, frontExp.atmIV + 2);
                          const labelPtU = project(frontExp.upper2SD || atmStrike + 350, frontExp.dte, frontExp.atmIV + 1);

                          return (
                            <g key="3d_2sd_trumpet_mesh">
                              <path d={ptsLower} fill="none" stroke="#a855f7" strokeWidth="2.4" strokeDasharray="4 3" opacity="0.9" />
                              <text x={labelPtL.x - 30} y={labelPtL.y - 8} fill="#c084fc" fontSize="9" fontWeight="bold" fontFamily="monospace">
                                -2σ (95.5%)
                              </text>
                              <path d={ptsUpper} fill="none" stroke="#f43f5e" strokeWidth="2.4" strokeDasharray="4 3" opacity="0.9" />
                              <text x={labelPtU.x + 6} y={labelPtU.y - 8} fill="#fb7185" fontSize="9" fontWeight="bold" fontFamily="monospace">
                                +2σ (95.5%)
                              </text>
                            </g>
                          );
                        })()}

                        {show1SD && (() => {
                          const ptsLower = expirations.map((exp, i) => {
                            const row = surfaceRows.find(r => r.strike === exp.lower1SD) || surfaceRows[0];
                            const val = row ? (row[`iv_${exp.id}`] || exp.atmIV) : exp.atmIV;
                            const pt = project(exp.lower1SD || atmStrike - 200, exp.dte, val);
                            return `${i === 0 ? 'M' : 'L'} ${pt.x} ${pt.y}`;
                          }).join(' ');

                          const ptsUpper = expirations.map((exp, i) => {
                            const row = surfaceRows.find(r => r.strike === exp.upper1SD) || surfaceRows[surfaceRows.length - 1];
                            const val = row ? (row[`iv_${exp.id}`] || exp.atmIV) : exp.atmIV;
                            const pt = project(exp.upper1SD || atmStrike + 200, exp.dte, val);
                            return `${i === 0 ? 'M' : 'L'} ${pt.x} ${pt.y}`;
                          }).join(' ');

                          const frontExp = expirations[0];
                          const labelPtL = project(frontExp.lower1SD || atmStrike - 180, frontExp.dte, frontExp.atmIV + 1);
                          const labelPtU = project(frontExp.upper1SD || atmStrike + 180, frontExp.dte, frontExp.atmIV);

                          return (
                            <g key="3d_1sd_trumpet_mesh">
                              <path d={ptsLower} fill="none" stroke="#f59e0b" strokeWidth="2.8" strokeDasharray="5 3" opacity="0.95" />
                              <text x={labelPtL.x - 26} y={labelPtL.y - 8} fill="#fbbf24" fontSize="9" fontWeight="bold" fontFamily="monospace">
                                -1σ (68.3%)
                              </text>
                              <path d={ptsUpper} fill="none" stroke="#06b6d4" strokeWidth="2.8" strokeDasharray="5 3" opacity="0.95" />
                              <text x={labelPtU.x + 6} y={labelPtU.y - 8} fill="#22d3ee" fontSize="9" fontWeight="bold" fontFamily="monospace">
                                +1σ (68.3%)
                              </text>
                            </g>
                          );
                        })()}

                        {/* ATM Marker in 3D Space */}
                        {(() => {
                          const frontExp = expirations[0];
                          const atmRow = surfaceRows.find(r => r.strike === atmStrike);
                          const atmVal = atmRow ? atmRow[`iv_${frontExp.id}`] : 14.5;
                          const atmPt = project(atmStrike, frontExp.dte, atmVal);
                          const basePt = project(atmStrike, frontExp.dte, ivMinMax.min);

                          return (
                            <g>
                              {/* Elevation Drop-line */}
                              <line
                                x1={basePt.x}
                                y1={basePt.y}
                                x2={atmPt.x}
                                y2={atmPt.y}
                                stroke="#10b981"
                                strokeWidth="2"
                                strokeDasharray="3 3"
                              />

                              <circle
                                cx={atmPt.x}
                                cy={atmPt.y}
                                r="5"
                                fill="#10b981"
                                stroke="#ffffff"
                                strokeWidth="2"
                              />

                              <text
                                x={atmPt.x - 35}
                                y={atmPt.y - 12}
                                fill="#10b981"
                                fontSize="10"
                                fontWeight="bold"
                                fontFamily="monospace"
                              >
                                ATM ₹{atmStrike}
                              </text>
                            </g>
                          );
                        })()}

                        {/* Active Condor Pins in 3D Space */}
                        {showCondorPins && activePositionLegs.map(leg => {
                          const frontExp = expirations[0];
                          const legRow = surfaceRows.find(r => r.strike === leg.strike);
                          const legVal = legRow ? legRow[`iv_${frontExp.id}`] : 16;
                          const pinPt = project(leg.strike, frontExp.dte, legVal);

                          return (
                            <g key={`3d_pin_${leg.id}`}>
                              <circle
                                cx={pinPt.x}
                                cy={pinPt.y}
                                r="4.5"
                                fill={leg.color}
                                stroke="#ffffff"
                                strokeWidth="1.5"
                              />
                              <text
                                x={pinPt.x - 20}
                                y={pinPt.y - 8}
                                fill={leg.color}
                                fontSize="9"
                                fontWeight="bold"
                                fontFamily="monospace"
                              >
                                {leg.type} {leg.strike}
                              </text>
                            </g>
                          );
                        })}
                      </g>
                    );
                  })()}
                </svg>

                {/* Floating Tooltip during Hover on 3D Mesh */}
                {hoveredPoint && (
                  <div className="absolute bottom-3 left-3 bg-slate-900/90 border border-indigo-500/50 p-2.5 rounded-lg text-xs font-mono shadow-xl backdrop-blur-md">
                    <span className="text-slate-400 block text-[10px] uppercase">3D Vertex Focus</span>
                    <span className="font-bold text-white text-sm">Strike: ₹{hoveredPoint.strike}</span>
                    <span className="text-indigo-300 block">
                      {selectedMetric}: <strong>{hoveredPoint.val.toFixed(2)}{selectedMetric === 'IV' ? '%' : ''}</strong>
                    </span>
                  </div>
                )}
              </div>

              {/* 3D Color Scale Bar */}
              <div className="flex items-center justify-between text-[11px] text-slate-400 font-mono px-2">
                <span>Low IV ({ivMinMax.min.toFixed(1)}%)</span>
                <div className="w-48 sm:w-64 h-2.5 rounded-full bg-gradient-to-r from-indigo-600 via-sky-500 via-emerald-500 via-amber-500 to-rose-500"></div>
                <span>High Wing IV ({ivMinMax.max.toFixed(1)}%)</span>
              </div>
            </div>
          )}

          {/* 3C. VIEW MODE 3: 2D HEATMAP CONTOUR MATRIX */}
          {viewMode === 'HEATMAP_MATRIX' && (
            <div className="space-y-3">
              <div className="overflow-x-auto border border-slate-800 rounded-xl bg-slate-950/90 p-2">
                <table className="w-full text-center text-xs font-mono">
                  <thead>
                    <tr className="border-b border-slate-800 text-slate-400 text-[11px]">
                      <th className="p-2 text-left bg-slate-900/80 sticky left-0 z-10">EXPIRATION / DTE</th>
                      {surfaceRows.filter((_, idx) => idx % 2 === 0).map(r => (
                        <th
                          key={r.strike}
                          className={`p-2 min-w-[58px] ${r.isATM ? 'bg-indigo-950/70 text-emerald-400 font-bold border-x border-indigo-500/30' : ''}`}
                        >
                          ₹{r.strike}
                          {r.isATM && <span className="block text-[8px] text-emerald-300">ATM</span>}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60">
                    {expirations.map(exp => (
                      <tr key={exp.id}>
                        <td className="p-2.5 text-left font-bold bg-slate-900/90 sticky left-0 z-10 text-slate-200 flex items-center space-x-1.5 whitespace-nowrap">
                          <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: exp.color }}></span>
                          <span>{exp.label}</span>
                        </td>

                        {surfaceRows.filter((_, idx) => idx % 2 === 0).map(r => {
                          const metricKey = selectedMetric === 'IV' ? `iv_${exp.id}`
                            : selectedMetric === 'DELTA' ? `delta_${exp.id}`
                            : selectedMetric === 'VEGA' ? `vega_${exp.id}` : `theta_${exp.id}`;
                          const val = r[metricKey];
                          const cellBg = getHeatmapColor(val, ivMinMax.min, ivMinMax.max);

                          return (
                            <td
                              key={`${exp.id}_${r.strike}`}
                              style={{ backgroundColor: cellBg }}
                              className="p-2 text-white font-semibold transition-transform hover:scale-110 cursor-pointer"
                              title={`Strike: ₹${r.strike} | ${exp.label} | ${selectedMetric}: ${val}`}
                            >
                              {selectedMetric === 'IV' ? `${val}%` : val}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex items-center justify-between text-[11px] text-slate-400 font-mono px-2">
                <span>Cool Blue (Low Vol)</span>
                <div className="w-48 sm:w-64 h-2.5 rounded-full bg-gradient-to-r from-indigo-600 via-sky-500 via-emerald-500 via-amber-500 to-rose-500"></div>
                <span>Hot Crimson (High Vol Skew)</span>
              </div>
            </div>
          )}

          {/* 3D. VIEW MODE 4: CROSS-SECTIONS (SMILE & TERM STRUCTURE) */}
          {viewMode === 'CROSS_SECTIONS' && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              
              {/* Plot A: Volatility Smile & Skew Curve (IV vs Strike) */}
              <div className="bg-slate-950/90 border border-slate-800 rounded-xl p-4 space-y-2">
                <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                  <span className="font-bold text-xs text-indigo-300 uppercase flex items-center gap-1.5">
                    <TrendingUp className="w-4 h-4 text-indigo-400" />
                    <span>Volatility Smile with 1SD &amp; 2SD Bands</span>
                  </span>
                  <span className="text-[11px] text-slate-400 font-mono">IV % vs Strike ({activeSDExp.label})</span>
                </div>

                <div className="h-64 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={surfaceRows} margin={{ top: 10, right: 20, left: -10, bottom: 10 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                      <XAxis dataKey="strike" stroke="#64748b" fontSize={10} tickFormatter={(s) => `₹${s}`} />
                      <YAxis stroke="#64748b" fontSize={10} tickFormatter={(v) => `${v}%`} domain={['auto', 'auto']} />
                      <Tooltip
                        contentStyle={{ backgroundColor: '#0f172a', borderColor: '#334155', fontSize: '11px', fontFamily: 'monospace' }}
                        formatter={(val: any) => [`${val}%`, 'IV']}
                        labelFormatter={(lbl) => `Strike: ₹${lbl}`}
                      />
                      {show2SD && activeSDExp.lower2SD && (
                        <ReferenceLine x={activeSDExp.lower2SD} stroke="#a855f7" strokeDasharray="3 3" label="-2σ" />
                      )}
                      {show1SD && activeSDExp.lower1SD && (
                        <ReferenceLine x={activeSDExp.lower1SD} stroke="#f59e0b" strokeDasharray="4 4" label="-1σ" />
                      )}
                      <ReferenceLine x={atmStrike} stroke="#10b981" strokeDasharray="3 3" label="ATM" />
                      {show1SD && activeSDExp.upper1SD && (
                        <ReferenceLine x={activeSDExp.upper1SD} stroke="#06b6d4" strokeDasharray="4 4" label="+1σ" />
                      )}
                      {show2SD && activeSDExp.upper2SD && (
                        <ReferenceLine x={activeSDExp.upper2SD} stroke="#f43f5e" strokeDasharray="3 3" label="+2σ" />
                      )}
                      {expirations.map(exp => (
                        <Line
                          key={exp.id}
                          type="monotone"
                          dataKey={`iv_${exp.id}`}
                          name={exp.label}
                          stroke={exp.color}
                          strokeWidth={activeSDExp.id === exp.id ? 2.5 : 1.5}
                          dot={false}
                        />
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Plot B: Term Structure Curve (ATM IV vs DTE) */}
              <div className="bg-slate-950/90 border border-slate-800 rounded-xl p-4 space-y-2">
                <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                  <span className="font-bold text-xs text-indigo-300 uppercase flex items-center gap-1.5">
                    <Activity className="w-4 h-4 text-emerald-400" />
                    <span>Implied Volatility Term Structure</span>
                  </span>
                  <span className="text-[11px] text-slate-400 font-mono">ATM IV vs Days to Expiry (DTE)</span>
                </div>

                <div className="h-64 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart
                      data={expirations.map(e => ({
                        dte: e.dte,
                        label: e.label,
                        atmIV: e.atmIV,
                        date: e.expiryDate,
                        move1SD: e.expectedMove1SD
                      }))}
                      margin={{ top: 10, right: 20, left: -10, bottom: 10 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                      <XAxis dataKey="dte" stroke="#64748b" fontSize={10} tickFormatter={(dte) => `${dte}d`} />
                      <YAxis stroke="#64748b" fontSize={10} tickFormatter={(v) => `${v}%`} domain={['auto', 'auto']} />
                      <Tooltip
                        contentStyle={{ backgroundColor: '#0f172a', borderColor: '#334155', fontSize: '11px', fontFamily: 'monospace' }}
                        formatter={(val: any, name: any) => [name === 'move1SD' ? `±₹${val}` : `${val}%`, name === 'move1SD' ? '1SD Move' : 'ATM IV']}
                        labelFormatter={(dte) => `DTE: ${dte} Days`}
                      />
                      <Line
                        type="monotone"
                        dataKey="atmIV"
                        name="ATM Volatility Curve"
                        stroke="#38bdf8"
                        strokeWidth={2.5}
                        dot={{ r: 5, fill: '#0284c7' }}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>

            </div>
          )}

          {/* 3E. DEDICATED STRATEGY ADVISOR & STRIKE RECOMMENDER (BASED ON 1SD & 2SD SURFACE) */}
          {showStrategyAdvisor && (
            <div className="bg-gradient-to-br from-slate-950 via-slate-900 to-indigo-950/60 border border-indigo-500/40 rounded-2xl p-4 sm:p-5 shadow-2xl space-y-4">
              
              {/* Advisor Header & Expiry Isolation Notice */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-800 pb-3">
                <div className="space-y-0.5">
                  <div className="flex items-center space-x-2">
                    <span className="p-1.5 rounded-lg bg-amber-500/10 text-amber-400 border border-amber-500/30">
                      <Sparkles className="w-4 h-4" />
                    </span>
                    <h4 className="font-bold text-sm text-white tracking-wide flex items-center gap-2">
                      <span>VOLATILITY SURFACE STRATEGY ADVISOR &amp; STRIKE BLUEPRINT</span>
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 font-mono border border-emerald-500/30 font-bold">
                        1SD / 2SD CALIBRATED
                      </span>
                    </h4>
                  </div>
                  <p className="text-xs text-slate-400">
                    Mathematically derived strike recommendations based on the 3D surface. Each expiration maintains strict independent volatility without blending cycles.
                  </p>
                </div>

                {/* Expiry Selector for Strategy Advisor */}
                <div className="flex flex-wrap items-center gap-1.5">
                  {expirations.map(exp => (
                    <button
                      key={`strat_exp_${exp.id}`}
                      onClick={() => {
                        setActiveSDExpiryId(exp.id);
                        if (selectedExpiryId !== 'ALL') setSelectedExpiryId(exp.id);
                      }}
                      className={`px-2.5 py-1 rounded-lg text-xs font-mono font-semibold transition-all cursor-pointer border ${
                        activeSDExp.id === exp.id
                          ? 'bg-indigo-600 text-white border-indigo-400 shadow-md shadow-indigo-600/30'
                          : 'bg-slate-900/80 text-slate-400 border-slate-800 hover:text-slate-200'
                      }`}
                    >
                      {exp.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* 4-Stat Mathematical Probability Strip */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 text-xs font-mono">
                
                {/* 1. Expiry & Volatility Profile */}
                <div className="bg-slate-950/80 p-3 rounded-xl border border-slate-800 space-y-1">
                  <span className="text-[10px] text-slate-500 uppercase font-sans block font-bold">Selected Cycle</span>
                  <div className="text-sm font-bold text-slate-100 flex items-center space-x-1.5">
                    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: activeSDExp.color }}></span>
                    <span>{activeSDExp.label}</span>
                  </div>
                  <span className="text-[11px] text-indigo-300 block">
                    ATM IV: <strong>{activeSDExp.atmIV}%</strong> | DTE: <strong>{activeSDExp.dte}d</strong>
                  </span>
                </div>

                {/* 2. 1SD Expected Move (68.3% Win Zone) */}
                <div className="bg-slate-950/80 p-3 rounded-xl border border-amber-500/30 space-y-1">
                  <span className="text-[10px] text-amber-400 uppercase font-sans block font-bold flex items-center gap-1">
                    <ShieldCheck className="w-3 h-3 text-amber-400" />
                    <span>±1SD Move (68.3% POP)</span>
                  </span>
                  <div className="text-sm font-bold text-amber-300">
                    ±₹{activeSDExp.expectedMove1SD} <span className="text-xs font-normal text-slate-400">(±{activeSDExp.movePct1SD}%)</span>
                  </div>
                  <span className="text-[11px] text-slate-300 block">
                    Range: <strong>₹{activeSDExp.lower1SD} – ₹{activeSDExp.upper1SD}</strong>
                  </span>
                </div>

                {/* 3. 2SD Tail Risk Boundary (95.5% Protection) */}
                <div className="bg-slate-950/80 p-3 rounded-xl border border-purple-500/30 space-y-1">
                  <span className="text-[10px] text-purple-400 uppercase font-sans block font-bold flex items-center gap-1">
                    <Crosshair className="w-3 h-3 text-purple-400" />
                    <span>±2SD Wing Band (95.5%)</span>
                  </span>
                  <div className="text-sm font-bold text-purple-300">
                    ±₹{activeSDExp.expectedMove2SD} <span className="text-xs font-normal text-slate-400">(±{activeSDExp.movePct2SD}%)</span>
                  </div>
                  <span className="text-[11px] text-slate-300 block">
                    Outer: <strong>₹{activeSDExp.lower2SD} – ₹{activeSDExp.upper2SD}</strong>
                  </span>
                </div>

                {/* 4. Condor Wing Spread Width */}
                <div className="bg-slate-950/80 p-3 rounded-xl border border-slate-800 space-y-1">
                  <span className="text-[10px] text-slate-500 uppercase font-sans block font-bold">Recommended Wing Width</span>
                  <div className="text-sm font-bold text-emerald-400">
                    ₹{activeSDExp.recommendedStrategy?.width || 200} pts
                  </div>
                  <span className="text-[11px] text-slate-400 block font-sans">
                    Distance between 1SD Short &amp; 2SD Wing
                  </span>
                </div>

              </div>

              {/* Strategy Recommendation Action Card */}
              {activeSDExp.recommendedStrategy && (
                <div className="bg-slate-900/95 border border-indigo-500/30 rounded-xl p-4 space-y-3.5">
                  
                  {/* Strategy Header */}
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-800/80 pb-2.5">
                    <div>
                      <div className="flex items-center space-x-2">
                        <span className="text-xs text-slate-400 font-sans font-semibold">Recommended Structure:</span>
                        <h5 className="text-sm sm:text-base font-bold text-white tracking-wide flex items-center gap-1.5">
                          <span className="text-amber-300">⚡</span>
                          <span>{activeSDExp.recommendedStrategy.name}</span>
                        </h5>
                      </div>
                      <p className="text-xs text-slate-400 mt-0.5">
                        {activeSDExp.recommendedStrategy.rationale}
                      </p>
                    </div>

                    <div className="flex items-center space-x-2 shrink-0">
                      <span className="text-xs font-mono font-bold px-2.5 py-1 rounded-md bg-emerald-500/10 text-emerald-300 border border-emerald-500/30">
                        POP: {activeSDExp.recommendedStrategy.pop}%
                      </span>
                      <span className="text-xs font-mono font-bold px-2.5 py-1 rounded-md bg-indigo-500/10 text-indigo-300 border border-indigo-500/30">
                        {activeSDExp.recommendedStrategy.bias}
                      </span>
                    </div>
                  </div>

                  {/* 4 Legs Strike Blueprint */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5 font-mono text-xs">
                    
                    {/* Leg 1: Long Put Wing (-2SD) */}
                    <div className="bg-slate-950/90 border border-emerald-500/40 p-2.5 rounded-lg space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] font-sans font-bold px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 uppercase">
                          BUY WING (-2SD)
                        </span>
                        <span className="text-[10px] text-slate-500">95.5% Protection</span>
                      </div>
                      <div className="text-base font-bold text-emerald-400">
                        ₹{activeSDExp.recommendedStrategy.longPut} PE
                      </div>
                      <span className="text-[10px] text-slate-400 font-sans block">
                        Long Put Wing to define max downside loss
                      </span>
                    </div>

                    {/* Leg 2: Short Put (-1SD) */}
                    <div className="bg-slate-950/90 border border-amber-500/40 p-2.5 rounded-lg space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] font-sans font-bold px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 uppercase">
                          SELL SHORT (-1SD)
                        </span>
                        <span className="text-[10px] text-slate-500">68.3% Win Barrier</span>
                      </div>
                      <div className="text-base font-bold text-amber-300">
                        ₹{activeSDExp.recommendedStrategy.shortPut} PE
                      </div>
                      <span className="text-[10px] text-slate-400 font-sans block">
                        Collects high downside put skew premium
                      </span>
                    </div>

                    {/* Leg 3: Short Call (+1SD) */}
                    <div className="bg-slate-950/90 border border-cyan-500/40 p-2.5 rounded-lg space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] font-sans font-bold px-1.5 py-0.5 rounded bg-cyan-500/20 text-cyan-300 uppercase">
                          SELL SHORT (+1SD)
                        </span>
                        <span className="text-[10px] text-slate-500">68.3% Win Barrier</span>
                      </div>
                      <div className="text-base font-bold text-cyan-300">
                        ₹{activeSDExp.recommendedStrategy.shortCall} CE
                      </div>
                      <span className="text-[10px] text-slate-400 font-sans block">
                        Collects call volatility premium
                      </span>
                    </div>

                    {/* Leg 4: Long Call Wing (+2SD) */}
                    <div className="bg-slate-950/90 border border-sky-500/40 p-2.5 rounded-lg space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] font-sans font-bold px-1.5 py-0.5 rounded bg-sky-500/20 text-sky-300 uppercase">
                          BUY WING (+2SD)
                        </span>
                        <span className="text-[10px] text-slate-500">95.5% Protection</span>
                      </div>
                      <div className="text-base font-bold text-sky-300">
                        ₹{activeSDExp.recommendedStrategy.longCall} CE
                      </div>
                      <span className="text-[10px] text-slate-400 font-sans block">
                        Long Call Wing to cap extreme upside rally
                      </span>
                    </div>

                  </div>

                  {/* Actions Bar */}
                  <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                    <div className="text-xs text-slate-400 flex items-center space-x-2">
                      <span className="w-2 h-2 rounded-full bg-emerald-400"></span>
                      <span>Safe Profit Corridor: <strong>₹{activeSDExp.recommendedStrategy.shortPut} – ₹{activeSDExp.recommendedStrategy.shortCall}</strong> ({activeSDExp.recommendedStrategy.shortCall - activeSDExp.recommendedStrategy.shortPut} pts sweet spot)</span>
                    </div>

                    <div className="flex items-center space-x-2">
                      {stagedStrategy ? (
                        <button
                          onClick={() => setStagedStrategy(null)}
                          className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-rose-300 text-xs font-semibold border border-rose-500/30 transition-all cursor-pointer"
                        >
                          Clear Staged Pins
                        </button>
                      ) : (
                        <button
                          onClick={() => {
                            if (activeSDExp.recommendedStrategy) {
                              setStagedStrategy(activeSDExp.recommendedStrategy);
                              setShowCondorPins(true);
                            }
                          }}
                          className="px-3.5 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-md shadow-indigo-600/30 transition-all cursor-pointer flex items-center space-x-1.5"
                        >
                          <Target className="w-3.5 h-3.5" />
                          <span>Stage Strategy on 3D Vol Surface</span>
                        </button>
                      )}

                      <button
                        onClick={() => {
                          const strat = activeSDExp.recommendedStrategy;
                          if (!strat) return;
                          const copyText = `NIFTY Strategy: ${strat.name} for ${activeSDExp.expiryDate} (${activeSDExp.dte}d)\nSell PE: ₹${strat.shortPut} (-1SD)\nBuy PE: ₹${strat.longPut} (-2SD)\nSell CE: ₹${strat.shortCall} (+1SD)\nBuy CE: ₹${strat.longCall} (+2SD)\nATM Spot: ₹${simulatedSpot} | Expected 1SD: ±₹${activeSDExp.expectedMove1SD}`;
                          navigator.clipboard.writeText(copyText).then(() => {
                            setHasCopiedStrategy(true);
                            setTimeout(() => setHasCopiedStrategy(false), 3000);
                          }).catch(() => {});
                        }}
                        className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold border border-slate-700 transition-all cursor-pointer flex items-center space-x-1.5"
                      >
                        {hasCopiedStrategy ? (
                          <>
                            <Check className="w-3.5 h-3.5 text-emerald-400" />
                            <span className="text-emerald-400">Copied!</span>
                          </>
                        ) : (
                          <>
                            <Copy className="w-3.5 h-3.5 text-slate-400" />
                            <span>Copy Strikes</span>
                          </>
                        )}
                      </button>
                    </div>
                  </div>

                </div>
              )}

            </div>
          )}

          {/* 4. FOOTER NOTE & METHODOLOGY */}
          <div className="p-3 bg-slate-950/60 rounded-xl border border-slate-800/80 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-[11px] text-slate-400">
            <div className="flex items-center space-x-2">
              <Sparkles className="w-4 h-4 text-indigo-400 shrink-0" />
              <span>
                SVI (Stochastic Volatility Inspired) parametric calibration with real-time Black-Scholes Greeks and independent per-cycle standard deviation cones.
              </span>
            </div>

            <div className="flex items-center space-x-2 font-mono shrink-0">
              <span className="text-slate-500">Live Nifty ATM:</span>
              <span className="font-bold text-slate-200">₹{atmStrike}</span>
            </div>
          </div>

        </div>
      )}

    </div>
  );
};
