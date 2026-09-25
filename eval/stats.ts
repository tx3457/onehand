// Pure statistics helpers shared by the evaluation reports. Every random draw comes from a seeded
// mulberry32 stream, so a report is reproducible from its inputs and seed.

export function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

export function sum(values: number[]): number { return values.reduce((a, b) => a + b, 0); }
export function mean(values: number[]): number { return values.length ? sum(values) / values.length : 0; }

// Nearest-rank percentile of an ascending array.
export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))]!;
}

export function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function bootstrapMeanCi(values: number[], samples = 4000, seed = 20260714 + values.length): [number, number] {
  if (!values.length) return [0, 0];
  const random = mulberry32(seed);
  const boot: number[] = [];
  for (let i = 0; i < samples; i += 1) {
    let total = 0;
    for (let j = 0; j < values.length; j += 1) total += values[Math.floor(random() * values.length)]!;
    boot.push(total / values.length);
  }
  boot.sort((a, b) => a - b);
  return [percentile(boot, 0.025), percentile(boot, 0.975)];
}

// statistic(indices) for `samples` resamples of 0..n-1 with replacement. The same n and seed give
// the same resamples, so statistics computed in separate calls stay jointly paired.
export function bootstrapReplicates(
  n: number,
  samples: number,
  seed: number,
  statistic: (indices: Int32Array) => number
): number[] {
  if (n <= 0) return [];
  const random = mulberry32(seed);
  const indices = new Int32Array(n);
  const replicates: number[] = [];
  for (let s = 0; s < samples; s += 1) {
    for (let i = 0; i < n; i += 1) indices[i] = Math.floor(random() * n);
    replicates.push(statistic(indices));
  }
  return replicates;
}

// Percentile interval over the finite replicates.
export function percentileCi(replicates: number[], level = 0.95): [number, number] {
  const sorted = replicates.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  const tail = (1 - level) / 2;
  return [percentile(sorted, tail), percentile(sorted, 1 - tail)];
}

// Two-sided bootstrap p-value for "the statistic is 0": 2·min(P(stat ≤ 0), P(stat ≥ 0)) over the
// finite replicates, clamped to [1/B, 1]. |stat| ≤ tolerance counts as 0, so float noise is not an effect.
export function bootstrapPValue(replicates: number[], tolerance = 0): number {
  const valid = replicates.filter((value) => Number.isFinite(value));
  if (!valid.length) return 1;
  const atMost = valid.filter((value) => value <= tolerance).length / valid.length;
  const atLeast = valid.filter((value) => value >= -tolerance).length / valid.length;
  return Math.min(1, Math.max(1 / valid.length, 2 * Math.min(atMost, atLeast)));
}

// Holm step-down adjusted p-values, returned in input order.
export function holmAdjust(pValues: number[]): number[] {
  const order = pValues.map((p, index) => ({ p, index })).sort((a, b) => a.p - b.p);
  const adjusted = new Array<number>(pValues.length);
  let running = 0;
  order.forEach(({ p, index }, rank) => {
    running = Math.max(running, Math.min(1, (pValues.length - rank) * p));
    adjusted[index] = running;
  });
  return adjusted;
}
