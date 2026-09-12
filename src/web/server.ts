import express from "express";
import pinoHttp from "pino-http";
import { logger } from "../lib/logger";
import { env } from "../config/env";
import { adminRouter } from "./routes/admin";
import { b2bApplyRouter } from "./routes/b2bApply";
import { embeddedRouter } from "./routes/embedded";
import { healthRouter } from "./routes/health";
import { oauthRouter } from "./routes/oauth";
import { shopifyOauthRouter } from "./routes/shopifyOauth";
import { webhookRouter } from "./routes/webhooks";

export function buildApp() {
  const app = express();
  app.disable("x-powered-by");
  // Railway/proxy: gör req.ip till klientens riktiga adress (rate-limit på /b2b/apply).
  app.set("trust proxy", 1);
  app.use(pinoHttp({ logger }));

  // OBS: ingen global body-parser — webhook-routern hanterar RÅ body själv (HMAC).
  app.use("/webhooks", webhookRouter);
  app.use(oauthRouter);
  app.use(shopifyOauthRouter);
  app.use(b2bApplyRouter);
  app.use(adminRouter);
  app.use(embeddedRouter);
  app.use(healthRouter);

  // 404
  app.use((_req, res) => res.status(404).send("not found"));

  return app;
}

export function startServer() {
  const app = buildApp();
  const server = app.listen(env.PORT, () => {
    logger.info(`Webserver lyssnar på :${env.PORT} (${env.APP_BASE_URL})`);
  });
  return server;
}
