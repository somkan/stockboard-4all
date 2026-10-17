import { db } from './db.js';
import { Settings } from './types.js';

// Standard Cumulative Normal Distribution approximation for Black-Scholes
function normCDF(x: number): number {
  if (x === 0) return 0.5;
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  let prob = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  if (x > 0) prob = 1 - prob;
  return prob;
}

/**
 * Black-Scholes European Option Pricing Formula
 */
function blackScholes(
  spot: number,
  strike: number,
  timeToExpiryYears: number,
  volatility: number = 0.14,
  riskFreeRate: number = 0.065,
  type: 'CE' | 'PE'
): number {
  if (timeToExpiryYears <= 0.0001) {
    if (type === 'CE') return Math.max(0, spot - strike);
    return Math.max(0, strike - spot);
  }

  const d1 = (Math.log(spot / strike) + (riskFreeRate + (volatility * volatility) / 2) * timeToExpiryYears) /
             (volatility * Math.sqrt(timeToExpiryYears));
  const d2 = d1 - volatility * Math.sqrt(timeToExpiryYears);

  if (type === 'CE') {
    const price = spot * normCDF(d1) - strike * Math.exp(-riskFreeRate * timeToExpiryYears) * normCDF(d2);
    return Math.max(0.05, Math.round(price * 20) / 20);
  } else {
    const price = strike * Math.exp(-riskFreeRate * timeToExpiryYears) * normCDF(-d2) - spot * normCDF(-d1);
    return Math.max(0.05, Math.round(price * 20) / 20);
  }
}

// Interface for Backtest Daily Bar
interface IntradayBar {
  timeStr: string; // e.g. "09:15"
  spot: number;
}

interface HistoricalDayData {
  dateStr: string;
  dayOfWeek: string;
  openSpot: number;
  highSpot: number;
  lowSpot: number;
  closeSpot: number;
  bars: IntradayBar[];
}

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

export interface EquityCurvePoint {
  timestamp: string;
  dayName: string;
  timeStr: string;
  spotPrice: number;
  intradayPnl: number;
  cumulativePnl: number;
}

export interface BacktestResult {
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

export class BacktestService {

