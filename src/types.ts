export type TradingMode = 'PAPER' | 'LIVE';

export interface Leg {
  id: string;
  symbol: string;
  type: 'CE' | 'PE' | 'FUT' | 'EQUITY';
  strike?: number;
  side: 'BUY' | 'SELL';
  qty: number;
  entryPrice: number;
  currentPrice: number;
  pnl: number;
  isWing?: boolean;
  isAdditionalLeg?: boolean;
}

export interface Position {
  id: string;
  strategy: 'SHORT_STRADDLE' | 'IRON_CONDOR' | 'SHORT_STRANGLE' | 'CASH_CARRY_ARBITRAGE' | 'SYNTHETIC_ARBITRAGE' | 'IRON_FLY_BREAKEVEN' | 'MONTHLY_SHORT_STRADDLE' | string;
  tag?: string;
  source?: 'BOT_EXECUTED' | 'FYERS_SYNCED' | 'MANUAL_IMPORT';
  notes?: string;
  symbol: string;
  indexEntryPrice: number;
  currentIndexPrice: number;
  status: 'OPEN' | 'ADJUSTED' | 'CLOSED';
  legs: Leg[];
  totalPnl: number;
  maxRisk: number;
  maxReward: number;
  entryTime: string;
  updatedTime: string;
  exitTime?: string;
  exitReason?: string;
  adjustmentCount: number;
  wingsAdded: boolean;
  mode: TradingMode;

  breakevenUpper?: number;
  breakevenLower?: number;
  initialCombinedPremium?: number;
  additionalLegsAdded?: boolean;
  continuationAdjusted?: boolean;
  noLossLocked?: boolean;
  straddleState?: 'INITIAL' | 'SCENARIO_1' | 'SCENARIO_2' | 'SCENARIO_3' | 'NO_LOSS_LOCKED';
}

export interface Order {
  id: string;
  positionId?: string;
  fyersOrderId?: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  qty: number;
  price: number;
  executedPrice?: number;
  status: 'PENDING' | 'FILLED' | 'CANCELLED' | 'REJECTED';
  type: 'MARKET' | 'LIMIT';
  mode: TradingMode;
  timestamp: string;
}

export interface AdjustmentLog {
  id: string;
  positionId: string;
  timestamp: string;
  conditionTriggered: string;
  pnlAtAdjustment: number;
  indexPriceAtAdjustment: number;
  actionTaken: string;
  wingsAdded: boolean;
  details: string;
  mode: TradingMode;
}

export interface TradeLogRecord {
  id: string;
  timestamp: string;
  action: string;
  symbol: string;
  strategy: string;
  price: number;
  quantity: number;
  pnl: number;
  mode: TradingMode;
  notes: string;
  userEmail?: string;
}

export interface SystemLog {
  id: string;
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'success';
  message: string;
  metadata?: any;
}

export interface Settings {
  mode: TradingMode;
  capital: number;
  capitalAllocationPct: number;
  fyersAvailableFunds?: number;
  fyersTotalFunds?: number;
  indexSymbol: string;
  strikeDistance: number;
  wingBuffer: number;
  defaultQuantity: number;
  monthlyMaxLossPct: number;
  perTradeMaxLossPct: number;
  autoTradingEnabled: boolean;
  fyId?: string;
  fyersAppId: string;
  fyersSecretKey: string;
  fyersRedirectUri: string;
  fyersPin: string;
  fyersTotpKey?: string;
  fyersAppType?: string;
  fyersAppIdType?: string;
  fyersAppIdHash?: string;
  telegramBotToken?: string;
  telegramChatId?: string;
  slackWebhookUrl?: string;
  vixThreshold?: number;
  vixAutoAdjustEnabled?: boolean;
  cronIntervalSeconds: number;
}

export interface OptionChainItem {
  strike: number;
  ce: {
    symbol: string;
    ltp: number;
    iv: number;
    oi: number;
    change: number;
  };
  pe: {
    symbol: string;
    ltp: number;
    iv: number;
    oi: number;
    change: number;
  };
}

export interface StrategyRuleConfig {
  id: string;
  strategyId: string;
  name: string;
  category: 'SHORT_STRADDLE' | 'IRON_CONDOR' | 'ARBITRAGE' | 'SPREAD' | 'CUSTOM';
  description: string;
  author: string;
  isPublic: boolean;
  isSubscribed: boolean;
  targetProfitPct: number;
  stopLossPct: number;
  maxLossPerLot: number;
  wingBufferPts: number;
  strikeDistancePts: number;
  deltaNeutralThreshold: number;
  rulesNotes: string;
  createdAt: string;
}

export interface OpportunityLeg {
  symbol: string;
  side: 'BUY' | 'SELL';
  qty: number;
  estimatedPrice: number;
  strike?: number;
  optionType?: 'CE' | 'PE' | 'FUT' | 'EQUITY';
  delta: number;
  theta: number;
  gamma: number;
  vega: number;
  iv: number;
}

export interface Opportunity {
  id: string;
  type: 'IRON_CONDOR' | 'SHORT_STRADDLE' | 'CASH_CARRY_ARBITRAGE' | 'SYNTHETIC_ARBITRAGE';
  title: string;
  description: string;
  symbol: string;
  spotPrice: number;
  expiryDate: string;
  daysToExpiry: number;
  lotSize: number;
  numberOfLots: number;
  totalQty: number;
  requiredMargin: number;
  expectedProfit: number;
  maxRisk: number;
  winProbabilityPct: number;
  weeklyReturnPct: number;
  annualizedYieldPct: number;
  breakevenLower: number;
  breakevenUpper: number;
  riskScore: 'LOW' | 'MEDIUM' | 'HIGH';
  status: 'ACTIVE' | 'EXECUTED' | 'EXPIRED';
  timestamp: string;
  greeks: {
    netDelta: number;
    netTheta: number;
    netGamma: number;
    netVega: number;
    avgIV: number;
  };
  payoffPoints: { spot: number; pnl: number }[];
  legs: OpportunityLeg[];
}

export interface UserAccessCode {
  id?: string;
  userId: string;
  userEmail?: string;
  accessCode?: string;
  accessToken: string;
  expiresAt: number;
  isValid: boolean;
  tokenType?: string;
  fyId?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface VixData {
  vix: number;
  prevClose: number;
  change: number;
  pctChange: number;
  isHighVol: boolean;
  threshold: number;
  recommendedWingWidth: number;
  recommendedStrikeBuffer: number;
  recommendationReason: string;
  strategySuggestion: string;
  strikes: {
    shortCall: number;
    longCall: number;
    shortPut: number;
    longPut: number;
  };
}

