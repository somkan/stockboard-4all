export function getClientExpiryDetails(symbol: string, baseDate: Date = new Date(), customExpiryDay?: number) {
  const sym = symbol.toUpperCase();
  const now = new Date(baseDate);

  let targetWeekday = 2; // Default Tuesday for NIFTY per user requirement
  let dayName = 'Tuesday';

  if (sym.includes('BANKNIFTY')) {
    targetWeekday = 3; // Wednesday
    dayName = 'Wednesday';
  } else if (sym.includes('FINNIFTY')) {
    targetWeekday = 2; // Tuesday
    dayName = 'Tuesday';
  } else if (sym.includes('MIDCPNIFTY')) {
    targetWeekday = 1; // Monday
    dayName = 'Monday';
  } else if (sym.includes('SENSEX')) {
    targetWeekday = 5; // Friday
    dayName = 'Friday';
  } else if (sym.includes('NIFTY')) {
    targetWeekday = customExpiryDay !== undefined ? customExpiryDay : 2; // Tuesday
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    dayName = dayNames[targetWeekday] || 'Tuesday';
  }

  const currentDay = now.getDay();
  let daysDiff = targetWeekday - currentDay;

  const utcHours = now.getUTCHours();
  const utcMinutes = now.getUTCMinutes();
  const istMinutes = utcHours * 60 + utcMinutes + 330;
  const isPast330PM = istMinutes >= (15 * 60 + 30);

  if (daysDiff < 0 || (daysDiff === 0 && isPast330PM)) {
    daysDiff += 7;
  }

  const expiryDateObj = new Date(now);
  expiryDateObj.setDate(now.getDate() + daysDiff);

  const dayNum = String(expiryDateObj.getDate()).padStart(2, '0');
  const monthNames = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const monthStr = monthNames[expiryDateObj.getMonth()];
  const yearFull = expiryDateObj.getFullYear();

  const monthCodes = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "O", "N", "D"];
  const monthCode = monthCodes[expiryDateObj.getMonth()];
  const yearShort = String(yearFull).slice(-2);
  const fyersWeeklyDateCode = `${yearShort}${monthCode}${dayNum}`;
  const fyersMonthlyDateCode = `${yearShort}${monthStr}`;

  // Check if monthly expiry
  const nextWeekSameDay = new Date(expiryDateObj);
  nextWeekSameDay.setDate(expiryDateObj.getDate() + 7);
  const isMonthly = nextWeekSameDay.getMonth() !== expiryDateObj.getMonth();

  const fyersDateCode = isMonthly ? fyersMonthlyDateCode : fyersWeeklyDateCode;

  return {
    expiryDate: `${dayNum}-${monthStr}-${yearFull}`,
    dayName,
    daysToExpiry: Math.max(0, daysDiff),
    fyersDateCode
  };
}

/**
 * Intelligent strategy classifier for client-side auto-identification
 */
export function clientDetectOptionStrategy(legs: Array<{ type: string; side: string; strike?: number; qty?: number }>): {
  strategy: string;
  tag: string;
  description: string;
} {
  const optLegs = legs.filter(l => l.type === 'CE' || l.type === 'PE');
  if (optLegs.length === 0) {
    return {
      strategy: 'EQUITY_HOLDINGS',
      tag: 'FYERS_EQUITY_PORTFOLIO',
      description: 'Equity / Cash Portfolio'
    };
  }

  const sellLegs = optLegs.filter(l => l.side === 'SELL');
  const buyLegs = optLegs.filter(l => l.side === 'BUY');
  const ceSells = sellLegs.filter(l => l.type === 'CE');
  const peSells = sellLegs.filter(l => l.type === 'PE');
  const ceBuys = buyLegs.filter(l => l.type === 'CE');
  const peBuys = buyLegs.filter(l => l.type === 'PE');

  // 2 Legs: 1 Short CE + 1 Short PE
  if (sellLegs.length === 2 && buyLegs.length === 0 && ceSells.length === 1 && peSells.length === 1) {
    const ceStrike = ceSells[0].strike || 0;
    const peStrike = peSells[0].strike || 0;

    if (ceStrike === peStrike) {
      return {
        strategy: 'SHORT_STRADDLE',
        tag: `FYERS_SHORT_STRADDLE_${ceStrike}`,
        description: `Short Straddle @ Strike ₹${ceStrike}`
      };
    } else {
      return {
        strategy: 'SHORT_STRANGLE',
        tag: `FYERS_SHORT_STRANGLE_${peStrike}_${ceStrike}`,
        description: `Short Strangle (PE ${peStrike} / CE ${ceStrike})`
      };
    }
  }

  // 4 Legs: 2 Short + 2 Long (Iron Condor or Iron Fly)
  if (sellLegs.length === 2 && buyLegs.length === 2 && ceSells.length === 1 && peSells.length === 1 && ceBuys.length === 1 && peBuys.length === 1) {
    const ceSellStrike = ceSells[0].strike || 0;
    const peSellStrike = peSells[0].strike || 0;

    if (ceSellStrike === peSellStrike) {
      return {
        strategy: 'IRON_FLY_BREAKEVEN',
        tag: `FYERS_IRON_FLY_${ceSellStrike}`,
        description: `Iron Fly Breakeven @ ATM ₹${ceSellStrike}`
      };
    } else {
      return {
        strategy: 'IRON_CONDOR',
        tag: `FYERS_IRON_CONDOR_${peSellStrike}_${ceSellStrike}`,
        description: `Iron Condor (Short ${peSellStrike}PE / ${ceSellStrike}CE with Wings)`
      };
    }
  }

  // Single Call Credit Spread (1 Short CE + 1 Long CE)
  if (ceSells.length === 1 && ceBuys.length === 1 && peSells.length === 0 && peBuys.length === 0) {
    return {
      strategy: 'CALL_CREDIT_SPREAD',
      tag: `FYERS_BEAR_CALL_SPREAD_${ceSells[0].strike}`,
      description: `Bear Call Spread (Sell ${ceSells[0].strike}CE / Buy ${ceBuys[0].strike}CE)`
    };
  }

  // Single Put Credit Spread (1 Short PE + 1 Long PE)
  if (peSells.length === 1 && peBuys.length === 1 && ceSells.length === 0 && ceBuys.length === 0) {
    return {
      strategy: 'PUT_CREDIT_SPREAD',
      tag: `FYERS_BULL_PUT_SPREAD_${peSells[0].strike}`,
      description: `Bull Put Spread (Sell ${peSells[0].strike}PE / Buy ${peBuys[0].strike}PE)`
    };
  }

  // 1 Short CE only
  if (ceSells.length === 1 && optLegs.length === 1) {
    return {
      strategy: 'NAKED_CALL_OPTION',
      tag: `FYERS_SHORT_CALL_${ceSells[0].strike}`,
      description: `Naked Short Call @ ₹${ceSells[0].strike}`
    };
  }

  // 1 Short PE only
  if (peSells.length === 1 && optLegs.length === 1) {
    return {
      strategy: 'NAKED_PUT_OPTION',
      tag: `FYERS_SHORT_PUT_${peSells[0].strike}`,
      description: `Naked Short Put @ ₹${peSells[0].strike}`
    };
  }

  // Fallback
  return {
    strategy: 'CUSTOM_STRATEGY',
    tag: `FYERS_LIVE_TRADE_${optLegs.length}LEGS`,
    description: `Multi-leg Option Position (${optLegs.length} legs)`
  };
}


