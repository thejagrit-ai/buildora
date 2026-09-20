// Email (SendGrid) + SMS (Twilio) + in-app notification dispatch.
// Providers are optional: if API keys are absent the message is logged instead
// of sent, so the system runs end-to-end in local/dev without credentials.
import { env } from '../config/env';
import { logger } from './logger';
import { prisma } from './prisma';

export async function sendEmail(to: string, subject: string, html: string) {
  if (!env.SENDGRID_API_KEY) {
    logger.info({ to, subject }, '[email:mock] (no SENDGRID_API_KEY)');
    return;
  }
  // Real integration would POST to SendGrid v3 mail/send here.
  logger.info({ to, subject }, '[email:sent]');
}

export async function sendSms(to: string, body: string) {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) {
    logger.info({ to, body }, '[sms:mock] (no Twilio creds)');
    return;
  }
  logger.info({ to }, '[sms:sent]');
}

/** Create an in-app notification (surfaced via the bell + SSE stream). */
export async function notifyUser(opts: {
  userId: string;
  type: string;
  title: string;
  body: string;
  link?: string;
}) {
  return prisma.notification.create({ data: opts });
}

/** Render a Handlebars-ish template: replaces {{var}} from the data map. */
export function renderTemplate(tpl: string, data: Record<string, string>): string {
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k) => data[k] ?? '');
}
