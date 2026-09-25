export type PriceSnapshot = {
  source: string;
  checkedAt: string;
  model: string;
  basis: "peak";
  peakHoursUtc: string;
  inputCacheHitPerMillionUsd: number;
  inputCacheMissPerMillionUsd: number;
  outputPerMillionUsd: number;
};

export type CurrentPriceSnapshot = Omit<PriceSnapshot, "basis"> & { basis: "peak" | "off-peak" };

// Peak list prices in USD per 1M tokens. Off-peak is a uniform 50%, so peak is a conservative upper bound.
const PEAK_PRICES = new Map([
  ["deepseek-flash", { inputCacheHitPerMillionUsd: 0.006, inputCacheMissPerMillionUsd: 0.3, outputPerMillionUsd: 1.2 }],
  ["deepseek-v4-pro", { inputCacheHitPerMillionUsd: 0.044, inputCacheMissPerMillionUsd: 1.32, outputPerMillionUsd: 3.96 }]
]);

export function priceSnapshotFor(model: string): PriceSnapshot {
  const price = PEAK_PRICES.get(model);
  if (!price) throw new Error(`No verified price snapshot for model: ${model}`);
  return {
    source: "https://api-docs.deepseek.com/quick_start/pricing/",
    checkedAt: "2026-09-25",
    model,
    basis: "peak",
    peakHoursUtc: "01:00-04:00 and 06:00-10:00 UTC, Monday-Friday, excluding Chinese public holidays",
    ...price
  };
}

/**
 * Selects the current weekday/hour rate in UTC. Chinese public holidays are not
 * encoded locally, so a holiday that falls on a weekday uses the weekday rate.
 */
export function currentPriceSnapshotFor(model: string, at = new Date()): CurrentPriceSnapshot | undefined {
  if (!PEAK_PRICES.has(model)) return undefined;
  const price = priceSnapshotFor(model);

  const day = at.getUTCDay();
  const hour = at.getUTCHours();
  const weekday = day >= 1 && day <= 5;
  const peak = weekday && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10));
  const multiplier = peak ? 1 : 0.5;

  return {
    ...price,
    basis: peak ? "peak" : "off-peak",
    inputCacheHitPerMillionUsd: price.inputCacheHitPerMillionUsd * multiplier,
    inputCacheMissPerMillionUsd: price.inputCacheMissPerMillionUsd * multiplier,
    outputPerMillionUsd: price.outputPerMillionUsd * multiplier
  };
}

export function estimateCost(
  usage: { cacheHitInputTokens: number; cacheMissInputTokens: number; outputTokens: number },
  price: CurrentPriceSnapshot
): number {
  return usage.cacheHitInputTokens / 1_000_000 * price.inputCacheHitPerMillionUsd +
    usage.cacheMissInputTokens / 1_000_000 * price.inputCacheMissPerMillionUsd +
    usage.outputTokens / 1_000_000 * price.outputPerMillionUsd;
}
