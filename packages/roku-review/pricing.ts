/**
 * Rough per-model list prices, USD per 1M tokens, for an estimated review price when Cursor
 * reports no cost (plan-included usage). Estimates only: they ignore Cursor's fees and discounts.
 * ponytail: hand-kept table; update when prices change, or read Cursor's pricing if it gets an API.
 */

interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const PRICES: { match: RegExp; price: Price }[] = [
  { match: /^claude-opus/, price: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 } },
  { match: /^claude-sonnet/, price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
  { match: /^claude-haiku/, price: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } },
  { match: /^gpt-.*mini/, price: { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0 } },
  { match: /^gpt-/, price: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 } },
  { match: /^gemini-.*flash/, price: { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0 } },
  { match: /^gemini-.*pro/, price: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 } },
  { match: /^grok-.*fast/, price: { input: 0.2, output: 0.5, cacheRead: 0.05, cacheWrite: 0 } },
  { match: /^grok-/, price: { input: 3, output: 15, cacheRead: 0.75, cacheWrite: 0 } },
];

/** Estimated cents for one run, or null when the model is not in the table. */
export function estimateCents(model: string, t: { input: number; output: number; cacheRead: number; cacheWrite: number }): number | null {
  const price = PRICES.find((p) => p.match.test(model.toLowerCase()))?.price;
  if (!price) return null;
  return ((t.input * price.input + t.output * price.output + t.cacheRead * price.cacheRead + t.cacheWrite * price.cacheWrite) / 1_000_000) * 100;
}
