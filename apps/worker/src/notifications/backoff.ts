/**
 * Exponential backoff with "equal jitter": half the delay is fixed, half random, so retries from
 * many notifications spread out without ever retrying immediately.
 */
export function backoffDelayMs(
  attempt: number,
  options: { baseMs?: number; capMs?: number } = {},
  random: () => number = Math.random,
): number {
  const base = options.baseMs ?? 5_000;
  const cap = options.capMs ?? 15 * 60_000;
  const exp = Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp / 2 + random() * (exp / 2));
}
