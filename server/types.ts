export type TradingMode = 'PAPER' | 'LIVE';

export type PositionStatus = 'OPEN' | 'ADJUSTED' | 'CLOSED';

export type PositionType = 'SHORT_STRADDLE' | 'IRON_CONDOR' | 'SHORT_STRANGLE' | 'CASH_CARRY_ARBITRAGE' | 'SYNTHETIC_ARBITRAGE' | 'IRON_FLY_BREAKEVEN' | 'MONTHLY_SHORT_STRADDLE' | string;

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
  strategy: PositionType;
  tag?: string;
  source?: 'BOT_EXECUTED' | 'FYERS_SYNCED' | 'MANUAL_IMPORT' | 'MANUAL_ENTRY' | 'PAPER';
  notes?: string;
  symbol: string;
  indexEntryPrice: number;
  currentIndexPrice: number;
  status: PositionStatus;
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

  // Metadata for custom strategy rules
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

export interface Settings {
  mode: TradingMode;
  capital: number;
  capitalAllocationPct: number; // Percentage of available funds to allocate (e.g. 10%, 50%, 100%)
  fyersAvailableFunds?: number;
  fyersTotalFunds?: number;
  indexSymbol: string;
  strikeDistance: number; // e.g. 500 points for straddle/strangle
  wingBuffer: number;    // e.g. 300 points further OTM for protective wings
  defaultQuantity: number; // e.g. 50
  monthlyMaxLossPct: number; // e.g. 5%
  perTradeMaxLossPct: number; // e.g. 2%
  autoTradingEnabled: boolean;
  
  // Fyers API credentials
  fyId?: string;
  fyersAppId: string;
  fyersSecretKey: string;
  fyersRedirectUri: string;
  fyersPin: string;
  fyersTotpKey?: string;
  fyersAppType?: string;
  fyersAppIdType?: string;
  fyersAppIdHash?: string;

  // Notifications
  telegramBotToken?: string;
  telegramChatId?: string;
  slackWebhookUrl?: string;

  // Volatility & VIX Threshold Alerts
  vixThreshold?: number; // e.g. 15.5
  vixAutoAdjustEnabled?: boolean;

  // Cron schedule interval
  cronIntervalSeconds: number;
}

export interface FyersTokenData {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number; // Unix timestamp
  authCode?: string;
  isValid: boolean;
  updatedAt: string;
  tokenType?: string;
  source?: string;
  userEmail?: string;
  userId?: string;
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
