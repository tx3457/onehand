# Paired A/B comparison: A = `ctx-sandbox`, B = `ctx-sandbox-mask`

- Benchmark `swebench`, model `deepseek-flash`, split dev
- Results: `eval/results/swebench-dev25-mask-plan-r1`
- Paired tasks: 23; excluded because only one arm has a valid run: 1 only in A, 0 only in B
- 10000 paired bootstrap resamples of tasks (seed 20260925); primary metrics, Holm-corrected at α = 0.05: estimatedCostUsd, modelRounds

## Interpretation

- estimatedCostUsd: significantly higher in B; B vs A +31.7% (geometric mean; 95% CI +3.8% to +70.6%), Holm-adjusted p = 0.041.
- modelRounds: significantly higher in B; B vs A +24.8% (geometric mean; 95% CI +1.5% to +52.8%), Holm-adjusted p = 0.041.
- resolved: no detectable difference; B − A = +4.3 pp (95% CI +0.0 pp to +13.0 pp).
- resolved: B is non-inferior to A at a 10.0 pp margin; the lower 95% CI bound of B − A, +0.0 pp, is above -10.0 pp.
- Caution: the data are incomplete (see Completeness); the estimates cover only the valid paired runs.

## Warnings

- WARNING: A (ctx-sandbox) is incomplete: 1 planned run(s) missing.
- WARNING: B (ctx-sandbox-mask) is incomplete: 2 planned run(s) missing.

## Completeness

| arm | variant | planned | observed | valid | missing | invalid_result | harness_error | grading_error | provider_error | environment failure | patch-caused grading failure | outside plan | status |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| A | `ctx-sandbox` | 25 | 24 | 24 | 1 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | INCOMPLETE |
| B | `ctx-sandbox-mask` | 25 | 23 | 23 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | INCOMPLETE |

## All paired tasks (n = 23)

Every paired task; each metric averages that arm's valid runs of the task.

| metric | A | B | Δ or %change | 95% CI | p (Holm) | note |
|---|---:|---:|---:|---:|---:|---|
| resolved | 82.6% | 87.0% | +4.3 pp | +0.0 pp to +13.0 pp | 0.738 | no detectable difference; n=23; non-inferior at 10.0 pp |
| falseSuccess | 0.0% | 0.0% | +0.0 pp | +0.0 pp to +0.0 pp | 1.000 | no detectable difference; n=23 |
| emptyPatch | 13.0% | 13.0% | +0.0 pp | -13.0 pp to +13.0 pp | 1.000 | no detectable difference; n=23 |
| cacheHitRate | 94.8% | 94.4% | -0.4 pp | -1.8 pp to +1.0 pp | 0.547 | no detectable difference; n=23 |
| toolFailureRate | 7.8% | 7.3% | -0.5 pp | -2.3 pp to +1.3 pp | 0.574 | no detectable difference; n=23 |
| governanceShare | 14.5% | 13.2% | -1.3 pp | -3.4 pp to +0.9 pp | 0.240 | no detectable difference; n=23 |
| modelRounds | 38.4 / 35.0 | 49.9 / 48.0 | +24.8% | +1.5% to +52.8% | 0.034 (0.041) | primary; significant (Holm); n=23 |
| toolCalls | 54.0 / 49.0 | 70.8 / 65.0 | +26.0% | +5.0% to +51.5% | 0.014 | CI excludes 0 (exploratory); n=23 |
| inputTokens | 1254227 / 709175 | 1299765 / 1061194 | +13.9% | -18.7% to +61.5% | 0.453 | no detectable difference; n=23 |
| outputTokens | 22117 / 14994 | 28781 / 20211 | +35.4% | +4.4% to +80.5% | 0.017 | CI excludes 0 (exploratory); n=23 |
| reasoningTokens | 16410 / 9181 | 21058 / 13133 | +41.5% | +3.7% to +99.0% | 0.025 | CI excludes 0 (exploratory); n=23 |
| estimatedCostUsd | $0.0457 / $0.0319 | $0.0617 / $0.0569 | +31.7% | +3.8% to +70.6% | 0.020 (0.041) | primary; significant (Holm); n=23 |
| durationMs | 164.8s / 133.4s | 190.6s / 173.7s | +18.3% | -8.4% to +53.4% | 0.190 | no detectable difference; n=23 |
| modelLatencyMs | 117.0s / 87.2s | 150.4s / 125.5s | +30.8% | +1.6% to +71.2% | 0.034 | CI excludes 0 (exploratory); n=23 |
| toolTimeMs | 23.4s / 8.9s | 15.3s / 10.2s | +13.1% | -33.7% to +82.9% | 0.605 | no detectable difference; n=23 |

## Tasks resolved in both arms (n = 19), efficiency only

Tasks with at least one resolved run in each arm; each efficiency metric averages the resolved runs only.

