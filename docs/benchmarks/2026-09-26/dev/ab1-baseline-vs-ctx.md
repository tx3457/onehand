# Paired A/B comparison: A = `baseline`, B = `ctx`

- Benchmark `swebench`, model `deepseek-flash`, split dev
- Results: `eval/results/swebench-dev25-ctx-r1`
- Paired tasks: 25; excluded because only one arm has a valid run: 0 only in A, 0 only in B
- 10000 paired bootstrap resamples of tasks (seed 20260925); primary metrics, Holm-corrected at α = 0.05: estimatedCostUsd, modelRounds

## Interpretation

- estimatedCostUsd: no detectable difference; B vs A -9.8% (geometric mean; 95% CI -25.2% to +9.5%).
- modelRounds: no detectable difference; B vs A +11.5% (geometric mean; 95% CI -5.9% to +33.6%).
- resolved: no detectable difference; B − A = +8.0 pp (95% CI +0.0 pp to +20.0 pp).
- resolved: B is non-inferior to A at a 10.0 pp margin; the lower 95% CI bound of B − A, +0.0 pp, is above -10.0 pp.

## Completeness

| arm | variant | planned | observed | valid | missing | invalid_result | harness_error | grading_error | provider_error | environment failure | patch-caused grading failure | outside plan | status |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| A | `baseline` | 25 | 25 | 25 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | complete |
| B | `ctx` | 25 | 25 | 25 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | complete |

## All paired tasks (n = 25)

Every paired task; each metric averages that arm's valid runs of the task.

| metric | A | B | Δ or %change | 95% CI | p (Holm) | note |
|---|---:|---:|---:|---:|---:|---|
| resolved | 76.0% | 84.0% | +8.0 pp | +0.0 pp to +20.0 pp | 0.245 | no detectable difference; n=25; non-inferior at 10.0 pp |
| falseSuccess | 0.0% | 0.0% | +0.0 pp | +0.0 pp to +0.0 pp | 1.000 | no detectable difference; n=25 |
| emptyPatch | 16.0% | 8.0% | -8.0 pp | -20.0 pp to +0.0 pp | 0.248 | no detectable difference; n=25 |
| cacheHitRate | 95.4% | 96.0% | +0.6 pp | -0.3 pp to +1.5 pp | 0.193 | no detectable difference; n=25 |
| toolFailureRate | 12.1% | 11.3% | -0.8 pp | -3.0 pp to +1.3 pp | 0.464 | no detectable difference; n=25 |
| governanceShare | 14.5% | 12.8% | -1.6 pp | -4.1 pp to +0.8 pp | 0.192 | no detectable difference; n=25 |
| modelRounds | 40.4 / 37.0 | 45.6 / 40.0 | +11.5% | -5.9% to +33.6% | 0.223 (0.446) | primary; no detectable difference; n=25 |
| toolCalls | 55.9 / 52.0 | 64.4 / 59.0 | +12.3% | -2.4% to +29.4% | 0.108 | no detectable difference; n=25 |
| inputTokens | 1792719 / 1463352 | 1602552 / 1029815 | -18.8% | -36.7% to +3.5% | 0.087 | no detectable difference; n=25 |
| outputTokens | 23157 / 15573 | 26891 / 24035 | +10.3% | -13.6% to +44.2% | 0.458 | no detectable difference; n=25 |
| reasoningTokens | 17340 / 9971 | 20281 / 18821 | +8.6% | -20.5% to +52.2% | 0.635 | no detectable difference; n=25 |
| estimatedCostUsd | $0.0564 / $0.0457 | $0.0539 / $0.0460 | -9.8% | -25.2% to +9.5% | 0.276 (0.446) | primary; no detectable difference; n=25 |
| durationMs | 171.6s / 149.1s | 191.5s / 195.7s | +6.8% | -12.8% to +32.4% | 0.531 | no detectable difference; n=25 |
| modelLatencyMs | 125.8s / 99.7s | 143.0s / 120.4s | +8.3% | -12.9% to +37.4% | 0.502 | no detectable difference; n=25 |
| toolTimeMs | 21.8s / 7.0s | 22.6s / 6.4s | +0.1% | -42.2% to +65.4% | 0.962 | no detectable difference; n=25 |

## Tasks resolved in both arms (n = 19), efficiency only

Tasks with at least one resolved run in each arm; each efficiency metric averages the resolved runs only.

