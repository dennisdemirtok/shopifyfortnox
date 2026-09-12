import { prisma } from "../lib/prisma";
import { logger } from "../lib/logger";

export interface AuditInput {
  shopDomain?: string;
  flow: "A" | "B" | "C" | "system";
  entityType: string;
  entityId?: string;
  step: string;
  status: "ok" | "error" | "skipped";
  message?: string;
  payload?: unknown;
}

/** Skriver en rad i audit-loggen. Får aldrig krascha anroparen. */
export async function audit(input: AuditInput): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        shopDomain: input.shopDomain ?? null,
        flow: input.flow,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        step: input.step,
        status: input.status,
        message: input.message?.slice(0, 2000) ?? null,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        payload: input.payload === undefined ? undefined : (input.payload as any),
      },
    });
  } catch (err) {
    logger.error({ err }, "Kunde inte skriva audit-logg");
  }
  const line = { flow: input.flow, step: input.step, status: input.status, entityId: input.entityId };
  if (input.status === "error") logger.warn(line, input.message ?? input.step);
  else logger.debug(line, input.message ?? input.step);
}
