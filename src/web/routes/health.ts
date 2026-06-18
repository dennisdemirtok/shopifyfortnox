import { Router } from "express";
import { hasFortnoxConnection } from "../../fortnox/oauth";
import { hasShopifyConnection } from "../../shopify/oauth";
import { env } from "../../config/env";

export const healthRouter = Router();

healthRouter.get("/health", async (_req, res) => {
  let fortnoxConnected = false;
  let shopifyConnected = false;
  try {
    [fortnoxConnected, shopifyConnected] = await Promise.all([
      hasFortnoxConnection(),
      hasShopifyConnection(),
    ]);
  } catch {
    /* db kanske inte uppe ännu */
  }
  res.json({
    ok: true,
    role: env.ROLE,
    shop: env.SHOPIFY_SHOP_DOMAIN,
    fortnoxConnected,
    shopifyConnected,
  });
});

healthRouter.get("/", (_req, res) => {
  res.type("html").send(
    `<h1>IAE Shopify → Fortnox</h1>
     <p>Status: körs.</p>
     <ul>
       <li><a href="/health">/health</a></li>
       <li><a href="/oauth/shopify/start">Installera Shopify-appen (OAuth)</a></li>
       <li><a href="/oauth/fortnox/start">Anslut Fortnox (OAuth)</a></li>
     </ul>`
  );
});
