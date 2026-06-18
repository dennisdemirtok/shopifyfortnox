import nodemailer, { type Transporter } from "nodemailer";
import { env } from "../config/env";
import { logger } from "../lib/logger";

let transporter: Transporter | null = null;

function getTransport(): Transporter | null {
  if (!env.SMTP_HOST) return null;
  if (!transporter) {
    const port = env.SMTP_PORT ?? 587;
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port,
      secure: port === 465,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    });
  }
  return transporter;
}

/**
 * Skickar ett larm. Loggar alltid (ERROR). Om SMTP är konfigurerat skickas
 * även e-post (spec §8: Gmail-larm vid dead-letter). Får aldrig krascha.
 */
export async function alert(subject: string, body: string): Promise<void> {
  logger.error({ subject }, `LARM: ${subject}`);
  logger.error(body);

  const t = getTransport();
  if (!t || !env.ALERT_EMAIL_TO) return;
  try {
    await t.sendMail({
      from: env.ALERT_EMAIL_FROM ?? env.ALERT_EMAIL_TO,
      to: env.ALERT_EMAIL_TO,
      subject: `[IAE Fortnox] ${subject}`,
      text: body,
    });
  } catch (err) {
    logger.error({ err }, "Kunde inte skicka larm-mejl");
  }
}
