import { db } from './db.js';
import { marketDataService } from './marketDataService.js';
import { fyersService } from './fyersService.js';
import { riskService } from './riskService.js';
import { notificationService } from './notificationService.js';
import { logger } from './logger.js';
import { Position, Leg, Order, AdjustmentLog } from './types.js';
import { getNearestExpiryForSymbol, getLotSizeForSymbol, getFyersSymbolPrefix, parseFyersOptionSymbol, detectOptionStrategy } from './expiryService.js';
import { opportunityScanner } from './opportunityScanner.js';

export class StrategyEngine {
  /**
   * Evaluates market and creates a new Short Straddle entry if conditions allow
   */
  public async executeEntryIfEligible(): Promise<{ success: boolean; position?: Position; message: string }> {
    const settings = db.getSettings();

    // Check market hours for live mode
    if (settings.mode === 'LIVE' && !marketDataService.isMarketOpen()) {
      return { success: false, message: 'NSE Derivatives Market is currently closed (Trading Hours: 09:15 AM - 03:30 PM IST, Mon-Fri). Live execution paused outside market hours.' };
    }

    // 1. Check Risk Controls
    const pauseCheck = riskService.shouldPauseTrading();
    if (pauseCheck.pause) {
      logger.warn(`Trade entry skipped: ${pauseCheck.reason}`);
      return { success: false, message: pauseCheck.reason || 'Trading paused by risk controls' };
    }

    // 2. Check if open position already exists
    const openPositions = db.getOpenPositions();
    if (openPositions.length > 0) {
      return { success: false, message: 'Position already open. Only 1 active position allowed per strategy instance.' };
    }

    // 3. Get Current Spot Price
    const spotPrice = await marketDataService.getLTP(settings.indexSymbol);
    const upperSym = (settings.indexSymbol || '').toUpperCase();
    const strikeStep = (upperSym.includes('BANK') || upperSym.includes('SENSEX')) ? 100 : 50;
    const atmStrike = Math.round(spotPrice / strikeStep) * strikeStep;

    // Golden Rule for Short Straddle: Strikes MUST be At-The-Money (ATM)
    const callStrike = atmStrike;
    const putStrike = atmStrike;

    const expiryInfo = getNearestExpiryForSymbol(settings.indexSymbol);
    const dateCode = expiryInfo.fyersSymbolDateCode;
    const cleanSym = getFyersSymbolPrefix(settings.indexSymbol);

    const callSymbol = `NSE:${cleanSym}${dateCode}${callStrike}CE`;
    const putSymbol = `NSE:${cleanSym}${dateCode}${putStrike}PE`;

    // Fetch initial LTPs for option legs
    const callPrice = await marketDataService.getLTP(callSymbol);
    const putPrice = await marketDataService.getLTP(putSymbol);

    const lotSize = getLotSizeForSymbol(settings.indexSymbol);
    const numberOfLots = Math.max(1, Math.round((settings.defaultQuantity || lotSize) / lotSize));
    const qty = numberOfLots * lotSize;

    // 4. Check available capital allocation requirement before taking position
    const estimatedRequiredMargin = 145000 * numberOfLots;
    const capitalCheck = riskService.checkCapitalRequirement(estimatedRequiredMargin, numberOfLots);
    if (!capitalCheck.isAllowed) {
      logger.warn(`Entry rejected due to capital allocation limit: ${capitalCheck.reason}`);
      return { success: false, message: capitalCheck.reason || 'Insufficient allocated capital for strategy' };
    }

    // 5. Check trade risk limit
    const estimatedMaxRisk = (callPrice + putPrice) * qty * 1.5; // Estimated risk before wings
    const riskCheck = riskService.checkTradeRisk(estimatedMaxRisk);
    if (!riskCheck.isAllowed) {
      logger.warn(`Entry rejected by trade risk manager: ${riskCheck.reason}`);
      return { success: false, message: riskCheck.reason || 'Trade risk limit exceeded' };
    }

    // 6. Create SELL Orders
    const positionId = `pos_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

    const ceOrder: Order = {
      id: `ord_ce_${Date.now()}`,
      positionId,
      symbol: callSymbol,
      side: 'SELL',
      qty,
      price: callPrice,
      executedPrice: callPrice,
      status: 'FILLED',
      type: 'MARKET',
      mode: settings.mode,
      timestamp: new Date().toISOString()
    };

    const peOrder: Order = {
      id: `ord_pe_${Date.now()}`,
      positionId,
      symbol: putSymbol,
      side: 'SELL',
      qty,
      price: putPrice,
      executedPrice: putPrice,
      status: 'FILLED',
      type: 'MARKET',
      mode: settings.mode,
      timestamp: new Date().toISOString()
    };

    // If LIVE mode, execute orders via FYERS API (Abort if order fails)
    if (settings.mode === 'LIVE') {
      try {
        const ceRes = await fyersService.placeOrder({
          symbol: callSymbol,
          qty,
          side: 'SELL',
          type: 'MARKET',
          productType: 'INTRADAY'
        });
        if (ceRes && (ceRes.id || ceRes.order_id)) {
          ceOrder.fyersOrderId = ceRes.id || ceRes.order_id;
        } else {
          throw new Error(`FYERS rejected CE order: ${JSON.stringify(ceRes)}`);
        }

        const peRes = await fyersService.placeOrder({
          symbol: putSymbol,
          qty,
          side: 'SELL',
          type: 'MARKET',
          productType: 'INTRADAY'
        });
        if (peRes && (peRes.id || peRes.order_id)) {
          peOrder.fyersOrderId = peRes.id || peRes.order_id;
        } else {
          throw new Error(`FYERS rejected PE order: ${JSON.stringify(peRes)}`);
        }

        logger.success(`FYERS Live Short Straddle Orders Executed: ${callSymbol} & ${putSymbol} (Qty: ${qty})`);
      } catch (err: any) {
        const errMsg = err?.message || String(err);
        logger.error(`Error placing FYERS Live Short Straddle order: ${errMsg}`);
        return {
          success: false,
          message: `Live Order Placement Failed on FYERS API: ${errMsg}. Position was NOT created.`
        };
      }
    }

    db.addOrder(ceOrder);
    db.addOrder(peOrder);

    // 6. Build initial Short Straddle position
    const legs: Leg[] = [
      {
        id: `leg_ce_${Date.now()}`,
        symbol: callSymbol,
        type: 'CE',
        strike: callStrike,
        side: 'SELL',
        qty,
        entryPrice: callPrice,
        currentPrice: callPrice,
        pnl: 0,
        isWing: false
      },
      {
        id: `leg_pe_${Date.now()}`,
        symbol: putSymbol,
        type: 'PE',
        strike: putStrike,
        side: 'SELL',
        qty,
        entryPrice: putPrice,
        currentPrice: putPrice,
        pnl: 0,
        isWing: false
      }
    ];

    const newPosition: Position = {
      id: positionId,
      strategy: 'SHORT_STRADDLE',
      symbol: settings.indexSymbol,
      indexEntryPrice: spotPrice,
      currentIndexPrice: spotPrice,
      status: 'OPEN',
      legs,
      totalPnl: 0,
      maxRisk: Math.round(estimatedMaxRisk),
      maxReward: Math.round((callPrice + putPrice) * qty),
      entryTime: new Date().toISOString(),
      updatedTime: new Date().toISOString(),
      adjustmentCount: 0,
      wingsAdded: false,
      mode: settings.mode,
      source: settings.mode === 'LIVE' ? 'BOT_EXECUTED' : 'PAPER'
    };

    db.savePosition(newPosition);

    // Log to trade log
    db.addTradeLog({
      action: 'ENTRY',
      symbol: settings.indexSymbol,
      strategy: 'SHORT_STRADDLE',
      price: spotPrice,
      quantity: qty,
      pnl: 0,
      mode: settings.mode,
      notes: `Opened Short Straddle at Spot ${spotPrice}. CE Short: ${callStrike} @ ₹${callPrice}, PE Short: ${putStrike} @ ₹${putPrice}`
    });

    logger.success(`NEW POSITION OPENED [Short Straddle]`, {
      positionId,
      spotPrice,
      callStrike,
      putStrike,
      mode: settings.mode
    });

    await notificationService.notify(
      `New Short Straddle Opened (${settings.mode} MODE)`,
      `Spot: ₹${spotPrice}\nCE Sell: ${callStrike} @ ₹${callPrice}\nPE Sell: ${putStrike} @ ₹${putPrice}\nQuantity: ${qty}`,
      'TRADE'
    );

    return { success: true, position: newPosition, message: 'Short Straddle opened successfully' };
  }

  /**
   * Calculates dynamic position Greeks (Delta & Theta) and average ATM entry premium
   */
  public calculatePositionGreeks(position: Position, currentSpot: number): {
    avgAtmPremium: number;
    netDelta: number;
    netTheta: number;
    deltaImbalance: number;
    legGreeks: Array<{ legId: string; symbol: string; type: string; side: string; delta: number; theta: number }>;
  } {
    const ceShort = position.legs.find(l => (l.type === 'CE' || (l as any).optionType === 'CE') && l.side === 'SELL') ||
                    position.legs.find(l => l.type === 'CE' || (l as any).optionType === 'CE');
    const peShort = position.legs.find(l => (l.type === 'PE' || (l as any).optionType === 'PE') && l.side === 'SELL') ||
                    position.legs.find(l => l.type === 'PE' || (l as any).optionType === 'PE');

    let avgAtmPremium = 200;
    if (ceShort && peShort && ceShort.entryPrice > 0 && peShort.entryPrice > 0) {
      avgAtmPremium = Math.round((ceShort.entryPrice + peShort.entryPrice) / 2);
    } else if (position.initialCombinedPremium && position.initialCombinedPremium > 0) {
      avgAtmPremium = Math.round(position.initialCombinedPremium / 2);
    } else if (ceShort && ceShort.entryPrice > 0) {
      avgAtmPremium = Math.round(ceShort.entryPrice);
    } else if (peShort && peShort.entryPrice > 0) {
      avgAtmPremium = Math.round(peShort.entryPrice);
    }

    if (avgAtmPremium <= 0) avgAtmPremium = 200;

    let netDelta = 0;
    let netTheta = 0;
    const legGreeks: Array<{ legId: string; symbol: string; type: string; side: string; delta: number; theta: number }> = [];

    for (const leg of position.legs) {
      const strike = leg.strike || Math.round(currentSpot / 100) * 100;
      const optionType = leg.type || (leg as any).optionType || 'CE';
      const side = leg.side || 'SELL';
      const qty = leg.qty || 65;
      const lots = Math.max(1, qty / 65);

      // Moneyness approximation for options
      const moneyness = (currentSpot - strike) / (2 * Math.max(avgAtmPremium, 40));

      let rawDelta = 0;
      if (optionType === 'CE') {
        rawDelta = Math.max(0, Math.min(1, 0.5 + moneyness));
      } else {
        rawDelta = Math.max(-1, Math.min(0, -0.5 + moneyness));
      }

      // Position Delta: Short Call = negative delta, Short Put = positive delta
      // Long Call = positive delta, Long Put = negative delta
      const legDelta = (side === 'BUY' ? 1 : -1) * lots * rawDelta;

      // Position Theta: Short options earn positive daily theta decay
      const price = leg.currentPrice || leg.entryPrice || 100;
      const rawThetaPerUnit = Math.max(2, price * 0.08);
      const legTheta = (side === 'SELL' ? 1 : -1) * qty * rawThetaPerUnit;

      netDelta += legDelta;
      netTheta += legTheta;

      legGreeks.push({
        legId: leg.id,
        symbol: leg.symbol,
        type: optionType,
        side,
        delta: Math.round(legDelta * 100) / 100,
        theta: Math.round(legTheta)
      });
    }

    const roundedNetDelta = Math.round(netDelta * 100) / 100;
    const roundedNetTheta = Math.round(netTheta);

    return {
      avgAtmPremium,
      netDelta: roundedNetDelta,
      netTheta: roundedNetTheta,
      deltaImbalance: Math.abs(roundedNetDelta),
      legGreeks
    };
  }

  /**
   * Monitor open positions & execute Golden Rule adjustments
   */
  public async monitorAndAdjustPositions(): Promise<{ checked: number; adjusted: number }> {
    const allPositions = db.getPositions();
    const openPositions = allPositions.filter(p => p.status === 'OPEN' || p.status === 'ADJUSTED');
    if (openPositions.length === 0) {
      return { checked: 0, adjusted: 0 };
    }

    const settings = db.getSettings();
    let adjustedCount = 0;

    for (const position of openPositions) {
      const currentSpot = await marketDataService.getLTP(position.symbol);
      position.currentIndexPrice = currentSpot;

      // Update Leg LTPs and leg P&L
      let totalPnl = 0;
      for (const leg of position.legs) {
        const cachedLtp = fyersService.getCacheLTP(leg.symbol);
        const cachedPl = fyersService.getCachePL(leg.symbol);

        if (cachedLtp && cachedLtp > 0) {
          leg.currentPrice = cachedLtp;
        } else {
          leg.currentPrice = await marketDataService.getLTP(leg.symbol);
        }

        if (typeof cachedPl === 'number') {
          leg.pnl = Math.round(cachedPl);
        } else if (leg.side === 'SELL') {
          // Short position P&L: (Entry - Current) * Qty
          leg.pnl = Math.round((leg.entryPrice - leg.currentPrice) * leg.qty);
        } else {
          // Long wing position P&L: (Current - Entry) * Qty
          leg.pnl = Math.round((leg.currentPrice - leg.entryPrice) * leg.qty);
        }
        totalPnl += leg.pnl;
      }

      position.totalPnl = Math.round(totalPnl);
      position.updatedTime = new Date().toISOString();

      // Calculate position Greeks and dynamic ATM premium threshold
      const greeks = this.calculatePositionGreeks(position, currentSpot);
      const priceMovement = Math.abs(currentSpot - position.indexEntryPrice);
      const moveThreshold = greeks.avgAtmPremium;

      logger.info(`Monitoring Position ${position.id}`, {
        spot: currentSpot,
        entrySpot: position.indexEntryPrice,
        movement: priceMovement,
        avgAtmThreshold: moveThreshold,
        netDelta: greeks.netDelta,
        netTheta: greeks.netTheta,
        pnl: position.totalPnl,
        wingsAdded: position.wingsAdded
      });

      // -------------------------------------------------------------
      // CORE ADJUSTMENT RULES BASED ON STRATEGY TYPE
      // -------------------------------------------------------------
      // Skip fixed arbitrage strategies (Cash & Carry, Synthetic Arbitrage) as they carry locked spread P&L
      if (position.strategy.includes('ARBITRAGE')) {
        // No option wing adjustments needed for fixed arbitrage positions
      } else if (position.strategy === 'IRON_FLY_BREAKEVEN') {
        const isFlyAdjusted = await this.adjustIronFlyPosition(position, currentSpot);
        if (isFlyAdjusted) adjustedCount++;
      } else if (position.strategy === 'MONTHLY_SHORT_STRADDLE') {
        const isStraddleAdjusted = await this.adjustMonthlyStraddlePosition(position, currentSpot);
        if (isStraddleAdjusted) adjustedCount++;
      } else if (position.strategy === 'IRON_CONDOR') {
        const isCondorAdjusted = await this.adjustClassicIronCondorPosition(position, currentSpot);
        if (isCondorAdjusted) adjustedCount++;
      } else if ((position.strategy === 'SHORT_STRADDLE' || position.strategy === 'SHORT_STRANGLE') && !position.wingsAdded) {
        // Golden Rule trigger: require spot movement >= 25 pts AND (priceMovement >= avg ATM premium OR delta skew)
        const isTriggered = priceMovement >= 25 && (priceMovement >= moveThreshold || (priceMovement >= moveThreshold * 0.6 && greeks.deltaImbalance >= 0.35));

        if (isTriggered) {
          // RULE 1: Price moved >= avg ATM premium and trade is IN PROFIT (P&L > 0)
          // -> Add Wings (Convert Short Straddle to Iron Condor)
          if (position.totalPnl > 0) {
            logger.info(`GOLDEN RULE TRIGGERED: Movement ${priceMovement} pts >= Threshold (${moveThreshold} pts) / Delta Imbalance (${greeks.netDelta}) AND P&L (₹${position.totalPnl}) > 0. Adding protective wings!`);
            
            await this.addWingsToPosition(position, currentSpot);
            adjustedCount++;
          } 
          
          // RULE 2: Price moved >= avg ATM premium and trade is IN LOSS (P&L <= 0)
          // -> Do NOT add wings. Roll losing side / execute Scenario 3 delta hedge to manage risk.
          else if (position.totalPnl <= 0) {
            logger.warn(`DEFENSIVE ADJUSTMENT TRIGGERED: Movement ${priceMovement} pts >= Threshold (${moveThreshold} pts) / Delta Imbalance (${greeks.netDelta}) BUT P&L (₹${position.totalPnl}) <= 0. NO WINGS ADDED per Golden Rule!`);
            
            await this.executeDefensiveRoll(position, currentSpot);
            adjustedCount++;
          }
        }
      }

      // Save updated position state
      db.savePosition(position);
    }

    return { checked: openPositions.length, adjusted: adjustedCount };
  }

  /**
   * Action: Add protective OTM Wings (BUY Call & BUY Put) when P&L is POSITIVE
   * Converts Short Straddle into Iron Condor to lock in profits!
   */
  private async addWingsToPosition(position: Position, currentSpot: number) {
    const settings = db.getSettings();

    // Find the original Short strikes
    const ceShort = position.legs.find(l => l.type === 'CE' && l.side === 'SELL');
    const peShort = position.legs.find(l => l.type === 'PE' && l.side === 'SELL');

    if (!ceShort || !peShort) return;

    // Wing strikes are placed further OTM by wingBuffer (e.g., 300 pts beyond short strikes)
    const wingCeStrike = ceShort.strike + settings.wingBuffer;
    const wingPeStrike = peShort.strike - settings.wingBuffer;

    const expiryInfo = getNearestExpiryForSymbol(position.symbol || settings.indexSymbol);
    const dateCode = expiryInfo.fyersSymbolDateCode;
    const cleanSym = getFyersSymbolPrefix(position.symbol || settings.indexSymbol);

    const wingCeSymbol = `NSE:${cleanSym}${dateCode}${wingCeStrike}CE`;
    const wingPeSymbol = `NSE:${cleanSym}${dateCode}${wingPeStrike}PE`;

    const wingCePrice = await marketDataService.getLTP(wingCeSymbol);
    const wingPePrice = await marketDataService.getLTP(wingPeSymbol);

    const qty = settings.defaultQuantity;

    // Place BUY Orders for wings
    const wingCeOrder: Order = {
      id: `ord_wing_ce_${Date.now()}`,
      positionId: position.id,
      symbol: wingCeSymbol,
      side: 'BUY',
      qty,
      price: wingCePrice,
      executedPrice: wingCePrice,
      status: 'FILLED',
      type: 'MARKET',
      mode: settings.mode,
      timestamp: new Date().toISOString()
    };

    const wingPeOrder: Order = {
      id: `ord_wing_pe_${Date.now()}`,
      positionId: position.id,
      symbol: wingPeSymbol,
      side: 'BUY',
      qty,
      price: wingPePrice,
      executedPrice: wingPePrice,
      status: 'FILLED',
      type: 'MARKET',
      mode: settings.mode,
      timestamp: new Date().toISOString()
    };

    db.addOrder(wingCeOrder);
    db.addOrder(wingPeOrder);

    // Add wing legs to position
    position.legs.push({
      id: `leg_wing_ce_${Date.now()}`,
      symbol: wingCeSymbol,
      type: 'CE',
      strike: wingCeStrike,
      side: 'BUY',
      qty,
      entryPrice: wingCePrice,
      currentPrice: wingCePrice,
      pnl: 0,
      isWing: true
    });

    position.legs.push({
      id: `leg_wing_pe_${Date.now()}`,
      symbol: wingPeSymbol,
      type: 'PE',
      strike: wingPeStrike,
      side: 'BUY',
      qty,
      entryPrice: wingPePrice,
      currentPrice: wingPePrice,
      pnl: 0,
      isWing: true
    });

    (position as any).originalStrategy = (position as any).originalStrategy || position.strategy;
    position.strategy = 'IRON_CONDOR';
    position.status = 'ADJUSTED';
    position.wingsAdded = true;
    position.adjustmentCount += 1;

    // Record adjustment log
    const adjLog: AdjustmentLog = {
      id: `adj_${Date.now()}`,
      positionId: position.id,
      timestamp: new Date().toISOString(),
      conditionTriggered: 'Price moved > 200 pts and P&L is POSITIVE',
      pnlAtAdjustment: position.totalPnl,
      indexPriceAtAdjustment: currentSpot,
      actionTaken: 'ADD_WINGS_IRON_CONDOR',
      wingsAdded: true,
      details: `Added Call Wing (${wingCeStrike} @ ₹${wingCePrice}) and Put Wing (${wingPeStrike} @ ₹${wingPePrice}). Converted to Iron Condor!`,
      mode: settings.mode
    };

    db.addAdjustment(adjLog);

    db.addTradeLog({
      action: 'WING_ADDITION',
      symbol: position.symbol,
      strategy: 'IRON_CONDOR',
      price: currentSpot,
      quantity: qty,
      pnl: position.totalPnl,
      mode: settings.mode,
      notes: `Golden Rule Applied: P&L positive (₹${position.totalPnl}). Added protective wings at ${wingCeStrike} CE & ${wingPeStrike} PE.`
    });

    logger.success(`WINGS ADDED! Position converted to IRON CONDOR`, {
      positionId: position.id,
      pnl: position.totalPnl,
      wingCeStrike,
      wingPeStrike
    });

    await notificationService.notify(
      'GOLDEN RULE: Wings Added (Iron Condor Converted)',
      `Position ID: ${position.id}\nSpot: ₹${currentSpot}\nCurrent P&L: ₹${position.totalPnl} (POSITIVE)\nAdded Call Wing: ${wingCeStrike}\nAdded Put Wing: ${wingPeStrike}`,
      'ADJUSTMENT'
    );
  }

  /**
   * Action: Execute defensive roll when P&L is NEGATIVE and price moved > Avg ATM Premium
   * Golden Rule: NO WINGS ADDED! Roll winning (untested) side closer to ATM to capture premium and rebalance delta.
   */
  private async executeDefensiveRoll(position: Position, currentSpot: number) {
    const settings = db.getSettings();
    const greeks = this.calculatePositionGreeks(position, currentSpot);

    // Upward move: Spot went UP -> CE is losing, PE is winning (positive P&L on PE)
    // Downward move: Spot went DOWN -> PE is losing, CE is winning (positive P&L on CE)
    const isUpMove = currentSpot > position.indexEntryPrice;
    const losingSideType: 'CE' | 'PE' = isUpMove ? 'CE' : 'PE';
    const winningSideType: 'CE' | 'PE' = isUpMove ? 'PE' : 'CE';

    // Find the winning short leg
    const winningLegIndex = position.legs.findIndex(l => l.type === winningSideType && l.side === 'SELL' && !l.isWing);
    const winningLeg = winningLegIndex >= 0 ? position.legs[winningLegIndex] : null;

    let rollDetails = '';

    if (winningLeg) {
      const exitPrice = await marketDataService.getLTP(winningLeg.symbol);
      const realizedLegPnl = Math.round((winningLeg.entryPrice - exitPrice) * winningLeg.qty);

      // 1. Buy back the winning leg
      db.addOrder({
        id: `ord_roll_close_${Date.now()}`,
        positionId: position.id,
        symbol: winningLeg.symbol,
        side: 'BUY',
        qty: winningLeg.qty,
        price: exitPrice,
        executedPrice: exitPrice,
        status: 'FILLED',
        type: 'MARKET',
        mode: settings.mode,
        timestamp: new Date().toISOString()
      });

      if (settings.mode === 'LIVE') {
        await fyersService.placeOrder({
          symbol: winningLeg.symbol,
          qty: winningLeg.qty,
          side: 1, // BUY to close short
          type: 2,
          productType: 'INTRADAY'
        }).catch(err => logger.error(`FYERS Live roll close order error: ${err.message}`));
      }

      // 2. Calculate new rolled strike closer to current spot
      const expiryInfo = getNearestExpiryForSymbol(position.symbol || settings.indexSymbol);
      const dateCode = expiryInfo.fyersSymbolDateCode;
      const cleanSym = getFyersSymbolPrefix(position.symbol || settings.indexSymbol);
      const step = (cleanSym === 'NIFTY' || cleanSym === 'FINNIFTY') ? 50 : 100;
      const atm = Math.round(currentSpot / step) * step;

      // Move new winning strike closer to ATM
      // If market went UP: winning side was PE. Roll to higher PE closer to ATM (atm - step)
      // If market went DOWN: winning side was CE. Roll to lower CE closer to ATM (atm + step)
      const newRolledStrike = winningSideType === 'PE' ? atm - step : atm + step;
      const newRolledSymbol = `NSE:${cleanSym}${dateCode}${newRolledStrike}${winningSideType}`;
      const newRolledPrice = await marketDataService.getLTP(newRolledSymbol);

      // 3. Place SELL order for new rolled leg
      db.addOrder({
        id: `ord_roll_open_${Date.now()}`,
        positionId: position.id,
        symbol: newRolledSymbol,
        side: 'SELL',
        qty: winningLeg.qty,
        price: newRolledPrice,
        executedPrice: newRolledPrice,
        status: 'FILLED',
        type: 'MARKET',
        mode: settings.mode,
        timestamp: new Date().toISOString()
      });

      if (settings.mode === 'LIVE') {
        await fyersService.placeOrder({
          symbol: newRolledSymbol,
          qty: winningLeg.qty,
          side: -1, // SELL to open new short
          type: 2,
          productType: 'INTRADAY'
        }).catch(err => logger.error(`FYERS Live roll open order error: ${err.message}`));
      }

      // Update position leg
      winningLeg.symbol = newRolledSymbol;
      winningLeg.strike = newRolledStrike;
      winningLeg.entryPrice = newRolledPrice;
      winningLeg.currentPrice = newRolledPrice;
      winningLeg.pnl = 0;

      rollDetails = `Closed winning ${winningSideType} leg at ₹${exitPrice} (Realized +₹${realizedLegPnl}) & rolled ${winningSideType} closer to ATM at strike ${newRolledStrike} @ ₹${newRolledPrice}. Rebalanced Delta!`;
    } else {
      rollDetails = `No active winning ${winningSideType} leg found to roll.`;
    }

    position.adjustmentCount += 1;
    position.status = 'ADJUSTED';

    const adjLog: AdjustmentLog = {
      id: `adj_${Date.now()}`,
      positionId: position.id,
      timestamp: new Date().toISOString(),
      conditionTriggered: `Spot moved >= Avg ATM Premium (${greeks.avgAtmPremium} pts) / Delta Imbalance (${greeks.netDelta}) and P&L is NEGATIVE (₹${position.totalPnl})`,
      pnlAtAdjustment: position.totalPnl,
      indexPriceAtAdjustment: currentSpot,
      actionTaken: 'DEFENSIVE_ROLL_WINNING_SIDE',
      wingsAdded: false,
      details: `Golden Rule Enforced: Wings CANNOT be added because trade is in loss (₹${position.totalPnl}). Net Delta: ${greeks.netDelta}. ${rollDetails}`,
      mode: settings.mode
    };

    db.addAdjustment(adjLog);

    db.addTradeLog({
      action: 'DEFENSIVE_ROLL',
      symbol: position.symbol,
      strategy: position.strategy,
      price: currentSpot,
      quantity: settings.defaultQuantity,
      pnl: position.totalPnl,
      mode: settings.mode,
      notes: `Defensive Roll executed: Rolled winning ${winningSideType} leg closer to ATM. ${rollDetails}`
    });

    logger.warn(`DEFENSIVE ROLL EXECUTED`, {
      positionId: position.id,
      pnl: position.totalPnl,
      losingSideType,
      winningSideType,
      netDelta: greeks.netDelta,
      rollDetails
    });

    await notificationService.notify(
      `DEFENSIVE ADJUSTMENT: Rolled Winning ${winningSideType} Leg (No Wings)`,
      `Position ID: ${position.id}\nSpot: ₹${currentSpot}\nCurrent P&L: ₹${position.totalPnl} (NEGATIVE)\nNet Delta: ${greeks.netDelta}\n${rollDetails}`,
      'ADJUSTMENT'
    );
  }

  /**
   * Square off active position
   */
  public async closePosition(positionId: string, reason: string = 'MANUAL_SQUARE_OFF'): Promise<{ success: boolean; position?: Position }> {
    const positions = db.getPositions();
    const position = positions.find(p => p.id === positionId && p.status !== 'CLOSED');

    if (!position) {
      return { success: false };
    }

    const currentSpot = await marketDataService.getLTP(position.symbol);

    // Close all open legs with opposite market orders
    let finalPnl = 0;
    for (const leg of position.legs) {
      leg.currentPrice = await marketDataService.getLTP(leg.symbol);
      const exitSide = leg.side === 'SELL' ? 'BUY' : 'SELL';

      const exitOrder: Order = {
        id: `ord_exit_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`,
        positionId: position.id,
        symbol: leg.symbol,
        side: exitSide,
        qty: leg.qty,
        price: leg.currentPrice,
        executedPrice: leg.currentPrice,
        status: 'FILLED',
        type: 'MARKET',
        mode: position.mode,
        timestamp: new Date().toISOString()
      };

      db.addOrder(exitOrder);

      // If LIVE position, close the live leg on Fyers broker terminal
      if (position.mode === 'LIVE') {
        try {
          await fyersService.placeOrder({
            symbol: leg.symbol,
            qty: leg.qty,
            side: exitSide,
            type: 'MARKET',
            productType: 'INTRADAY'
          });
          logger.success(`Live FYERS Exit Order Placed for ${leg.symbol} ${exitSide} x ${leg.qty}`);
        } catch (fyersExitErr) {
          logger.warn(`Notice while placing exit order on Fyers for ${leg.symbol}:`, fyersExitErr);
        }
      }

      if (leg.side === 'SELL') {
        leg.pnl = Math.round((leg.entryPrice - leg.currentPrice) * leg.qty);
      } else {
        leg.pnl = Math.round((leg.currentPrice - leg.entryPrice) * leg.qty);
      }
      finalPnl += leg.pnl;
    }

    position.status = 'CLOSED';
    position.totalPnl = Math.round(finalPnl);
    position.exitTime = new Date().toISOString();
    position.exitReason = reason;

    db.savePosition(position);

    db.addTradeLog({
      action: finalPnl >= 0 ? 'EXIT_PROFIT' : 'EXIT_STOPLOSS',
      symbol: position.symbol,
      strategy: position.strategy,
      price: currentSpot,
      quantity: db.getSettings().defaultQuantity,
      pnl: position.totalPnl,
      mode: position.mode,
      notes: `Closed position ${position.id}. Reason: ${reason}. Final P&L: ₹${position.totalPnl}`
    });

    logger.info(`POSITION CLOSED [${position.id}]`, { finalPnl: position.totalPnl, reason });

    await notificationService.notify(
      `Position Closed (${reason})`,
      `Position ID: ${position.id}\nFinal P&L: ₹${position.totalPnl}\nStrategy: ${position.strategy}`,
      finalPnl >= 0 ? 'TRADE' : 'WARNING'
    );

    return { success: true, position };
  }

  /**
   * Executes a specific identified opportunity (Iron Condor, Short Straddle, Arbitrage)
   */
  public async executeOpportunityById(oppType: string, customMode?: TradingMode): Promise<{ success: boolean; position?: Position; message: string }> {
    const settings = db.getSettings();
    const effectiveMode: TradingMode = customMode || settings.mode;

    // Check market hours for live mode
    if (effectiveMode === 'LIVE' && !marketDataService.isMarketOpen()) {
      return { success: false, message: 'NSE Derivatives Market is currently closed (Trading Hours: 09:15 AM - 03:30 PM IST, Mon-Fri). Live execution paused outside market hours.' };
    }

    // Check Risk Controls
    const pauseCheck = riskService.shouldPauseTrading();
    if (pauseCheck.pause) {
      return { success: false, message: pauseCheck.reason || 'Trading paused by risk controls' };
    }

    // Check if an active open position already exists in THIS SPECIFIC MODE
    const openPositions = db.getOpenPositions(effectiveMode);
    const existingPosition = openPositions.find(p => (p.status === 'OPEN' || p.status === 'ADJUSTED') && p.strategy === oppType && (p.mode === effectiveMode));
    if (existingPosition) {
      return {
        success: false,
        message: `Strategy ${oppType} (${effectiveMode} mode) is already in-trade (Position ID: ${existingPosition.id}). Duplicate execution prevented.`
      };
    }

    const symbol = settings.indexSymbol || 'NSE:NIFTY50-INDEX';
    const spotPrice = await marketDataService.getLTP(symbol);
    const upperSym = symbol.toUpperCase();
    const strikeStep = (upperSym.includes('BANK') || upperSym.includes('SENSEX')) ? 100 : 50;
    const atmStrike = Math.round(spotPrice / strikeStep) * strikeStep;

    const expiryInfo = getNearestExpiryForSymbol(symbol);
    const dateCode = expiryInfo.fyersSymbolDateCode;
    const cleanSym = symbol.replace('NSE:', '').replace('BSE:', '').replace('-INDEX', '').replace('-EQ', '');

    const lotSize = getLotSizeForSymbol(symbol);
    const numberOfLots = Math.max(1, Math.round((settings.defaultQuantity || lotSize) / lotSize));
    const qty = numberOfLots * lotSize;

    const positionId = `pos_opp_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`;

    let strategyName = oppType;
    let legs: Leg[] = [];

    if (oppType === 'IRON_CONDOR') {
      const ceShortStrike = atmStrike + (settings.strikeDistance || 500);
      const peShortStrike = atmStrike - (settings.strikeDistance || 500);
      const ceBuyStrike = ceShortStrike + (settings.wingBuffer || 300);
      const peBuyStrike = peShortStrike - (settings.wingBuffer || 300);

      const ceShortSymbol = `NSE:${cleanSym}${dateCode}${ceShortStrike}CE`;
      const peShortSymbol = `NSE:${cleanSym}${dateCode}${peShortStrike}PE`;
      const ceBuySymbol = `NSE:${cleanSym}${dateCode}${ceBuyStrike}CE`;
      const peBuySymbol = `NSE:${cleanSym}${dateCode}${peBuyStrike}PE`;

      const p1 = await marketDataService.getLTP(ceShortSymbol);
      const p2 = await marketDataService.getLTP(peShortSymbol);
      const p3 = await marketDataService.getLTP(ceBuySymbol);
      const p4 = await marketDataService.getLTP(peBuySymbol);

      legs = [
        { id: `leg_1_${Date.now()}`, symbol: ceShortSymbol, type: 'CE', strike: ceShortStrike, side: 'SELL', qty, entryPrice: p1, currentPrice: p1, pnl: 0, isWing: false },
        { id: `leg_2_${Date.now()}`, symbol: peShortSymbol, type: 'PE', strike: peShortStrike, side: 'SELL', qty, entryPrice: p2, currentPrice: p2, pnl: 0, isWing: false },
        { id: `leg_3_${Date.now()}`, symbol: ceBuySymbol, type: 'CE', strike: ceBuyStrike, side: 'BUY', qty, entryPrice: p3, currentPrice: p3, pnl: 0, isWing: true },
        { id: `leg_4_${Date.now()}`, symbol: peBuySymbol, type: 'PE', strike: peBuyStrike, side: 'BUY', qty, entryPrice: p4, currentPrice: p4, pnl: 0, isWing: true }
      ];
      strategyName = 'IRON_CONDOR';
    } else if (oppType === 'SHORT_STRADDLE') {
      const ceSymbol = `NSE:${cleanSym}${dateCode}${atmStrike}CE`;
      const peSymbol = `NSE:${cleanSym}${dateCode}${atmStrike}PE`;

      const p1 = await marketDataService.getLTP(ceSymbol);
      const p2 = await marketDataService.getLTP(peSymbol);

      legs = [
        { id: `leg_1_${Date.now()}`, symbol: ceSymbol, type: 'CE', strike: atmStrike, side: 'SELL', qty, entryPrice: p1, currentPrice: p1, pnl: 0, isWing: false },
        { id: `leg_2_${Date.now()}`, symbol: peSymbol, type: 'PE', strike: atmStrike, side: 'SELL', qty, entryPrice: p2, currentPrice: p2, pnl: 0, isWing: false }
      ];
      strategyName = 'SHORT_STRADDLE';
    } else if (oppType === 'CASH_CARRY_ARBITRAGE') {
      const futSymbol = `NSE:${cleanSym}${dateCode}FUT`;
      const spotSymbol = `${symbol}-SPOT`;
      const futPrice = Math.round(spotPrice + 68);

      legs = [
        { id: `leg_1_${Date.now()}`, symbol: spotSymbol, type: 'EQUITY', side: 'BUY', qty, entryPrice: spotPrice, currentPrice: spotPrice, pnl: 0, isWing: false },
        { id: `leg_2_${Date.now()}`, symbol: futSymbol, type: 'FUT', side: 'SELL', qty, entryPrice: futPrice, currentPrice: futPrice, pnl: 0, isWing: false }
      ];
      strategyName = 'CASH_CARRY_ARBITRAGE';
    } else if (oppType === 'SYNTHETIC_ARBITRAGE') {
      const ceSymbol = `NSE:${cleanSym}${dateCode}${atmStrike}CE`;
      const peSymbol = `NSE:${cleanSym}${dateCode}${atmStrike}PE`;
      const futSymbol = `NSE:${cleanSym}${dateCode}FUT`;

      const p1 = await marketDataService.getLTP(ceSymbol);
      const p2 = await marketDataService.getLTP(peSymbol);
      const p3 = Math.round(spotPrice + 68);

      legs = [
        { id: `leg_1_${Date.now()}`, symbol: ceSymbol, type: 'CE', strike: atmStrike, side: 'BUY', qty, entryPrice: p1, currentPrice: p1, pnl: 0, isWing: false },
        { id: `leg_2_${Date.now()}`, symbol: peSymbol, type: 'PE', strike: atmStrike, side: 'SELL', qty, entryPrice: p2, currentPrice: p2, pnl: 0, isWing: false },
        { id: `leg_3_${Date.now()}`, symbol: futSymbol, type: 'FUT', side: 'SELL', qty, entryPrice: p3, currentPrice: p3, pnl: 0, isWing: false }
      ];
      strategyName = 'SYNTHETIC_ARBITRAGE';
    } else if (oppType === 'IRON_FLY_BREAKEVEN') {
      const ceSymbol = `NSE:${cleanSym}${dateCode}${atmStrike}CE`;
      const peSymbol = `NSE:${cleanSym}${dateCode}${atmStrike}PE`;

      const p1 = await marketDataService.getLTP(ceSymbol);
      const p2 = await marketDataService.getLTP(peSymbol);
      const totalPremium = p1 + p2;

      const upperBeStrike = Math.round((atmStrike + totalPremium) / strikeStep) * strikeStep;
      const lowerBeStrike = Math.round((atmStrike - totalPremium) / strikeStep) * strikeStep;

      const wingCeSymbol = `NSE:${cleanSym}${dateCode}${upperBeStrike}CE`;
      const wingPeSymbol = `NSE:${cleanSym}${dateCode}${lowerBeStrike}PE`;

      const p3 = await marketDataService.getLTP(wingCeSymbol);
      const p4 = await marketDataService.getLTP(wingPeSymbol);

      legs = [
        { id: `leg_1_${Date.now()}`, symbol: ceSymbol, type: 'CE', strike: atmStrike, side: 'SELL', qty, entryPrice: p1, currentPrice: p1, pnl: 0, isWing: false },
        { id: `leg_2_${Date.now()}`, symbol: peSymbol, type: 'PE', strike: atmStrike, side: 'SELL', qty, entryPrice: p2, currentPrice: p2, pnl: 0, isWing: false },
        { id: `leg_3_${Date.now()}`, symbol: wingCeSymbol, type: 'CE', strike: upperBeStrike, side: 'BUY', qty, entryPrice: p3, currentPrice: p3, pnl: 0, isWing: true },
        { id: `leg_4_${Date.now()}`, symbol: wingPeSymbol, type: 'PE', strike: lowerBeStrike, side: 'BUY', qty, entryPrice: p4, currentPrice: p4, pnl: 0, isWing: true }
      ];
      strategyName = 'IRON_FLY_BREAKEVEN';
    } else if (oppType === 'MONTHLY_SHORT_STRADDLE') {
      const ceSymbol = `NSE:${cleanSym}${dateCode}${atmStrike}CE`;
      const peSymbol = `NSE:${cleanSym}${dateCode}${atmStrike}PE`;

      const p1 = await marketDataService.getLTP(ceSymbol);
      const p2 = await marketDataService.getLTP(peSymbol);

      legs = [
        { id: `leg_1_${Date.now()}`, symbol: ceSymbol, type: 'CE', strike: atmStrike, side: 'SELL', qty, entryPrice: p1, currentPrice: p1, pnl: 0, isWing: false },
        { id: `leg_2_${Date.now()}`, symbol: peSymbol, type: 'PE', strike: atmStrike, side: 'SELL', qty, entryPrice: p2, currentPrice: p2, pnl: 0, isWing: false }
      ];
      strategyName = 'MONTHLY_SHORT_STRADDLE';
    } else {
      return this.executeEntryIfEligible();
    }

    // Capital check before execution
    const estMargin = (strategyName === 'IRON_CONDOR' || strategyName === 'IRON_FLY_BREAKEVEN') ? 95000 * numberOfLots : 145000 * numberOfLots;
    const capCheck = riskService.checkCapitalRequirement(estMargin, numberOfLots);
    if (!capCheck.isAllowed) {
      logger.warn(`Opportunity execution rejected due to capital limit: ${capCheck.reason}`);
      return { success: false, message: capCheck.reason || 'Insufficient allocated capital' };
    }

    // Add orders for each leg and execute via FYERS if LIVE mode
    const executedOrders: Order[] = [];
    for (const leg of legs) {
      const order: Order = {
        id: `ord_${leg.id}`,
        positionId,
        symbol: leg.symbol,
        side: leg.side,
        qty: leg.qty,
        price: leg.entryPrice,
        executedPrice: leg.entryPrice,
        status: 'FILLED',
        type: 'MARKET',
        mode: effectiveMode,
        timestamp: new Date().toISOString()
      };

      if (effectiveMode === 'LIVE') {
        try {
          const fyersRes = await fyersService.placeOrder({
            symbol: leg.symbol,
            qty: leg.qty,
            side: leg.side,
            type: 'MARKET',
            productType: 'INTRADAY'
          });
          if (fyersRes && (fyersRes.id || fyersRes.order_id)) {
            order.fyersOrderId = fyersRes.id || fyersRes.order_id;
            logger.success(`Live FYERS Order Placed: ${leg.symbol} ${leg.side} x ${leg.qty} | Order ID: ${order.fyersOrderId}`);
          } else {
            throw new Error(`FYERS order placement failed: ${JSON.stringify(fyersRes)}`);
          }
        } catch (err: any) {
          const errMsg = err?.message || String(err);
          logger.error(`Error submitting FYERS live order for ${leg.symbol}: ${errMsg}`);
          return {
            success: false,
            message: `Live Order Placement Failed on FYERS API for leg ${leg.symbol}: ${errMsg}. Position was NOT created.`
          };
        }
      }

      executedOrders.push(order);
    }

    // Save orders now that all live orders succeeded
    executedOrders.forEach(ord => db.addOrder(ord));


    const sellLegs = legs.filter(l => l.side === 'SELL');
    const initialPremiumSum = sellLegs.reduce((sum, l) => sum + l.entryPrice, 0);

    const newPosition: Position = {
      id: positionId,
      strategy: strategyName,
      symbol: settings.indexSymbol,
      indexEntryPrice: spotPrice,
      currentIndexPrice: spotPrice,
      status: 'OPEN',
      legs,
      totalPnl: 0,
      maxRisk: strategyName.includes('ARBITRAGE') ? 0 : 15000,
      maxReward: Math.round(initialPremiumSum * qty),
      entryTime: new Date().toISOString(),
      updatedTime: new Date().toISOString(),
      adjustmentCount: 0,
      wingsAdded: strategyName === 'IRON_CONDOR' || strategyName === 'IRON_FLY_BREAKEVEN',
      mode: effectiveMode,
      source: effectiveMode === 'LIVE' ? 'BOT_EXECUTED' : 'PAPER',
      initialCombinedPremium: Math.round(initialPremiumSum),
      breakevenUpper: Math.round(spotPrice + initialPremiumSum + (strategyName === 'MONTHLY_SHORT_STRADDLE' ? 100 : 0)),
      breakevenLower: Math.round(spotPrice - initialPremiumSum - (strategyName === 'MONTHLY_SHORT_STRADDLE' ? 100 : 0)),
      straddleState: strategyName === 'MONTHLY_SHORT_STRADDLE' ? 'INITIAL' : undefined
    };

    db.savePosition(newPosition);

    db.addTradeLog({
      action: 'OPPORTUNITY_EXECUTED',
      symbol: settings.indexSymbol,
      strategy: strategyName,
      price: spotPrice,
      quantity: qty,
      pnl: 0,
      mode: effectiveMode,
      notes: `Automated Opportunity Execution (${effectiveMode} Mode): ${strategyName} locked at spot ₹${spotPrice}.`
    });

    logger.success(`OPPORTUNITY EXECUTED [${strategyName}] in ${effectiveMode} mode`, { positionId, spotPrice });

    await notificationService.notify(
      `Opportunity Executed (${strategyName})`,
      `Position ID: ${positionId}\nSpot: ₹${spotPrice}\nMode: ${effectiveMode}`,
      'TRADE'
    );

    return { success: true, position: newPosition, message: `${strategyName} Opportunity executed in ${effectiveMode} mode and locked successfully` };
  }

  /**
   * Syncs Live Fyers Trades & Net Positions into Strategy Engine with Auto-Tagging
   */
  public async syncFyersPositions(requestedTag?: string, requestedStrategy?: string): Promise<{ success: boolean; syncedCount: number; message: string; positions: Position[] }> {
    const settings = db.getSettings();
    let auth = db.getFyersAuth();

    // Ensure token is valid before sync attempt
    if (!auth.isValid || !auth.accessToken || auth.expiresAt <= Date.now()) {
      await fyersService.ensureValidToken().catch(() => {});
      auth = db.getFyersAuth();
    }

    if (!auth.isValid || !auth.accessToken) {
      return {
        success: false,
        syncedCount: 0,
        message: 'Fyers Authorization Required. Headless TOTP login was attempted. Please verify FY ID, TOTP Secret Key & PIN in Settings.',
        positions: []
      };
    }

    // Auto-switch setting mode to LIVE if user syncs live FYERS positions
    if (settings.mode !== 'LIVE') {
      db.updateSettings({ mode: 'LIVE' });
      logger.info('Automatically switched strategy mode to LIVE upon FYERS position sync request.');
    }

    const fyersData = await fyersService.getPositions();
    const allNet = fyersData?.netPositions || [];
    const netPositions = allNet.filter((p: any) => Math.abs(p.netQty || p.qty || 0) > 0);

    const existingOpen = db.getOpenPositions();

    // If Fyers returns 0 active non-zero net positions
    if (netPositions.length === 0) {
      let closedCount = 0;
      for (const pos of existingOpen) {
        if (pos.source === 'FYERS_SYNCED') {
          pos.status = 'CLOSED';
          pos.exitReason = 'NOT_PRESENT_IN_FYERS_TERMINAL';
          pos.updatedTime = new Date().toISOString();
          db.savePosition(pos);
          closedCount++;
        }
      }
      return {
        success: true,
        syncedCount: 0,
        message: closedCount > 0
          ? `No open net positions found in Fyers. Cleared ${closedCount} unconfirmed live trade(s) from local dashboard.`
          : 'No active open positions found in Fyers live account.',
        positions: []
      };
    }

    const spotPrice = await marketDataService.getLTP(settings.indexSymbol || 'NSE:NIFTY50-INDEX');
    const fyersSymbolSet = new Set(netPositions.map((p: any) => p.symbol));

    // Find any existing synced or matching open LIVE position in DB
    const matchingPosIndex = existingOpen.findIndex(p =>
      (p.mode === 'LIVE' && p.source === 'FYERS_SYNCED') || (p.mode === 'LIVE' && p.legs.some(l => fyersSymbolSet.has(l.symbol)))
    );

    // Build leg objects from netPositions
    const optionLegs = netPositions.filter((p: any) => p.symbol.includes('CE') || p.symbol.includes('PE'));
    const nonOptionLegs = netPositions.filter((p: any) => !p.symbol.includes('CE') && !p.symbol.includes('PE'));

    const updatedLegs: Leg[] = [];

    // Map option legs
    optionLegs.forEach((p: any, idx: number) => {
      const parsed = parseFyersOptionSymbol(p.symbol);
      const isCe = parsed.isValid ? parsed.type === 'CE' : p.symbol.includes('CE');
      const strike = parsed.isValid ? parsed.strike : (p.symbol.match(/(\d+)(CE|PE)/)?.[1] ? parseInt(p.symbol.match(/(\d+)(CE|PE)/)[1], 10) : 0);
      const side = (p.netQty < 0 || p.side < 0) ? 'SELL' : 'BUY';
      const qty = Math.abs(p.netQty || p.qty || 65);
      const entryPrice = p.netAvg || p.sellAvg || p.buyAvg || 100;
      const currentPrice = typeof p.ltp === 'number' && p.ltp > 0 ? p.ltp : entryPrice;
      const pnl = typeof p.pl === 'number' ? Math.round(p.pl) : (typeof p.unrealized_pnl === 'number' ? Math.round(p.unrealized_pnl) : Math.round((currentPrice - entryPrice) * (side === 'SELL' ? -1 : 1) * qty));

      updatedLegs.push({
        id: `fyers_leg_${p.id || idx}`,
        symbol: p.symbol,
        type: isCe ? 'CE' : 'PE',
        strike,
        side,
        qty,
        entryPrice,
        currentPrice,
        pnl,
        isWing: side === 'BUY'
      });
    });

    // Map non-option legs
    nonOptionLegs.forEach((p: any, idx: number) => {
      const isFut = p.symbol.includes('FUT');
      const side = (p.netQty < 0 || p.side < 0) ? 'SELL' : 'BUY';
      const qty = Math.abs(p.netQty || p.qty || 50);
      const entryPrice = p.netAvg || p.sellAvg || p.buyAvg || spotPrice;
      const currentPrice = typeof p.ltp === 'number' && p.ltp > 0 ? p.ltp : entryPrice;
      const pnl = typeof p.pl === 'number' ? Math.round(p.pl) : Math.round((currentPrice - entryPrice) * (side === 'SELL' ? -1 : 1) * qty);

      updatedLegs.push({
        id: `fyers_leg_nonopt_${p.id || idx}`,
        symbol: p.symbol,
        type: isFut ? 'FUT' : 'EQUITY',
        side,
        qty,
        entryPrice,
        currentPrice,
        pnl,
        isWing: false
      });
    });

    const totalPnl = updatedLegs.reduce((acc, l) => acc + l.pnl, 0);
    const detected = detectOptionStrategy(updatedLegs);

    const strategyName = requestedStrategy || detected.strategy;
    const finalTag = requestedTag || detected.tag;

    let targetPos: Position;

    if (matchingPosIndex >= 0) {
      targetPos = existingOpen[matchingPosIndex];
      targetPos.legs = updatedLegs;
      targetPos.totalPnl = totalPnl;
      targetPos.currentIndexPrice = spotPrice;
      targetPos.updatedTime = new Date().toISOString();
      if (requestedStrategy) targetPos.strategy = requestedStrategy;
      else if (!targetPos.strategy || targetPos.strategy === 'LIVE_FYERS_POSITION' || targetPos.strategy === 'SHORT_STRADDLE') targetPos.strategy = strategyName;
      if (requestedTag) targetPos.tag = requestedTag;
      else targetPos.tag = finalTag;
      targetPos.status = 'OPEN';
      db.savePosition(targetPos);
    } else {
      const positionId = `pos_fyers_live_sync`;
      targetPos = {
        id: positionId,
        strategy: strategyName,
        tag: finalTag,
        source: 'FYERS_SYNCED',
        symbol: settings.indexSymbol || 'NSE:NIFTY50-INDEX',
        indexEntryPrice: spotPrice,
        currentIndexPrice: spotPrice,
        status: 'OPEN',
        legs: updatedLegs,
        totalPnl,
        maxRisk: 15000,
        maxReward: 10000,
        entryTime: new Date().toISOString(),
        updatedTime: new Date().toISOString(),
        adjustmentCount: 0,
        wingsAdded: optionLegs.length === 4,
        mode: 'LIVE',
        notes: `Synced live position directly from Fyers API v3: ${detected.description}`
      };
      db.savePosition(targetPos);
    }

    logger.success(`Successfully synced live position (${updatedLegs.length} legs) from Fyers. Total P&L: ₹${totalPnl}`);

    return {
      success: true,
      syncedCount: 1,
      message: `Successfully synced live positions from Fyers with strategy tag "${targetPos.tag}". Total P&L: ₹${totalPnl >= 0 ? '+' : ''}₹${totalPnl.toLocaleString('en-IN')}`,
      positions: [targetPos]
    };
  }

  /**
   * Strategy 1: Iron Fly Breakeven Wing Hedges & Dynamic Spot Breach Adjustments
   */
  private async adjustIronFlyPosition(position: Position, currentSpot: number): Promise<boolean> {
    const settings = db.getSettings();
    const expiryInfo = getNearestExpiryForSymbol(position.symbol || settings.indexSymbol);
    const dateCode = expiryInfo.fyersSymbolDateCode;
    const cleanSym = getFyersSymbolPrefix(position.symbol || settings.indexSymbol);

    const atmStrike = position.indexEntryPrice;
    const totalPremium = position.initialCombinedPremium || 300;
    const upperLimit = position.breakevenUpper || (atmStrike + totalPremium);
    const lowerLimit = position.breakevenLower || (atmStrike - totalPremium);

    let adjusted = false;

    // RULE A: Spot price breaches Upper Limit (UL) or Lower Limit (LL) -> Add 1 additional Sell PE/CE leg
    if (!position.additionalLegsAdded) {
      if (currentSpot >= upperLimit) {
        // UL breached -> Add 1 additional Sell PE leg with strike = ATM + premium value
        const addStrike = Math.round((atmStrike + totalPremium) / 50) * 50;
        const addSymbol = `NSE:${cleanSym}${dateCode}${addStrike}PE`;
        const addPrice = await marketDataService.getLTP(addSymbol);
        const qty = settings.defaultQuantity || 50;

        const addOrder: Order = {
          id: `ord_add_pe_${Date.now()}`,
          positionId: position.id,
          symbol: addSymbol,
          side: 'SELL',
          qty,
          price: addPrice,
          executedPrice: addPrice,
          status: 'FILLED',
          type: 'MARKET',
          mode: settings.mode,
          timestamp: new Date().toISOString()
        };
        db.addOrder(addOrder);

        position.legs.push({
          id: `leg_add_pe_${Date.now()}`,
          symbol: addSymbol,
          type: 'PE',
          strike: addStrike,
          side: 'SELL',
          qty,
          entryPrice: addPrice,
          currentPrice: addPrice,
          pnl: 0,
          isWing: false,
          isAdditionalLeg: true
        });

        position.additionalLegsAdded = true;
        position.adjustmentCount += 1;
        position.status = 'ADJUSTED';
        adjusted = true;

        const details = `UL Breach (Spot ₹${currentSpot} >= ₹${upperLimit}): Added 1 additional Sell PE at strike ₹${addStrike} @ ₹${addPrice}`;
        db.addAdjustment({
          id: `adj_${Date.now()}`,
          positionId: position.id,
          timestamp: new Date().toISOString(),
          conditionTriggered: `Upper Limit breached at Spot ₹${currentSpot}`,
          pnlAtAdjustment: position.totalPnl,
          indexPriceAtAdjustment: currentSpot,
          actionTaken: 'ADD_ADDITIONAL_PE_SELL',
          wingsAdded: position.wingsAdded,
          details,
          mode: settings.mode
        });

        await notificationService.notify('IRON FLY ADJUSTMENT: UL Breach PE Sell Added', details, 'ADJUSTMENT');
      } else if (currentSpot <= lowerLimit) {
        // LL breached -> Add 1 additional Sell CE leg with strike = ATM - premium value
        const addStrike = Math.round((atmStrike - totalPremium) / 50) * 50;
        const addSymbol = `NSE:${cleanSym}${dateCode}${addStrike}CE`;
        const addPrice = await marketDataService.getLTP(addSymbol);
        const qty = settings.defaultQuantity || 50;

        const addOrder: Order = {
          id: `ord_add_ce_${Date.now()}`,
          positionId: position.id,
          symbol: addSymbol,
          side: 'SELL',
          qty,
          price: addPrice,
          executedPrice: addPrice,
          status: 'FILLED',
          type: 'MARKET',
          mode: settings.mode,
          timestamp: new Date().toISOString()
        };
        db.addOrder(addOrder);

        position.legs.push({
          id: `leg_add_ce_${Date.now()}`,
          symbol: addSymbol,
          type: 'CE',
          strike: addStrike,
          side: 'SELL',
          qty,
          entryPrice: addPrice,
          currentPrice: addPrice,
          pnl: 0,
          isWing: false,
          isAdditionalLeg: true
        });

        position.additionalLegsAdded = true;
        position.adjustmentCount += 1;
        position.status = 'ADJUSTED';
        adjusted = true;

        const details = `LL Breach (Spot ₹${currentSpot} <= ₹${lowerLimit}): Added 1 additional Sell CE at strike ₹${addStrike} @ ₹${addPrice}`;
        db.addAdjustment({
          id: `adj_${Date.now()}`,
          positionId: position.id,
          timestamp: new Date().toISOString(),
          conditionTriggered: `Lower Limit breached at Spot ₹${currentSpot}`,
          pnlAtAdjustment: position.totalPnl,
          indexPriceAtAdjustment: currentSpot,
          actionTaken: 'ADD_ADDITIONAL_CE_SELL',
          wingsAdded: position.wingsAdded,
          details,
          mode: settings.mode
        });

        await notificationService.notify('IRON FLY ADJUSTMENT: LL Breach CE Sell Added', details, 'ADJUSTMENT');
      }
    }

    // RULE B: Continuation Movement -> Close initial strike leg, sell new ATM leg
    if (position.additionalLegsAdded && !position.continuationAdjusted) {
      const isUpContinuation = currentSpot >= (upperLimit + 100);
      const isDownContinuation = currentSpot <= (lowerLimit - 100);

      if (isUpContinuation || isDownContinuation) {
        const initialLosingType = isUpContinuation ? 'CE' : 'PE';
        const initialLeg = position.legs.find(l => l.type === initialLosingType && l.side === 'SELL' && !l.isAdditionalLeg);

        if (initialLeg) {
          const exitPrice = await marketDataService.getLTP(initialLeg.symbol);
          initialLeg.currentPrice = exitPrice;
          initialLeg.pnl = Math.round((initialLeg.entryPrice - exitPrice) * initialLeg.qty);

          db.addOrder({
            id: `ord_close_init_${Date.now()}`,
            positionId: position.id,
            symbol: initialLeg.symbol,
            side: 'BUY',
            qty: initialLeg.qty,
            price: exitPrice,
            executedPrice: exitPrice,
            status: 'FILLED',
            type: 'MARKET',
            mode: settings.mode,
            timestamp: new Date().toISOString()
          });

          const newAtm = Math.round(currentSpot / 100) * 100;
          const newSymbol = `NSE:${cleanSym}${dateCode}${newAtm}${initialLosingType}`;
          const newPrice = await marketDataService.getLTP(newSymbol);

          db.addOrder({
            id: `ord_new_atm_${Date.now()}`,
            positionId: position.id,
            symbol: newSymbol,
            side: 'SELL',
            qty: settings.defaultQuantity || 50,
            price: newPrice,
            executedPrice: newPrice,
            status: 'FILLED',
            type: 'MARKET',
            mode: settings.mode,
            timestamp: new Date().toISOString()
          });

          initialLeg.symbol = newSymbol;
          initialLeg.strike = newAtm;
          initialLeg.entryPrice = newPrice;
          initialLeg.currentPrice = newPrice;
          initialLeg.pnl = 0;

          position.continuationAdjusted = true;
          position.adjustmentCount += 1;
          adjusted = true;

          const details = `Continuation Movement: Closed initial ${initialLosingType} leg and opened new ATM leg at ₹${newAtm}`;
          db.addAdjustment({
            id: `adj_${Date.now()}`,
            positionId: position.id,
            timestamp: new Date().toISOString(),
            conditionTriggered: `Spot moved further to ₹${currentSpot}`,
            pnlAtAdjustment: position.totalPnl,
            indexPriceAtAdjustment: currentSpot,
            actionTaken: 'CONTINUATION_ROLL_ATM',
            wingsAdded: position.wingsAdded,
            details,
            mode: settings.mode
          });

          await notificationService.notify('IRON FLY ADJUSTMENT: Continuation ATM Roll', details, 'ADJUSTMENT');
        }
      }
    }

    // RULE C: Reversal Movement -> Close additional position if spot price breaches back across strike
    if (position.additionalLegsAdded) {
      const addLegIndex = position.legs.findIndex(l => l.isAdditionalLeg);
      if (addLegIndex >= 0) {
        const addLeg = position.legs[addLegIndex];
        const isReversal = (addLeg.type === 'PE' && currentSpot < (addLeg.strike || 0)) ||
                           (addLeg.type === 'CE' && currentSpot > (addLeg.strike || 0));

        if (isReversal) {
          const exitPrice = await marketDataService.getLTP(addLeg.symbol);
          db.addOrder({
            id: `ord_close_add_${Date.now()}`,
            positionId: position.id,
            symbol: addLeg.symbol,
            side: 'BUY',
            qty: addLeg.qty,
            price: exitPrice,
            executedPrice: exitPrice,
            status: 'FILLED',
            type: 'MARKET',
            mode: settings.mode,
            timestamp: new Date().toISOString()
          });

          position.legs.splice(addLegIndex, 1);
          position.additionalLegsAdded = false;
          position.adjustmentCount += 1;
          adjusted = true;

          const details = `Reversal Triggered: Spot ₹${currentSpot} crossed back past additional strike ₹${addLeg.strike}. Square off additional ${addLeg.type} position.`;
          db.addAdjustment({
            id: `adj_${Date.now()}`,
            positionId: position.id,
            timestamp: new Date().toISOString(),
            conditionTriggered: `Market reversal detected`,
            pnlAtAdjustment: position.totalPnl,
            indexPriceAtAdjustment: currentSpot,
            actionTaken: 'REVERSAL_SQUARE_OFF_ADDITIONAL_LEG',
            wingsAdded: position.wingsAdded,
            details,
            mode: settings.mode
          });

          await notificationService.notify('IRON FLY ADJUSTMENT: Reversal Square Off', details, 'ADJUSTMENT');
        }
      }
    }

    return adjusted;
  }

  /**
   * Strategy 2: Short Straddle Monthly Strategy (First Friday Entry & Breakeven Defense Engine)
   */
  private async adjustMonthlyStraddlePosition(position: Position, currentSpot: number): Promise<boolean> {
    const settings = db.getSettings();
    const expiryInfo = getNearestExpiryForSymbol(position.symbol || settings.indexSymbol);
    const dateCode = expiryInfo.fyersSymbolDateCode;
    const cleanSym = getFyersSymbolPrefix(position.symbol || settings.indexSymbol);

    const greeks = this.calculatePositionGreeks(position, currentSpot);
    const avgAtmPremium = greeks.avgAtmPremium;

    // Sell legs and premium calculations
    const sellLegs = position.legs.filter(l => l.side === 'SELL' && !l.isWing);
    const ceShort = sellLegs.find(l => l.type === 'CE');
    const peShort = sellLegs.find(l => l.type === 'PE');
    const initialCombinedPremium = position.initialCombinedPremium || 
      ((ceShort?.entryPrice || 150) + (peShort?.entryPrice || 150));
    
    // Average of PE and CE premium price
    const cePremium = ceShort?.currentPrice || ceShort?.entryPrice || (initialCombinedPremium / 2);
    const pePremium = peShort?.currentPrice || peShort?.entryPrice || (initialCombinedPremium / 2);
    const avgPeCePremium = Math.round((cePremium + pePremium) / 2);
    
    // Alert difference: 100 points diff or avg of PE and CE premium price whichever is lower
    const alertDiff = Math.min(100, Math.max(25, avgPeCePremium));

    // Breakeven price calculation: ATM +/- combined premium
    const atmStrike = position.indexEntryPrice;
    const upperBreakeven = position.breakevenUpper || (atmStrike + Math.round(initialCombinedPremium));
    const lowerBreakeven = position.breakevenLower || (atmStrike - Math.round(initialCombinedPremium));

    // Alert setup limits: when Spot price crosses below (lowerBreakeven + alertDiff) or above (upperBreakeven - alertDiff)
    const upperAlertLimit = upperBreakeven - alertDiff;
    const lowerAlertLimit = lowerBreakeven + alertDiff;

    const isUpperAlertTriggered = currentSpot >= upperAlertLimit;
    const isLowerAlertTriggered = currentSpot <= lowerAlertLimit;
    const isAlertTriggered = isUpperAlertTriggered || isLowerAlertTriggered;

    if (!isAlertTriggered || position.noLossLocked) {
      return false;
    }

    const dte = expiryInfo.daysToExpiry ?? 15;
    const qty = settings.defaultQuantity || 50;
    let adjusted = false;

    // SCENARIO 1: Positive P/L & Expiry < 5 days
    // Buy 1 lot of CE 50 pts below (i.e. CE strike - 50 or ATM - 50) for that same expiry
    // Buy 1 lot of PE 50 pts above (i.e. PE strike + 50 or ATM + 50) for the same expiry
    // This final adjustment will make trade as NO LOSS TRADE. LEAVE TO EXPIRY.
    if (position.totalPnl > 0 && dte < 5) {
      const baseAtm = Math.round(currentSpot / 50) * 50;
      const ceBuyStrike = (ceShort?.strike || baseAtm) - 50;
      const peBuyStrike = (peShort?.strike || baseAtm) + 50;

      const ceSymbol = `NSE:${cleanSym}${dateCode}${ceBuyStrike}CE`;
      const peSymbol = `NSE:${cleanSym}${dateCode}${peBuyStrike}PE`;

      const pCe = await marketDataService.getLTP(ceSymbol);
      const pPe = await marketDataService.getLTP(peSymbol);

      // Execute buy orders
      db.addOrder({
        id: `ord_s1_ce_${Date.now()}`,
        positionId: position.id,
        symbol: ceSymbol,
        side: 'BUY',
        qty,
        price: pCe,
        executedPrice: pCe,
        status: 'FILLED',
        type: 'MARKET',
        mode: settings.mode,
        timestamp: new Date().toISOString()
      });

      db.addOrder({
        id: `ord_s1_pe_${Date.now()}`,
        positionId: position.id,
        symbol: peSymbol,
        side: 'BUY',
        qty,
        price: pPe,
        executedPrice: pPe,
        status: 'FILLED',
        type: 'MARKET',
        mode: settings.mode,
        timestamp: new Date().toISOString()
      });

      if (settings.mode === 'LIVE') {
        await fyersService.placeOrder({ symbol: ceSymbol, qty, side: 'BUY', type: 'MARKET', productType: 'INTRADAY' }).catch(() => {});
        await fyersService.placeOrder({ symbol: peSymbol, qty, side: 'BUY', type: 'MARKET', productType: 'INTRADAY' }).catch(() => {});
      }

      position.legs.push({ id: `leg_s1_ce_${Date.now()}`, symbol: ceSymbol, type: 'CE', strike: ceBuyStrike, side: 'BUY', qty, entryPrice: pCe, currentPrice: pCe, pnl: 0, isWing: true });
      position.legs.push({ id: `leg_s1_pe_${Date.now()}`, symbol: peSymbol, type: 'PE', strike: peBuyStrike, side: 'BUY', qty, entryPrice: pPe, currentPrice: pPe, pnl: 0, isWing: true });

      position.noLossLocked = true;
      position.straddleState = 'NO_LOSS_LOCKED';
      position.status = 'ADJUSTED';
      position.adjustmentCount += 1;
      adjusted = true;

      const details = `Scenario 1 Applied (Alert at ₹${currentSpot.toFixed(1)}, P/L +₹${position.totalPnl}, DTE ${dte}d < 5d): Bought 1 lot ${ceBuyStrike} CE (50 pts below) & 1 lot ${peBuyStrike} PE (50 pts above). Locked into NO LOSS TRADE! Leave to expiry.`;
      db.addAdjustment({
        id: `adj_${Date.now()}`,
        positionId: position.id,
        timestamp: new Date().toISOString(),
        conditionTriggered: `Alert Triggered in Positive P/L (DTE < 5d, Spot ₹${currentSpot})`,
        pnlAtAdjustment: position.totalPnl,
        indexPriceAtAdjustment: currentSpot,
        actionTaken: 'SCENARIO_1_NO_LOSS_LOCK',
        wingsAdded: true,
        details,
        mode: settings.mode
      });

      await notificationService.notify('GOLDEN RULE: Scenario 1 No Loss Trade Locked', details, 'ADJUSTMENT');
    }
    // SCENARIO 2: Positive P/L & Expiry >= 5 days
    // 1. Close the max profit leg (either CE or PE)
    // 2. Sell 1 lot with 100 point below if CE or 100 pt above if PE (i.e. rolled strike or ATM alternate)
    // 3. Buy 1 lot of CE 50 pts below (same expiry) & Buy 1 lot of PE 50 pts above (same expiry)
    // This final adjustment will make trade as NO LOSS TRADE. LEAVE TO EXPIRY.
    else if (position.totalPnl > 0 && dte >= 5) {
      const openSellLegs = position.legs.filter(l => l.side === 'SELL' && !l.isWing);
      const profitLeg = openSellLegs.reduce((max, leg) => leg.pnl > max.pnl ? leg : max, openSellLegs[0] || position.legs[0]);

      if (profitLeg) {
        const exitPrice = await marketDataService.getLTP(profitLeg.symbol);
        profitLeg.currentPrice = exitPrice;

        // Close max profit leg
        db.addOrder({
          id: `ord_s2_close_${Date.now()}`,
          positionId: position.id,
          symbol: profitLeg.symbol,
          side: 'BUY',
          qty: profitLeg.qty,
          price: exitPrice,
          executedPrice: exitPrice,
          status: 'FILLED',
          type: 'MARKET',
          mode: settings.mode,
          timestamp: new Date().toISOString()
        });

        if (settings.mode === 'LIVE') {
          await fyersService.placeOrder({ symbol: profitLeg.symbol, qty: profitLeg.qty, side: 'BUY', type: 'MARKET', productType: 'INTRADAY' }).catch(() => {});
        }

        // Sell 1 lot with 100 point below if CE or 100 pt above if PE (or ATM alternate)
        const currentAtm = Math.round(currentSpot / 50) * 50;
        const newSellStrike = profitLeg.type === 'CE' 
          ? (profitLeg.strike ? profitLeg.strike - 100 : currentAtm - 100)
          : (profitLeg.strike ? profitLeg.strike + 100 : currentAtm + 100);

        const newSellSymbol = `NSE:${cleanSym}${dateCode}${newSellStrike}${profitLeg.type}`;
        const newSellPrice = await marketDataService.getLTP(newSellSymbol);

        db.addOrder({
          id: `ord_s2_roll_${Date.now()}`,
          positionId: position.id,
          symbol: newSellSymbol,
          side: 'SELL',
          qty: profitLeg.qty,
          price: newSellPrice,
          executedPrice: newSellPrice,
          status: 'FILLED',
          type: 'MARKET',
          mode: settings.mode,
          timestamp: new Date().toISOString()
        });

        if (settings.mode === 'LIVE') {
          await fyersService.placeOrder({ symbol: newSellSymbol, qty: profitLeg.qty, side: 'SELL', type: 'MARKET', productType: 'INTRADAY' }).catch(() => {});
        }

        profitLeg.symbol = newSellSymbol;
        profitLeg.strike = newSellStrike;
        profitLeg.entryPrice = newSellPrice;
        profitLeg.currentPrice = newSellPrice;
        profitLeg.pnl = 0;

        // Buy 1 lot of CE 50 pts below & Buy 1 lot of PE 50 pts above for same expiry
        const ceBuyStrike = (profitLeg.type === 'CE' ? newSellStrike : (ceShort?.strike || currentAtm)) - 50;
        const peBuyStrike = (profitLeg.type === 'PE' ? newSellStrike : (peShort?.strike || currentAtm)) + 50;

        const s2CeSym = `NSE:${cleanSym}${dateCode}${ceBuyStrike}CE`;
        const s2PeSym = `NSE:${cleanSym}${dateCode}${peBuyStrike}PE`;
        const pCe = await marketDataService.getLTP(s2CeSym);
        const pPe = await marketDataService.getLTP(s2PeSym);

        db.addOrder({
          id: `ord_s2_buy_ce_${Date.now()}`,
          positionId: position.id,
          symbol: s2CeSym,
          side: 'BUY',
          qty,
          price: pCe,
          executedPrice: pCe,
          status: 'FILLED',
          type: 'MARKET',
          mode: settings.mode,
          timestamp: new Date().toISOString()
        });

        db.addOrder({
          id: `ord_s2_buy_pe_${Date.now()}`,
          positionId: position.id,
          symbol: s2PeSym,
          side: 'BUY',
          qty,
          price: pPe,
          executedPrice: pPe,
          status: 'FILLED',
          type: 'MARKET',
          mode: settings.mode,
          timestamp: new Date().toISOString()
        });

        if (settings.mode === 'LIVE') {
          await fyersService.placeOrder({ symbol: s2CeSym, qty, side: 'BUY', type: 'MARKET', productType: 'INTRADAY' }).catch(() => {});
          await fyersService.placeOrder({ symbol: s2PeSym, qty, side: 'BUY', type: 'MARKET', productType: 'INTRADAY' }).catch(() => {});
        }

        position.legs.push({ id: `leg_s2_ce_${Date.now()}`, symbol: s2CeSym, type: 'CE', strike: ceBuyStrike, side: 'BUY', qty, entryPrice: pCe, currentPrice: pCe, pnl: 0, isWing: true });
        position.legs.push({ id: `leg_s2_pe_${Date.now()}`, symbol: s2PeSym, type: 'PE', strike: peBuyStrike, side: 'BUY', qty, entryPrice: pPe, currentPrice: pPe, pnl: 0, isWing: true });

        position.noLossLocked = true;
        position.straddleState = 'NO_LOSS_LOCKED';
        position.status = 'ADJUSTED';
        position.adjustmentCount += 1;
        adjusted = true;

        const details = `Scenario 2 Applied (Alert at ₹${currentSpot.toFixed(1)}, P/L +₹${position.totalPnl}, DTE ${dte}d >= 5d): Closed max profit ${profitLeg.type} leg @ ₹${exitPrice}, Sold 1 lot at ${newSellStrike} @ ₹${newSellPrice} (100pt shift/ATM alternate), and Bought 1 lot CE at ${ceBuyStrike} & PE at ${peBuyStrike} (50pt wings). Locked into NO LOSS TRADE! Leave to expiry.`;
        db.addAdjustment({
          id: `adj_${Date.now()}`,
          positionId: position.id,
          timestamp: new Date().toISOString(),
          conditionTriggered: `Alert Triggered in Positive P/L (DTE >= 5d, Spot ₹${currentSpot})`,
          pnlAtAdjustment: position.totalPnl,
          indexPriceAtAdjustment: currentSpot,
          actionTaken: 'SCENARIO_2_ROLL_AND_LOCK_NO_LOSS',
          wingsAdded: true,
          details,
          mode: settings.mode
        });

        await notificationService.notify('GOLDEN RULE: Scenario 2 Roll & No Loss Trade Locked', details, 'ADJUSTMENT');
      }
    }
    // SCENARIO 3: Negative P&L
    // Check premium value of negative leg.
    // Rule 1: Choose a premium in same range or below in positive leg. Combined premium should NOT be more than negative leg premium. Sell 1 lot in positive leg.
    // Rule 2: If combined premium is 50% less than negative one, choose additional position same as Rule 1.
    // If further Rule 2 is breached, close the lowest positive premium and apply Rule 1.
    // When you get positive P&L of at least > INR 2500, buy 1 lot above your PE and 1 lot below your CE. Locked into NO LOSS TRADE!
    else if (position.totalPnl <= 0 || (position.straddleState === 'SCENARIO_3' && !position.noLossLocked)) {
      const openSellLegs = position.legs.filter(l => l.side === 'SELL' && !l.isWing);
      const losingLeg = openSellLegs.reduce((min, leg) => leg.pnl < min.pnl ? leg : min, openSellLegs[0]);
      const losingPremium = losingLeg ? (losingLeg.currentPrice || losingLeg.entryPrice) : 150;
      const losingType: 'CE' | 'PE' = losingLeg ? (losingLeg.type as 'CE' | 'PE') : (currentSpot > position.indexEntryPrice ? 'CE' : 'PE');
      const positiveType: 'CE' | 'PE' = losingType === 'CE' ? 'PE' : 'CE';

      // Existing positive leg selling positions
      const existingPositiveLegs = position.legs.filter(l => l.type === positiveType && l.side === 'SELL');
      const existingPositivePremiumSum = existingPositiveLegs.reduce((sum, l) => sum + (l.currentPrice || l.entryPrice), 0);

      // Check if combined positive premium is 50% less than negative one (Rule 2 breach)
      const is50PctLess = existingPositivePremiumSum > 0 && (existingPositivePremiumSum < (losingPremium * 0.5));
      const additionalPositionsCount = position.legs.filter(l => (l as any).isAdditionalLeg).length;

      // Strike selection under Rule 1: Choose a premium in the same range or below such that combined premium <= negative leg premium
      const maxAllowedNewPremium = Math.max(20, losingPremium - (is50PctLess ? 0 : existingPositivePremiumSum));
      const baseAtm = Math.round(currentSpot / 50) * 50;
      const candidateOffsets = positiveType === 'CE' ? [50, 100, 150, 200, 250, 300, 350, 400] : [-50, -100, -150, -200, -250, -300, -350, -400];
      
      let bestStrike = positiveType === 'CE' ? baseAtm + 150 : baseAtm - 150;
      let bestPrice = 0;
      let minDiff = Infinity;

      for (const offset of candidateOffsets) {
        const testStrike = baseAtm + offset;
        const testSym = `NSE:${cleanSym}${dateCode}${testStrike}${positiveType}`;
        const testLtp = await marketDataService.getLTP(testSym);
        
        // Rule 1: Premium must not cause combined to exceed negative leg premium
        if (testLtp <= maxAllowedNewPremium) {
          const diff = Math.abs(testLtp - maxAllowedNewPremium);
          if (diff < minDiff) {
            minDiff = diff;
            bestStrike = testStrike;
            bestPrice = testLtp;
          }
        }
      }

      // If Rule 2 breached further (already have multiple additional legs), close lowest positive premium
      if (additionalPositionsCount >= 2 && existingPositiveLegs.length > 2) {
        const lowestPosLeg = existingPositiveLegs.reduce((min, l) => (l.currentPrice || l.entryPrice) < (min.currentPrice || min.entryPrice) ? l : min, existingPositiveLegs[0]);
        if (lowestPosLeg) {
          const closePrice = await marketDataService.getLTP(lowestPosLeg.symbol);
          db.addOrder({
            id: `ord_close_low_${Date.now()}`,
            positionId: position.id,
            symbol: lowestPosLeg.symbol,
            side: 'BUY',
            qty: lowestPosLeg.qty,
            price: closePrice,
            executedPrice: closePrice,
            status: 'FILLED',
            type: 'MARKET',
            mode: settings.mode,
            timestamp: new Date().toISOString()
          });

          const legIdx = position.legs.findIndex(l => l.id === lowestPosLeg.id);
          if (legIdx >= 0) position.legs.splice(legIdx, 1);
          logger.info(`Rule 2 extended breach: Closed lowest positive premium leg at strike ${lowestPosLeg.strike} @ ₹${closePrice}`);
        }
      }

      const addSellSymbol = `NSE:${cleanSym}${dateCode}${bestStrike}${positiveType}`;
      const alreadyHasStrike = position.legs.some(l => l.symbol === addSellSymbol && l.side === 'SELL');

      // Cooldown / shift check
      const nowMs = Date.now();
      const lastAdjMs = (position as any).lastAdjustmentMs || 0;
      const lastAdjSpot = (position as any).lastAdjustmentSpot || position.indexEntryPrice;
      const spotShift = Math.abs(currentSpot - lastAdjSpot);
      const isCooldown = (nowMs - lastAdjMs < 180000) && spotShift < 40;

      if (!alreadyHasStrike && bestPrice > 0 && !isCooldown && additionalPositionsCount < 3) {
        db.addOrder({
          id: `ord_s3_sell_${Date.now()}`,
          positionId: position.id,
          symbol: addSellSymbol,
          side: 'SELL',
          qty,
          price: bestPrice,
          executedPrice: bestPrice,
          status: 'FILLED',
          type: 'MARKET',
          mode: settings.mode,
          timestamp: new Date().toISOString()
        });

        if (settings.mode === 'LIVE') {
          await fyersService.placeOrder({ symbol: addSellSymbol, qty, side: 'SELL', type: 'MARKET', productType: 'INTRADAY' }).catch(() => {});
        }

        position.legs.push({
          id: `leg_s3_sell_${Date.now()}`,
          symbol: addSellSymbol,
          type: positiveType,
          strike: bestStrike,
          side: 'SELL',
          qty,
          entryPrice: bestPrice,
          currentPrice: bestPrice,
          pnl: 0,
          isWing: false,
          isAdditionalLeg: true
        });

        position.straddleState = 'SCENARIO_3';
        position.status = 'ADJUSTED';
        position.adjustmentCount += 1;
        (position as any).lastAdjustmentMs = nowMs;
        (position as any).lastAdjustmentSpot = currentSpot;
        adjusted = true;

        const details = `Scenario 3 Applied (Negative P/L ₹${position.totalPnl}, Negative Leg ${losingType} @ ₹${losingPremium.toFixed(1)}): Sold 1 lot in positive ${positiveType} leg at strike ${bestStrike} @ ₹${bestPrice.toFixed(1)}. Combined positive premium kept <= negative leg premium per Rule 1 & Rule 2.`;
        db.addAdjustment({
          id: `adj_${Date.now()}`,
          positionId: position.id,
          timestamp: new Date().toISOString(),
          conditionTriggered: `Alert Triggered in Negative P/L (Spot ₹${currentSpot})`,
          pnlAtAdjustment: position.totalPnl,
          indexPriceAtAdjustment: currentSpot,
          actionTaken: 'SCENARIO_3_RULE1_RULE2_SELL_POSITIVE_LEG',
          wingsAdded: false,
          details,
          mode: settings.mode
        });

        await notificationService.notify('GOLDEN RULE: Scenario 3 Positive Leg Adjustment', details, 'ADJUSTMENT');
      }

      // Check if Scenario 3 has recovered and achieved positive P/L of at least > INR 2500
      if (position.totalPnl >= 2500 && !position.noLossLocked) {
        const currentAtm = Math.round(currentSpot / 50) * 50;
        const ceBuyStrike = currentAtm - 50; // 1 lot below your CE
        const peBuyStrike = currentAtm + 50; // 1 lot above your PE

        const ceBuySymbol = `NSE:${cleanSym}${dateCode}${ceBuyStrike}CE`;
        const peBuySymbol = `NSE:${cleanSym}${dateCode}${peBuyStrike}PE`;

        const pCe = await marketDataService.getLTP(ceBuySymbol);
        const pPe = await marketDataService.getLTP(peBuySymbol);

        db.addOrder({
          id: `ord_s3_nl_ce_${Date.now()}`,
          positionId: position.id,
          symbol: ceBuySymbol,
          side: 'BUY',
          qty,
          price: pCe,
          executedPrice: pCe,
          status: 'FILLED',
          type: 'MARKET',
          mode: settings.mode,
          timestamp: new Date().toISOString()
        });

        db.addOrder({
          id: `ord_s3_nl_pe_${Date.now()}`,
          positionId: position.id,
          symbol: peBuySymbol,
          side: 'BUY',
          qty,
          price: pPe,
          executedPrice: pPe,
          status: 'FILLED',
          type: 'MARKET',
          mode: settings.mode,
          timestamp: new Date().toISOString()
        });

        if (settings.mode === 'LIVE') {
          await fyersService.placeOrder({ symbol: ceBuySymbol, qty, side: 'BUY', type: 'MARKET', productType: 'INTRADAY' }).catch(() => {});
          await fyersService.placeOrder({ symbol: peBuySymbol, qty, side: 'BUY', type: 'MARKET', productType: 'INTRADAY' }).catch(() => {});
        }

        position.legs.push({ id: `leg_s3_nl_ce_${Date.now()}`, symbol: ceBuySymbol, type: 'CE', strike: ceBuyStrike, side: 'BUY', qty, entryPrice: pCe, currentPrice: pCe, pnl: 0, isWing: true });
        position.legs.push({ id: `leg_s3_nl_pe_${Date.now()}`, symbol: peBuySymbol, type: 'PE', strike: peBuyStrike, side: 'BUY', qty, entryPrice: pPe, currentPrice: pPe, pnl: 0, isWing: true });

        position.noLossLocked = true;
        position.straddleState = 'NO_LOSS_LOCKED';
        position.status = 'ADJUSTED';
        position.adjustmentCount += 1;
        adjusted = true;

        const details = `Scenario 3 Recovery Target Reached (P/L ₹${position.totalPnl} >= ₹2,500): Bought 1 lot at ${ceBuyStrike} CE (below CE) & 1 lot at ${peBuyStrike} PE (above PE). Converted to NO LOSS TRADE! Leave to expiry.`;
        db.addAdjustment({
          id: `adj_${Date.now()}`,
          positionId: position.id,
          timestamp: new Date().toISOString(),
          conditionTriggered: 'Scenario 3 P/L turned positive >= ₹2,500',
          pnlAtAdjustment: position.totalPnl,
          indexPriceAtAdjustment: currentSpot,
          actionTaken: 'SCENARIO_3_LOCK_NO_LOSS_TRADE',
          wingsAdded: true,
          details,
          mode: settings.mode
        });

        await notificationService.notify('GOLDEN RULE: Scenario 3 +₹2500 Reached & No Loss Trade Locked', details, 'ADJUSTMENT');
      }
    }

    return adjusted;
  }

  /**
   * Updates custom strategy tag for a given position
   */
  public updatePositionTag(positionId: string, tag: string, strategy?: string): { success: boolean; message: string } {
    const allPositions = db.getPositions();
    const pos = allPositions.find(p => p.id === positionId);
    if (!pos) {
      return { success: false, message: 'Position not found' };
    }

    if (tag) pos.tag = tag;
    if (strategy) pos.strategy = strategy;
    pos.updatedTime = new Date().toISOString();
    db.savePosition(pos);

    logger.info(`Updated position ${positionId} tag to "${tag}" (strategy: ${pos.strategy})`);
    return { success: true, message: `Strategy tagged as "${tag}" successfully` };
  }

  /**
   * 100% Automated Paper Trading Engine for ALL Scanner Opportunities
   * Runs continuously regardless of live mode or auto-trading settings,
   * executing paper trades for all opportunities identified by opportunityScanner.
   */
  public async autoPaperTradeScannerOpportunities(): Promise<{ executed: number; totalOpportunities: number }> {
    try {
      const settings = db.getSettings();
      if (settings.mode !== 'PAPER') {
        return { executed: 0, totalOpportunities: 0 };
      }

      const opportunities = await opportunityScanner.scanOpportunities();
      const allPositions = db.getPositions();
      const openPaperPositions = allPositions.filter(p => (p.status === 'OPEN' || p.status === 'ADJUSTED') && (p.mode === 'PAPER' || !p.mode));
      
      // Auto-deduplicate existing open paper positions to prevent position flickering/duplication
      const seenTypes = new Set<string>();
      for (const pos of openPaperPositions) {
        const key = (pos as any).originalStrategy || pos.strategy;
        if (seenTypes.has(key)) {
          pos.status = 'CLOSED';
          pos.exitTime = new Date().toISOString();
          pos.exitReason = 'DEDUPLICATED_BY_SYSTEM';
          db.savePosition(pos);
        } else {
          seenTypes.add(key);
        }
      }

      const activePaperPositions = db.getPositions().filter(p => (p.status === 'OPEN' || p.status === 'ADJUSTED') && (p.mode === 'PAPER' || !p.mode));
      let executedCount = 0;

      for (const opp of opportunities) {
        // Check if a PAPER position already exists for this strategy type or original strategy
        const existingPaper = activePaperPositions.find(
          p => p.strategy === opp.type || (p as any).originalStrategy === opp.type || p.tag?.includes(opp.type)
        );

        if (!existingPaper && opp.legs && opp.legs.length > 0) {
          const settings = db.getSettings();
          const symbol = settings.indexSymbol || 'NSE:NIFTY50-INDEX';
          const spotPrice = opp.spotPrice || await marketDataService.getLTP(symbol);
          const positionId = `paper_opp_${opp.type.toLowerCase()}_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`;

          const legs: Leg[] = opp.legs.map((l, idx) => ({
            id: `paper_leg_${idx}_${Date.now()}`,
            symbol: l.symbol,
            type: l.optionType || 'CE',
            strike: l.strike,
            side: l.side,
            qty: l.qty || 65,
            entryPrice: l.estimatedPrice || 100,
            currentPrice: l.estimatedPrice || 100,
            pnl: 0,
            isWing: l.side === 'BUY'
          }));

          const sellLegs = legs.filter(l => l.side === 'SELL');
          const initialPremiumSum = sellLegs.reduce((sum, l) => sum + l.entryPrice, 0);

          const paperPos: Position = {
            id: positionId,
            strategy: opp.type,
            tag: `[Auto Paper] ${opp.title}`,
            source: 'BOT_EXECUTED',
            symbol: symbol,
            indexEntryPrice: spotPrice,
            currentIndexPrice: spotPrice,
            status: 'OPEN',
            legs,
            totalPnl: 0,
            maxRisk: opp.maxRisk || 15000,
            maxReward: opp.expectedProfit || 10000,
            entryTime: new Date().toISOString(),
            updatedTime: new Date().toISOString(),
            adjustmentCount: 0,
            wingsAdded: opp.type === 'IRON_CONDOR' || opp.type === 'IRON_FLY_BREAKEVEN',
            mode: 'PAPER',
            initialCombinedPremium: Math.round(initialPremiumSum),
            breakevenUpper: opp.breakevenUpper || Math.round(spotPrice + 350),
            breakevenLower: opp.breakevenLower || Math.round(spotPrice - 350)
          };
          (paperPos as any).originalStrategy = opp.type;

          db.savePosition(paperPos);

          db.addTradeLog({
            action: 'ENTRY',
            symbol: symbol,
            strategy: opp.type,
            price: spotPrice,
            quantity: opp.legs[0]?.qty || 65,
            pnl: 0,
            mode: 'PAPER',
            notes: `Auto Paper Engine: Executed ${opp.title} at Spot ₹${spotPrice}. Initial Combined Premium: ₹${Math.round(initialPremiumSum)}.`
          });

          executedCount++;
          logger.info(`Automated Paper Engine: Executed Paper Trade for opportunity ${opp.type} (${opp.title})`);
        }
      }

      return { executed: executedCount, totalOpportunities: opportunities.length };
    } catch (err: any) {
      logger.error('Error in autoPaperTradeScannerOpportunities:', err);
      return { executed: 0, totalOpportunities: 0 };
    }
  }

  /**
   * Classic 4-Leg Iron Condor Strategy Monitor & Auto-Adjustment Engine:
   * 1. Dynamic Breakeven & Alert Thresholds:
   *    - Upper Breakeven = Short CE Strike + Net Credit
   *    - Lower Breakeven = Short PE Strike - Net Credit
   *    - Upper Alert = Short CE Strike - 50 (or Upper Breakeven - 75)
   *    - Lower Alert = Short PE Strike + 50 (or Lower Breakeven + 75)
   * 
   * 2. When Market Surges Up (Threatening Short CE side):
   *    - Short CE leg loses value (Call price increases)
   *    - Short PE leg + Long PE wing are WINNING (Put side decayed to low premium / in profit)
   *    - ADJUSTMENT ACTION: Close the winning Put Spread (buy back Short PE, sell Long PE wing)
   *      and ROLL UP the Put spread closer to spot (sell new higher OTM PE and buy higher OTM PE wing).
   *      This collects extra fresh credit, expands Upper Breakeven, and neutralizes positive delta!
   * 
   * 3. When Market Plunges Down (Threatening Short PE side):
   *    - Short PE leg loses value (Put price increases)
   *    - Short CE leg + Long CE wing are WINNING (Call side decayed to low premium / in profit)
   *    - ADJUSTMENT ACTION: Close the winning Call Spread (buy back Short CE, sell Long CE wing)
   *      and ROLL DOWN the Call spread closer to spot (sell new lower OTM CE and buy lower OTM CE wing).
   *      This collects extra fresh credit, expands Lower Breakeven, and neutralizes negative delta!
   * 
   * 4. Target Profit & Risk Caps:
   *    - If overall position P&L >= 75% of max possible credit, auto-square off all 4 legs to lock profit.
   */
  public async adjustClassicIronCondorPosition(position: Position, currentSpot: number): Promise<boolean> {
    const settings = db.getSettings();
    const expiryInfo = getNearestExpiryForSymbol(position.symbol || settings.indexSymbol);
    const dateCode = expiryInfo.fyersSymbolDateCode;
    const cleanSym = getFyersSymbolPrefix(position.symbol || settings.indexSymbol);
    const step = (cleanSym === 'NIFTY' || cleanSym === 'FINNIFTY') ? 50 : 100;
    const wingWidth = settings.wingBuffer || 200;

    // Identify current 4 legs
    const ceShort = position.legs.find(l => l.type === 'CE' && l.side === 'SELL');
    const ceLong = position.legs.find(l => l.type === 'CE' && l.side === 'BUY');
    const peShort = position.legs.find(l => l.type === 'PE' && l.side === 'SELL');
    const peLong = position.legs.find(l => l.type === 'PE' && l.side === 'BUY');

    if (!ceShort || !peShort) {
      return false;
    }

    // Calculate current net credit and dynamic breakevens
    const ceSpreadCredit = Math.max(0, (ceShort.entryPrice || 0) - (ceLong?.entryPrice || 0));
    const peSpreadCredit = Math.max(0, (peShort.entryPrice || 0) - (peLong?.entryPrice || 0));
    const totalNetCredit = Math.max(10, ceSpreadCredit + peSpreadCredit);

    const upperBreakeven = position.breakevenUpper || (ceShort.strike + Math.round(totalNetCredit));
    const lowerBreakeven = position.breakevenLower || (peShort.strike - Math.round(totalNetCredit));

    // Dynamic Alert Boundaries
    const upperAlertThreshold = Math.min(ceShort.strike - 50, upperBreakeven - 75);
    const lowerAlertThreshold = Math.max(peShort.strike + 50, lowerBreakeven + 75);

    // Target Profit Check: Auto Square Off if 75% of max net credit is realized
    const totalQty = ceShort.qty || settings.defaultQuantity || 65;
    const maxCreditValue = totalNetCredit * totalQty;
    if (maxCreditValue > 0 && position.totalPnl >= Math.round(maxCreditValue * 0.75)) {
      logger.info(`IRON CONDOR TARGET PROFIT (75%) REACHED! P&L ₹${position.totalPnl} >= ₹${Math.round(maxCreditValue * 0.75)}. Closing all legs!`);
      await this.closePosition(position.id, 'PROFIT_TARGET_75_PERCENT');
      return true;
    }

    // Cooldown check (prevent repeated rolls within 60 seconds)
    const lastAdjTime = position.updatedTime ? new Date(position.updatedTime).getTime() : 0;
    const isCoolingDown = Date.now() - lastAdjTime < 60000;
    if (isCoolingDown) {
      return false;
    }

    let adjusted = false;

    // -------------------------------------------------------------
    // SCENARIO 1: Bullish Rally -> Spot threatening Short CE Strike
    // -------------------------------------------------------------
    const isThreateningCall = currentSpot >= upperAlertThreshold;
    if (isThreateningCall && peShort) {
      const currentAtm = Math.round(currentSpot / step) * step;
      const newPeStrike = currentAtm - 150; // Move Put closer to spot (e.g. 150 pts below ATM)
      const newPeWingStrike = newPeStrike - wingWidth;

      if (peShort.strike < newPeStrike) {
        logger.info(`IRON CONDOR ADJUSTMENT TRIGGERED: Spot ₹${currentSpot} approaching Upper Alert (₹${upperAlertThreshold}). Rolling WINNING Put side UP to ₹${newPeStrike} to defend Short CE!`);

        // 1. Close the winning Put Spread (Short PE + Long PE Wing)
        const peClosePrice = await marketDataService.getLTP(peShort.symbol);
        const peRealizedPnl = Math.round((peShort.entryPrice - peClosePrice) * peShort.qty);

        db.addOrder({
          id: `ord_ic_pe_close_${Date.now()}`,
          positionId: position.id,
          symbol: peShort.symbol,
          side: 'BUY',
          qty: peShort.qty,
          price: peClosePrice,
          executedPrice: peClosePrice,
          status: 'FILLED',
          type: 'MARKET',
          mode: settings.mode,
          timestamp: new Date().toISOString()
        });

        if (settings.mode === 'LIVE') {
          await fyersService.placeOrder({ symbol: peShort.symbol, qty: peShort.qty, side: 'BUY', type: 'MARKET', productType: 'INTRADAY' }).catch(err => logger.error(`Live close PE error: ${err.message}`));
        }

        if (peLong) {
          const peLongClosePrice = await marketDataService.getLTP(peLong.symbol);
          db.addOrder({
            id: `ord_ic_pelong_close_${Date.now()}`,
            positionId: position.id,
            symbol: peLong.symbol,
            side: 'SELL',
            qty: peLong.qty,
            price: peLongClosePrice,
            executedPrice: peLongClosePrice,
            status: 'FILLED',
            type: 'MARKET',
            mode: settings.mode,
            timestamp: new Date().toISOString()
          });

          if (settings.mode === 'LIVE') {
            await fyersService.placeOrder({ symbol: peLong.symbol, qty: peLong.qty, side: 'SELL', type: 'MARKET', productType: 'INTRADAY' }).catch(err => logger.error(`Live close PE Wing error: ${err.message}`));
          }
        }

        // 2. Open new rolled higher Put Spread closer to current spot
        const newPeSymbol = `NSE:${cleanSym}${dateCode}${newPeStrike}PE`;
        const newPeWingSymbol = `NSE:${cleanSym}${dateCode}${newPeWingStrike}PE`;

        const newPePrice = await marketDataService.getLTP(newPeSymbol);
        const newPeWingPrice = await marketDataService.getLTP(newPeWingSymbol);

        db.addOrder({
          id: `ord_ic_pe_roll_open_${Date.now()}`,
          positionId: position.id,
          symbol: newPeSymbol,
          side: 'SELL',
          qty: peShort.qty,
          price: newPePrice,
          executedPrice: newPePrice,
          status: 'FILLED',
          type: 'MARKET',
          mode: settings.mode,
          timestamp: new Date().toISOString()
        });

        db.addOrder({
          id: `ord_ic_pewing_roll_open_${Date.now()}`,
          positionId: position.id,
          symbol: newPeWingSymbol,
          side: 'BUY',
          qty: peShort.qty,
          price: newPeWingPrice,
          executedPrice: newPeWingPrice,
          status: 'FILLED',
          type: 'MARKET',
          mode: settings.mode,
          timestamp: new Date().toISOString()
        });

        if (settings.mode === 'LIVE') {
          await fyersService.placeOrder({ symbol: newPeSymbol, qty: peShort.qty, side: 'SELL', type: 'MARKET', productType: 'INTRADAY' }).catch(err => logger.error(`Live open rolled PE error: ${err.message}`));
          await fyersService.placeOrder({ symbol: newPeWingSymbol, qty: peShort.qty, side: 'BUY', type: 'MARKET', productType: 'INTRADAY' }).catch(err => logger.error(`Live open rolled PE Wing error: ${err.message}`));
        }

        // 3. Update Position Legs
        peShort.symbol = newPeSymbol;
        peShort.strike = newPeStrike;
        peShort.entryPrice = newPePrice;
        peShort.currentPrice = newPePrice;
        peShort.pnl = 0;

        if (peLong) {
          peLong.symbol = newPeWingSymbol;
          peLong.strike = newPeWingStrike;
          peLong.entryPrice = newPeWingPrice;
          peLong.currentPrice = newPeWingPrice;
          peLong.pnl = 0;
        }

        // Recalculate expanded upper breakeven
        const newPeSpreadCredit = Math.max(0, newPePrice - newPeWingPrice);
        const updatedTotalCredit = Math.round(ceSpreadCredit + newPeSpreadCredit);
        position.breakevenUpper = ceShort.strike + updatedTotalCredit;
        position.breakevenLower = newPeStrike - updatedTotalCredit;
        position.status = 'ADJUSTED';
        position.adjustmentCount += 1;
        position.updatedTime = new Date().toISOString();
        adjusted = true;

        const details = `Iron Condor Adjustment: Market rallied to ₹${currentSpot} (threatened ${ceShort.strike} CE). Booked +₹${peRealizedPnl} on winning PE leg & rolled Put spread UP to ${newPeStrike} PE / ${newPeWingStrike} PE Wing. Collected fresh ₹${newPeSpreadCredit} credit!`;

        db.addAdjustment({
          id: `adj_${Date.now()}`,
          positionId: position.id,
          timestamp: new Date().toISOString(),
          conditionTriggered: `Spot ₹${currentSpot} approached Upper Alert boundary (₹${upperAlertThreshold})`,
          pnlAtAdjustment: position.totalPnl,
          indexPriceAtAdjustment: currentSpot,
          actionTaken: 'IRON_CONDOR_ROLL_UP_PE',
          wingsAdded: true,
          details,
          mode: settings.mode
        });

        db.addTradeLog({
          action: 'STRATEGY_ADJUSTMENT',
          symbol: position.symbol,
          strategy: 'IRON_CONDOR',
          price: currentSpot,
          quantity: peShort.qty,
          pnl: position.totalPnl,
          mode: settings.mode,
          notes: details
        });

        await notificationService.notify('IRON CONDOR ADJUSTMENT: Put Side Rolled Up', details, 'ADJUSTMENT');
        logger.success('IRON CONDOR ROLL UP PE COMPLETED', { positionId: position.id, newPeStrike, currentSpot });
      }
    }

    // -------------------------------------------------------------
    // SCENARIO 2: Bearish Drop -> Spot threatening Short PE Strike
    // -------------------------------------------------------------
    const isThreateningPut = currentSpot <= lowerAlertThreshold;
    if (isThreateningPut && ceShort) {
      const currentAtm = Math.round(currentSpot / step) * step;
      const newCeStrike = currentAtm + 150; // Move Call closer to spot (e.g. 150 pts above ATM)
      const newCeWingStrike = newCeStrike + wingWidth;

      if (ceShort.strike > newCeStrike) {
        logger.info(`IRON CONDOR ADJUSTMENT TRIGGERED: Spot ₹${currentSpot} approaching Lower Alert (₹${lowerAlertThreshold}). Rolling WINNING Call side DOWN to ₹${newCeStrike} to defend Short PE!`);

        // 1. Close the winning Call Spread (Short CE + Long CE Wing)
        const ceClosePrice = await marketDataService.getLTP(ceShort.symbol);
        const ceRealizedPnl = Math.round((ceShort.entryPrice - ceClosePrice) * ceShort.qty);

        db.addOrder({
          id: `ord_ic_ce_close_${Date.now()}`,
          positionId: position.id,
          symbol: ceShort.symbol,
          side: 'BUY',
          qty: ceShort.qty,
          price: ceClosePrice,
          executedPrice: ceClosePrice,
          status: 'FILLED',
          type: 'MARKET',
          mode: settings.mode,
          timestamp: new Date().toISOString()
        });

        if (settings.mode === 'LIVE') {
          await fyersService.placeOrder({ symbol: ceShort.symbol, qty: ceShort.qty, side: 'BUY', type: 'MARKET', productType: 'INTRADAY' }).catch(err => logger.error(`Live close CE error: ${err.message}`));
        }

        if (ceLong) {
          const ceLongClosePrice = await marketDataService.getLTP(ceLong.symbol);
          db.addOrder({
            id: `ord_ic_celong_close_${Date.now()}`,
            positionId: position.id,
            symbol: ceLong.symbol,
            side: 'SELL',
            qty: ceLong.qty,
            price: ceLongClosePrice,
            executedPrice: ceLongClosePrice,
            status: 'FILLED',
            type: 'MARKET',
            mode: settings.mode,
            timestamp: new Date().toISOString()
          });

          if (settings.mode === 'LIVE') {
            await fyersService.placeOrder({ symbol: ceLong.symbol, qty: ceLong.qty, side: 'SELL', type: 'MARKET', productType: 'INTRADAY' }).catch(err => logger.error(`Live close CE Wing error: ${err.message}`));
          }
        }

        // 2. Open new rolled lower Call Spread closer to current spot
        const newCeSymbol = `NSE:${cleanSym}${dateCode}${newCeStrike}CE`;
        const newCeWingSymbol = `NSE:${cleanSym}${dateCode}${newCeWingStrike}CE`;

        const newCePrice = await marketDataService.getLTP(newCeSymbol);
        const newCeWingPrice = await marketDataService.getLTP(newCeWingSymbol);

        db.addOrder({
          id: `ord_ic_ce_roll_open_${Date.now()}`,
          positionId: position.id,
          symbol: newCeSymbol,
          side: 'SELL',
          qty: ceShort.qty,
          price: newCePrice,
          executedPrice: newCePrice,
          status: 'FILLED',
          type: 'MARKET',
          mode: settings.mode,
          timestamp: new Date().toISOString()
        });

        db.addOrder({
          id: `ord_ic_cewing_roll_open_${Date.now()}`,
          positionId: position.id,
          symbol: newCeWingSymbol,
          side: 'BUY',
          qty: ceShort.qty,
          price: newCeWingPrice,
          executedPrice: newCeWingPrice,
          status: 'FILLED',
          type: 'MARKET',
          mode: settings.mode,
          timestamp: new Date().toISOString()
        });

        if (settings.mode === 'LIVE') {
          await fyersService.placeOrder({ symbol: newCeSymbol, qty: ceShort.qty, side: 'SELL', type: 'MARKET', productType: 'INTRADAY' }).catch(err => logger.error(`Live open rolled CE error: ${err.message}`));
          await fyersService.placeOrder({ symbol: newCeWingSymbol, qty: ceShort.qty, side: 'BUY', type: 'MARKET', productType: 'INTRADAY' }).catch(err => logger.error(`Live open rolled CE Wing error: ${err.message}`));
        }

        // 3. Update Position Legs
        ceShort.symbol = newCeSymbol;
        ceShort.strike = newCeStrike;
        ceShort.entryPrice = newCePrice;
        ceShort.currentPrice = newCePrice;
        ceShort.pnl = 0;

        if (ceLong) {
          ceLong.symbol = newCeWingSymbol;
          ceLong.strike = newCeWingStrike;
          ceLong.entryPrice = newCeWingPrice;
          ceLong.currentPrice = newCeWingPrice;
          ceLong.pnl = 0;
        }

        // Recalculate expanded lower breakeven
        const newCeSpreadCredit = Math.max(0, newCePrice - newCeWingPrice);
        const updatedTotalCredit = Math.round(newCeSpreadCredit + peSpreadCredit);
        position.breakevenUpper = newCeStrike + updatedTotalCredit;
        position.breakevenLower = peShort.strike - updatedTotalCredit;
        position.status = 'ADJUSTED';
        position.adjustmentCount += 1;
        position.updatedTime = new Date().toISOString();
        adjusted = true;

        const details = `Iron Condor Adjustment: Market dropped to ₹${currentSpot} (threatened ${peShort.strike} PE). Booked +₹${ceRealizedPnl} on winning CE leg & rolled Call spread DOWN to ${newCeStrike} CE / ${newCeWingStrike} CE Wing. Collected fresh ₹${newCeSpreadCredit} credit!`;

        db.addAdjustment({
          id: `adj_${Date.now()}`,
          positionId: position.id,
          timestamp: new Date().toISOString(),
          conditionTriggered: `Spot ₹${currentSpot} approached Lower Alert boundary (₹${lowerAlertThreshold})`,
          pnlAtAdjustment: position.totalPnl,
          indexPriceAtAdjustment: currentSpot,
          actionTaken: 'IRON_CONDOR_ROLL_DOWN_CE',
          wingsAdded: true,
          details,
          mode: settings.mode
        });

        db.addTradeLog({
          action: 'STRATEGY_ADJUSTMENT',
          symbol: position.symbol,
          strategy: 'IRON_CONDOR',
          price: currentSpot,
          quantity: ceShort.qty,
          pnl: position.totalPnl,
          mode: settings.mode,
          notes: details
        });

        await notificationService.notify('IRON CONDOR ADJUSTMENT: Call Side Rolled Down', details, 'ADJUSTMENT');
        logger.success('IRON CONDOR ROLL DOWN CE COMPLETED', { positionId: position.id, newCeStrike, currentSpot });
      }
    }

    return adjusted;
  }
}

export const strategyEngine = new StrategyEngine();

