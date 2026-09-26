# Paired A/B comparison: A = `baseline`, B = `ctx-sandbox`

- Benchmark `swebench`, model `deepseek-flash`, split dev
- Results: `eval/results/final-2026-09-26-mini`
- Paired tasks: 50; excluded because only one arm has a valid run: 0 only in A, 0 only in B
- 10000 paired bootstrap resamples of tasks (seed 20260925); primary metrics, Holm-corrected at α = 0.05: estimatedCostUsd, modelRounds

## Interpretation

- estimatedCostUsd: significantly lower in B; B vs A -20.7% (geometric mean; 95% CI -28.0% to -13.1%), Holm-adjusted p = 2.0e-4.
- modelRounds: no detectable difference; B vs A -2.2% (geometric mean; 95% CI -9.9% to +5.5%).
- resolved: no detectable difference; B − A = +0.0 pp (95% CI -4.7 pp to +4.7 pp).
- resolved: B is non-inferior to A at a 10.0 pp margin; the lower 95% CI bound of B − A, -4.7 pp, is above -10.0 pp.

## Completeness

| arm | variant | planned | observed | valid | missing | invalid_result | harness_error | grading_error | provider_error | environment failure | patch-caused grading failure | outside plan | status |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| A | `baseline` | 150 | 150 | 150 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | complete |
| B | `ctx-sandbox` | 150 | 150 | 150 | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | complete |

## All paired tasks (n = 50)

Every paired task; each metric averages that arm's valid runs of the task.

| metric | A | B | Δ or %change | 95% CI | p (Holm) | note |
|---|---:|---:|---:|---:|---:|---|
| resolved | 72.0% | 72.0% | +0.0 pp | -4.7 pp to +4.7 pp | 1.000 | no detectable difference; n=50; non-inferior at 10.0 pp |
| falseSuccess | 1.3% | 4.0% | +2.7 pp | -0.7 pp to +6.7 pp | 0.181 | no detectable difference; n=50 |
| emptyPatch | 11.3% | 10.0% | -1.3 pp | -8.0 pp to +4.7 pp | 0.790 | no detectable difference; n=50 |
| cacheHitRate | 96.1% | 95.7% | -0.4 pp | -0.8 pp to +0.1 pp | 0.115 | no detectable difference; n=50 |
| toolFailureRate | 11.3% | 8.7% | -2.6 pp | -3.7 pp to -1.6 pp | 1.0e-4 | CI excludes 0 (exploratory); n=50 |
| governanceShare | 12.6% | 14.3% | +1.7 pp | +0.3 pp to +3.3 pp | 0.018 | CI excludes 0 (exploratory); n=50 |
| modelRounds | 41.6 / 43.7 | 43.2 / 42.0 | -2.2% | -9.9% to +5.5% | 0.582 (0.582) | primary; no detectable difference; n=50 |
| toolCalls | 60.0 / 61.3 | 61.5 / 63.7 | -2.6% | -9.8% to +4.8% | 0.480 | no detectable difference; n=50 |
| inputTokens | 1998073 / 2141708 | 1579805 / 1290965 | -35.0% | -44.0% to -25.3% | 1.0e-4 | CI excludes 0 (exploratory); n=50 |
| outputTokens | 26473 / 22455 | 27976 / 25793 | -6.0% | -15.0% to +3.4% | 0.207 | no detectable difference; n=50 |
| reasoningTokens | 20577 / 16601 | 21478 / 19087 | -11.3% | -21.7% to -0.4% | 0.042 | CI excludes 0 (exploratory); n=50 |
| estimatedCostUsd | $0.0624 / $0.0566 | $0.0551 / $0.0515 | -20.7% | -28.0% to -13.1% | 1.0e-4 (2.0e-4) | primary; significant (Holm); n=50 |
| durationMs | 172.3s / 158.2s | 224.2s / 189.5s | +9.2% | -3.7% to +24.5% | 0.180 | no detectable difference; n=50 |
| modelLatencyMs | 129.3s / 112.8s | 132.6s / 119.2s | -8.7% | -17.1% to +0.0% | 0.049 | CI excludes 0 (exploratory); n=50 |
| toolTimeMs | 16.2s / 7.0s | 64.2s / 10.5s | +109.4% | +42.9% to +214.3% | 1.0e-4 | CI excludes 0 (exploratory); n=50 |

## Tasks resolved in both arms (n = 38), efficiency only

Tasks with at least one resolved run in each arm; each efficiency metric averages the resolved runs only.

| metric | A | B | Δ or %change | 95% CI | p (Holm) | note |
|---|---:|---:|---:|---:|---:|---|
| cacheHitRate | 95.7% | 95.0% | -0.7 pp | -1.2 pp to -0.2 pp | 0.008 | CI excludes 0 (exploratory); n=38 |
| toolFailureRate | 11.0% | 8.0% | -3.0 pp | -4.3 pp to -1.6 pp | 1.0e-4 | CI excludes 0 (exploratory); n=38 |
| governanceShare | 15.1% | 17.3% | +2.3 pp | +0.6 pp to +4.0 pp | 0.009 | CI excludes 0 (exploratory); n=38 |
| modelRounds | 37.9 / 38.8 | 37.1 / 31.0 | -7.5% | -16.2% to +2.0% | 0.119 | no detectable difference; n=38 |
| toolCalls | 55.3 / 59.0 | 53.6 / 44.8 | -8.0% | -16.1% to +0.9% | 0.078 | no detectable difference; n=38 |
| inputTokens | 1683047 / 1461722 | 1182879 / 698358 | -42.3% | -51.5% to -31.5% | 1.0e-4 | CI excludes 0 (exploratory); n=38 |
| outputTokens | 21946 / 18661 | 21205 / 16210 | -13.2% | -22.8% to -2.7% | 0.015 | CI excludes 0 (exploratory); n=38 |
| reasoningTokens | 16400 / 13150 | 15358 / 10726 | -19.6% | -30.6% to -7.4% | 0.002 | CI excludes 0 (exploratory); n=38 |
| estimatedCostUsd | $0.0540 / $0.0487 | $0.0435 / $0.0351 | -27.0% | -34.7% to -18.5% | 1.0e-4 | CI excludes 0 (exploratory); n=38 |
| durationMs | 150.8s / 141.8s | 170.4s / 126.1s | -1.4% | -13.4% to +13.3% | 0.810 | no detectable difference; n=38 |
| modelLatencyMs | 107.4s / 100.2s | 100.5s / 78.3s | -16.0% | -24.9% to -6.1% | 0.002 | CI excludes 0 (exploratory); n=38 |
| toolTimeMs | 13.8s / 6.8s | 40.4s / 9.9s | +61.8% | +13.9% to +133.3% | 0.007 | CI excludes 0 (exploratory); n=38 |

## Cost per resolved task

Sum over paired tasks of per-task mean cost, divided by the sum of per-task resolved rates; the ratio is B/A.

| arm | cost | resolved tasks | cost per resolved task |
|---|---:|---:|---:|
| A | $3.1213 | 36.00 | $0.0867 |
| B | $2.7573 | 36.00 | $0.0766 |

B/A ratio: 0.883 (95% CI 0.797 to 0.986).

## Claimed success × resolved (valid runs of paired tasks)

| arm | runs | claimed, resolved | claimed, unresolved (false success) | not claimed, resolved | not claimed, unresolved |
|---|---:|---:|---:|---:|---:|
| A | 150 | 84 | 2 | 24 | 40 |
| B | 150 | 91 | 6 | 17 | 36 |

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
