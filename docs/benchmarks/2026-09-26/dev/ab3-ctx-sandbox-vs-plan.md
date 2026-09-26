# Paired A/B comparison: A = `ctx-sandbox`, B = `ctx-sandbox-plan`

- Benchmark `swebench`, model `deepseek-flash`, split dev
- Results: `eval/results/swebench-dev25-plan-explore-r1`
- Paired tasks: 25; excluded because only one arm has a valid run: 0 only in A, 0 only in B
- 10000 paired bootstrap resamples of tasks (seed 20260925); primary metrics, Holm-corrected at α = 0.05: estimatedCostUsd, modelRounds

## Interpretation

- estimatedCostUsd: no detectable difference; B vs A +5.4% (geometric mean; 95% CI -14.3% to +32.9%).
- modelRounds: no detectable difference; B vs A +6.0% (geometric mean; 95% CI -7.6% to +22.3%).
- resolved: no detectable difference; B − A = -4.0 pp (95% CI -16.0 pp to +8.0 pp).
- resolved: non-inferiority of B is NOT established at a 10.0 pp margin; the lower 95% CI bound of B − A, -16.0 pp, is not above -10.0 pp.

## Completeness

| arm | variant | planned | observed | valid | missing | invalid_result | harness_error | grading_error | provider_error | environment failure | patch-caused grading failure | outside plan | status |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| A | `ctx-sandbox` | 25 | 25 | 25 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | complete |
| B | `ctx-sandbox-plan` | 25 | 25 | 25 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | complete |

## All paired tasks (n = 25)

Every paired task; each metric averages that arm's valid runs of the task.

| metric | A | B | Δ or %change | 95% CI | p (Holm) | note |
|---|---:|---:|---:|---:|---:|---|
| resolved | 84.0% | 80.0% | -4.0 pp | -16.0 pp to +8.0 pp | 0.778 | no detectable difference; n=25; non-inferiority not shown at 10.0 pp |
| falseSuccess | 0.0% | 4.0% | +4.0 pp | +0.0 pp to +12.0 pp | 0.722 | no detectable difference; n=25 |
| emptyPatch | 12.0% | 4.0% | -8.0 pp | -20.0 pp to +0.0 pp | 0.260 | no detectable difference; n=25 |
| cacheHitRate | 95.2% | 95.8% | +0.6 pp | -0.3 pp to +1.5 pp | 0.193 | no detectable difference; n=25 |
| toolFailureRate | 8.5% | 8.2% | -0.3 pp | -2.0 pp to +1.5 pp | 0.730 | no detectable difference; n=25 |
| governanceShare | 15.1% | 9.2% | -6.0 pp | -8.6 pp to -3.5 pp | 1.0e-4 | CI excludes 0 (exploratory); n=25 |
| modelRounds | 40.2 / 34.0 | 43.2 / 42.0 | +6.0% | -7.6% to +22.3% | 0.421 (0.842) | primary; no detectable difference; n=25 |
| toolCalls | 57.7 / 50.0 | 60.0 / 62.0 | +1.0% | -12.9% to +18.3% | 0.906 | no detectable difference; n=25 |
| inputTokens | 1457039 / 785954 | 1559070 / 1580780 | +8.7% | -17.9% to +47.2% | 0.589 | no detectable difference; n=25 |
| outputTokens | 23128 / 18051 | 25333 / 19810 | +10.1% | -13.6% to +44.7% | 0.475 | no detectable difference; n=25 |
| reasoningTokens | 17126 / 11461 | 18743 / 12896 | +14.1% | -17.3% to +63.3% | 0.453 | no detectable difference; n=25 |
| estimatedCostUsd | $0.0491 / $0.0377 | $0.0517 / $0.0443 | +5.4% | -14.3% to +32.9% | 0.652 (0.842) | primary; no detectable difference; n=25 |
| durationMs | 159.5s / 137.6s | 272.1s / 210.1s | +35.2% | +3.4% to +80.3% | 0.024 | CI excludes 0 (exploratory); n=25 |
| modelLatencyMs | 122.1s / 102.5s | 131.6s / 122.4s | +7.4% | -13.0% to +35.6% | 0.548 | no detectable difference; n=25 |
| toolTimeMs | 11.1s / 8.2s | 112.1s / 13.0s | +155.8% | +33.8% to +409.2% | 0.003 | CI excludes 0 (exploratory); n=25 |

## Tasks resolved in both arms (n = 19), efficiency only

Tasks with at least one resolved run in each arm; each efficiency metric averages the resolved runs only.

