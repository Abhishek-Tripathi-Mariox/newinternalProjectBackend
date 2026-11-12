import nodemailer from 'nodemailer';
import { config } from '../config/index.js';
import { logger } from './logger.js';

/**
 * Outgoing email over SMTP (nodemailer). Disabled when SMTP_USER / SMTP_PASS are not set (and in
 * tests) — callers then fall back to showing the admin a link to share by hand.
 */
export const sentMail = [];

let transport = !config.mail.enabled
  ? null
  : nodemailer.createTransport({
      host: config.mail.host,
      port: config.mail.port,
      secure: config.mail.secure,
      requireTLS: !config.mail.secure, // never send credentials over plain text
      auth: { user: config.mail.user, pass: config.mail.pass },
      pool: true,
      maxConnections: 3,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });

/** Tests: capture mail in memory (`sentMail`) instead of sending; pass `fail: true` to simulate an SMTP error. */
export function useTestTransport({ fail = false } = {}) {
  sentMail.length = 0;
  transport = fail
    ? { sendMail: async () => { throw new Error('SMTP down'); } }
    : nodemailer.createTransport({ jsonTransport: true });
}

export const mailEnabled = () => !!transport;

/** Send one email. Returns true when the SMTP server accepted it; never throws (failures are logged). */
export async function sendMail({ to, subject, text, html }) {
  if (!transport) return false;
  try {
    const info = await transport.sendMail({ from: config.mail.from, to, subject, text, html });
    if (config.isTest) sentMail.push({ to, subject, text, html });
    logger.info({ to, subject, messageId: info.messageId }, 'Email sent');
    return true;
  } catch (err) {
    logger.error({ err, to, subject }, 'Email failed');
    return false;
  }
}

/** Startup check: logs whether SMTP login works. Never blocks the API from starting. */
export async function verifyMailer() {
  if (!transport || config.isTest) {
    logger.info('Email: not configured (set SMTP_USER / SMTP_PASS) — invite links are shown to the admin instead');
    return false;
  }
  try {
    await transport.verify();
    logger.info(`Email: SMTP ready (${config.mail.host}:${config.mail.port} as ${config.mail.user})`);
    return true;
  } catch (err) {
    logger.warn({ err: { message: err.message, code: err.code } }, `Email: SMTP login to ${config.mail.host} failed — invites will show a link instead`);
    return false;
  }
}
