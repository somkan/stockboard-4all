import { db } from './db.js';
import { logger } from './logger.js';

export class RiskService {
  /**
   * Calculates monthly cumulative loss (realized + unrealized P&L for current month)
   */
  public getMonthlyStats(modeFilter?: string): {
    totalPnl: number;
    realizedPnl: number;
    unrealizedPnl: number;
    winCount: number;
    totalTrades: number;
    winRate: number;
    maxDrawdown: number;
  } {
    const positions = db.getPositions();
    const settings = db.getSettings();

    const targetMode = modeFilter || settings.mode;
    const now = new Date();
    const currentMonthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    // Filter closed/open positions for current month and matching mode
    const currentMonthPositions = positions.filter(p => {
      const posMode = p.mode || 'PAPER';
      if (posMode !== targetMode) return false;
      const pDate = p.entryTime || p.updatedTime;
      const dateStr = typeof pDate === 'string' ? pDate : (pDate ? new Date(pDate).toISOString() : '');
      return dateStr.startsWith(currentMonthPrefix);
    });

    let realizedPnl = 0;
    let unrealizedPnl = 0;
    let winCount = 0;
    let closedTradesCount = 0;

    currentMonthPositions.forEach(p => {
      const pnl = p.totalPnl || 0;
      if (p.status === 'CLOSED') {
        realizedPnl += pnl;
        closedTradesCount++;
        if (pnl > 0) {
          winCount++;
        }
      } else {
        unrealizedPnl += pnl;
      }
    });

    const totalPnl = Math.round(realizedPnl + unrealizedPnl);
    const totalTrades = currentMonthPositions.length;
    const winRate = closedTradesCount > 0
      ? Math.round((winCount / closedTradesCount) * 100)
      : (totalTrades > 0 && totalPnl > 0 ? 100 : 0);

    const maxDrawdown = Math.min(0, totalPnl);

    return {
      totalPnl,
      realizedPnl: Math.round(realizedPnl),
      unrealizedPnl: Math.round(unrealizedPnl),
      winCount,
      totalTrades,
      winRate,
      maxDrawdown: Math.round(maxDrawdown)
    };
  }

  /**
   * Check if monthly risk limit breached (e.g. 5% loss of Capital = ₹25,000 max loss)
   */
  public checkMonthlyRisk(modeFilter?: string): { isBreached: boolean; monthlyLoss: number; maxAllowedLoss: number; pctUsed: number } {
    const settings = db.getSettings();
    const targetMode = modeFilter || settings.mode;
    const stats = this.getMonthlyStats(targetMode);
    
    const effectiveCapital = (targetMode === 'LIVE' && settings.fyersTotalFunds && settings.fyersTotalFunds > 0)
      ? settings.fyersTotalFunds
      : settings.capital;

    const maxAllowedLoss = (effectiveCapital * settings.monthlyMaxLossPct) / 100;
    const currentMonthlyLoss = stats.totalPnl < 0 ? Math.abs(stats.totalPnl) : 0;

    const pctUsed = Math.min(100, Math.round((currentMonthlyLoss / maxAllowedLoss) * 100));
    const isBreached = currentMonthlyLoss >= maxAllowedLoss;

    return {
      isBreached,
      monthlyLoss: currentMonthlyLoss,
      maxAllowedLoss,
      pctUsed
    };
  }

  /**
   * Check if a proposed trade's max potential risk exceeds per-trade cap (e.g., 2% of capital = ₹10,000)
   */
  public checkTradeRisk(estimatedMaxLoss: number): { isAllowed: boolean; maxAllowedTradeLoss: number; reason?: string } {
    const settings = db.getSettings();
    const maxAllowedTradeLoss = (settings.capital * settings.perTradeMaxLossPct) / 100;

    if (estimatedMaxLoss > maxAllowedTradeLoss) {
      return {
        isAllowed: false,
        maxAllowedTradeLoss,
        reason: `Estimated trade max loss (₹${estimatedMaxLoss}) exceeds per-trade limit of ₹${maxAllowedTradeLoss} (${settings.perTradeMaxLossPct}% of capital)`
      };
    }

    return {
      isAllowed: true,
      maxAllowedTradeLoss
    };
  }

  /**
   * Checks if required margin for new trade fits within allocated capital (based on consumption %)
   */
  public checkCapitalRequirement(requiredMargin: number, numberOfLots: number = 1): {
    isAllowed: boolean;
    allocatedCapital: number;
    remainingAllocatedCapital: number;
    requiredMargin: number;
    maxLotsAllowed: number;
    reason?: string;
  } {
    const settings = db.getSettings();
    const pct = settings.capitalAllocationPct || 100;
    
    // Total raw available funds from Fyers or paper capital
    const rawAvailableFunds = (settings.mode === 'LIVE' && settings.fyersAvailableFunds && settings.fyersAvailableFunds > 0)
      ? settings.fyersAvailableFunds
      : settings.capital;

    // Allocated capital based on user's consumption %
    const allocatedCapital = Math.round(rawAvailableFunds * (pct / 100));

    // Calculate utilized margin from open positions
    const openPositions = db.getOpenPositions(settings.mode);
    let utilizedMargin = 0;
    openPositions.forEach(p => {
      // For open positions, estimate required margin (minimum ₹100,000 per lot or maxRisk * 1.5)
      const posMargin = p.maxRisk > 0 ? Math.max(p.maxRisk * 1.5, 80000) : 120000;
      utilizedMargin += posMargin;
    });

    const remainingAllocatedCapital = Math.max(0, allocatedCapital - utilizedMargin);
    const marginPerLot = requiredMargin > 0 ? Math.round(requiredMargin / Math.max(1, numberOfLots)) : 100000;
    const maxLotsAllowed = Math.floor(remainingAllocatedCapital / marginPerLot);

    if (remainingAllocatedCapital < requiredMargin) {
      return {
        isAllowed: false,
        allocatedCapital,
        remainingAllocatedCapital,
        requiredMargin,
        maxLotsAllowed,
        reason: `Insufficient Allocated Capital: Available allocated funds are ₹${remainingAllocatedCapital.toLocaleString('en-IN')} (based on ${pct}% consumption of ₹${rawAvailableFunds.toLocaleString('en-IN')}). Required margin: ₹${requiredMargin.toLocaleString('en-IN')}. Please increase Capital Allocation % in settings or deposit funds.`
      };
    }

    return {
      isAllowed: true,
      allocatedCapital,
      remainingAllocatedCapital,
      requiredMargin,
      maxLotsAllowed
    };
  }

  /**
   * Determines if trading should be paused due to risk breach or setting
   */
  public shouldPauseTrading(): { pause: boolean; reason?: string } {
    const settings = db.getSettings();

    if (!settings.autoTradingEnabled) {
      return { pause: true, reason: 'Auto-trading is disabled in settings.' };
    }

    const monthlyRisk = this.checkMonthlyRisk();
    if (monthlyRisk.isBreached) {
      return {
        pause: true,
        reason: `Monthly loss limit breached (Used: ₹${monthlyRisk.monthlyLoss} / Limit: ₹${monthlyRisk.maxAllowedLoss}).`
      };
    }

    return { pause: false };
  }
}

export const riskService = new RiskService();
