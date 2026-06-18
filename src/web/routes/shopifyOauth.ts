import { Router } from "express";
import {
  buildInstallUrl,
  createState,
  exchangeInstallCode,
  isValidShop,
  verifyCallbackHmac,
  verifyState,
} from "../../shopify/oauth";
import { env } from "../../config/env";
import { logger } from "../../lib/logger";

export const shopifyOauthRouter = Router();

/** Startar Shopify-appinstallationen (OAuth) — ger offline Admin API-token. */
shopifyOauthRouter.get("/oauth/shopify/start", (req, res) => {
  const shop = typeof req.query.shop === "string" ? req.query.shop : env.SHOPIFY_SHOP_DOMAIN;
  if (!isValidShop(shop)) return res.status(400).send("ogiltig shop");
  res.redirect(buildInstallUrl(createState(), shop));
});

/** Callback efter godkänd install: verifierar HMAC+state och byter code mot token. */
shopifyOauthRouter.get("/oauth/shopify/callback", async (req, res) => {
  const q = Object.fromEntries(
    Object.entries(req.query).map(([k, v]) => [k, String(v)])
  ) as Record<string, string>;

  if (!isValidShop(q.shop)) return res.status(400).send("ogiltig shop");
  if (!verifyCallbackHmac(q)) return res.status(401).send("ogiltig hmac");
  if (!verifyState(q.state)) return res.status(400).send("ogiltigt state");
  if (!q.code) return res.status(400).send("saknar code");

  try {
    await exchangeInstallCode(q.shop, q.code);
    res
      .type("html")
      .send("<h1>✅ Shopify anslutet</h1><p>Admin-token sparat. Du kan stänga fönstret.</p>");
  } catch (err) {
    logger.error({ err }, "Shopify OAuth-callback misslyckades");
    res
      .status(500)
      .type("html")
      .send(`<h1>Fel vid token-utbyte</h1><pre>${(err as Error).message}</pre>`);
  }
});