| metric | A | B | Δ or %change | 95% CI | p (Holm) | note |
|---|---:|---:|---:|---:|---:|---|
| cacheHitRate | 94.4% | 94.2% | -0.2 pp | -1.8 pp to +1.4 pp | 0.777 | no detectable difference; n=19 |
| toolFailureRate | 6.3% | 6.3% | +0.0 pp | -2.2 pp to +2.0 pp | 0.969 | no detectable difference; n=19 |
| governanceShare | 16.9% | 15.6% | -1.3 pp | -3.9 pp to +1.3 pp | 0.328 | no detectable difference; n=19 |
| modelRounds | 36.2 / 35.0 | 43.6 / 32.0 | +15.7% | -7.2% to +42.6% | 0.187 | no detectable difference; n=19 |
| toolCalls | 50.3 / 47.0 | 60.9 / 56.0 | +17.3% | -3.6% to +40.7% | 0.102 | no detectable difference; n=19 |
| inputTokens | 1016205 / 645833 | 1061265 / 807065 | +9.3% | -23.3% to +57.6% | 0.627 | no detectable difference; n=19 |
| outputTokens | 18028 / 13263 | 22154 / 14742 | +26.4% | -1.7% to +67.4% | 0.068 | no detectable difference; n=19 |
| reasoningTokens | 12606 / 8012 | 15230 / 8706 | +32.8% | -2.6% to +87.9% | 0.076 | no detectable difference; n=19 |
| estimatedCostUsd | $0.0385 / $0.0307 | $0.0494 / $0.0346 | +22.7% | -3.3% to +58.3% | 0.089 | no detectable difference; n=19 |
| durationMs | 152.4s / 122.1s | 162.0s / 122.9s | +7.9% | -16.0% to +37.1% | 0.538 | no detectable difference; n=19 |
| modelLatencyMs | 97.7s / 77.8s | 118.1s / 87.4s | +21.7% | -5.1% to +58.5% | 0.123 | no detectable difference; n=19 |
| toolTimeMs | 27.0s / 9.5s | 16.0s / 9.4s | -6.9% | -48.0% to +53.0% | 0.829 | no detectable difference; n=19 |

## Cost per resolved task

Sum over paired tasks of per-task mean cost, divided by the sum of per-task resolved rates; the ratio is B/A.

| arm | cost | resolved tasks | cost per resolved task |
|---|---:|---:|---:|
| A | $1.0522 | 19.00 | $0.0554 |
| B | $1.4200 | 20.00 | $0.0710 |

B/A ratio: 1.282 (95% CI 1.049 to 1.647).

## Claimed success × resolved (valid runs of paired tasks)

| arm | runs | claimed, resolved | claimed, unresolved (false success) | not claimed, resolved | not claimed, unresolved |
|---|---:|---:|---:|---:|---:|
| A | 23 | 17 | 0 | 2 | 4 |
| B | 23 | 18 | 0 | 2 | 3 |

## Response models

- A (`ctx-sandbox`): deepseek-flash
- B (`ctx-sandbox-mask`): deepseek-flash

## Excluded tasks

- Only A has a valid run (1): sphinx-doc__sphinx-9320
- Only B has a valid run (0): none

## Method

- The task is the unit: each metric is first averaged over an arm's valid runs of a task. invalid_result, harness_error, grading_error, and provider_error rows are left out of every statistic and counted under Completeness, which is defined as in the evaluation summary. Runs an environment failure ended, and runs whose patch made grading time out, run out of memory, or error, are valid (scored unresolved when grading failed) and counted separately.
- Every result directory must share the dataset, images, harness, agent limits, container limits, model, provider, endpoint, and inference settings, and each variant's rows must come from one agent version (agentFingerprint and sourceFingerprint); otherwise the comparison refuses to run.
- Rates (resolved, falseSuccess, emptyPatch) and trace proportions (cacheHitRate, toolFailureRate, governanceShare) report Δ = mean over tasks of B − A, in percentage points.
- Efficiency metrics report the geometric-mean change exp(mean ln((B+ε)/(A+ε))) − 1, with ε = 1e-9 × the metric's mean; tasks where both arms are 0 are skipped. Their A and B cells show the mean / median of per-task means.
- 95% CIs are percentile intervals over resamples of tasks with replacement, shared by all metrics; p = 2·min(P(stat ≤ 0), P(stat ≥ 0)), clamped to [1/B, 1]. The parenthesized Holm-adjusted p applies to the primary metrics only; every other p-value is unadjusted and exploratory.
- "Significant" requires a Holm-adjusted p ≤ α and a CI that excludes 0. A CI that includes 0 is reported as no detectable difference, which is not evidence of equivalence.
- resolved is non-inferior when the lower CI bound of B − A is above −10.0 pp.
- toolFailureRate counts tool calls that were rejected, errored, or timed out; a failing test run is not a failure. governanceShare is (set_plan + update_plan + finish_task) calls over all tool calls. modelLatencyMs and toolTimeMs sum model_turn.latencyMs and tool_result.durationMs.
