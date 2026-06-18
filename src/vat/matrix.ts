import type { FortnoxVATType } from "../fortnox/types";

/**
 * Momsmatris (spec §7). Konfigdriven: (destinationsland × VAT-nr giltigt?) →
 * (momssats, VATType, reverse charge, kontonyckel).
 *
 * VIKTIGT (verifieras med redovisning): konton sätts INTE här utan slås upp via
 * StorefrontConfig.accountMap[accountKey]. Detta är default-logik för svensk
 * säljare (SE) — anpassa EU_COUNTRIES och satser efter er faktiska situation.
 */

const SELLER_COUNTRY = "SE";

const EU_COUNTRIES = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR",
  "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK",
  "SI", "ES", "SE",
]);

export type VatScenario =
  | "inhemsk"
  | "eu-reverse-charge"
  | "eu-no-vat"
  | "export";

export interface VatResolution {
  scenario: VatScenario;
  ratePercent: number; // default momssats om Shopify-radens taxLines saknas
  vatType: FortnoxVATType;
  reverseCharge: boolean; // true => rader ska faktureras med 0 % moms
  accountKey: string; // nyckel in i StorefrontConfig.accountMap
  needsReview: boolean; // edge case som kräver manuell granskning
  note?: string;
}

export interface VatResolveInput {
  destinationCountry?: string | null; // ISO alpha-2 från leverans/faktureringsadress
  vatNumber?: string | null;
  vatNumberValid?: boolean; // resultat från VIES (Flöde A)
  domesticRatePercent?: number; // default 25
}

export function resolveVat(input: VatResolveInput): VatResolution {
  const dest = (input.destinationCountry ?? SELLER_COUNTRY).toUpperCase();
  const domesticRate = input.domesticRatePercent ?? 25;

  // Inhemsk svensk B2B.
  if (dest === SELLER_COUNTRY) {
    return {
      scenario: "inhemsk",
      ratePercent: domesticRate,
      vatType: "SEVAT",
      reverseCharge: false,
      accountKey: "sales_se",
      needsReview: false,
    };
  }

  // EU (utanför SE).
  if (EU_COUNTRIES.has(dest)) {
    if (input.vatNumberValid) {
      return {
        scenario: "eu-reverse-charge",
        ratePercent: 0,
        vatType: "EUREVERSEDVAT",
        reverseCharge: true,
        accountKey: "sales_eu_reverse",
        needsReview: false,
      };
    }
    // EU B2B utan verifierat VAT-nr: kan ej anta reverse charge.
    return {
      scenario: "eu-no-vat",
      ratePercent: domesticRate,
      vatType: "SEVAT",
      reverseCharge: false,
      accountKey: "sales_se",
      needsReview: true,
      note: "EU-kund utan verifierat VAT-nr — reverse charge ej tillämpad. Kräver manuell granskning.",
    };
  }

  // Tredjeland (t.ex. Norge) = export, 0 % svensk moms.
  return {
    scenario: "export",
    ratePercent: 0,
    vatType: "EXPORT",
    reverseCharge: true,
    accountKey: "sales_export",
    needsReview: false,
  };
}

export function isEuCountry(country?: string | null): boolean {
  return !!country && EU_COUNTRIES.has(country.toUpperCase()) && country.toUpperCase() !== SELLER_COUNTRY;
}
