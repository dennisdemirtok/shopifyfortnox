import { PrismaClient } from "@prisma/client";
import { env } from "../config/env";

/** Singleton PrismaClient (undviker att tömma connection-poolen vid hot-reload). */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
