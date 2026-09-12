import { env } from "../config/env";
import { logger } from "../lib/logger";
import { prisma } from "../lib/prisma";
import { getCustomer, listCustomers } from "../fortnox/client";
import type { FortnoxCustomer } from "../fortnox/types";
import {
  createCompany,
  listAllCompanies,
  type CompanyCreatePayload,
} from "../shopify/data";
import { audit } from "../domain/audit";

/**
 * Flöde C — engångsimport/backfyllnad: hämtar ALLA aktiva kunder ur Fortnox
 * och skapar dem som B2B-Companies i Shopify (Company + Location + ev. kontakt).
 *
 *   npm run import:customers                 # DRY-RUN: visar vad som skulle skapas
 *   npm run import:customers -- --apply      # skapar på riktigt
 *   npm run import:customers -- --apply --max 5    # testa med max 5 st
 *   flaggor: --include-private (ta även med Type=PRIVATE, annars hoppas de över)
 *
 * Idempotent: hoppar över kunder som redan finns via (1) lokala mapping-tabellen,
 * (2) Shopify Company.externalId = Fortnox CustomerNumber, (3) exakt namnmatch.
 * Sätter Company.externalId = CustomerNumber och CompanyLocation.taxRegistrationId
 * = org.nr — exakt de fält Flöde A/B använder, så flödena hänger ihop efteråt.
 */

const APPLY = process.argv.includes("--apply");
const INCLUDE_PRIVATE = process.argv.includes("--include-private");
const maxIdx = process.argv.indexOf("--max");
const MAX =
  maxIdx !== -1 && process.argv[maxIdx + 1]
    ? Number(process.argv[maxIdx + 1])
    : Infinity;

interface Stats {
  scanned: number;
  toCreate: number;
  created: number;
  alreadyExists: number;
  mappingsRepaired: number;
  privateSkipped: number;
  failed: number;
}

function buildCompanyInput(c: FortnoxCustomer, withContact: boolean) {
  const orgNr = c.OrganisationNumber?.replace(/\s/g, "") || undefined;
  const country =
    c.CountryCode && /^[A-Za-z]{2}$/.test(c.CountryCode)
      ? c.CountryCode.toUpperCase()
      : "SE";
  return {
    company: {
      name: c.Name,
      externalId: c.CustomerNumber,
      note: `Importerad från Fortnox (kundnr ${c.CustomerNumber})`,
    },
    ...(withContact && c.Email ? { companyContact: { email: c.Email } } : {}),
    companyLocation: {
      name: c.City?.trim() || "Huvudkontor",
      ...(orgNr ? { taxRegistrationId: orgNr } : {}),
      // Shopify kräver address1 om en adress skickas — kunder utan gatuadress i
      // Fortnox får en location utan adress (kompletteras manuellt/vid Flöde A).
      ...(c.Address1?.trim()
        ? {
            billingSameAsShipping: true,
            // billingSameAsShipping=true => billingAddress ignoreras, så adressen
            // skickas som shippingAddress (blir både leverans- och fakturaadress).
            shippingAddress: {
              address1: c.Address1,
              address2: c.Address2 ?? undefined,
              city: c.City ?? undefined,
              zip: c.ZipCode ?? undefined,
              countryCode: country,
              recipient: c.Name,
              // Telefon utelämnas medvetet: Shopify kräver E.164, Fortnox har fritext.
            },
          }
        : {}),
    },
  };
}

async function createInShopify(c: FortnoxCustomer): Promise<CompanyCreatePayload> {
  let result = await createCompany(buildCompanyInput(c, true));
  if (result.userErrors.length > 0 && c.Email) {
    // Vanligast: kontakt-mejlen krockar (redan kund/kontakt någon annanstans).
    // Försök igen utan kontakt så företaget ändå kommer in.
    logger.warn(
      { customer: c.CustomerNumber, errors: result.userErrors.map((e) => e.message) },
      "companyCreate med kontakt misslyckades — försöker utan kontakt"
    );
    result = await createCompany(buildCompanyInput(c, false));
  }
  return result;
}

