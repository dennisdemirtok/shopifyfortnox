import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { env, fortnoxScopes } from "../config/env";
import { prisma } from "../lib/prisma";
import { redis } from "../lib/redis";
import { logger } from "../lib/logger";
import { audit } from "../domain/audit";
import { alert } from "../notify/notifier";
import type { FortnoxTokenResponse } from "./types";

const TENANT = "default";
const PROVIDER = "fortnox";
const TOKEN_URL = `${env.FORTNOX_AUTH_BASE}/token`;
const AUTH_URL = `${env.FORTNOX_AUTH_BASE}/auth`;
const REFRESH_LOCK_KEY = "fortnox:refresh:lock";
const ACCESS_TOKEN_BUFFER_MS = 90_000; // förnya 90 s före utgång
const REFRESH_TOKEN_TTL_MS = 45 * 24 * 60 * 60 * 1000; // 45 dagar

function basicAuthHeader(): string {
  const raw = `${env.FORTNOX_CLIENT_ID}:${env.FORTNOX_CLIENT_SECRET}`;
  return `Basic ${Buffer.from(raw).toString("base64")}`;
}

// ── CSRF-skyddat state (stateless, HMAC-signerat) ──────────────────────────
export function createState(): string {
  const nonce = randomUUID();
  const sig = createHmac("sha256", env.OAUTH_STATE_SECRET).update(nonce).digest("hex");
  return `${nonce}.${sig}`;
}

export function verifyState(state: string | undefined): boolean {
  if (!state || !state.includes(".")) return false;
  const [nonce, sig] = state.split(".");
  if (!nonce || !sig) return false;
  const expected = createHmac("sha256", env.OAUTH_STATE_SECRET).update(nonce).digest("hex");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Bygger authorize-URL:en som användaren öppnar för att godkänna anslutningen. */
export function buildAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: env.FORTNOX_CLIENT_ID,
    redirect_uri: env.FORTNOX_REDIRECT_URI,
    scope: fortnoxScopes.join(" "),
    state,
    access_type: "offline",
    response_type: "code",
    account_type: "service", // maskin-till-maskin (spec §6)
  });
  return `${AUTH_URL}?${params.toString()}`;
}

async function postToken(body: URLSearchParams): Promise<FortnoxTokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Fortnox token-endpoint ${res.status}: ${text}`);
  }
  return JSON.parse(text) as FortnoxTokenResponse;
}

async function persistTokens(t: FortnoxTokenResponse): Promise<void> {
  const now = Date.now();
  const expiresAt = new Date(now + t.expires_in * 1000);
  const refreshExpiresAt = new Date(now + REFRESH_TOKEN_TTL_MS);
  // Enradsupdate = atomisk. Tillsammans med refresh-låset tappas aldrig rotationen.
  await prisma.oAuthToken.upsert({
    where: { provider_tenant: { provider: PROVIDER, tenant: TENANT } },
    create: {
      provider: PROVIDER,
      tenant: TENANT,
      accessToken: t.access_token,
      refreshToken: t.refresh_token,
      scope: t.scope,
      expiresAt,
      refreshExpiresAt,
      rotatedAt: new Date(),
    },
    update: {
      accessToken: t.access_token,
      refreshToken: t.refresh_token,
      scope: t.scope,
      expiresAt,
      refreshExpiresAt,
      rotatedAt: new Date(),
    },
  });
}

/** Steg 1 i auth-flödet: byt authorization code mot token-par och spara. */
export async function exchangeCodeForTokens(code: string): Promise<void> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: env.FORTNOX_REDIRECT_URI,
  });
  const tokens = await postToken(body);
  await persistTokens(tokens);
  await audit({
    flow: "system",
    entityType: "oauth",
    step: "fortnox.authorize",
    status: "ok",
    message: `Anslutning upprättad, scope: ${tokens.scope}`,
  });
  logger.info("Fortnox-anslutning upprättad (token sparat).");
}

// ── Distribuerat lås kring refresh ─────────────────────────────────────────
async function acquireRefreshLock(ttlMs = 15_000): Promise<string | null> {
  const token = randomUUID();
  const ok = await redis.set(REFRESH_LOCK_KEY, token, "PX", ttlMs, "NX");
  return ok ? token : null;
}

const RELEASE_LUA = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end`;

async function releaseRefreshLock(token: string): Promise<void> {
  await redis.eval(RELEASE_LUA, 1, REFRESH_LOCK_KEY, token);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function doRefresh(currentRefreshToken: string): Promise<void> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: currentRefreshToken,
  });
  try {
    const tokens = await postToken(body);
    await persistTokens(tokens);
    logger.info("Fortnox access token förnyat (refresh-token roterat & sparat).");
  } catch (err) {
    await audit({
      flow: "system",
      entityType: "oauth",
      step: "fortnox.refresh",
      status: "error",
      message: (err as Error).message,
    });
    await alert(
      "Fortnox-anslutning bruten",
      `Refresh av Fortnox-token misslyckades. Sannolikt utgången/invaliderad refresh-token — anslutningen måste återauktoriseras via ${env.APP_BASE_URL}/oauth/fortnox/start.\n\nFel: ${(err as Error).message}`
    );
    throw err;
  }
}

/**
 * Returnerar ett giltigt access token. Förnyar vid behov med dubbelkollat lås:
 * efter att låset tagits läses token om ifall en annan instans redan förnyat.
 */
export async function getValidAccessToken(): Promise<string> {
  const row = await prisma.oAuthToken.findUnique({
    where: { provider_tenant: { provider: PROVIDER, tenant: TENANT } },
  });
  if (!row) {
    throw new Error(
      `Ingen Fortnox-anslutning. Auktorisera först via ${env.APP_BASE_URL}/oauth/fortnox/start`
    );
  }
  if (row.expiresAt.getTime() - Date.now() > ACCESS_TOKEN_BUFFER_MS) {
    return row.accessToken;
  }
  return refreshWithLock();
}

/** Tvingar fram en refresh (används vid 401 från Fortnox). */
export async function forceRefresh(): Promise<string> {
  return refreshWithLock(true);
}

async function refreshWithLock(force = false): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const lock = await acquireRefreshLock();
    if (!lock) {
      // Någon annan förnyar just nu — vänta och läs om.
      await sleep(200);
      const fresh = await prisma.oAuthToken.findUnique({
        where: { provider_tenant: { provider: PROVIDER, tenant: TENANT } },
      });
      if (fresh && fresh.expiresAt.getTime() - Date.now() > ACCESS_TOKEN_BUFFER_MS) {
        return fresh.accessToken;
      }
      continue;
    }
    try {
      // Dubbelkoll under låset.
      const row = await prisma.oAuthToken.findUnique({
        where: { provider_tenant: { provider: PROVIDER, tenant: TENANT } },
      });
      if (!row) throw new Error("Fortnox-token saknas vid refresh.");
      if (!force && row.expiresAt.getTime() - Date.now() > ACCESS_TOKEN_BUFFER_MS) {
        return row.accessToken; // annan instans hann förnya
      }
      await doRefresh(row.refreshToken);
      const updated = await prisma.oAuthToken.findUnique({
        where: { provider_tenant: { provider: PROVIDER, tenant: TENANT } },
      });
      return updated!.accessToken;
    } finally {
      await releaseRefreshLock(lock);
    }
  }
  throw new Error("Kunde inte förnya Fortnox-token (lås-timeout).");
}

export async function hasFortnoxConnection(): Promise<boolean> {
  const row = await prisma.oAuthToken.findUnique({
    where: { provider_tenant: { provider: PROVIDER, tenant: TENANT } },
  });
  return !!row;
}
