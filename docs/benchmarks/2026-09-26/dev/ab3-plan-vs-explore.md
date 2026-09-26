# Paired A/B comparison: A = `ctx-sandbox-plan`, B = `ctx-sandbox-plan-explore`

- Benchmark `swebench`, model `deepseek-flash`, split dev
- Results: `eval/results/swebench-dev25-plan-explore-r1`
- Paired tasks: 25; excluded because only one arm has a valid run: 0 only in A, 0 only in B
- 10000 paired bootstrap resamples of tasks (seed 20260925); primary metrics, Holm-corrected at α = 0.05: estimatedCostUsd, modelRounds

## Interpretation

- estimatedCostUsd: no detectable difference; B vs A -6.7% (geometric mean; 95% CI -24.7% to +15.1%).
- modelRounds: no detectable difference; B vs A -6.9% (geometric mean; 95% CI -21.0% to +10.5%).
- resolved: no detectable difference; B − A = +0.0 pp (95% CI -12.0 pp to +12.0 pp).
- resolved: non-inferiority of B is NOT established at a 10.0 pp margin; the lower 95% CI bound of B − A, -12.0 pp, is not above -10.0 pp.

## Completeness

| arm | variant | planned | observed | valid | missing | invalid_result | harness_error | grading_error | provider_error | environment failure | patch-caused grading failure | outside plan | status |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| A | `ctx-sandbox-plan` | 25 | 25 | 25 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | complete |
| B | `ctx-sandbox-plan-explore` | 25 | 25 | 25 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | complete |

## All paired tasks (n = 25)

Every paired task; each metric averages that arm's valid runs of the task.

| metric | A | B | Δ or %change | 95% CI | p (Holm) | note |
|---|---:|---:|---:|---:|---:|---|
| resolved | 80.0% | 80.0% | +0.0 pp | -12.0 pp to +12.0 pp | 1.000 | no detectable difference; n=25; non-inferiority not shown at 10.0 pp |
| falseSuccess | 4.0% | 4.0% | +0.0 pp | +0.0 pp to +0.0 pp | 1.000 | no detectable difference; n=25 |
| emptyPatch | 4.0% | 8.0% | +4.0 pp | -8.0 pp to +16.0 pp | 0.784 | no detectable difference; n=25 |
| cacheHitRate | 95.8% | 95.4% | -0.4 pp | -1.3 pp to +0.6 pp | 0.479 | no detectable difference; n=25 |
| toolFailureRate | 8.2% | 7.3% | -0.9 pp | -2.7 pp to +0.8 pp | 0.303 | no detectable difference; n=25 |
| governanceShare | 9.2% | 9.0% | -0.1 pp | -2.1 pp to +1.7 pp | 0.929 | no detectable difference; n=25 |
| modelRounds | 43.2 / 42.0 | 40.9 / 37.0 | -6.9% | -21.0% to +10.5% | 0.407 (0.813) | primary; no detectable difference; n=25 |
| toolCalls | 60.0 / 62.0 | 56.4 / 52.0 | -7.0% | -21.4% to +10.1% | 0.396 | no detectable difference; n=25 |
| inputTokens | 1559070 / 1580780 | 1446692 / 752248 | -12.6% | -35.2% to +18.1% | 0.388 | no detectable difference; n=25 |
| outputTokens | 25333 / 19810 | 25345 / 17881 | -6.0% | -26.6% to +19.9% | 0.634 | no detectable difference; n=25 |
| reasoningTokens | 18743 / 12896 | 19087 / 11686 | -9.1% | -33.3% to +23.3% | 0.552 | no detectable difference; n=25 |
| estimatedCostUsd | $0.0517 / $0.0443 | $0.0507 / $0.0359 | -6.7% | -24.7% to +15.1% | 0.530 (0.813) | primary; no detectable difference; n=25 |
| durationMs | 272.1s / 210.1s | 193.8s / 142.4s | -20.4% | -39.5% to +4.8% | 0.110 | no detectable difference; n=25 |
| modelLatencyMs | 131.6s / 122.4s | 130.2s / 100.6s | -5.9% | -24.7% to +17.2% | 0.598 | no detectable difference; n=25 |
| toolTimeMs | 112.1s / 13.0s | 36.6s / 9.1s | -48.9% | -73.4% to -2.4% | 0.042 | CI excludes 0 (exploratory); n=25 |

## Tasks resolved in both arms (n = 19), efficiency only

Tasks with at least one resolved run in each arm; each efficiency metric averages the resolved runs only.

