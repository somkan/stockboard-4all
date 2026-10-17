import { logger } from './logger.js';
import { db } from './db.js';

export interface ExpiryDetails {
  symbol: string;
  expiryDate: string; // e.g. "11-AUG-2026"
  expiryDayName: string; // e.g. "Tuesday"
  daysToExpiry: number; // e.g. 3
  fyersSymbolDateCode: string; // e.g. "26AUG"
  isTodayExpiry: boolean;
}

/**
 * Calculates the exact nearest weekly or monthly expiry date for Indian market symbols.
 * Schedules:
 * - NIFTY / NIFTY 50: Tuesday (Day 2)
 * - BANK NIFTY: Wednesday (Day 3) / Thursday (Day 4)
 * - FIN NIFTY: Tuesday (Day 2)
 * - MIDCP NIFTY: Monday (Day 1)
 * - BSE SENSEX: Friday (Day 5)
 * - Stock Options / Equities: Last Thursday of the month
 */
export function getNearestExpiryForSymbol(symbol: string, baseDate: Date = new Date(), customExpiryDay?: number): ExpiryDetails {
  const sym = symbol.toUpperCase();
  const now = new Date(baseDate);

  // Determine target weekday (0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat)
  let targetWeekday = 2; // Default Tuesday for NIFTY per user specification
  let dayName = 'Tuesday';

  if (sym.includes('BANKNIFTY')) {
    targetWeekday = 3; // Wednesday for BANKNIFTY
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
    // NIFTY 50 / NIFTY INDEX
    targetWeekday = customExpiryDay !== undefined ? customExpiryDay : 2; // Tuesday
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    dayName = dayNames[targetWeekday] || 'Tuesday';
  } else if (!sym.includes('INDEX') && (sym.includes('RELIANCE') || sym.includes('TCS') || sym.includes('INFY'))) {
    // Stock options expire on the LAST Thursday of the month
    targetWeekday = 4;
    dayName = 'Last Thursday';
  }

  const currentDay = now.getDay();
  let daysDiff = targetWeekday - currentDay;

  // If today is the target day, check if past market close (15:30 IST / 03:30 PM)
  // IST is UTC+5:30
  const utcHours = now.getUTCHours();
  const utcMinutes = now.getUTCMinutes();
  const istMinutes = utcHours * 60 + utcMinutes + 330;
  const isPast330PM = istMinutes >= (15 * 60 + 30);

  if (daysDiff < 0 || (daysDiff === 0 && isPast330PM)) {
    daysDiff += 7; // Target next week
  }

  const expiryDateObj = new Date(now);
  expiryDateObj.setDate(now.getDate() + daysDiff);

  const dayNum = String(expiryDateObj.getDate()).padStart(2, '0');
  const monthNames = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const monthStr = monthNames[expiryDateObj.getMonth()];
  const yearFull = expiryDateObj.getFullYear();
  const yearShort = String(yearFull).slice(-2);

  const formattedDate = `${dayNum}-${monthStr}-${yearFull}`;
  const isToday = daysDiff === 0 && !isPast330PM;

  // Determine if expiry is Monthly (last target weekday of month) or Weekly
  const nextWeekSameDay = new Date(expiryDateObj);
  nextWeekSameDay.setDate(expiryDateObj.getDate() + 7);
  const isMonthly = nextWeekSameDay.getMonth() !== expiryDateObj.getMonth();

  const monthCodes = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "O", "N", "D"];
  const monthCode = monthCodes[expiryDateObj.getMonth()];
  const fyersWeeklyDateCode = `${yearShort}${monthCode}${dayNum}`;
  const fyersMonthlyDateCode = `${yearShort}${monthStr}`;

  // FYERS symbol date code: Weekly format (e.g. 26818) or Monthly format (e.g. 26AUG)
  const fyersSymbolDateCode = isMonthly ? fyersMonthlyDateCode : fyersWeeklyDateCode;

  return {
    symbol,
    expiryDate: formattedDate,
    expiryDayName: dayName,
    daysToExpiry: Math.max(0, daysDiff),
    fyersSymbolDateCode,
    isTodayExpiry: isToday
  };
}

/**
 * Returns exact FYERS / NSE contract lot size for a given index or equity symbol
 */
export function getLotSizeForSymbol(symbol: string): number {
  const upper = symbol.toUpperCase();
  if (upper.includes('BANKNIFTY') || upper.includes('NIFTYBANK')) return 15;
  if (upper.includes('FINNIFTY')) return 25;
  if (upper.includes('MIDCPNIFTY') || upper.includes('MIDSELECT')) return 50;
  if (upper.includes('SENSEX')) return 10;
  if (upper.includes('RELIANCE')) return 250;
  if (upper.includes('TCS')) return 175;
  if (upper.includes('INFY')) return 300;
  // Default NSE NIFTY 50 lot size is 65
  return 65;
}

/**
 * Returns clean FYERS symbol prefix for option contract generation.
 * Maps 'NSE:NIFTY50-INDEX' -> 'NIFTY' (as FYERS option symbols are NSE:NIFTY26AUG... not NSE:NIFTY50...)
 */
