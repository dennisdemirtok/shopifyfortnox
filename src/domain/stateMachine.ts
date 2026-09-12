/**
 * State machine per order (spec §8):
 *   PENDING → ORDER_OK → INVOICE_OK → SENT → BOOKKEPT
 * Omkörning återupptar från senaste lyckade steg och dubblerar aldrig.
 * FAILED är ett sidospår (dead-letter) med larm.
 */
export const ORDER_STATES = [
  "PENDING",
  "AWAITING_CONSOLIDATION",
  "ORDER_OK",
  "INVOICE_OK",
  "SENT",
  "BOOKKEPT",
  "FAILED",
] as const;

export type OrderState = (typeof ORDER_STATES)[number];

const RANK: Record<string, number> = {
  PENDING: 0,
  // Parkerad i väntan på samlingsfaktura — inget Fortnox-steg är gjort ännu.
  AWAITING_CONSOLIDATION: 0,
  ORDER_OK: 1,
  INVOICE_OK: 2,
  SENT: 3,
  BOOKKEPT: 4,
};

/** true om `state` har nått minst `target` (för att hoppa över redan klara steg). */
export function isAtLeast(state: string, target: OrderState): boolean {
  return (RANK[state] ?? -1) >= (RANK[target] ?? 99);
}
