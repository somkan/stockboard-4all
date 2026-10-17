import cron from 'node-cron';
import { db } from './db.js';
import { strategyEngine } from './strategyEngine.js';
import { riskService } from './riskService.js';
import { fyersService } from './fyersService.js';
import { marketDataService } from './marketDataService.js';
import { logger } from './logger.js';

let cronTask: any = null;
let isRunning = false;
let lastTokenRefreshCheck = 0;

export function initCronScheduler() {
  // Run every minute (during active trading session or simulation)
  cronTask = cron.schedule('* * * * *', async () => {
    if (isRunning) return;
    isRunning = true;

    try {
      // Periodic Token Resolution & FYERS Live Positions Sync
      try {
        await fyersService.ensureValidToken();
        await strategyEngine.syncFyersPositions();
      } catch (fyersErr: any) {
        // Silent catch for off-market or unconfigured environments
      }

      logger.info('--- CRON TICK: Evaluating Strategy & Risk Engine ---');

      const settings = db.getSettings();

      // 1. Run automated paper trading engine ONLY in PAPER mode
      if (settings.mode === 'PAPER') {
        await strategyEngine.autoPaperTradeScannerOpportunities();
      }

      // 2. Monitor ALL existing open positions (Live and Paper) & apply Golden Rule adjustments
      await strategyEngine.monitorAndAdjustPositions();

      if (!settings.autoTradingEnabled) {
        isRunning = false;
        return;
      }

      // Check if market is open for automated live entry
      const marketOpen = marketDataService.isMarketOpen();
      if (!marketOpen && settings.mode === 'LIVE') {
        isRunning = false;
        return;
      }

      // 3. Check Risk Controls
      const pauseCheck = riskService.shouldPauseTrading();
      if (pauseCheck.pause) {
        logger.warn(`Cron live execution paused: ${pauseCheck.reason}`);
        isRunning = false;
        return;
      }

      // 4. If no open live position, check entry eligibility
      const livePositions = db.getOpenPositions('LIVE');
      if (livePositions.length === 0) {
        await strategyEngine.executeEntryIfEligible();
      }

    } catch (err: any) {
      logger.error('Error in cron job execution', { error: err.message });
    } finally {
      isRunning = false;
    }
  });

  logger.info('Cron Scheduler initialized (Running strategy engine check every 60 seconds)');
}

export function stopCronScheduler() {
  if (cronTask) {
    cronTask.stop();
    logger.info('Cron Scheduler stopped');
  }
}
