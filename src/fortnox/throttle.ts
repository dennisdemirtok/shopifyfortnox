import { randomUUID } from "node:crypto";
import { redis } from "../lib/redis";
import { env } from "../config/env";
import { logger } from "../lib/logger";

/**
 * Global rate-limiter mot Fortnox (sliding window).
 *
 * Spec §9/§6: 25 anrop / 5 s gäller PER Fortnox-anslutning, delat över ALLA
 * storefronts och workers. Därför en central token-bucket i Redis (inte
 * in-process), så flera worker-instanser delar samma budget.
 */
const WINDOW_MS = env.FORTNOX_RATE_WINDOW_MS;
const MAX = env.FORTNOX_RATE_MAX;
const KEY = "fortnox:ratelimit:default";

// Atomisk sliding-window i Lua: städa gamla, räkna, lägg till om plats finns.
// Returnerar 1 om tillåtet, annars negativt tal = ms att vänta tills slot frigörs.
const LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local max = tonumber(ARGV[3])
local member = ARGV[4]
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local count = redis.call('ZCARD', key)
if count < max then
  redis.call('ZADD', key, now, member)
  redis.call('PEXPIRE', key, window)
  return 1
end
local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local wait = (tonumber(oldest[2]) + window) - now
if wait < 1 then wait = 1 end
return -wait
`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Blockerar tills en slot är ledig i det globala fönstret, och konsumerar den.
 * @param signalTimeoutMs max total väntetid innan vi ger upp (skydd mot deadlock).
 */
export async function acquireFortnoxSlot(signalTimeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + signalTimeoutMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const now = Date.now();
    const member = `${now}-${randomUUID()}`;
    const res = (await redis.eval(LUA, 1, KEY, now, WINDOW_MS, MAX, member)) as number;
    if (res === 1) return;
    if (Date.now() >= deadline) {
      throw new Error("Fortnox throttle: timeout vid väntan på ledig slot");
    }
    const waitMs = Math.min(Math.max(Number(-res), 5), WINDOW_MS);
    logger.debug({ waitMs }, "Fortnox-throttle: väntar på ledig slot");
    await sleep(waitMs);
  }
}
