import IORedis, { type Redis } from "ioredis";
import type { ConnectionOptions } from "bullmq";
import { env } from "../config/env";

const globalForRedis = globalThis as unknown as { redis?: Redis };

/** Allmän Redis-klient (token-bucket, dedup-lås, m.m.). */
export const redis =
  globalForRedis.redis ??
  new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });

if (env.NODE_ENV !== "production") globalForRedis.redis = redis;

/**
 * Connection-options för BullMQ (parsade ur REDIS_URL).
 * Vi skickar options i stället för en delad instans, eftersom BullMQ buntar sin
 * egen ioredis och då skapar/äger sina egna anslutningar (kräver
 * maxRetriesPerRequest: null för blockerande worker-kommandon).
 */
export function bullConnection(): ConnectionOptions {
  const u = new URL(env.REDIS_URL);
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : 6379,
    username: u.username || undefined,
    password: u.password || undefined,
    maxRetriesPerRequest: null,
    ...(u.protocol === "rediss:" ? { tls: {} } : {}),
  } as ConnectionOptions;
}
