import { env } from "../config/env";
import { logger } from "../lib/logger";
import { clearShopifyTokenCache, getShopifyAccessToken } from "./oauth";

export class ShopifyGraphQLError extends Error {
  constructor(
    public errors: unknown,
    message: string
  ) {
    super(message);
    this.name = "ShopifyGraphQLError";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAX_RETRIES = 5;

interface GraphQLResponse<T> {
  data?: T;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
}

/**
 * Anropar Shopify Admin GraphQL. Hanterar Shopifys kostnadsbaserade throttling
 * (HTTP 429 och errors[].extensions.code === "THROTTLED") med backoff.
 */
export async function shopifyGraphQL<T>(
  query: string,
  variables: Record<string, unknown> = {}
): Promise<T> {
  const url = `https://${env.SHOPIFY_SHOP_DOMAIN}/admin/api/${env.SHOPIFY_API_VERSION}/graphql.json`;
  const accessToken = await getShopifyAccessToken();
  let attempt = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt++;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });

    if (res.status === 401) {
      // Offline-token ogiltigt (avinstallerat/ny installation krävs) — kan ej auto-förnyas.
      clearShopifyTokenCache();
      const body = await res.text().catch(() => "");
      throw new ShopifyGraphQLError(
        body,
        `Shopify 401 — token ogiltig. Installera om appen via ${env.APP_BASE_URL}/oauth/shopify/start`
      );
    }

    if (res.status === 429 && attempt <= MAX_RETRIES) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(1000 * 2 ** (attempt - 1), 8000);
      logger.warn({ waitMs }, "Shopify 429 — backoff");
      await sleep(waitMs);
      continue;
    }

    const text = await res.text();

    if (!res.ok) {
      if (res.status >= 500 && attempt <= MAX_RETRIES) {
        await sleep(Math.min(1000 * 2 ** (attempt - 1), 8000));
        continue;
      }
      throw new ShopifyGraphQLError(text, `Shopify HTTP ${res.status}: ${text.slice(0, 500)}`);
    }

    const json = JSON.parse(text) as GraphQLResponse<T>;

    if (json.errors && json.errors.length > 0) {
      const throttled = json.errors.some((e) => e.extensions?.code === "THROTTLED");
      if (throttled && attempt <= MAX_RETRIES) {
        const waitMs = Math.min(1000 * 2 ** (attempt - 1), 8000);
        logger.warn({ waitMs }, "Shopify THROTTLED — backoff");
        await sleep(waitMs);
        continue;
      }
      throw new ShopifyGraphQLError(
        json.errors,
        json.errors.map((e) => e.message).join("; ")
      );
    }

    return json.data as T;
  }
}
