# Paired A/B comparison: A = `baseline`, B = `ctx-sandbox`

- Benchmark `swebench`, model `deepseek-flash`, split holdout
- Results: `eval/results/final-2026-09-26-holdout`
- Paired tasks: 46; excluded because only one arm has a valid run: 0 only in A, 0 only in B
- 10000 paired bootstrap resamples of tasks (seed 20260925); primary metrics, Holm-corrected at α = 0.05: estimatedCostUsd, modelRounds

## Interpretation

- estimatedCostUsd: significantly lower in B; B vs A -16.1% (geometric mean; 95% CI -28.1% to -2.5%), Holm-adjusted p = 0.039.
- modelRounds: no detectable difference; B vs A +8.9% (geometric mean; 95% CI -5.0% to +24.0%).
- resolved: no detectable difference; B − A = +4.3 pp (95% CI -6.5 pp to +15.2 pp).
- resolved: B is non-inferior to A at a 10.0 pp margin; the lower 95% CI bound of B − A, -6.5 pp, is above -10.0 pp.

## Completeness

| arm | variant | planned | observed | valid | missing | invalid_result | harness_error | grading_error | provider_error | environment failure | patch-caused grading failure | outside plan | status |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| A | `baseline` | 46 | 46 | 46 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | complete |
| B | `ctx-sandbox` | 46 | 46 | 46 | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | complete |

## All paired tasks (n = 46)

Every paired task; each metric averages that arm's valid runs of the task.

| metric | A | B | Δ or %change | 95% CI | p (Holm) | note |
|---|---:|---:|---:|---:|---:|---|
| resolved | 73.9% | 78.3% | +4.3 pp | -6.5 pp to +15.2 pp | 0.534 | no detectable difference; n=46; non-inferior at 10.0 pp |
| falseSuccess | 10.9% | 13.0% | +2.2 pp | -4.3 pp to +10.9 pp | 0.790 | no detectable difference; n=46 |
| emptyPatch | 4.3% | 2.2% | -2.2 pp | -10.9 pp to +4.3 pp | 0.790 | no detectable difference; n=46 |
| cacheHitRate | 95.8% | 95.8% | +0.0 pp | -0.9 pp to +0.8 pp | 0.913 | no detectable difference; n=46 |
| toolFailureRate | 9.9% | 8.8% | -1.1 pp | -2.4 pp to +0.2 pp | 0.093 | no detectable difference; n=46 |
| governanceShare | 15.3% | 16.5% | +1.2 pp | -0.9 pp to +3.4 pp | 0.290 | no detectable difference; n=46 |
| modelRounds | 38.8 / 34.0 | 43.8 / 45.5 | +8.9% | -5.0% to +24.0% | 0.218 (0.218) | primary; no detectable difference; n=46 |
| toolCalls | 55.8 / 50.5 | 60.5 / 59.5 | +4.4% | -7.8% to +17.5% | 0.489 | no detectable difference; n=46 |
| inputTokens | 1647669 / 1033196 | 1467907 / 1247077 | -22.7% | -38.6% to -3.2% | 0.023 | CI excludes 0 (exploratory); n=46 |
| outputTokens | 24895 / 17927 | 24510 / 18699 | -5.1% | -21.6% to +13.3% | 0.571 | no detectable difference; n=46 |
| reasoningTokens | 18893 / 12195 | 17581 / 13218 | -14.2% | -34.6% to +8.6% | 0.216 | no detectable difference; n=46 |
| estimatedCostUsd | $0.0551 / $0.0456 | $0.0488 / $0.0429 | -16.1% | -28.1% to -2.5% | 0.020 (0.039) | primary; significant (Holm); n=46 |
| durationMs | 208.9s / 158.9s | 263.9s / 188.4s | +14.5% | -3.7% to +36.5% | 0.126 | no detectable difference; n=46 |
| modelLatencyMs | 122.8s / 88.9s | 121.4s / 98.1s | -4.4% | -19.7% to +12.7% | 0.588 | no detectable difference; n=46 |
| toolTimeMs | 51.2s / 11.4s | 106.8s / 18.6s | +82.2% | +22.2% to +175.4% | 0.002 | CI excludes 0 (exploratory); n=46 |

## Tasks resolved in both arms (n = 32), efficiency only

Tasks with at least one resolved run in each arm; each efficiency metric averages the resolved runs only.

