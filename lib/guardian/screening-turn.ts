/**
 * Twilio can retry callbacks. Only the next bounded turn may advance a live
 * screening session; stale, skipped, malformed, and over-limit turns are no-ops.
 */
export function isNextScreeningTurn(currentTurn: number, requestedTurn: number, maxTurns = 5): boolean {
  return Number.isInteger(currentTurn)
    && Number.isInteger(requestedTurn)
    && currentTurn >= 0
    && requestedTurn === currentTurn + 1
    && requestedTurn <= maxTurns;
}