| metric | A | B | Δ or %change | 95% CI | p (Holm) | note |
|---|---:|---:|---:|---:|---:|---|
| cacheHitRate | 95.2% | 94.7% | -0.5 pp | -1.7 pp to +0.8 pp | 0.468 | no detectable difference; n=19 |
| toolFailureRate | 7.5% | 6.6% | -1.0 pp | -2.9 pp to +1.0 pp | 0.344 | no detectable difference; n=19 |
| governanceShare | 10.6% | 10.8% | +0.2 pp | -2.3 pp to +2.5 pp | 0.839 | no detectable difference; n=19 |
| modelRounds | 38.5 / 29.0 | 35.5 / 32.0 | -8.6% | -25.9% to +14.2% | 0.428 | no detectable difference; n=19 |
| toolCalls | 53.5 / 45.0 | 48.2 / 44.0 | -9.6% | -26.9% to +12.6% | 0.369 | no detectable difference; n=19 |
| inputTokens | 1301677 / 703952 | 1081327 / 645305 | -18.4% | -44.1% to +20.4% | 0.309 | no detectable difference; n=19 |
| outputTokens | 20990 / 16286 | 18921 / 13740 | -12.9% | -35.5% to +18.0% | 0.378 | no detectable difference; n=19 |
| reasoningTokens | 14917 / 12021 | 13279 / 8027 | -18.6% | -43.9% to +18.2% | 0.285 | no detectable difference; n=19 |
| estimatedCostUsd | $0.0446 / $0.0316 | $0.0403 / $0.0323 | -12.2% | -32.4% to +14.4% | 0.345 | no detectable difference; n=19 |
| durationMs | 219.4s / 210.1s | 172.0s / 110.0s | -20.2% | -42.5% to +10.4% | 0.176 | no detectable difference; n=19 |
| modelLatencyMs | 109.5s / 77.7s | 98.6s / 68.7s | -11.6% | -32.7% to +17.0% | 0.396 | no detectable difference; n=19 |
| toolTimeMs | 80.9s / 14.1s | 44.7s / 9.1s | -37.0% | -69.3% to +31.4% | 0.208 | no detectable difference; n=19 |

## Cost per resolved task

Sum over paired tasks of per-task mean cost, divided by the sum of per-task resolved rates; the ratio is B/A.

| arm | cost | resolved tasks | cost per resolved task |
|---|---:|---:|---:|
| A | $1.2935 | 20.00 | $0.0647 |
| B | $1.2677 | 20.00 | $0.0634 |

B/A ratio: 0.980 (95% CI 0.770 to 1.278).

## Claimed success × resolved (valid runs of paired tasks)

| arm | runs | claimed, resolved | claimed, unresolved (false success) | not claimed, resolved | not claimed, unresolved |
|---|---:|---:|---:|---:|---:|
| A | 25 | 19 | 1 | 1 | 4 |
| B | 25 | 18 | 1 | 2 | 4 |

## Response models

- A (`ctx-sandbox-plan`): deepseek-flash
- B (`ctx-sandbox-plan-explore`): deepseek-flash

## Method

- The task is the unit: each metric is first averaged over an arm's valid runs of a task. invalid_result, harness_error, grading_error, and provider_error rows are left out of every statistic and counted under Completeness, which is defined as in the evaluation summary. Runs an environment failure ended, and runs whose patch made grading time out, run out of memory, or error, are valid (scored unresolved when grading failed) and counted separately.
- Every result directory must share the dataset, images, harness, agent limits, container limits, model, provider, endpoint, and inference settings, and each variant's rows must come from one agent version (agentFingerprint and sourceFingerprint); otherwise the comparison refuses to run.
- Rates (resolved, falseSuccess, emptyPatch) and trace proportions (cacheHitRate, toolFailureRate, governanceShare) report Δ = mean over tasks of B − A, in percentage points.
- Efficiency metrics report the geometric-mean change exp(mean ln((B+ε)/(A+ε))) − 1, with ε = 1e-9 × the metric's mean; tasks where both arms are 0 are skipped. Their A and B cells show the mean / median of per-task means.
- 95% CIs are percentile intervals over resamples of tasks with replacement, shared by all metrics; p = 2·min(P(stat ≤ 0), P(stat ≥ 0)), clamped to [1/B, 1]. The parenthesized Holm-adjusted p applies to the primary metrics only; every other p-value is unadjusted and exploratory.
- "Significant" requires a Holm-adjusted p ≤ α and a CI that excludes 0. A CI that includes 0 is reported as no detectable difference, which is not evidence of equivalence.
- resolved is non-inferior when the lower CI bound of B − A is above −10.0 pp.
- toolFailureRate counts tool calls that were rejected, errored, or timed out; a failing test run is not a failure. governanceShare is (set_plan + update_plan + finish_task) calls over all tool calls. modelLatencyMs and toolTimeMs sum model_turn.latencyMs and tool_result.durationMs.
