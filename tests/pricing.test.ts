import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  currentPriceSnapshotFor,
  estimateCost as sourceEstimateCost,
  priceSnapshotFor as sourcePriceSnapshotFor
} from "../src/pricing.js";
import {
  estimateCost as evalEstimateCost,
  priceSnapshotFor as evalPriceSnapshotFor,
  runEvaluation
} from "../eval/run.js";

const FLASH_PEAK = {
  source: "https://api-docs.deepseek.com/quick_start/pricing/",
  checkedAt: "2026-09-25",
  model: "deepseek-flash",
  basis: "peak",
  peakHoursUtc: "01:00-04:00 and 06:00-10:00 UTC, Monday-Friday, excluding Chinese public holidays",
  inputCacheHitPerMillionUsd: 0.006,
  inputCacheMissPerMillionUsd: 0.3,
  outputPerMillionUsd: 1.2
} as const;

const PRO_PEAK = {
  source: "https://api-docs.deepseek.com/quick_start/pricing/",
  checkedAt: "2026-09-25",
  model: "deepseek-v4-pro",
  basis: "peak",
  peakHoursUtc: "01:00-04:00 and 06:00-10:00 UTC, Monday-Friday, excluding Chinese public holidays",
  inputCacheHitPerMillionUsd: 0.044,
  inputCacheMissPerMillionUsd: 1.32,
  outputPerMillionUsd: 3.96
} as const;

const tempDirs: string[] = [];
afterEach(async () => Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe("pricing", () => {
  it("preserves the pinned evaluation snapshots and cost calculation exactly", () => {
    expect(sourcePriceSnapshotFor("deepseek-flash")).toEqual(FLASH_PEAK);
    expect(sourcePriceSnapshotFor("deepseek-v4-pro")).toEqual(PRO_PEAK);
    expect(sourceEstimateCost({
      cacheHitInputTokens: 123_456,
      cacheMissInputTokens: 234_567,
      outputTokens: 345_678
    }, FLASH_PEAK)).toBe(0.48592443599999996);
    expect(sourceEstimateCost({
      cacheHitInputTokens: 123_456,
      cacheMissInputTokens: 234_567,
      outputTokens: 345_678
    }, PRO_PEAK)).toBe(1.683945384);
    expect(() => sourcePriceSnapshotFor("deepseek-unknown")).toThrow("No verified price snapshot for model: deepseek-unknown");
  });

  it("re-exports the same pricing function objects from the evaluation harness", () => {
    expect(evalPriceSnapshotFor).toBe(sourcePriceSnapshotFor);
    expect(evalEstimateCost).toBe(sourceEstimateCost);
  });

  it("keeps the pinned snapshot unchanged in an offline evaluation manifest", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "onehand-pricing-"));
    tempDirs.push(outputDir);

    const { manifest } = await runEvaluation({
      split: "pilot",
      repetitions: 1,
      concurrency: 1,
      taskIds: ["pilot-single-add"],
      model: "deepseek-flash",
      apiKey: "unused-offline-fixture",
      baseURL: "https://example.invalid",
      outputDir,
      executeRun: async () => {
        throw new Error("offline fixture");
      }
    });

    expect(manifest.priceSnapshot).toEqual(FLASH_PEAK);
  });

  it.each([
    ["weekday first peak window", "2026-09-28T01:00:00.000Z", "peak", 1],
    ["weekday between peak windows", "2026-09-28T04:00:00.000Z", "off-peak", 0.5],
    ["weekday second peak window", "2026-09-28T06:00:00.000Z", "peak", 1],
    ["weekday after peak windows", "2026-09-28T10:00:00.000Z", "off-peak", 0.5],
    ["weekend", "2026-09-27T02:00:00.000Z", "off-peak", 0.5]
  ] as const)("selects the %s rate in UTC", (_name, timestamp, basis, multiplier) => {
    expect(currentPriceSnapshotFor("deepseek-flash", new Date(timestamp))).toEqual({
      ...FLASH_PEAK,
      basis,
      inputCacheHitPerMillionUsd: FLASH_PEAK.inputCacheHitPerMillionUsd * multiplier,
      inputCacheMissPerMillionUsd: FLASH_PEAK.inputCacheMissPerMillionUsd * multiplier,
      outputPerMillionUsd: FLASH_PEAK.outputPerMillionUsd * multiplier
    });
  });

  it("returns undefined when current pricing is unknown", () => {
    expect(currentPriceSnapshotFor("deepseek-unknown", new Date("2026-09-28T02:00:00.000Z"))).toBeUndefined();
    expect(currentPriceSnapshotFor("constructor", new Date("2026-09-28T02:00:00.000Z"))).toBeUndefined();
  });
});
