import { getCompany, getCompanyLocation, setCompanyExternalId } from "../shopify/data";
import type { CompanyLocationNode } from "../shopify/types";
import {
  createCustomer,
  findCustomerByOrgNr,
  updateCustomer,
} from "../fortnox/client";
import type { FortnoxCustomer } from "../fortnox/types";
import { isEuCountry, resolveVat } from "../vat/matrix";
import { checkVies } from "../vat/vies";
import {
  findCustomerMappingByLocation,
  upsertCustomerMapping,
} from "../domain/mapping";
import { getStorefrontConfig } from "../config/storefronts";
import { audit } from "../domain/audit";
import { alert } from "../notify/notifier";
import { logger } from "../lib/logger";

type CompanyRef = NonNullable<CompanyLocationNode["company"]>;

function mapPaymentTerms(
  loc: CompanyLocationNode,
  paymentTermsMap: Record<string, string>
): string | undefined {
  const name = loc.buyerExperienceConfiguration?.paymentTermsTemplate?.name;
  if (!name) return undefined;
  return paymentTermsMap[name];
}

/**
 * Kärnan i Flöde A: speglar en CompanyLocation till en Fortnox-kund (upsert).
 * En CompanyLocation = en Fortnox-kund (spec §4). Returnerar CustomerNumber.
 */
async function upsertLocationCustomer(
  shopDomain: string,
  loc: CompanyLocationNode,
  company: CompanyRef | null
): Promise<string> {
  const config = await getStorefrontConfig(shopDomain);

  const taxRegId = loc.taxSettings?.taxRegistrationId?.trim() || undefined;
  const country = loc.billingAddress?.countryCode ?? undefined;
  const contactEmail =
    company?.mainContact?.customer?.defaultEmailAddress?.emailAddress ?? undefined;
  const companyName = company?.name ?? loc.name ?? "Okänt företag";

  // taxRegistrationId kan vara org.nr (siffror) eller VAT-nr (2 bokstäver + siffror).
  const looksLikeVat = !!taxRegId && /^[A-Za-z]{2}/.test(taxRegId);
  const vatNumber = looksLikeVat ? taxRegId!.toUpperCase() : undefined;
  const orgNr = taxRegId ? taxRegId.replace(/\s/g, "") : undefined;

  // VIES endast för EU utanför SE och när vi har ett VAT-nr (spec §7).
  let vatValid = false;
  if (vatNumber && isEuCountry(country)) {
    const vies = await checkVies(vatNumber);
    vatValid = vies.valid;
    await audit({
      shopDomain,
      flow: "A",
      entityType: "company_location",
      entityId: loc.id,
      step: "vies.check",
      status: "ok",
      message: `VIES ${vatNumber}: ${vies.valid ? "giltigt" : "ogiltigt/okänt"}`,
    });
  }

  const vat = resolveVat({
    destinationCountry: country,
    vatNumber,
    vatNumberValid: vatValid,
  });

  if (!orgNr) {
    await alert(
      "Kundsynk: org.nr saknas",
      `CompanyLocation ${loc.id} (${companyName}) saknar taxRegistrationId/org.nr i Shopify. ` +
        `Kunden skapas/uppdateras ändå men dubblettspärr via org.nr går inte att använda. Fyll i org.nr i Shopify.`
    );
  }

  const payload: FortnoxCustomer = {
    Name: companyName,
    OrganisationNumber: orgNr,
    Type: "COMPANY",
    Address1: loc.billingAddress?.address1 ?? undefined,
    Address2: loc.billingAddress?.address2 ?? undefined,
    ZipCode: loc.billingAddress?.zip ?? undefined,
    City: loc.billingAddress?.city ?? undefined,
    CountryCode: country ?? undefined,
    Phone1: loc.billingAddress?.phone ?? undefined,
    Email: contactEmail,
    EmailInvoice: contactEmail,
    Currency: config.currency,
    VATType: vat.vatType,
    VATNumber: vatNumber,
    TermsOfPayment: mapPaymentTerms(loc, config.paymentTermsMap),
    DefaultDeliveryTypes: {
      Invoice: config.sendMethod === "eprint" ? "PRINTSERVICE" : "EMAIL",
    },
    EmailInformation: contactEmail ? { EmailAddressTo: contactEmail } : undefined,
    Active: true,
  };

  // Upsert-nyckel: 1) lokal mapping  2) Company.externalId  3) org.nr i Fortnox.
  const mapping = await findCustomerMappingByLocation(shopDomain, loc.id);
  let custNr: string | undefined = mapping?.fortnoxCustomerNumber;
  if (!custNr && company?.externalId) custNr = company.externalId;
  if (!custNr && orgNr) {
    const found = await findCustomerByOrgNr(orgNr);
    if (found?.CustomerNumber) custNr = found.CustomerNumber;
  }

  let finalNr: string;
  if (custNr) {
    const updated = await updateCustomer(custNr, { ...payload, CustomerNumber: custNr });
    finalNr = updated.CustomerNumber ?? custNr;
  } else {
    const created = await createCustomer(payload);
    finalNr = created.CustomerNumber!;
  }

  // Spara mapping (alltid per location — sann källa även vid flera locations).
  await upsertCustomerMapping({
    shopDomain,
    companyId: company?.id ?? "",
    companyLocationId: loc.id,
    companyName: companyName,
    organisationNumber: orgNr,
    fortnoxCustomerNumber: finalNr,
  });

  // Skriv tillbaka externalId till Company (spec §4). I 1:1-fallet (en location per
  // company) är detta exakt; vid flera locations är mapping-tabellen den exakta källan.
  if (company?.id) {
    try {
      await setCompanyExternalId(company.id, finalNr);
    } catch (err) {
      await audit({
        shopDomain,
        flow: "A",
        entityType: "company_location",
        entityId: loc.id,
        step: "shopify.externalId.writeback",
        status: "error",
        message: (err as Error).message,
      });
    }
  }

  await audit({
    shopDomain,
    flow: "A",
    entityType: "company_location",
    entityId: loc.id,
    step: "customer.upsert",
    status: "ok",
    message: `Fortnox-kund ${finalNr} (${vat.scenario}, ${vat.vatType})`,
    payload: { customerNumber: finalNr, orgNr, scenario: vat.scenario },
  });

  if (vat.needsReview) {
    await alert(
      "Momsgranskning krävs (Flöde A)",
      `Kund ${finalNr} (${companyName}, land ${country}): ${vat.note}`
    );
  }

  return finalNr;
}

