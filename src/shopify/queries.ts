/**
 * GraphQL-operationer mot Shopify Admin API.
 * Samtliga validerade mot schema 2026-01 via shopify-dev-mcp.
 */

// Flöde A: hämta en CompanyLocation (från company_locations/* webhook).
export const COMPANY_LOCATION_FOR_SYNC = /* GraphQL */ `
query CompanyLocationForSync($id: ID!) {
  companyLocation(id: $id) {
    id
    name
    externalId
    taxSettings { taxRegistrationId taxExempt }
    company {
      id
      name
      externalId
      mainContact { customer { defaultEmailAddress { emailAddress } firstName lastName } }
    }
    billingAddress { address1 address2 city zip countryCode province recipient phone }
    shippingAddress { address1 address2 city zip countryCode }
    buyerExperienceConfiguration { paymentTermsTemplate { id name paymentTermsType dueInDays } }
  }
}`;

// Flöde A: hämta ett Company med alla locations (från companies/* webhook).
export const COMPANY_FOR_SYNC = /* GraphQL */ `
query CompanyForSync($id: ID!) {
  company(id: $id) {
    id
    name
    externalId
    mainContact { customer { defaultEmailAddress { emailAddress } firstName lastName } }
    locations(first: 20) {
      nodes {
        id
        name
        externalId
        taxSettings { taxRegistrationId taxExempt }
        billingAddress { address1 address2 city zip countryCode province recipient phone }
        buyerExperienceConfiguration { paymentTermsTemplate { id name paymentTermsType dueInDays } }
      }
    }
  }
}`;

// Flöde A: skriv tillbaka Fortnox CustomerNumber till Company.externalId.
export const SET_COMPANY_EXTERNAL_ID = /* GraphQL */ `
mutation SetCompanyExternalId($companyId: ID!, $input: CompanyInput!) {
  companyUpdate(companyId: $companyId, input: $input) {
    company { id externalId }
    userErrors { field message }
  }
}`;

// Flöde B: hämta order för fakturering (från orders/fulfilled webhook).
export const ORDER_FOR_INVOICING = /* GraphQL */ `
query OrderForInvoicing($id: ID!) {
  order(id: $id) {
    id
    name
    createdAt
    taxesIncluded
    currencyCode
    note
    billingAddress { countryCodeV2 }
    shippingAddress { countryCodeV2 }
    purchasingEntity {
      __typename
      ... on PurchasingCompany {
        company { id name externalId }
        location { id name externalId }
      }
    }
    totalShippingPriceSet { shopMoney { amount currencyCode } }
    shippingLines(first: 5) {
      nodes { title originalPriceSet { shopMoney { amount } } taxLines { rate ratePercentage } }
    }
    lineItems(first: 100) {
      nodes {
        id
        sku
        quantity
        title
        originalUnitPriceSet { shopMoney { amount currencyCode } }
        discountedUnitPriceSet { shopMoney { amount } }
        taxLines { rate ratePercentage priceSet { shopMoney { amount } } }
      }
    }
  }
}`;

// Flöde C (import): skapa Company + Location (+ ev. kontakt) från Fortnox-kund.
export const COMPANY_CREATE = /* GraphQL */ `
mutation CompanyCreate($input: CompanyCreateInput!) {
  companyCreate(input: $input) {
    company {
      id
      name
      externalId
      locations(first: 1) { nodes { id } }
    }
    userErrors { field message }
  }
}`;

// Flöde C (import): lista alla befintliga companies för dubblettskydd.
export const COMPANIES_FOR_DEDUPE = /* GraphQL */ `
query AllCompaniesForDedupe($first: Int!, $after: String) {
  companies(first: $first, after: $after) {
    nodes { id name externalId }
    pageInfo { hasNextPage endCursor }
  }
}`;

// Provisionering: skapa webhook-prenumeration (HTTPS-leverans via uri).
export const WEBHOOK_SUBSCRIPTION_CREATE = /* GraphQL */ `
mutation WebhookSubscriptionCreate($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
    webhookSubscription { id topic format }
    userErrors { field message }
  }
}`;

// Provisionering: lista befintliga webhook-prenumerationer.
export const WEBHOOK_SUBSCRIPTIONS = /* GraphQL */ `
query WebhookSubscriptions {
  webhookSubscriptions(first: 100) {
    nodes {
      id
      topic
      uri
    }
  }
}`;
