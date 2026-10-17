import { db } from './db.js';
import { logger } from './logger.js';

export class NotificationService {
  /**
   * Send Telegram Alert
   */
  public async sendTelegramMessage(message: string): Promise<boolean> {
    const settings = db.getSettings();
    if (!settings.telegramBotToken || !settings.telegramChatId) {
      return false;
    }

    try {
      const url = `https://api.telegram.org/bot${settings.telegramBotToken}/sendMessage`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: settings.telegramChatId,
          text: message,
          parse_mode: 'HTML'
        })
      });
      return res.ok;
    } catch (err: any) {
      logger.error('Failed to send Telegram notification', { error: err.message });
      return false;
    }
  }

  /**
   * Send Slack Webhook Alert
   */
  public async sendSlackMessage(message: string): Promise<boolean> {
    const settings = db.getSettings();
    if (!settings.slackWebhookUrl) {
      return false;
    }

    try {
      const res = await fetch(settings.slackWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: message })
      });
      return res.ok;
    } catch (err: any) {
      logger.error('Failed to send Slack notification', { error: err.message });
      return false;
    }
  }

  /**
   * Broadcast notification to all configured channels
   */
  public async notify(title: string, details: string, level: 'INFO' | 'TRADE' | 'ADJUSTMENT' | 'WARNING' | 'CRITICAL' = 'INFO') {
    const istTime = new Date().toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true
    });
    const formatted = `<b>[FYERS TRADING BOT - ${level}]</b>\n<b>${title}</b>\n${details}\n<i>Time: ${istTime} IST</i>`;
    logger.info(`Notification [${level}]: ${title} - ${details}`);

    await Promise.all([
      this.sendTelegramMessage(formatted),
      this.sendSlackMessage(`[FYERS BOT - ${level}] ${title}\n${details}\nTime: ${istTime} IST`)
    ]);
  }
}

export const notificationService = new NotificationService();
