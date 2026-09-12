import { env } from "../config/env";

/**
 * Faktureringsrytm per kund. Sanningen är metafältet
 * `custom.fortnox_invoice_mode` på Company i Shopify — CustomerMapping.invoiceMode
 * är bara en spegling som används om fältet inte är satt.
 */
export type InvoiceMode = "per_order" | "weekly" | "biweekly" | "monthly";

export const INVOICE_MODES: InvoiceMode[] = [
  "per_order",
  "weekly",
  "biweekly",
  "monthly",
];

export const MODE_LABEL: Record<string, string> = {
  per_order: "Per order (faktura direkt)",
  weekly: "Varje vecka",
  biweekly: "Varannan vecka",
  monthly: "Varje månad",
};

export const METAFIELD_NAMESPACE = "custom";
export const METAFIELD_KEY = "fortnox_invoice_mode";

export function isValidMode(v: unknown): v is InvoiceMode {
  return typeof v === "string" && (INVOICE_MODES as string[]).includes(v);
}

/** ISO-veckonummer (för varannan-vecka-rytmen). */
function isoWeek(d: Date): number {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

/** Är det dags att klippa fakturaperioden för den här rytmen i dag? */
export function isCutDay(mode: string, now = new Date()): boolean {
  const weekday = now.getDay() === 0 ? 7 : now.getDay(); // 1=mån … 7=sön
  switch (mode) {
    case "weekly":
      return weekday === env.CONSOLIDATION_WEEKDAY;
    case "biweekly":
      return weekday === env.CONSOLIDATION_WEEKDAY && isoWeek(now) % 2 === 0;
    case "monthly":
      return now.getDate() === 1;
    default:
      return false;
  }
}
