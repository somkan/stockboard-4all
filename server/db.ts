import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import initSqlJs, { Database } from 'sql.js';
import { Settings, FyersTokenData, Position, Order, AdjustmentLog, TradeLogRecord, StrategyRuleConfig } from './types.js';
import { logger } from './logger.js';

const DATA_DIR = path.join(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'trading.sqlite');

const DUMMY_HASH_PLACEHOLDER = '5593718a0e9e2e8f01ba03f0a8415502cff7f0be93cdd7ac201186d0cce0406d';

const defaultSettings: Settings = {
  mode: 'PAPER',
  capital: 100000,
  capitalAllocationPct: 100,
  fyersAvailableFunds: 0,
  fyersTotalFunds: 0,
  indexSymbol: 'NSE:NIFTY50-INDEX',
  strikeDistance: 500,
  wingBuffer: 300,
  defaultQuantity: 65,
  monthlyMaxLossPct: 5,
  perTradeMaxLossPct: 2,
  autoTradingEnabled: true,

  fyId: process.env.FY_ID || 'XS06414',
  fyersAppId: process.env.FYERS_APP_ID || 'V78VJBA972-100',
  fyersSecretKey: process.env.FYERS_SECRET_KEY || '',
  fyersRedirectUri: process.env.FYERS_REDIRECT_URI || 'https://127.0.0.1:6414',
  fyersPin: process.env.FYERS_PIN || '6479',
  fyersTotpKey: process.env.FYERS_TOTP_KEY || '7F3HAO6UV2J5RZZR6HYB325LKKKX4YSV',
  fyersAppType: process.env.FYERS_APP_TYPE || '100',
  fyersAppIdType: process.env.FYERS_APP_ID_TYPE || '2',
  fyersAppIdHash: process.env.FYERS_APP_ID_HASH || '',

  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL || '',
  vixThreshold: 15.5,
  vixAutoAdjustEnabled: false,
  cronIntervalSeconds: 60
};

const defaultFyersAuth: FyersTokenData = {
  accessToken: '',
  refreshToken: '',
  expiresAt: 0,
  isValid: false,
  updatedAt: new Date().toISOString()
};

let sqlFactory: any = null;

class SqliteDatabaseManager {
  private db: Database | null = null;
  private initPromise: Promise<void> | null = null;
  private inMemoryFallback: {
    settings: Settings;
    fyersAuth: FyersTokenData;
    positions: Position[];
    orders: Order[];
    adjustments: AdjustmentLog[];
    tradeLogs: TradeLogRecord[];
    strategies: StrategyRuleConfig[];
    userAccessCodes: Map<string, FyersTokenData>;
  };

  constructor() {
    this.inMemoryFallback = {
      settings: { ...defaultSettings },
      fyersAuth: { ...defaultFyersAuth },
      positions: [],
      orders: [],
      adjustments: [],
      tradeLogs: [],
      strategies: [],
      userAccessCodes: new Map()
    };
  }

  public async init(): Promise<void> {
    if (this.db) return;
    if (!this.initPromise) {
      this.initPromise = (async () => {
        try {
          if (!sqlFactory) {
            sqlFactory = await initSqlJs();
          }
          this.ensureDirectory();
          let buffer: Buffer | null = null;
          let isValidSqliteFile = false;

          if (fs.existsSync(DB_FILE)) {
            try {
              const stats = fs.statSync(DB_FILE);
              if (stats.size >= 100) {
                const readBuf = fs.readFileSync(DB_FILE);
                const header = readBuf.subarray(0, 16).toString('utf8');
                if (header.startsWith('SQLite format 3')) {
                  buffer = readBuf;
                  isValidSqliteFile = true;
                }
              }
            } catch (e) {
              logger.error('Error reading SQLite database file, creating new', e);
            }
          }

          if (isValidSqliteFile && buffer && buffer.length > 0) {
            try {
              this.db = new sqlFactory.Database(buffer);
              this.db.exec("PRAGMA integrity_check;");
              this.initTables();
              logger.info('Successfully initialized SQLite database from disk');
            } catch (err) {
              logger.warn('Existing SQLite database file was corrupted. Initializing clean database.', err);
              if (fs.existsSync(DB_FILE)) {
                try {
                  fs.unlinkSync(DB_FILE);
                } catch (_) {}
              }
              this.db = new sqlFactory.Database();
              this.initTables();
            }
          } else {
            this.db = new sqlFactory.Database();
            logger.info('Initialized new SQLite database instance');
            this.initTables();
          }
        } catch (err) {
          logger.error('Failed to initialize WASM SQLite instance', err);
        }
      })();
    }
    await this.initPromise;
  }