| metric | A | B | Δ or %change | 95% CI | p (Holm) | note |
|---|---:|---:|---:|---:|---:|---|
| cacheHitRate | 94.7% | 95.4% | +0.7 pp | -0.4 pp to +1.8 pp | 0.229 | no detectable difference; n=19 |
| toolFailureRate | 12.1% | 11.3% | -0.8 pp | -3.4 pp to +1.7 pp | 0.575 | no detectable difference; n=19 |
| governanceShare | 17.6% | 15.5% | -2.1 pp | -5.1 pp to +0.9 pp | 0.169 | no detectable difference; n=19 |
| modelRounds | 34.7 / 34.0 | 39.7 / 36.0 | +11.6% | -9.5% to +39.8% | 0.323 | no detectable difference; n=19 |
| toolCalls | 49.2 / 45.0 | 55.9 / 52.0 | +10.5% | -7.6% to +32.9% | 0.275 | no detectable difference; n=19 |
| inputTokens | 1397849 / 1040918 | 1217247 / 809405 | -21.6% | -42.3% to +6.7% | 0.125 | no detectable difference; n=19 |
| outputTokens | 17369 / 13755 | 21069 / 14987 | +11.5% | -18.6% to +56.3% | 0.529 | no detectable difference; n=19 |
| reasoningTokens | 12048 / 8903 | 15227 / 10245 | +10.5% | -26.3% to +70.2% | 0.657 | no detectable difference; n=19 |
| estimatedCostUsd | $0.0459 / $0.0426 | $0.0431 / $0.0346 | -11.9% | -30.4% to +12.2% | 0.304 | no detectable difference; n=19 |
| durationMs | 151.2s / 121.0s | 167.6s / 113.5s | +5.4% | -18.6% to +39.5% | 0.716 | no detectable difference; n=19 |
| modelLatencyMs | 96.8s / 75.4s | 113.8s / 83.0s | +8.8% | -17.9% to +46.6% | 0.580 | no detectable difference; n=19 |
| toolTimeMs | 26.5s / 9.5s | 25.9s / 6.4s | -10.2% | -54.7% to +67.8% | 0.766 | no detectable difference; n=19 |

## Cost per resolved task

Sum over paired tasks of per-task mean cost, divided by the sum of per-task resolved rates; the ratio is B/A.

| arm | cost | resolved tasks | cost per resolved task |
|---|---:|---:|---:|
| A | $1.4099 | 19.00 | $0.0742 |
| B | $1.3483 | 21.00 | $0.0642 |

B/A ratio: 0.865 (95% CI 0.701 to 1.044).

## Claimed success × resolved (valid runs of paired tasks)

| arm | runs | claimed, resolved | claimed, unresolved (false success) | not claimed, resolved | not claimed, unresolved |
|---|---:|---:|---:|---:|---:|
| A | 25 | 15 | 0 | 4 | 6 |
| B | 25 | 17 | 0 | 4 | 4 |

## Response models

- A (`baseline`): deepseek-flash
- B (`ctx`): deepseek-flash

## Method

- The task is the unit: each metric is first averaged over an arm's valid runs of a task. invalid_result, harness_error, grading_error, and provider_error rows are left out of every statistic and counted under Completeness, which is defined as in the evaluation summary. Runs an environment failure ended, and runs whose patch made grading time out, run out of memory, or error, are valid (scored unresolved when grading failed) and counted separately.
- Every result directory must share the dataset, images, harness, agent limits, container limits, model, provider, endpoint, and inference settings, and each variant's rows must come from one agent version (agentFingerprint and sourceFingerprint); otherwise the comparison refuses to run.
- Rates (resolved, falseSuccess, emptyPatch) and trace proportions (cacheHitRate, toolFailureRate, governanceShare) report Δ = mean over tasks of B − A, in percentage points.
- Efficiency metrics report the geometric-mean change exp(mean ln((B+ε)/(A+ε))) − 1, with ε = 1e-9 × the metric's mean; tasks where both arms are 0 are skipped. Their A and B cells show the mean / median of per-task means.
- 95% CIs are percentile intervals over resamples of tasks with replacement, shared by all metrics; p = 2·min(P(stat ≤ 0), P(stat ≥ 0)), clamped to [1/B, 1]. The parenthesized Holm-adjusted p applies to the primary metrics only; every other p-value is unadjusted and exploratory.
- "Significant" requires a Holm-adjusted p ≤ α and a CI that excludes 0. A CI that includes 0 is reported as no detectable difference, which is not evidence of equivalence.
- resolved is non-inferior when the lower CI bound of B − A is above −10.0 pp.
- toolFailureRate counts tool calls that were rejected, errored, or timed out; a failing test run is not a failure. governanceShare is (set_plan + update_plan + finish_task) calls over all tool calls. modelLatencyMs and toolTimeMs sum model_turn.latencyMs and tool_result.durationMs.
