import { env } from "../config/env";
import { logger } from "../lib/logger";

export interface ViesResult {
  valid: boolean;
  name?: string;
  address?: string;
  checkedAt: string;
}

/** Delar upp "SE556677889901" -> { countryCode: "SE", number: "556677889901" }. */
export function parseVatNumber(
  vat: string
): { countryCode: string; number: string } | null {
  const cleaned = vat.replace(/\s+/g, "").toUpperCase();
  const m = cleaned.match(/^([A-Z]{2})(.+)$/);
  if (!m) return null;
  return { countryCode: m[1]!, number: m[2]! };
}

/**
 * Kontrollerar ett EU-VAT-nummer mot VIES (spec §7).
 * Konservativ: vid fel/avbrott returneras valid=false (reverse charge sätts då EJ,
 * vilket flaggas som edge case i momsmatrisen i stället för att felaktigt nollställa moms).
 */
export async function checkVies(vatNumber: string): Promise<ViesResult> {
  const checkedAt = new Date().toISOString();
  if (!env.VIES_ENABLED) return { valid: false, checkedAt };

  const parsed = parseVatNumber(vatNumber);
  if (!parsed) return { valid: false, checkedAt };

  try {
    const res = await fetch(env.VIES_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        countryCode: parsed.countryCode,
        vatNumber: parsed.number,
      }),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, "VIES svarade icke-OK — behandlar som ogiltigt");
      return { valid: false, checkedAt };
    }
    const json = (await res.json()) as {
      valid?: boolean;
      name?: string;
      address?: string;
    };
    return {
      valid: !!json.valid,
      name: json.name,
      address: json.address,
      checkedAt,
    };
  } catch (err) {
    logger.warn({ err }, "VIES-anrop misslyckades — behandlar som ogiltigt");
    return { valid: false, checkedAt };
  }
}