  /**
   * Generates realistic historical NIFTY50 price action for the last 5 trading days
   */
  private getHistorical5DayData(baseSpot: number): HistoricalDayData[] {
    const days: HistoricalDayData[] = [];
    
    // Generate dates for last 5 trading days (Mon-Fri)
    const now = new Date();
    const dateList: Array<{ dateStr: string; dayOfWeek: string }> = [];
    let d = new Date(now);
    
    while (dateList.length < 5) {
      d.setDate(d.getDate() - 1);
      const day = d.getDay();
      if (day !== 0 && day !== 6) { // Exclude weekends
        const dateStr = d.toISOString().split('T')[0];
        const dayOfWeek = d.toLocaleDateString('en-US', { weekday: 'short' });
        dateList.unshift({ dateStr, dayOfWeek });
      }
    }

    // Realistic market archetypes across 5 days:
    // Day 1: Sideways range-bound day (Theta decay friendly)
    // Day 2: Gradual Bullish Drift (+120 pts)
    // Day 3: Volatile Intraday Spike & Mean Reversion
    // Day 4: Gap Down & Recovery
    // Day 5: Tight Consolidation Day

    const dayProfiles = [
      { startOffset: -120, trend: 'SIDEWAYS', volatility: 15, highDiff: 90, lowDiff: -60 },
      { startOffset: -40, trend: 'BULLISH', volatility: 25, highDiff: 160, lowDiff: -20 },
      { startOffset: +80, trend: 'VOLATILE_SPIKE', volatility: 45, highDiff: 210, lowDiff: -130 },
      { startOffset: -110, trend: 'GAP_DOWN_RECOVERY', volatility: 35, highDiff: 110, lowDiff: -150 },
      { startOffset: -10, trend: 'TIGHT_CONSOLIDATION', volatility: 12, highDiff: 50, lowDiff: -40 }
    ];

    const timeSteps = [
      '09:15', '09:30', '09:45', '10:00', '10:15', '10:30', '10:45', '11:00',
      '11:15', '11:30', '11:45', '12:00', '12:15', '12:30', '12:45', '13:00',
      '13:15', '13:30', '13:45', '14:00', '14:15', '14:30', '14:45', '15:00', '15:15'
    ];

    for (let i = 0; i < 5; i++) {
      const profile = dayProfiles[i];
      const dateObj = dateList[i];
      const openSpot = Math.round((baseSpot + profile.startOffset) / 50) * 50;

      const bars: IntradayBar[] = [];
      let current = openSpot;

      for (let t = 0; t < timeSteps.length; t++) {
        const timeStr = timeSteps[t];
        if (t === 0) {
          bars.push({ timeStr, spot: openSpot });
          continue;
        }

        // Intra-step price drift
        let stepDrift = 0;
        if (profile.trend === 'SIDEWAYS') {
          stepDrift = (Math.sin(t / 2) * 15) + (Math.random() - 0.5) * 10;
        } else if (profile.trend === 'BULLISH') {
          stepDrift = 6 + (Math.random() - 0.3) * 12;
        } else if (profile.trend === 'VOLATILE_SPIKE') {
          if (t < 12) stepDrift = 18 + Math.random() * 15; // Rapid morning rally
          else stepDrift = -22 - Math.random() * 18; // Afternoon dump
        } else if (profile.trend === 'GAP_DOWN_RECOVERY') {
          if (t < 8) stepDrift = -12 + (Math.random() - 0.5) * 8;
          else stepDrift = 11 + Math.random() * 10; // Midday recovery
        } else { // TIGHT_CONSOLIDATION
          stepDrift = (Math.random() - 0.5) * 8;
        }

        current = Math.round((current + stepDrift) * 20) / 20;
        bars.push({ timeStr, spot: current });
      }

      const spots = bars.map(b => b.spot);
      const highSpot = Math.max(...spots);
      const lowSpot = Math.min(...spots);
      const closeSpot = spots[spots.length - 1];

      days.push({
        dateStr: dateObj.dateStr,
        dayOfWeek: dateObj.dayOfWeek,
        openSpot,
        highSpot,
        lowSpot,
        closeSpot,
        bars
      });
    }

    return days;
  }