async function main() {
  const shopDomain = env.SHOPIFY_SHOP_DOMAIN;
  logger.info(
    APPLY
      ? `SKARP KÖRNING mot ${shopDomain}${Number.isFinite(MAX) ? ` (max ${MAX} st)` : ""}`
      : "DRY-RUN — inget skapas. Kör med --apply för att skapa på riktigt."
  );

  // Dubblettskydd 1+2: befintliga Shopify-companies + lokala mappings.
  const existing = await listAllCompanies();
  const byExternalId = new Map(
    existing.filter((x) => x.externalId).map((x) => [x.externalId as string, x])
  );
  const byName = new Map(
    existing
      .filter((x) => x.name)
      .map((x) => [(x.name as string).trim().toLowerCase(), x])
  );
  const mappings = await prisma.customerMapping.findMany({ where: { shopDomain } });
  const mappedNrs = new Set(mappings.map((m) => m.fortnoxCustomerNumber));
  logger.info(
    `Shopify har ${existing.length} companies sedan tidigare; ${mappings.length} lokala mappings.`
  );

  const stats: Stats = {
    scanned: 0,
    toCreate: 0,
    created: 0,
    alreadyExists: 0,
    mappingsRepaired: 0,
    privateSkipped: 0,
    failed: 0,
  };
  const failures: string[] = [];
  let page = 1;
  let done = false;

  while (!done) {
    const res = await listCustomers(page, 100, "active");
    const list = res.Customers ?? [];
    for (const item of list) {
      if (!item.CustomerNumber) continue;
      if (stats.scanned >= MAX) {
        done = true;
        break;
      }
      stats.scanned++;

      // Listan saknar Type/CountryCode m.m. — hämta full kund (throttlas globalt).
      const c = await getCustomer(item.CustomerNumber);
      const nr = c.CustomerNumber!;
      const label = `${c.Name} (kundnr ${nr}, org.nr ${c.OrganisationNumber ?? "saknas"})`;

      if (c.Type === "PRIVATE" && !INCLUDE_PRIVATE) {
        stats.privateSkipped++;
        logger.debug(`~ hoppar privatkund: ${label}`);
        continue;
      }

      const nameKey = (c.Name ?? "").trim().toLowerCase();
      const known = byExternalId.get(nr) ?? (nameKey ? byName.get(nameKey) : undefined);
      if (mappedNrs.has(nr) || known) {
        stats.alreadyExists++;
        // Reparera lokal mapping-cache om den saknas (t.ex. efter DB-byte/deploy).
        const locId = known?.locations?.nodes?.[0]?.id;
        if (APPLY && known && locId && !mappedNrs.has(nr)) {
          await prisma.customerMapping.upsert({
            where: {
              shopDomain_companyLocationId: { shopDomain, companyLocationId: locId },
            },
            create: {
              shopDomain,
              companyId: known.id,
              companyLocationId: locId,
              companyName: known.name ?? c.Name,
              organisationNumber: c.OrganisationNumber?.replace(/\s/g, "") ?? null,
              fortnoxCustomerNumber: nr,
            },
            update: {
              fortnoxCustomerNumber: nr,
              companyName: known.name ?? c.Name,
              organisationNumber: c.OrganisationNumber?.replace(/\s/g, "") ?? null,
            },
          });
          mappedNrs.add(nr);
          stats.mappingsRepaired++;
        }
        logger.info(`= finns redan i Shopify: ${label}`);
        continue;
      }

      stats.toCreate++;
      if (!APPLY) {
        logger.info(`+ skulle skapa: ${label}`);
        continue;
      }

      try {
        const result = await createInShopify(c);
        if (result.userErrors.length > 0 || !result.company) {
          throw new Error(result.userErrors.map((e) => e.message).join("; ") || "okänt fel");
        }
        const companyId = result.company.id;
        const locationId = result.company.locations?.nodes?.[0]?.id ?? "";
        if (locationId) {
          await prisma.customerMapping.upsert({
            where: {
              shopDomain_companyLocationId: { shopDomain, companyLocationId: locationId },
            },
            create: {
              shopDomain,
              companyId,
              companyLocationId: locationId,
              companyName: c.Name,
              organisationNumber: c.OrganisationNumber?.replace(/\s/g, "") ?? null,
              fortnoxCustomerNumber: nr,
            },
            update: { fortnoxCustomerNumber: nr },
          });
        }
        await audit({
          shopDomain,
          flow: "C",
          entityType: "fortnox_customer",
          entityId: nr,
          step: "company.import",
          status: "ok",
          message: `Skapade ${result.company.name} (${companyId})`,
        });
        byExternalId.set(nr, { id: companyId, name: c.Name, externalId: nr });
        if (nameKey) byName.set(nameKey, { id: companyId, name: c.Name, externalId: nr });
        stats.created++;
        logger.info(`✓ skapade: ${label} → ${companyId}`);
      } catch (err) {
        stats.failed++;
        const msg = `${label}: ${(err as Error).message}`;
        failures.push(msg);
        logger.error(`✗ misslyckades: ${msg}`);
        await audit({
          shopDomain,
          flow: "C",
          entityType: "fortnox_customer",
          entityId: nr,
          step: "company.import",
          status: "error",
          message: (err as Error).message,
        });
      }
    }
    const pages = res.MetaInformation?.["@TotalPages"] ?? 1;
    if (done || page >= pages || list.length === 0) break;
    page++;
  }

  logger.info("──────── SAMMANFATTNING ────────");
  logger.info(`Genomgångna:        ${stats.scanned}`);
  logger.info(`Fanns redan:        ${stats.alreadyExists}`);
  if (APPLY) logger.info(`Mappningar lagade: ${stats.mappingsRepaired}`);
  logger.info(`Privatkunder över:  ${stats.privateSkipped}`);
  if (APPLY) {
    logger.info(`Skapade:            ${stats.created}`);
    logger.info(`Misslyckade:        ${stats.failed}`);
    for (const f of failures) logger.error(`  ✗ ${f}`);
  } else {
    logger.info(`Skulle skapas:      ${stats.toCreate}  (kör med --apply)`);
  }
  process.exit(stats.failed > 0 ? 1 : 0);
}

main().catch((err) => {
  logger.error({ err }, "importFortnoxCustomers kraschade");
  process.exit(1);
});
