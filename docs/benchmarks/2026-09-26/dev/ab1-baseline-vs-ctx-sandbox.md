# Paired A/B comparison: A = `baseline`, B = `ctx-sandbox`

- Benchmark `swebench`, model `deepseek-flash`, split dev
- Results: `eval/results/swebench-dev25-ctx-r1`
- Paired tasks: 25; excluded because only one arm has a valid run: 0 only in A, 0 only in B
- 10000 paired bootstrap resamples of tasks (seed 20260925); primary metrics, Holm-corrected at α = 0.05: estimatedCostUsd, modelRounds

## Interpretation

- estimatedCostUsd: significantly lower in B; B vs A -26.4% (geometric mean; 95% CI -40.4% to -8.4%), Holm-adjusted p = 0.012.
- modelRounds: no detectable difference; B vs A -2.8% (geometric mean; 95% CI -16.3% to +13.7%).
- resolved: no detectable difference; B − A = +4.0 pp (95% CI -8.0 pp to +16.0 pp).
- resolved: B is non-inferior to A at a 10.0 pp margin; the lower 95% CI bound of B − A, -8.0 pp, is above -10.0 pp.

## Completeness

| arm | variant | planned | observed | valid | missing | invalid_result | harness_error | grading_error | provider_error | environment failure | patch-caused grading failure | outside plan | status |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| A | `baseline` | 25 | 25 | 25 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | complete |
| B | `ctx-sandbox` | 25 | 25 | 25 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | complete |

## All paired tasks (n = 25)

Every paired task; each metric averages that arm's valid runs of the task.

| metric | A | B | Δ or %change | 95% CI | p (Holm) | note |
|---|---:|---:|---:|---:|---:|---|
| resolved | 76.0% | 80.0% | +4.0 pp | -8.0 pp to +16.0 pp | 0.785 | no detectable difference; n=25; non-inferior at 10.0 pp |
| falseSuccess | 0.0% | 4.0% | +4.0 pp | +0.0 pp to +12.0 pp | 0.722 | no detectable difference; n=25 |
| emptyPatch | 16.0% | 4.0% | -12.0 pp | -24.0 pp to +0.0 pp | 0.083 | no detectable difference; n=25 |
| cacheHitRate | 95.4% | 95.3% | -0.1 pp | -1.0 pp to +0.8 pp | 0.864 | no detectable difference; n=25 |
| toolFailureRate | 12.1% | 7.6% | -4.5 pp | -7.1 pp to -2.1 pp | 1.0e-4 | CI excludes 0 (exploratory); n=25 |
| governanceShare | 14.5% | 15.7% | +1.2 pp | -1.5 pp to +3.8 pp | 0.377 | no detectable difference; n=25 |
| modelRounds | 40.4 / 37.0 | 39.3 / 39.0 | -2.8% | -16.3% to +13.7% | 0.705 (0.705) | primary; no detectable difference; n=25 |
| toolCalls | 55.9 / 52.0 | 54.7 / 50.0 | -4.2% | -16.2% to +9.4% | 0.523 | no detectable difference; n=25 |
| inputTokens | 1792719 / 1463352 | 1262234 / 653374 | -39.1% | -55.0% to -16.2% | 0.003 | CI excludes 0 (exploratory); n=25 |
| outputTokens | 23157 / 15573 | 22393 / 15293 | -12.9% | -30.0% to +9.4% | 0.232 | no detectable difference; n=25 |
| reasoningTokens | 17340 / 9971 | 16636 / 10830 | -19.6% | -40.1% to +9.0% | 0.160 | no detectable difference; n=25 |
| estimatedCostUsd | $0.0564 / $0.0457 | $0.0459 / $0.0346 | -26.4% | -40.4% to -8.4% | 0.006 (0.012) | primary; significant (Holm); n=25 |
| durationMs | 171.6s / 149.1s | 207.2s / 131.3s | +2.4% | -14.0% to +23.0% | 0.829 | no detectable difference; n=25 |
| modelLatencyMs | 125.8s / 99.7s | 119.2s / 89.8s | -11.8% | -27.0% to +7.5% | 0.209 | no detectable difference; n=25 |
| toolTimeMs | 21.8s / 7.0s | 61.4s / 11.1s | +58.0% | +2.0% to +154.7% | 0.040 | CI excludes 0 (exploratory); n=25 |

## Tasks resolved in both arms (n = 18), efficiency only

Tasks with at least one resolved run in each arm; each efficiency metric averages the resolved runs only.

| metric | A | B | Δ or %change | 95% CI | p (Holm) | note |
|---|---:|---:|---:|---:|---:|---|
| cacheHitRate | 94.6% | 94.6% | -0.1 pp | -1.3 pp to +1.2 pp | 0.925 | no detectable difference; n=18 |
| toolFailureRate | 11.9% | 6.7% | -5.2 pp | -8.4 pp to -2.0 pp | 8.0e-4 | CI excludes 0 (exploratory); n=18 |
| governanceShare | 17.5% | 18.9% | +1.4 pp | -1.9 pp to +4.4 pp | 0.378 | no detectable difference; n=18 |
| modelRounds | 34.6 / 31.5 | 32.9 / 31.0 | -3.2% | -21.0% to +19.2% | 0.738 | no detectable difference; n=18 |
| toolCalls | 49.7 / 45.5 | 46.3 / 45.0 | -7.3% | -22.1% to +10.7% | 0.391 | no detectable difference; n=18 |
| inputTokens | 1417244 / 1025075 | 800610 / 596090 | -44.3% | -61.8% to -15.3% | 0.008 | CI excludes 0 (exploratory); n=18 |
| outputTokens | 17064 / 13590 | 13765 / 9919 | -18.4% | -37.5% to +8.9% | 0.161 | no detectable difference; n=18 |
| reasoningTokens | 11746 / 8390 | 8762 / 5739 | -26.1% | -49.4% to +10.3% | 0.133 | no detectable difference; n=18 |
| estimatedCostUsd | $0.0460 / $0.0415 | $0.0311 / $0.0230 | -32.8% | -47.9% to -10.4% | 0.008 | CI excludes 0 (exploratory); n=18 |
| durationMs | 151.3s / 120.8s | 185.8s / 109.8s | -0.3% | -20.3% to +27.8% | 0.942 | no detectable difference; n=18 |
| modelLatencyMs | 95.8s / 75.3s | 79.0s / 60.1s | -15.9% | -33.6% to +8.5% | 0.175 | no detectable difference; n=18 |
| toolTimeMs | 27.7s / 9.7s | 79.2s / 11.0s | +39.9% | -14.8% to +140.6% | 0.200 | no detectable difference; n=18 |

## Cost per resolved task

Sum over paired tasks of per-task mean cost, divided by the sum of per-task resolved rates; the ratio is B/A.

| arm | cost | resolved tasks | cost per resolved task |
|---|---:|---:|---:|
| A | $1.4099 | 19.00 | $0.0742 |
| B | $1.1477 | 20.00 | $0.0574 |

B/A ratio: 0.773 (95% CI 0.617 to 0.957).

## Claimed success × resolved (valid runs of paired tasks)

| arm | runs | claimed, resolved | claimed, unresolved (false success) | not claimed, resolved | not claimed, unresolved |
|---|---:|---:|---:|---:|---:|
| A | 25 | 15 | 0 | 4 | 6 |
| B | 25 | 19 | 1 | 1 | 4 |

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
