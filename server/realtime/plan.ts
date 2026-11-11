/**
 * Subscription planning.
 *
 * A condition can capture far more codes than the (unverified) realtime subscription cap
 * allows, so the watch list must be planned explicitly instead of silently truncating the
 * tail. Selected chart codes always win; the remaining slots rotate through the captured
 * codes so no stock is starved forever, and the caller can report how many were skipped.
 */

export type PlanInput = {
  /** Codes shown in charts/strategy — always subscribed first. */
  selected: readonly string[];
  /** Every code currently captured by the condition search, in arrival order. */
  captured: readonly string[];
  /** Hard cap on simultaneous subscriptions (from RealtimeCaps). */
  maxSubscriptions: number;
  /** Slots reserved for captured codes that are not selected (rotation budget). */
  budget: number;
  /** Rotation cursor returned by the previous call. */
  cursor?: number;
};

export type PlanResult = {
  watch: string[];
  /** Cursor to pass into the next call. */
  cursor: number;
  /** Captured codes that did not fit in this plan (reported, never dropped silently). */
  skipped: number;
};

const CODE = /^\d{6}$/;

function uniqueCodes(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string' || !CODE.test(value) || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

export function planSubscriptions(input: PlanInput): PlanResult {
  const {selected, captured} = input;
  if (!Number.isInteger(input.maxSubscriptions) || input.maxSubscriptions < 1) throw new Error('구독 상한이 올바르지 않습니다.');
  if (!Number.isInteger(input.budget) || input.budget < 0) throw new Error('로테이션 예산이 올바르지 않습니다.');

  const selectedCodes = uniqueCodes(selected);
  const capturedCodes = uniqueCodes(captured);
  const watch = selectedCodes.slice(0, input.maxSubscriptions);

  const skippedCount = (watched: string[]): number => {
    const inWatch = new Set(watched);
    return capturedCodes.filter((code) => !inWatch.has(code)).length;
  };

  const room = Math.min(input.maxSubscriptions - watch.length, input.budget);
  if (room <= 0 || capturedCodes.length === 0) {
    return {watch, cursor: 0, skipped: skippedCount(watch)};
  }

  const rawCursor = Number.isInteger(input.cursor) ? (input.cursor as number) : 0;
  const start = ((rawCursor % capturedCodes.length) + capturedCodes.length) % capturedCodes.length;
  const known = new Set(watch);
  let added = 0;
  for (let step = 0; step < capturedCodes.length && added < room; step += 1) {
    const code = capturedCodes[(start + step) % capturedCodes.length];
    if (known.has(code)) continue;
    known.add(code);
    watch.push(code);
    added += 1;
  }
  const nextCursor = added > 0 ? (start + added) % capturedCodes.length : start;
  return {watch, cursor: nextCursor, skipped: skippedCount(watch)};
}