  private ensureDirectory() {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  }

  private saveDisk() {
    if (!this.db) return;
    try {
      this.ensureDirectory();
      const data = this.db.export();
      const tempFile = path.join(DATA_DIR, `.trading.sqlite.${Date.now()}.${Math.random().toString(36).substring(2, 8)}.tmp`);
      fs.writeFileSync(tempFile, Buffer.from(data));
      fs.renameSync(tempFile, DB_FILE);
    } catch (err) {
      logger.error('Error persisting SQLite database to disk:', err);
    }
  }

  private initTables() {
    if (!this.db) return;

    // 1. Settings table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY DEFAULT 1,
        data TEXT NOT NULL
      );
    `);

    // 2. Fyers Auth table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS fyers_auth (
        id INTEGER PRIMARY KEY DEFAULT 1,
        data TEXT NOT NULL
      );
    `);

    // 2b. User-Keyed Access Codes Table (Firestore Sync & Multi-User Support)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS user_access_codes (
        user_id TEXT PRIMARY KEY,
        user_email TEXT,
        access_token TEXT NOT NULL,
        access_code TEXT,
        data TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    // 3. Positions table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS positions (
        id TEXT PRIMARY KEY,
        strategy TEXT,
        symbol TEXT,
        status TEXT,
        updated_at TEXT,
        data TEXT NOT NULL
      );
    `);

    // 4. Orders table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        symbol TEXT,
        side TEXT,
        qty INTEGER,
        price REAL,
        status TEXT,
        mode TEXT,
        timestamp TEXT,
        data TEXT NOT NULL
      );
    `);

    // 5. Adjustments table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS adjustments (
        id TEXT PRIMARY KEY,
        position_id TEXT,
        timestamp TEXT,
        condition_triggered TEXT,
        action_taken TEXT,
        data TEXT NOT NULL
      );
    `);

    // 6. Trade Logs table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS trade_logs (
        id TEXT PRIMARY KEY,
        timestamp TEXT,
        action TEXT,
        symbol TEXT,
        strategy TEXT,
        price REAL,
        quantity INTEGER,
        pnl REAL,
        mode TEXT,
        notes TEXT,
        data TEXT NOT NULL
      );
    `);

    // 7. Strategies table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS strategies (
        id TEXT PRIMARY KEY,
        category TEXT,
        is_public INTEGER,
        is_subscribed INTEGER,
        data TEXT NOT NULL
      );
    `);

    // Seed defaults if empty
    const settingsRes = this.db.exec("SELECT data FROM settings WHERE id = 1");
    if (settingsRes.length === 0 || settingsRes[0].values.length === 0) {
      this.db.run("INSERT INTO settings (id, data) VALUES (1, ?)", [JSON.stringify(defaultSettings)]);
    }

    const authRes = this.db.exec("SELECT data FROM fyers_auth WHERE id = 1");
    if (authRes.length === 0 || authRes[0].values.length === 0) {
      this.db.run("INSERT INTO fyers_auth (id, data) VALUES (1, ?)", [JSON.stringify(defaultFyersAuth)]);
    }

    this.saveDisk();
  }

  // ---------------- Settings ----------------
  public getSettings(): Settings {
    if (this.db) {
      try {
        const res = this.db.exec("SELECT data FROM settings WHERE id = 1");
        if (res.length > 0 && res[0].values.length > 0 && res[0].values[0][0]) {
          const parsed = JSON.parse(res[0].values[0][0] as string);
          if (parsed.fyersAvailableFunds === 317068.14 || parsed.fyersTotalFunds === 317068.14) {
            parsed.fyersAvailableFunds = 0;
            parsed.fyersTotalFunds = 0;
          }
          // If hash is missing and a valid secret key is provided (and not identical to TOTP 2FA key), compute SHA256
          const secret = (parsed.fyersSecretKey || '').trim();
          const totpKey = (parsed.fyersTotpKey || '').trim();
          const isTotpMistakenForSecret = secret && totpKey && secret.toUpperCase() === totpKey.toUpperCase();
          if (secret && !isTotpMistakenForSecret && (!parsed.fyersAppIdHash || parsed.fyersAppIdHash.trim().length !== 64)) {
            const rawAppId = (parsed.fyersAppId || 'V78VJBA972').trim();
            const appType = (parsed.fyersAppType || '100').trim();
            const formattedAppId = rawAppId.includes('-') ? rawAppId : `${rawAppId}-${appType}`;
            parsed.fyersAppIdHash = crypto.createHash('sha256').update(`${formattedAppId}:${secret}`).digest('hex');
          }
          return { ...defaultSettings, ...parsed };
        }
      } catch (e) {
        logger.error('Error fetching settings from SQLite', e);
      }
    }
    return { ...this.inMemoryFallback.settings };
  }

  public updateSettings(newSettings: Partial<Settings>): Settings {
    const current = this.getSettings();
    const updated = { ...current, ...newSettings };

    // If custom fyersAppIdHash is explicitly provided by user/settings, preserve it
    if (newSettings.fyersAppIdHash && newSettings.fyersAppIdHash.trim().length === 64) {
      updated.fyersAppIdHash = newSettings.fyersAppIdHash.trim();
    } else {
      // Auto-update fyersAppIdHash if secret key or app ID is updated, and secret is not identical to TOTP key
      const secret = (updated.fyersSecretKey || '').trim();
      const totpKey = (updated.fyersTotpKey || '').trim();
      const isTotpMistakenForSecret = secret && totpKey && secret.toUpperCase() === totpKey.toUpperCase();
      if (secret && !isTotpMistakenForSecret && (newSettings.fyersSecretKey || newSettings.fyersAppId || !updated.fyersAppIdHash)) {
        const rawAppId = (updated.fyersAppId || 'V78VJBA972').trim();
        const appType = (updated.fyersAppType || '100').trim();
        const formattedAppId = rawAppId.includes('-') ? rawAppId : `${rawAppId}-${appType}`;
        updated.fyersAppIdHash = crypto.createHash('sha256').update(`${formattedAppId}:${secret}`).digest('hex');
      }
    }

    this.inMemoryFallback.settings = updated;

    if (this.db) {
      this.db.run("UPDATE settings SET data = ? WHERE id = 1", [JSON.stringify(updated)]);
      this.saveDisk();
    }
    logger.info('Settings updated in SQLite DB', { mode: updated.mode });
    return updated;
  }

  // ---------------- Fyers Auth ----------------
  public getFyersAuth(userId?: string): FyersTokenData {
    if (userId) {
      const userCode = this.getUserAccessCode(userId);
      if (userCode && userCode.accessToken) {
        return userCode;
      }
    }

    if (this.db) {
      try {
        const res = this.db.exec("SELECT data FROM fyers_auth WHERE id = 1");
        if (res.length > 0 && res[0].values.length > 0 && res[0].values[0][0]) {
          const parsed = JSON.parse(res[0].values[0][0] as string);
          return { ...defaultFyersAuth, ...parsed };
        }
      } catch (e) {
        logger.error('Error fetching fyers_auth from SQLite', e);
      }
    }
    return { ...this.inMemoryFallback.fyersAuth };
  }

  public updateFyersAuth(authData: Partial<FyersTokenData>, userId?: string, userEmail?: string): FyersTokenData {
    const current = this.getFyersAuth(userId);
    const updated = {
      ...current,
      ...authData,
      updatedAt: new Date().toISOString()
    };
    if (authData.authCode === undefined) {
      delete (updated as any).authCode;
    }
    this.inMemoryFallback.fyersAuth = updated;

    if (this.db) {
      this.db.run("UPDATE fyers_auth SET data = ? WHERE id = 1", [JSON.stringify(updated)]);
      this.saveDisk();
    }

    if (userId) {
      this.saveUserAccessCode(userId, updated, userEmail);
    } else {
      // Also update any existing user records in user_access_codes so all registered users have the new active token
      if (this.db) {
        try {
          const stmt = this.db.prepare("SELECT user_id, user_email FROM user_access_codes");
          const usersToUpdate: Array<{ id: string; email: string }> = [];
          while (stmt.step()) {
            const row = stmt.getAsObject();
            if (row.user_id) {
              usersToUpdate.push({ id: row.user_id as string, email: (row.user_email as string) || '' });
            }
          }
          stmt.free();
          for (const u of usersToUpdate) {
            this.saveUserAccessCode(u.id, updated, u.email);
          }
        } catch (e) {
          // ignore
        }
      }
    }

    return updated;
  }

  public clearAuthCode(userId?: string): void {
    const current = this.getFyersAuth();
    delete (current as any).authCode;
    this.inMemoryFallback.fyersAuth = current;
    if (this.db) {
      try {
        this.db.run("UPDATE fyers_auth SET data = ? WHERE id = 1", [JSON.stringify(current)]);
        if (userId) {
          const userObj = this.getUserAccessCode(userId);
          if (userObj) {
            delete (userObj as any).authCode;
            this.inMemoryFallback.userAccessCodes?.set(userId, userObj);
            this.db.run(
              "UPDATE user_access_codes SET access_code = '', data = ? WHERE user_id = ? OR user_email = ?",
              [JSON.stringify(userObj), userId, userId]
            );
          }
        } else {
          this.db.run("UPDATE user_access_codes SET access_code = ''");
          const stmt = this.db.prepare("SELECT user_id, data FROM user_access_codes");
          const toUpdate: Array<{ id: string; data: string }> = [];
          while (stmt.step()) {
            const row = stmt.getAsObject();
            if (row.user_id && row.data) {
              try {
                const parsed = JSON.parse(row.data as string);
                delete parsed.authCode;
                toUpdate.push({ id: row.user_id as string, data: JSON.stringify(parsed) });
              } catch (_) {}
            }
          }
          stmt.free();
          for (const item of toUpdate) {
            this.db.run("UPDATE user_access_codes SET data = ? WHERE user_id = ?", [item.data, item.id]);
          }
        }
        this.saveDisk();
      } catch (e) {
        logger.error('Error clearing authCode in SQLite', e);
      }
    }
  }

  // ---------------- User Access Codes (Stored Against User) ----------------
  public getUserAccessCode(userIdOrEmail?: string): FyersTokenData | null {
    if (!userIdOrEmail) return this.getFyersAuth();
    const key = userIdOrEmail.trim();

    if (this.db) {
      try {
        const stmt = this.db.prepare("SELECT data FROM user_access_codes WHERE user_id = :key OR user_email = :key LIMIT 1");
        stmt.bind({ ':key': key });
        if (stmt.step()) {
          const row = stmt.getAsObject();
          stmt.free();
          if (row && row.data) {
            const parsed = JSON.parse(row.data as string);
            return { ...defaultFyersAuth, ...parsed };
          }
        } else {
          stmt.free();
        }
      } catch (e) {
        logger.error('Error fetching user access code from user_access_codes table', e);
      }
    }

    const inMem = this.inMemoryFallback.userAccessCodes?.get(key);
    if (inMem) return inMem;

    // Fall back to primary active fyersAuth if user has no specific code yet
    const primary = this.getFyersAuth();
    if (primary && primary.accessToken) {
      return primary;
    }

    return null;
  }

  public saveUserAccessCode(userId: string, authData: Partial<FyersTokenData>, userEmail?: string): FyersTokenData {
    const current = this.getUserAccessCode(userId) || this.getFyersAuth();
    const updated: FyersTokenData = {
      ...current,
      ...authData,
      updatedAt: new Date().toISOString()
    };

    if (!this.inMemoryFallback.userAccessCodes) {
      this.inMemoryFallback.userAccessCodes = new Map();
    }
    this.inMemoryFallback.userAccessCodes.set(userId, updated);
    if (userEmail) {
      this.inMemoryFallback.userAccessCodes.set(userEmail, updated);
    }

    if (this.db) {
      try {
        const stmt = this.db.prepare(`
          INSERT INTO user_access_codes (user_id, user_email, access_token, access_code, data, updated_at)
          VALUES (:user_id, :user_email, :access_token, :access_code, :data, :updated_at)
          ON CONFLICT(user_id) DO UPDATE SET
            user_email = excluded.user_email,
            access_token = excluded.access_token,
            access_code = excluded.access_code,
            data = excluded.data,
            updated_at = excluded.updated_at
        `);
        stmt.run({
          ':user_id': userId,
          ':user_email': userEmail || '',
          ':access_token': updated.accessToken || '',
          ':access_code': updated.authCode || '',
          ':data': JSON.stringify(updated),
          ':updated_at': updated.updatedAt || new Date().toISOString()
        });
        stmt.free();
        this.saveDisk();
      } catch (e) {
        logger.error('Error persisting user access code to SQLite', e);
      }
    }

    // Also keep primary auth updated
    this.inMemoryFallback.fyersAuth = updated;
    if (this.db) {
      this.db.run("UPDATE fyers_auth SET data = ? WHERE id = 1", [JSON.stringify(updated)]);
      this.saveDisk();
    }

    return updated;
  }

  public deleteUserAccessCode(userId: string): boolean {
    if (this.inMemoryFallback.userAccessCodes) {
      this.inMemoryFallback.userAccessCodes.delete(userId);
    }
    if (this.db) {
      try {
        this.db.run("DELETE FROM user_access_codes WHERE user_id = ? OR user_email = ?", [userId, userId]);
        this.saveDisk();
        return true;
      } catch (e) {
        logger.error('Error deleting user access code', e);
      }
    }
    return false;
  }

  // ---------------- Positions ----------------
  private sanitizePosition(position: Position): Position {
    if (!position || !position.legs || position.legs.length === 0) return position;

    const seenSellSymbols = new Set<string>();
    const cleanLegs: any[] = [];
    let modified = false;

    for (const leg of position.legs) {
      if (leg.side === 'SELL') {
        if (seenSellSymbols.has(leg.symbol)) {
          modified = true;
          continue;
        }
        seenSellSymbols.add(leg.symbol);
      }
      cleanLegs.push(leg);
    }

    if (modified) {
      position.legs = cleanLegs;
      logger.info(`Sanitized duplicate sell legs in position ${position.id}, kept ${cleanLegs.length} unique legs.`);
    }

    return position;
  }

  public getPositions(): Position[] {
    if (this.db) {
      const positions: Position[] = [];
      try {
        const res = this.db.exec("SELECT data FROM positions ORDER BY updated_at DESC");
        if (res.length > 0 && res[0].values) {
          for (const row of res[0].values) {
            if (row[0]) {
              const rawPos = JSON.parse(row[0] as string);
              const sanitized = this.sanitizePosition(rawPos);
              positions.push(sanitized);
            }
          }
        }
        return positions;
      } catch (e) {
        logger.error('Error fetching positions from SQLite', e);
      }
    }
    return this.inMemoryFallback.positions.map(p => this.sanitizePosition(p));
  }

  public getOpenPositions(modeFilter?: string): Position[] {
    const targetMode = modeFilter || this.getSettings().mode;

    return this.getPositions().filter(p => {
      const isOpen = p.status === 'OPEN' || p.status === 'ADJUSTED';
      const posMode = p.mode || 'PAPER';

      if (targetMode === 'LIVE') {
        return isOpen && posMode === 'LIVE';
      }

      return isOpen && (posMode === 'PAPER' || !p.mode);
    });
  }

  public savePosition(position: Position): Position {
    const updatedTime = new Date().toISOString();
    const posToSave = { ...position, updatedTime };

    const idx = this.inMemoryFallback.positions.findIndex(p => p.id === position.id);
    if (idx >= 0) {
      this.inMemoryFallback.positions[idx] = posToSave;
    } else {
      this.inMemoryFallback.positions.unshift(posToSave);
    }

    if (this.db) {
      const posJson = JSON.stringify(posToSave);
      this.db.run(
        `INSERT OR REPLACE INTO positions (id, strategy, symbol, status, updated_at, data)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [position.id, position.strategy, position.symbol, position.status, updatedTime, posJson]
      );
      this.saveDisk();
    }
    return posToSave;
  }

  // ---------------- Orders ----------------
  public getOrders(): Order[] {
    if (this.db) {
      const orders: Order[] = [];
      try {
        const res = this.db.exec("SELECT data FROM orders ORDER BY timestamp DESC");
        if (res.length > 0 && res[0].values) {
          for (const row of res[0].values) {
            if (row[0]) {
              orders.push(JSON.parse(row[0] as string));
            }
          }
        }
        return orders;
      } catch (e) {
        logger.error('Error fetching orders from SQLite', e);
      }
    }
    return [...this.inMemoryFallback.orders];
  }

  public addOrder(order: Order): Order {
    this.inMemoryFallback.orders.unshift(order);
    if (this.db) {
      this.db.run(
        `INSERT INTO orders (id, symbol, side, qty, price, status, mode, timestamp, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          order.id,
          order.symbol,
          order.side,
          order.qty,
          order.price,
          order.status,
          order.mode,
          order.timestamp,
          JSON.stringify(order)
        ]
      );
      this.saveDisk();
    }
    return order;
  }

  // ---------------- Adjustments ----------------
  public getAdjustments(): AdjustmentLog[] {
    if (this.db) {
      const adjustments: AdjustmentLog[] = [];
      try {
        const res = this.db.exec("SELECT data FROM adjustments ORDER BY timestamp DESC");
        if (res.length > 0 && res[0].values) {
          for (const row of res[0].values) {
            if (row[0]) {
              adjustments.push(JSON.parse(row[0] as string));
            }
          }
        }
        return adjustments;
      } catch (e) {
        logger.error('Error fetching adjustments from SQLite', e);
      }
    }
    return [...this.inMemoryFallback.adjustments];
  }

  public addAdjustment(adj: AdjustmentLog): AdjustmentLog {
    this.inMemoryFallback.adjustments.unshift(adj);
    if (this.db) {
      this.db.run(
        `INSERT INTO adjustments (id, position_id, timestamp, condition_triggered, action_taken, data)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          adj.id,
          adj.positionId,
          adj.timestamp,
          adj.conditionTriggered,
          adj.actionTaken,
          JSON.stringify(adj)
        ]
      );
      this.saveDisk();
    }
    return adj;
  }

  // ---------------- Trade Logs ----------------
  public getTradeLogs(filter?: { startDate?: string; endDate?: string; action?: string; mode?: string; search?: string; userEmail?: string }): TradeLogRecord[] {
    let logs: TradeLogRecord[] = [];
    if (this.db) {
      try {
        const res = this.db.exec("SELECT data FROM trade_logs ORDER BY timestamp DESC");
        if (res.length > 0 && res[0].values) {
          for (const row of res[0].values) {
            if (row[0]) {
              logs.push(JSON.parse(row[0] as string));
            }
          }
        }
      } catch (e) {
        logger.error('Error fetching trade logs from SQLite', e);
      }
    } else {
      logs = [...this.inMemoryFallback.tradeLogs];
    }

    // Auto-synthesize trade logs for any open/closed positions if missing
    try {
      const positions = this.getPositions();
      for (const pos of positions) {
        const hasLog = logs.some(l => l.notes?.includes(pos.id) || l.notes?.includes(pos.tag || pos.strategy));
        if (!hasLog) {
          const newLog = this.addTradeLog({
            action: 'ENTRY',
            symbol: pos.symbol,
            strategy: pos.strategy,
            price: pos.indexEntryPrice,
            quantity: pos.legs[0]?.qty || 65,
            pnl: pos.totalPnl || 0,
            mode: pos.mode || 'PAPER',
            notes: `${pos.tag || pos.strategy} Executed at Spot ₹${pos.indexEntryPrice}. Position ID: ${pos.id}`,
            userEmail: pos.mode === 'LIVE' ? 'sosund@gmail.com' : undefined
          });
          logs.unshift(newLog);
        }
      }
    } catch (err) {
      logger.warn('Error during trade log position synthesis:', err);
    }

    // Filter by User Email if specified
    if (filter?.userEmail) {
      const uEmail = filter.userEmail.toLowerCase().trim();
      logs = logs.filter(l => !l.userEmail || l.userEmail.toLowerCase().trim() === uEmail || l.mode === 'PAPER');
    }

    // Filter by Trading Mode
    if (filter?.mode && filter.mode !== 'ALL' && filter.mode !== '') {
      const targetMode = filter.mode.toUpperCase();
      logs = logs.filter(l => (l.mode || 'PAPER').toUpperCase() === targetMode);
    }

    // Filter by Action / Category
    if (filter?.action && filter.action !== 'ALL' && filter.action !== '') {
      const act = filter.action.toUpperCase();
      if (act === 'ALL_ADJUSTMENTS') {
        logs = logs.filter(l => 
          l.action.includes('SCENARIO') || 
          l.action.includes('ADJUST') || 
          l.action.includes('LOCK') || 
          l.action.includes('WING') || 
          l.action.includes('ROLL')
        );
      } else if (act === 'ALL_EXITS') {
        logs = logs.filter(l => 
          l.action.includes('EXIT') || 
          l.action.includes('CLOSE') || 
          l.action.includes('SQUARE')
        );
      } else if (act === 'ALL_ENTRIES') {
        logs = logs.filter(l => 
          l.action.includes('ENTRY') || 
          l.action.includes('OPPORTUNITY')
        );
      } else {
        logs = logs.filter(l => 
          l.action === filter.action || 
          l.action.toUpperCase().includes(act)
        );
      }
    }

    // Filter by Start Date (Inclusive of full start day)
    if (filter?.startDate) {
      const start = new Date(filter.startDate);
      if (!isNaN(start.getTime())) {
        start.setHours(0, 0, 0, 0);
        logs = logs.filter(l => new Date(l.timestamp) >= start);
      }
    }

    // Filter by End Date (Inclusive of full end day until 23:59:59.999)
    if (filter?.endDate) {
      const end = new Date(filter.endDate);
      if (!isNaN(end.getTime())) {
        end.setHours(23, 59, 59, 999);
        logs = logs.filter(l => new Date(l.timestamp) <= end);
      }
    }

    // Search Query across Notes, Symbol, Strategy, Action, and ID
    if (filter?.search && filter.search.trim()) {
      const q = filter.search.toLowerCase().trim();
      logs = logs.filter(l => 
        (l.notes && l.notes.toLowerCase().includes(q)) ||
        (l.strategy && l.strategy.toLowerCase().includes(q)) ||
        (l.symbol && l.symbol.toLowerCase().includes(q)) ||
        (l.action && l.action.toLowerCase().includes(q)) ||
        (l.id && l.id.toLowerCase().includes(q))
      );
    }

    return logs;
  }

  public addTradeLog(log: Omit<TradeLogRecord, 'id' | 'timestamp'>): TradeLogRecord {
    const record: TradeLogRecord = {
      id: `trade_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      timestamp: new Date().toISOString(),
      ...log
    };
    this.inMemoryFallback.tradeLogs.unshift(record);

    if (this.db) {
      this.db.run(
        `INSERT INTO trade_logs (id, timestamp, action, symbol, strategy, price, quantity, pnl, mode, notes, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          record.id,
          record.timestamp,
          record.action,
          record.symbol,
          record.strategy,
          record.price,
          record.quantity,
          record.pnl,
          record.mode,
          record.notes,
          JSON.stringify(record)
        ]
      );
      this.saveDisk();
    }
    return record;
  }

  // ---------------- Strategy Rules & Marketplace ----------------
  public getStrategies(): StrategyRuleConfig[] {
    let list: StrategyRuleConfig[] = [];
    if (this.db) {
      try {
        const res = this.db.exec("SELECT data FROM strategies");
        if (res.length > 0 && res[0].values) {
          for (const row of res[0].values) {
            if (row[0]) {
              list.push(JSON.parse(row[0] as string));
            }
          }
        }
      } catch (e) {
        logger.error('Error fetching strategies from SQLite', e);
      }
    } else {
      list = [...(this.inMemoryFallback.strategies || [])];
    }

    // Seed defaults if empty
    if (list.length === 0) {
      const defaults: StrategyRuleConfig[] = [
        {
          id: 'strat_short_straddle',
          strategyId: 'SHORT_STRADDLE',
          name: 'Short Straddle (Golden Rule)',
          category: 'SHORT_STRADDLE',
          description: 'Sell ATM Call & PE simultaneously. Converts to Iron Condor by adding wings when P&L > 0 and market moves beyond delta threshold.',
          author: 'Quant Engine (Built-In)',
          isPublic: true,
          isSubscribed: true,
          targetProfitPct: 50,
          stopLossPct: 30,
          maxLossPerLot: 15000,
          wingBufferPts: 300,
          strikeDistancePts: 500,
          deltaNeutralThreshold: 0.15,
          rulesNotes: 'Golden Rule: Add wings ONLY when trade P&L is positive (> ₹0). Roll losing leg if P&L <= 0.',
          createdAt: new Date().toISOString()
        },
        {
          id: 'strat_iron_condor',
          strategyId: 'IRON_CONDOR',
          name: 'Golden Rule Iron Condor',
          category: 'IRON_CONDOR',
          description: 'Defined-risk 4-leg option strategy. Sells OTM Call & PE while buying further OTM protective wings for maximum margin safety.',
          author: 'Quant Engine (Built-In)',
          isPublic: true,
          isSubscribed: true,
          targetProfitPct: 60,
          stopLossPct: 25,
          maxLossPerLot: 10000,
          wingBufferPts: 300,
          strikeDistancePts: 500,
          deltaNeutralThreshold: 0.10,
          rulesNotes: 'Auto-exit when 60% of max profit is achieved or when breakeven boundaries are breached.',
          createdAt: new Date().toISOString()
        },
        {
          id: 'strat_arbitrage',
          strategyId: 'ARBITRAGE',
          name: 'Cash & Carry / Synthetic Arbitrage',
          category: 'ARBITRAGE',
          description: 'Risk-neutral arbitrage strategy taking advantage of mispricing between Spot Index / Futures and Synthetics.',
          author: 'Quant Engine (Built-In)',
          isPublic: true,
          isSubscribed: true,
          targetProfitPct: 100,
          stopLossPct: 15,
          maxLossPerLot: 0,
          wingBufferPts: 0,
          strikeDistancePts: 0,
          deltaNeutralThreshold: 0.05,
          rulesNotes: 'Risk-free lock in. Zero capital risk on margin.',
          createdAt: new Date().toISOString()
        }
      ];

      for (const s of defaults) {
        this.saveStrategy(s);
      }
      return defaults;
    }

    return list;
  }

  public saveStrategy(strategy: StrategyRuleConfig): StrategyRuleConfig {
    if (!strategy.id) {
      strategy.id = `strat_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    }
    if (!strategy.createdAt) {
      strategy.createdAt = new Date().toISOString();
    }

    const index = this.inMemoryFallback.strategies.findIndex(s => s.id === strategy.id);
    if (index >= 0) {
      this.inMemoryFallback.strategies[index] = strategy;
    } else {
      this.inMemoryFallback.strategies.push(strategy);
    }

    if (this.db) {
      this.db.run(
        `INSERT OR REPLACE INTO strategies (id, category, is_public, is_subscribed, data)
         VALUES (?, ?, ?, ?, ?)`,
        [
          strategy.id,
          strategy.category,
          strategy.isPublic ? 1 : 0,
          strategy.isSubscribed ? 1 : 0,
          JSON.stringify(strategy)
        ]
      );
      this.saveDisk();
    }
    return strategy;
  }

  public deleteStrategy(id: string): boolean {
    this.inMemoryFallback.strategies = this.inMemoryFallback.strategies.filter(s => s.id !== id);
    if (this.db) {
      this.db.run("DELETE FROM strategies WHERE id = ?", [id]);
      this.saveDisk();
    }
    return true;
  }
}

export const db = new SqliteDatabaseManager();