/** Trigger: company_locations/create|update. */
export async function syncCompanyLocation(
  shopDomain: string,
  locationGid: string
): Promise<void> {
  const loc = await getCompanyLocation(locationGid);
  if (!loc) {
    await audit({
      shopDomain,
      flow: "A",
      entityType: "company_location",
      entityId: locationGid,
      step: "fetch",
      status: "skipped",
      message: "CompanyLocation hittades inte i Shopify",
    });
    return;
  }
  await upsertLocationCustomer(shopDomain, loc, loc.company ?? null);
}

/** Trigger: companies/create|update. Synkar alla locations på företaget. */
export async function syncCompany(shopDomain: string, companyGid: string): Promise<void> {
  const company = await getCompany(companyGid);
  if (!company) {
    await audit({
      shopDomain,
      flow: "A",
      entityType: "company",
      entityId: companyGid,
      step: "fetch",
      status: "skipped",
      message: "Company hittades inte i Shopify",
    });
    return;
  }
  const locations = company.locations?.nodes ?? [];
  if (locations.length === 0) {
    logger.info({ companyGid }, "Company saknar locations — inget att synka ännu");
    return;
  }
  const companyRef: CompanyRef = {
    id: company.id,
    name: company.name,
    externalId: company.externalId,
    mainContact: company.mainContact,
  };
  for (const loc of locations) {
    await upsertLocationCustomer(shopDomain, loc, companyRef);
  }
}