export function getFyersSymbolPrefix(symbol: string): string {
  if (!symbol) return 'NIFTY';
  const sym = symbol.toUpperCase();
  if (sym.includes('BANKNIFTY') || sym.includes('NIFTYBANK')) return 'BANKNIFTY';
  if (sym.includes('FINNIFTY')) return 'FINNIFTY';
  if (sym.includes('MIDCPNIFTY') || sym.includes('MIDSELECT')) return 'MIDCPNIFTY';
  if (sym.includes('SENSEX')) return 'SENSEX';
  if (sym.includes('NIFTY')) return 'NIFTY';

  return symbol.replace('NSE:', '').replace('BSE:', '').replace('-INDEX', '').replace('-EQ', '').replace('50', '');
}

/**
 * Parses any FYERS weekly or monthly option symbol into strike, option type, expiry code, and underlying
 * Handles:
 * - Weekly format: NSE:NIFTY2681824800CE -> underlying: 'NIFTY', dateCode: '26818', strike: 24800, type: 'CE'
 * - Monthly format: NSE:NIFTY26AUG24500PE -> underlying: 'NIFTY', dateCode: '26AUG', strike: 24500, type: 'PE'
 */
export function parseFyersOptionSymbol(symbol: string): {
  underlying: string;
  strike: number;
  type: 'CE' | 'PE' | 'FUT' | 'EQUITY';
  dateCode: string;
  expiryFormatted?: string;
  isValid: boolean;
} {
  if (!symbol) return { underlying: '', strike: 0, type: 'EQUITY', dateCode: '', isValid: false };
  const clean = symbol.replace(/^(NSE|BSE):/, '').trim();

  // Match option pattern: e.g. NIFTY 26818 24800 CE or NIFTY 26AUG 24500 PE or BANKNIFTY 26819 51000 CE
  const optMatch = clean.match(/^([A-Z]+)(\d{2}[0-9OND][0-9]{2}|\d{2}[A-Z]{3})(\d{4,6})(CE|PE)$/i);
  if (optMatch) {
    const underlying = optMatch[1];
    const dateCode = optMatch[2].toUpperCase();
    const strike = parseInt(optMatch[3], 10);
    const type = optMatch[4].toUpperCase() as 'CE' | 'PE';
    return {
      underlying,
      strike,
      type,
      dateCode,
      isValid: true
    };
  }

  // Fallback for monthly format with alternative pattern
  const monthMatch = clean.match(/^([A-Z]+)(\d{2}[A-Z]{3,4})(\d{4,6})(CE|PE)$/i);
  if (monthMatch) {
    return {
      underlying: monthMatch[1],
      strike: parseInt(monthMatch[3], 10),
      type: monthMatch[4].toUpperCase() as 'CE' | 'PE',
      dateCode: monthMatch[2].toUpperCase(),
      isValid: true
    };
  }

  // General fallback for strike & type
  const strikeMatch = clean.match(/(\d{4,6})(CE|PE)$/i);
  if (strikeMatch) {
    return {
      underlying: 'NIFTY',
      strike: parseInt(strikeMatch[1], 10),
      type: strikeMatch[2].toUpperCase() as 'CE' | 'PE',
      dateCode: '',
      isValid: true
    };
  }

  const isFut = clean.includes('FUT');
  return {
    underlying: clean,
    strike: 0,
    type: isFut ? 'FUT' : 'EQUITY',
    dateCode: '',
    isValid: false
  };
}

/**
 * Intelligent strategy classifier: Given an array of option & equity legs, automatically identifies
 * exact strategy pattern: SHORT_STRANGLE, SHORT_STRADDLE, IRON_CONDOR, IRON_FLY, CREDIT_SPREAD, etc.
 */
export function detectOptionStrategy(legs: Array<{ type: string; side: string; strike?: number; qty: number }>): {
  strategy: string;
  tag: string;
  description: string;
} {
  const optLegs = legs.filter(l => l.type === 'CE' || l.type === 'PE');
  if (optLegs.length === 0) {
    return {
      strategy: 'EQUITY_HOLDINGS',
      tag: 'FYERS_EQUITY_PORTFOLIO',
      description: 'Equity / Cash Portfolio Holdings'
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
      description: `Bear Call Credit Spread (Sell ${ceSells[0].strike}CE / Buy ${ceBuys[0].strike}CE)`
    };
  }

  // Single Put Credit Spread (1 Short PE + 1 Long PE)
  if (peSells.length === 1 && peBuys.length === 1 && ceSells.length === 0 && ceBuys.length === 0) {
    return {
      strategy: 'PUT_CREDIT_SPREAD',
      tag: `FYERS_BULL_PUT_SPREAD_${peSells[0].strike}`,
      description: `Bull Put Credit Spread (Sell ${peSells[0].strike}PE / Buy ${peBuys[0].strike}PE)`
    };
  }

  // 1 Short CE only
  if (ceSells.length === 1 && optLegs.length === 1) {
    return {
      strategy: 'NAKED_CALL_OPTION',
      tag: `FYERS_SHORT_CALL_${ceSells[0].strike}`,
      description: `Naked Short Call Option @ ₹${ceSells[0].strike}`
    };
  }

  // 1 Short PE only
  if (peSells.length === 1 && optLegs.length === 1) {
    return {
      strategy: 'NAKED_PUT_OPTION',
      tag: `FYERS_SHORT_PUT_${peSells[0].strike}`,
      description: `Naked Short Put Option @ ₹${peSells[0].strike}`
    };
  }

  // Fallback
  return {
    strategy: 'CUSTOM_STRATEGY',
    tag: `FYERS_LIVE_TRADE_${optLegs.length}LEGS`,
    description: `Multi-leg Option Position (${optLegs.length} legs)`
  };
}


