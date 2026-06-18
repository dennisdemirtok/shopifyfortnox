import { Router } from "express";
import {
  buildAuthorizeUrl,
  createState,
  exchangeCodeForTokens,
  verifyState,
} from "../../fortnox/oauth";
import { logger } from "../../lib/logger";

export const oauthRouter = Router();

/** Startar Fortnox-auktoriseringen — användaren skickas till Fortnox för att godkänna. */
oauthRouter.get("/oauth/fortnox/start", (_req, res) => {
  const state = createState();
  res.redirect(buildAuthorizeUrl(state));
});

/** Callback från Fortnox efter godkännande: byter code mot token-par. */
oauthRouter.get("/oauth/fortnox/callback", async (req, res) => {
  const code = typeof req.query.code === "string" ? req.query.code : undefined;
  const state = typeof req.query.state === "string" ? req.query.state : undefined;
  const error = typeof req.query.error === "string" ? req.query.error : undefined;

  if (error) {
    return res.status(400).type("html").send(`<h1>Fortnox nekade</h1><p>${error}</p>`);
  }
  if (!verifyState(state)) {
    return res.status(400).type("html").send("<h1>Ogiltigt state</h1>");
  }
  if (!code) {
    return res.status(400).type("html").send("<h1>Saknar authorization code</h1>");
  }

  try {
    await exchangeCodeForTokens(code);
    res
      .type("html")
      .send(
        "<h1>✅ Fortnox anslutet</h1><p>Token sparat. Du kan stänga fönstret.</p>"
      );
  } catch (err) {
    logger.error({ err }, "OAuth-callback misslyckades");
    res
      .status(500)
      .type("html")
      .send(`<h1>Fel vid token-utbyte</h1><pre>${(err as Error).message}</pre>`);
  }
});