| metric | A | B | Δ or %change | 95% CI | p (Holm) | note |
|---|---:|---:|---:|---:|---:|---|
| cacheHitRate | 94.3% | 95.2% | +0.8 pp | -0.2 pp to +2.0 pp | 0.129 | no detectable difference; n=19 |
| toolFailureRate | 7.5% | 7.5% | +0.1 pp | -1.9 pp to +2.2 pp | 0.952 | no detectable difference; n=19 |
| governanceShare | 18.4% | 10.6% | -7.8 pp | -10.7 pp to -5.0 pp | 1.0e-4 | CI excludes 0 (exploratory); n=19 |
| modelRounds | 35.2 / 31.0 | 38.5 / 29.0 | +8.4% | -8.1% to +29.6% | 0.363 | no detectable difference; n=19 |
| toolCalls | 50.2 / 46.0 | 53.5 / 45.0 | +3.7% | -12.0% to +24.5% | 0.710 | no detectable difference; n=19 |
| inputTokens | 1048528 / 712949 | 1301677 / 703952 | +22.0% | -13.3% to +75.1% | 0.275 | no detectable difference; n=19 |
| outputTokens | 16278 / 12489 | 20990 / 16286 | +22.2% | -8.5% to +69.2% | 0.194 | no detectable difference; n=19 |
| reasoningTokens | 10974 / 8151 | 14917 / 12021 | +31.0% | -11.6% to +101.1% | 0.185 | no detectable difference; n=19 |
| estimatedCostUsd | $0.0373 / $0.0312 | $0.0446 / $0.0316 | +15.2% | -10.3% to +51.2% | 0.289 | no detectable difference; n=19 |
| durationMs | 130.1s / 111.4s | 219.4s / 210.1s | +38.3% | +1.9% to +94.1% | 0.037 | CI excludes 0 (exploratory); n=19 |
| modelLatencyMs | 89.3s / 74.2s | 109.5s / 77.7s | +16.8% | -9.2% to +55.3% | 0.257 | no detectable difference; n=19 |
| toolTimeMs | 11.9s / 7.2s | 80.9s / 14.1s | +109.7% | +5.8% to +343.1% | 0.033 | CI excludes 0 (exploratory); n=19 |

## Cost per resolved task

Sum over paired tasks of per-task mean cost, divided by the sum of per-task resolved rates; the ratio is B/A.

| arm | cost | resolved tasks | cost per resolved task |
|---|---:|---:|---:|
| A | $1.2273 | 21.00 | $0.0584 |
| B | $1.2935 | 20.00 | $0.0647 |

B/A ratio: 1.107 (95% CI 0.854 to 1.403).

## Claimed success × resolved (valid runs of paired tasks)

| arm | runs | claimed, resolved | claimed, unresolved (false success) | not claimed, resolved | not claimed, unresolved |
|---|---:|---:|---:|---:|---:|
| A | 25 | 17 | 0 | 4 | 4 |
| B | 25 | 19 | 1 | 1 | 4 |

## Response models

- A (`ctx-sandbox`): deepseek-flash
- B (`ctx-sandbox-plan`): deepseek-flash

## Method

- The task is the unit: each metric is first averaged over an arm's valid runs of a task. invalid_result, harness_error, grading_error, and provider_error rows are left out of every statistic and counted under Completeness, which is defined as in the evaluation summary. Runs an environment failure ended, and runs whose patch made grading time out, run out of memory, or error, are valid (scored unresolved when grading failed) and counted separately.
- Every result directory must share the dataset, images, harness, agent limits, container limits, model, provider, endpoint, and inference settings, and each variant's rows must come from one agent version (agentFingerprint and sourceFingerprint); otherwise the comparison refuses to run.
- Rates (resolved, falseSuccess, emptyPatch) and trace proportions (cacheHitRate, toolFailureRate, governanceShare) report Δ = mean over tasks of B − A, in percentage points.
- Efficiency metrics report the geometric-mean change exp(mean ln((B+ε)/(A+ε))) − 1, with ε = 1e-9 × the metric's mean; tasks where both arms are 0 are skipped. Their A and B cells show the mean / median of per-task means.
- 95% CIs are percentile intervals over resamples of tasks with replacement, shared by all metrics; p = 2·min(P(stat ≤ 0), P(stat ≥ 0)), clamped to [1/B, 1]. The parenthesized Holm-adjusted p applies to the primary metrics only; every other p-value is unadjusted and exploratory.
- "Significant" requires a Holm-adjusted p ≤ α and a CI that excludes 0. A CI that includes 0 is reported as no detectable difference, which is not evidence of equivalence.
- resolved is non-inferior when the lower CI bound of B − A is above −10.0 pp.
- toolFailureRate counts tool calls that were rejected, errored, or timed out; a failing test run is not a failure. governanceShare is (set_plan + update_plan + finish_task) calls over all tool calls. modelLatencyMs and toolTimeMs sum model_turn.latencyMs and tool_result.durationMs.