  /**
   * Run 5-Day Historical Iron Condor Strategy Simulation
   */
  public runBacktest(overrideSettings?: Partial<Settings>): BacktestResult {
    const currentSettings = db.getSettings();
    const settings = {
      strikeDistance: overrideSettings?.strikeDistance ?? currentSettings.strikeDistance ?? 300,
      wingBuffer: overrideSettings?.wingBuffer ?? currentSettings.wingBuffer ?? 200,
      quantity: overrideSettings?.defaultQuantity ?? currentSettings.defaultQuantity ?? 75,
      perTradeMaxLossPct: overrideSettings?.perTradeMaxLossPct ?? currentSettings.perTradeMaxLossPct ?? 2.0,
      targetProfitPct: 65, // 65% of max credit
      capital: overrideSettings?.capital ?? currentSettings.capital ?? 500000
    };

    const baseSpot = 24500;
    const historicalDays = this.getHistorical5DayData(baseSpot);

    const dailyBreakdown: BacktestDailyResult[] = [];
    const equityCurve: EquityCurvePoint[] = [];

    let cumulativePnl = 0;
    let peakEquity = 0;
    let maxDrawdown = 0;
    let totalCreditCollectedSum = 0;
    let totalAdjustmentsCount = 0;

    historicalDays.forEach((dayData, dayIdx) => {
      const openSpot = dayData.openSpot;
      const atmStrike = Math.round(openSpot / 100) * 100;

      // Iron Condor Strike Selection
      let shortCeStrike = atmStrike + settings.strikeDistance;
      let shortPeStrike = atmStrike - settings.strikeDistance;
      let longCeStrike = shortCeStrike + settings.wingBuffer;
      let longPeStrike = shortPeStrike - settings.wingBuffer;

      // Initial Pricing at 09:15 AM
      const dteDays = 4 - dayIdx; // DTE counting down
      const dteYears = Math.max(1, dteDays) / 365.0;
      const iv = 0.14;

      const shortCeEntry = blackScholes(openSpot, shortCeStrike, dteYears, iv, 0.065, 'CE');
      const shortPeEntry = blackScholes(openSpot, shortPeStrike, dteYears, iv, 0.065, 'PE');
      const longCeEntry = blackScholes(openSpot, longCeStrike, dteYears, iv, 0.065, 'CE');
      const longPeEntry = blackScholes(openSpot, longPeStrike, dteYears, iv, 0.065, 'PE');

      // Net Credit per share & Total Credit for lot size
      let netCreditPerShare = Math.max(1.0, (shortCeEntry + shortPeEntry) - (longCeEntry + longPeEntry));
      const initialCreditCollected = Math.round(netCreditPerShare * settings.quantity);
      let totalCreditCollected = initialCreditCollected;
      totalCreditCollectedSum += initialCreditCollected;

      const maxLossAllowed = Math.min(
        (settings.capital * (settings.perTradeMaxLossPct / 100)),
        (settings.wingBuffer - netCreditPerShare) * settings.quantity
      );
      const targetProfitAmount = initialCreditCollected * (settings.targetProfitPct / 100);

      let dayFinalPnl = 0;
      let dayMaxProfit = 0;
      let dayMaxDd = 0;
      let exitTime = '15:15';
      let exitReason: 'TARGET_PROFIT' | 'STOP_LOSS' | '3:15 PM EOD EXIT' | 'DEFENSIVE_ADJUSTED' = '3:15 PM EOD EXIT';
      let positionClosed = false;
      let realizedAdjustmentPnl = 0;

      const adjustments: BacktestAdjustment[] = [];

      // Track Intraday Progress
      dayData.bars.forEach((bar, barIdx) => {
        if (positionClosed) {
          // Record flat line after exit
          equityCurve.push({
            timestamp: `${dayData.dateStr} ${bar.timeStr}`,
            dayName: dayData.dayOfWeek,
            timeStr: bar.timeStr,
            spotPrice: bar.spot,
            intradayPnl: dayFinalPnl,
            cumulativePnl: cumulativePnl + dayFinalPnl
          });
          return;
        }

        // Time elapsed fraction of the day
        const dayFraction = barIdx / (dayData.bars.length - 1);
        const remainingDteYears = Math.max(0.1, dteDays - dayFraction) / 365.0;

        // Current option leg market prices
        const curShortCe = blackScholes(bar.spot, shortCeStrike, remainingDteYears, iv, 0.065, 'CE');
        const curShortPe = blackScholes(bar.spot, shortPeStrike, remainingDteYears, iv, 0.065, 'PE');
        const curLongCe = blackScholes(bar.spot, longCeStrike, remainingDteYears, iv, 0.065, 'CE');
        const curLongPe = blackScholes(bar.spot, longPeStrike, remainingDteYears, iv, 0.065, 'PE');

        const curNetPremium = (curShortCe + curShortPe) - (curLongCe + curLongPe);
        const openPositionsPnl = Math.round((netCreditPerShare - curNetPremium) * settings.quantity);
        const currentIntradayPnl = openPositionsPnl + realizedAdjustmentPnl;

        if (currentIntradayPnl > dayMaxProfit) dayMaxProfit = currentIntradayPnl;
        if (currentIntradayPnl < dayMaxDd) dayMaxDd = currentIntradayPnl;

        // --- DYNAMIC IRON CONDOR BREAKeven ADJUSTMENT LOGIC ---
        // Alert threshold: Spot within 35 pts of short strike or nearing breakeven boundary
        const upperBreakevenAlert = shortCeStrike - 35;
        const lowerBreakevenAlert = shortPeStrike + 35;

        // Condition 1: Market rallies up towards Short CE strike (threatens Call spread)
        if (bar.spot >= upperBreakevenAlert && adjustments.length < 2 && (barIdx > 2 && barIdx < dayData.bars.length - 2)) {
          const oldPeStrike = shortPeStrike;
          const oldLongPeStrike = longPeStrike;
          
          // Close winning Put spread (decayed) and lock in realized profit
          const peSpreadDecayedValue = Math.max(0.1, curShortPe - curLongPe);
          const initialPeSpreadCredit = Math.max(0.5, shortPeEntry - longPeEntry);
          const putProfitRealized = Math.round((initialPeSpreadCredit - peSpreadDecayedValue) * settings.quantity);
          realizedAdjustmentPnl += putProfitRealized;

          // Roll Put spread UP closer to current spot
          const newShortPeStrike = Math.min(shortCeStrike - 150, Math.round((bar.spot - 150) / 50) * 50);
          const newLongPeStrike = newShortPeStrike - settings.wingBuffer;

          // Price new rolled Put spread
          const newShortPePrice = blackScholes(bar.spot, newShortPeStrike, remainingDteYears, iv, 0.065, 'PE');
          const newLongPePrice = blackScholes(bar.spot, newLongPeStrike, remainingDteYears, iv, 0.065, 'PE');
          const freshPutCredit = Math.max(1.0, newShortPePrice - newLongPePrice);
          const freshCreditTotal = Math.round(freshPutCredit * settings.quantity);
          
          totalCreditCollected += freshCreditTotal;
          totalCreditCollectedSum += freshCreditTotal;
          netCreditPerShare = freshPutCredit + (curShortCe - curLongCe);

          shortPeStrike = newShortPeStrike;
          longPeStrike = newLongPeStrike;

          const adjObj: BacktestAdjustment = {
            id: `adj_${dayData.dateStr}_${bar.timeStr}_call_rally`,
            time: `${bar.timeStr} IST`,
            type: 'ROLL_UP_PUT',
            title: `Defensive Roll UP: ${oldPeStrike} PE → ${newShortPeStrike} PE`,
            triggerSpot: bar.spot,
            triggerCondition: `Spot breached ₹${bar.spot} (nearing CE short ₹${shortCeStrike})`,
            description: `Market rallied. Squared off winning ${oldPeStrike} PE spread (+₹${putProfitRealized.toLocaleString('en-IN')}) and rolled PE UP to ${newShortPeStrike} PE / ${newLongPeStrike} PE wing.`,
            oldSpread: `${oldPeStrike} PE / ${oldLongPeStrike} PE`,
            newSpread: `${newShortPeStrike} PE / ${newLongPeStrike} PE`,
            freshCreditCollected: freshCreditTotal,
            realizedPnlOnClosedLegs: putProfitRealized
          };
          adjustments.push(adjObj);
          totalAdjustmentsCount++;
        }
        // Condition 2: Market plunges down towards Short PE strike (threatens Put spread)
        else if (bar.spot <= lowerBreakevenAlert && adjustments.length < 2 && (barIdx > 2 && barIdx < dayData.bars.length - 2)) {
          const oldCeStrike = shortCeStrike;
          const oldLongCeStrike = longCeStrike;
          
          // Close winning Call spread (decayed) and lock in realized profit
          const ceSpreadDecayedValue = Math.max(0.1, curShortCe - curLongCe);
          const initialCeSpreadCredit = Math.max(0.5, shortCeEntry - longCeEntry);
          const callProfitRealized = Math.round((initialCeSpreadCredit - ceSpreadDecayedValue) * settings.quantity);
          realizedAdjustmentPnl += callProfitRealized;

          // Roll Call spread DOWN closer to current spot
          const newShortCeStrike = Math.max(shortPeStrike + 150, Math.round((bar.spot + 150) / 50) * 50);
          const newLongCeStrike = newShortCeStrike + settings.wingBuffer;

          // Price new rolled Call spread
          const newShortCePrice = blackScholes(bar.spot, newShortCeStrike, remainingDteYears, iv, 0.065, 'CE');
          const newLongCePrice = blackScholes(bar.spot, newLongCeStrike, remainingDteYears, iv, 0.065, 'CE');
          const freshCallCredit = Math.max(1.0, newShortCePrice - newLongCePrice);
          const freshCreditTotal = Math.round(freshCallCredit * settings.quantity);

          totalCreditCollected += freshCreditTotal;
          totalCreditCollectedSum += freshCreditTotal;
          netCreditPerShare = freshCallCredit + (curShortPe - curLongPe);

          shortCeStrike = newShortCeStrike;
          longCeStrike = newLongCeStrike;

          const adjObj: BacktestAdjustment = {
            id: `adj_${dayData.dateStr}_${bar.timeStr}_put_drop`,
            time: `${bar.timeStr} IST`,
            type: 'ROLL_DOWN_CALL',
            title: `Defensive Roll DOWN: ${oldCeStrike} CE → ${newShortCeStrike} CE`,
            triggerSpot: bar.spot,
            triggerCondition: `Spot dropped to ₹${bar.spot} (nearing PE short ₹${shortPeStrike})`,
            description: `Market dropped. Squared off winning ${oldCeStrike} CE spread (+₹${callProfitRealized.toLocaleString('en-IN')}) and rolled CE DOWN to ${newShortCeStrike} CE / ${newLongCeStrike} CE wing.`,
            oldSpread: `${oldCeStrike} CE / ${oldLongCeStrike} CE`,
            newSpread: `${newShortCeStrike} CE / ${newLongCeStrike} CE`,
            freshCreditCollected: freshCreditTotal,
            realizedPnlOnClosedLegs: callProfitRealized
          };
          adjustments.push(adjObj);
          totalAdjustmentsCount++;
        }

        // Check Exit Conditions
        if (currentIntradayPnl >= targetProfitAmount) {
          dayFinalPnl = Math.round(targetProfitAmount);
          exitTime = bar.timeStr;
          exitReason = 'TARGET_PROFIT';
          positionClosed = true;
        } else if (currentIntradayPnl <= -maxLossAllowed) {
          dayFinalPnl = -Math.round(maxLossAllowed);
          exitTime = bar.timeStr;
          exitReason = 'STOP_LOSS';
          positionClosed = true;
        } else if (barIdx === dayData.bars.length - 1) {
          dayFinalPnl = currentIntradayPnl;
          exitTime = bar.timeStr;
          exitReason = adjustments.length > 0 ? 'DEFENSIVE_ADJUSTED' : '3:15 PM EOD EXIT';
          positionClosed = true;
        }

        const pointPnl = positionClosed ? dayFinalPnl : currentIntradayPnl;
        equityCurve.push({
          timestamp: `${dayData.dateStr} ${bar.timeStr}`,
          dayName: dayData.dayOfWeek,
          timeStr: bar.timeStr,
          spotPrice: bar.spot,
          intradayPnl: pointPnl,
          cumulativePnl: cumulativePnl + pointPnl
        });
      });

      cumulativePnl += dayFinalPnl;
      if (cumulativePnl > peakEquity) peakEquity = cumulativePnl;
      const drawdown = peakEquity - cumulativePnl;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;

      const spotRangePts = Math.round(dayData.highSpot - dayData.lowSpot);

      let adjustmentSummary = '0 Adjustments (Safe Range)';
      if (adjustments.length === 1) {
        adjustmentSummary = `1 Adjustment (${adjustments[0].title.split(':')[1]?.trim() || adjustments[0].type})`;
      } else if (adjustments.length > 1) {
        adjustmentSummary = `${adjustments.length} Adjustments Executed`;
      }

      dailyBreakdown.push({
        dayIndex: dayIdx + 1,
        dateStr: dayData.dateStr,
        dayOfWeek: dayData.dayOfWeek,
        openSpot: dayData.openSpot,
        highSpot: dayData.highSpot,
        lowSpot: dayData.lowSpot,
        closeSpot: dayData.closeSpot,
        spotRangePts,
        strategyEntered: `Iron Condor (${settings.quantity} Qty)`,
        shortCeStrike,
        shortPeStrike,
        longCeStrike,
        longPeStrike,
        creditCollected: totalCreditCollected,
        finalPnl: dayFinalPnl,
        pnlPct: Math.round((dayFinalPnl / settings.capital) * 10000) / 100,
        maxProfitReached: Math.round(dayMaxProfit),
        maxDrawdown: Math.round(dayMaxDd),
        exitTime,
        exitReason,
        adjustmentMade: adjustments.length > 0,
        adjustmentsCount: adjustments.length,
        adjustments,
        adjustmentSummary,
        adjustmentDetails: adjustments.map(a => `${a.time}: ${a.title} (Triggered at spot ₹${a.triggerSpot})`).join(' | ') || undefined
      });
    });

    const winningDays = dailyBreakdown.filter(d => d.finalPnl >= 0).length;
    const losingDays = dailyBreakdown.filter(d => d.finalPnl < 0).length;
    const winRate = Math.round((winningDays / 5) * 100);

    const returnPct = Math.round((cumulativePnl / settings.capital) * 10000) / 100;
    const maxDrawdownPct = Math.round((maxDrawdown / settings.capital) * 10000) / 100;
    const avgDailyPnl = Math.round(cumulativePnl / 5);

    const sessionsWithAdjustments = dailyBreakdown.filter(d => d.adjustmentsCount > 0).length;
    const adjustedDaysWinning = dailyBreakdown.filter(d => d.adjustmentsCount > 0 && d.finalPnl >= 0).length;
    const adjustmentSuccessRate = sessionsWithAdjustments > 0 
      ? Math.round((adjustedDaysWinning / sessionsWithAdjustments) * 100) 
      : 100;

    // AI Insights Generator
    const insights: string[] = [
      `Across 5 sessions, the strategy executed ${totalAdjustmentsCount} automated rolling adjustment(s) across ${sessionsWithAdjustments} volatile session(s).`,
      `Adjustment Defense Efficacy: ${adjustmentSuccessRate}% of adjusted positions finished in profit by rolling decayed winning legs to defend tested sides.`,
      `With a ${settings.strikeDistance}pt strike distance, the Iron Condor achieved an overall ${winRate}% win rate across all 5 trading days.`,
      `Total Net 5-Day Simulation Profit: ₹${cumulativePnl.toLocaleString('en-IN')} (${returnPct >= 0 ? '+' : ''}${returnPct}% on ₹${(settings.capital / 100000).toFixed(1)}L capital).`
    ];

    return {
      settingsUsed: {
        strikeDistance: settings.strikeDistance,
        wingBuffer: settings.wingBuffer,
        quantity: settings.quantity,
        perTradeMaxLossPct: settings.perTradeMaxLossPct,
        targetProfitPct: settings.targetProfitPct,
        capital: settings.capital
      },
      summary: {
        totalPnl: cumulativePnl,
        returnPct,
        winRate,
        totalDays: 5,
        winningDays,
        losingDays,
        maxDrawdown,
        maxDrawdownPct,
        avgDailyPnl,
        totalCreditCollected: totalCreditCollectedSum,
        totalAdjustments: totalAdjustmentsCount,
        sessionsWithAdjustments,
        adjustmentSuccessRate,
        capital: settings.capital
      },
      dailyBreakdown,
      equityCurve,
      insights
    };
  }
}

export const backtestService = new BacktestService();