| metric | A | B | Δ or %change | 95% CI | p (Holm) | note |
|---|---:|---:|---:|---:|---:|---|
| cacheHitRate | 95.2% | 95.3% | +0.1 pp | -0.9 pp to +1.0 pp | 0.783 | no detectable difference; n=32 |
| toolFailureRate | 9.9% | 8.4% | -1.6 pp | -3.1 pp to -0.1 pp | 0.031 | CI excludes 0 (exploratory); n=32 |
| governanceShare | 17.7% | 19.9% | +2.2 pp | -0.4 pp to +5.0 pp | 0.097 | no detectable difference; n=32 |
| modelRounds | 34.4 / 30.5 | 39.2 / 36.0 | +10.7% | -4.1% to +28.2% | 0.159 | no detectable difference; n=32 |
| toolCalls | 49.0 / 46.0 | 54.3 / 54.0 | +5.7% | -8.5% to +21.9% | 0.435 | no detectable difference; n=32 |
| inputTokens | 1305210 / 989455 | 1151917 / 731477 | -23.9% | -41.5% to +0.2% | 0.052 | no detectable difference; n=32 |
| outputTokens | 18065 / 13454 | 18223 / 15940 | -6.4% | -26.3% to +17.5% | 0.605 | no detectable difference; n=32 |
| reasoningTokens | 12816 / 8706 | 12070 / 8798 | -18.7% | -43.5% to +12.3% | 0.236 | no detectable difference; n=32 |
| estimatedCostUsd | $0.0434 / $0.0361 | $0.0384 / $0.0319 | -17.8% | -31.8% to -0.2% | 0.047 | CI excludes 0 (exploratory); n=32 |
| durationMs | 182.6s / 125.9s | 243.9s / 148.8s | +19.9% | -1.5% to +48.4% | 0.075 | no detectable difference; n=32 |
| modelLatencyMs | 91.8s / 69.0s | 93.2s / 81.8s | -4.6% | -22.7% to +17.4% | 0.681 | no detectable difference; n=32 |
| toolTimeMs | 54.8s / 11.5s | 114.6s / 19.0s | +101.8% | +37.5% to +216.4% | 1.0e-4 | CI excludes 0 (exploratory); n=32 |

## Cost per resolved task

Sum over paired tasks of per-task mean cost, divided by the sum of per-task resolved rates; the ratio is B/A.

| arm | cost | resolved tasks | cost per resolved task |
|---|---:|---:|---:|
| A | $2.5327 | 34.00 | $0.0745 |
| B | $2.2450 | 36.00 | $0.0624 |

B/A ratio: 0.837 (95% CI 0.724 to 0.956).

## Claimed success × resolved (valid runs of paired tasks)

| arm | runs | claimed, resolved | claimed, unresolved (false success) | not claimed, resolved | not claimed, unresolved |
|---|---:|---:|---:|---:|---:|
| A | 46 | 26 | 5 | 8 | 7 |
| B | 46 | 28 | 6 | 8 | 4 |

## Response models

- A (`baseline`): deepseek-flash
- B (`ctx-sandbox`): deepseek-flash

## Method

- The task is the unit: each metric is first averaged over an arm's valid runs of a task. invalid_result, harness_error, grading_error, and provider_error rows are left out of every statistic and counted under Completeness, which is defined as in the evaluation summary. Runs an environment failure ended, and runs whose patch made grading time out, run out of memory, or error, are valid (scored unresolved when grading failed) and counted separately.
- Every result directory must share the dataset, images, harness, agent limits, container limits, model, provider, endpoint, and inference settings, and each variant's rows must come from one agent version (agentFingerprint and sourceFingerprint); otherwise the comparison refuses to run.
- Rates (resolved, falseSuccess, emptyPatch) and trace proportions (cacheHitRate, toolFailureRate, governanceShare) report Δ = mean over tasks of B − A, in percentage points.
- Efficiency metrics report the geometric-mean change exp(mean ln((B+ε)/(A+ε))) − 1, with ε = 1e-9 × the metric's mean; tasks where both arms are 0 are skipped. Their A and B cells show the mean / median of per-task means.
- 95% CIs are percentile intervals over resamples of tasks with replacement, shared by all metrics; p = 2·min(P(stat ≤ 0), P(stat ≥ 0)), clamped to [1/B, 1]. The parenthesized Holm-adjusted p applies to the primary metrics only; every other p-value is unadjusted and exploratory.
- "Significant" requires a Holm-adjusted p ≤ α and a CI that excludes 0. A CI that includes 0 is reported as no detectable difference, which is not evidence of equivalence.
- resolved is non-inferior when the lower CI bound of B − A is above −10.0 pp.
- toolFailureRate counts tool calls that were rejected, errored, or timed out; a failing test run is not a failure. governanceShare is (set_plan + update_plan + finish_task) calls over all tool calls. modelLatencyMs and toolTimeMs sum model_turn.latencyMs and tool_result.durationMs.
