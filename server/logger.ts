import winston from 'winston';
import { SystemLog } from './types.js';

const logBuffer: SystemLog[] = [];
const MAX_LOG_BUFFER = 200;

export const winstonLogger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, metadata }) => {
          const metaStr = metadata ? ` | ${JSON.stringify(metadata)}` : '';
          return `[${timestamp}] ${level.toUpperCase()}: ${message}${metaStr}`;
        })
      )
    })
  ]
});

function formatMeta(meta?: any) {
  if (meta instanceof Error) {
    return { error: meta.message, stack: meta.stack };
  }
  return meta;
}

export const logger = {
  info(message: string, metadata?: any) {
    const meta = formatMeta(metadata);
    winstonLogger.info(message, { metadata: meta });
    addSystemLog('info', message, meta);
  },
  warn(message: string, metadata?: any) {
    const meta = formatMeta(metadata);
    winstonLogger.warn(message, { metadata: meta });
    addSystemLog('warn', message, meta);
  },
  error(message: string, metadata?: any) {
    const meta = formatMeta(metadata);
    winstonLogger.error(message, { metadata: meta });
    addSystemLog('error', message, meta);
  },
  success(message: string, metadata?: any) {
    const meta = formatMeta(metadata);
    winstonLogger.info(`[SUCCESS] ${message}`, { metadata: meta });
    addSystemLog('success', message, meta);
  }
};

function addSystemLog(level: 'info' | 'warn' | 'error' | 'success', message: string, metadata?: any) {
  const logItem: SystemLog = {
    id: `log_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    timestamp: new Date().toISOString(),
    level,
    message,
    metadata
  };
  logBuffer.unshift(logItem);
  if (logBuffer.length > MAX_LOG_BUFFER) {
    logBuffer.pop();
  }
}

export function getSystemLogs(): SystemLog[] {
  return [...logBuffer];
}
