/**
 * Bounded-parallel map — the one implementation.
 *
 * `Promise.all(items.map(...))` fires EVERY task at once, which is how the research
 * pipeline used to trip the account's rate limit and come back with "no findings"
 * (2026-07-17), and how a calendar fan-out across ~10 calendars per account would
 * turn one search into a burst of API calls. This keeps at most `limit` in flight,
 * preserving input order in the result.
 *
 * It lives in core/ rather than next to either caller because a second private copy
 * is how two versions drift apart (see the tz formatter, 2026-07-29).
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: width }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}
