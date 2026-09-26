# SWE-bench evaluation: holdout, `baseline`, `ctx-sandbox`

> A/B claims come only from `npm run eval:compare` on paired variants. A single-variant run is a diagnostic of one configuration, not a comparison.

- Evaluation `swebench-holdout-2026-09-26T11-54-05-087Z-142320`; model `deepseek-flash` (thinking enabled, reasoning effort high); images: epoch
- Dataset revision `78f471bf655a3137b2e8a75af1501690ec009ec3`; data file sha256 `faf8fab974e851c5065a84d2a46e6c77ab99143d2f3d0a9922c81105514403dd`; swebench 5.0.2
- Plan: 46 instance(s) × 1 repetition(s) × 2 variant(s) = 92 run(s); 0 instance(s) excluded by self-check
- Cost cap $30.00, with $0.3000 reserved per run in flight; limits are checked before each model turn, so a run can exceed its reservation by at most one turn's usage

## Completeness

COMPLETE.

| planned | observed | missing | invalid_result | harness_error | grading_error | provider_error | environment_failure | test timeout | out of memory | tests errored | cap reached |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| 92 | 92 | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | no |

A run that an environment failure ended is complete: it keeps its real usage and cost and its graded verdict, and is counted separately above. So is a run whose patch made grading time out, run out of memory, or error after the tests ran: like the official harness, it is scored unresolved. invalid_result, harness_error, grading_error, and provider_error rows leave the evaluation incomplete and are left out of every statistic below; a resume runs the job of every provider_error row again.

## Resolved

- 70 of 92 scored run(s) resolved: 76.1% (task-cluster bootstrap 95% CI 64.1% to 87.0%); pooled over every variant, see Per variant
- False success (finish_task accepted, not resolved): 11 of 92 (12.0%)

| repository | runs | resolved | rate | 95% CI |
|---|---:|---:|---:|---:|
| astropy/astropy | 6 | 6 | 100.0% | 100.0% to 100.0% |
| django/django | 46 | 32 | 69.6% | 52.2% to 84.8% |
| matplotlib/matplotlib | 2 | 2 | 100.0% | 100.0% to 100.0% |
| pydata/xarray | 4 | 1 | 25.0% | 0.0% to 50.0% |
| pylint-dev/pylint | 2 | 2 | 100.0% | 100.0% to 100.0% |
| pytest-dev/pytest | 4 | 2 | 50.0% | 0.0% to 100.0% |
| scikit-learn/scikit-learn | 8 | 8 | 100.0% | 100.0% to 100.0% |
| sphinx-doc/sphinx | 4 | 4 | 100.0% | 100.0% to 100.0% |
| sympy/sympy | 16 | 13 | 81.3% | 56.3% to 100.0% |

| difficulty | runs | resolved | rate | 95% CI |
|---|---:|---:|---:|---:|
| 1-4 hours | 8 | 4 | 50.0% | 0.0% to 100.0% |
| 15 min - 1 hour | 44 | 32 | 72.7% | 56.8% to 88.6% |
| <15 min fix | 38 | 34 | 89.5% | 76.3% to 100.0% |
| >4 hours | 2 | 0 | 0.0% | 0.0% to 0.0% |

## Claimed success × resolved

| | resolved | not resolved |
|---|---:|---:|
| claimed success | 54 | 11 (false success) |
| no success claim | 16 | 11 |

## Patches

- Empty patches: 3 of 92 (3.3%); the harness does not run on an empty patch, so it is unresolved.
- Non-empty patches the harness could not apply: 0

## Efficiency per scored run

| metric | mean | P50 | P95 | max |
|---|---:|---:|---:|---:|
| model rounds | 41.3 | 37.0 | 74.0 | 80.0 |
| tool calls | 58.1 | 54.0 | 101.0 | 123.0 |
| input tokens | 1,557,788 | 1,089,175 | 3,077,965 | 3,094,936 |
| output tokens | 24,702 | 18,027 | 67,779 | 89,785 |
| reasoning tokens | 18,237 | 12,377 | 58,586 | 78,847 |
| cost (final attempt) | $0.0519 | $0.0433 | $0.1150 | $0.1445 |
| job duration (setup to grading) | 236.4s | 167.8s | 752.1s | 905.6s |

- Cache hit rate: 97.2% of scored input tokens
- All rows: 143,316,513 input tokens (139,266,688 cache hits), 2,272,622 output tokens (1,677,800 reasoning)

## Cost

- Per-task metric (estimatedCostUsd): $4.7777 over all rows; per resolved run: $0.0683. Each row counts only its final attempt, the one its trajectory describes, so a provider outage does not bias the cost of the variant it hit. The efficiency table and eval:compare use this figure.
- True spend (totalSpendUsd): $4.7777: the per-task metric, plus $0.0000 for attempts a provider outage ended before the job re-ran them (retryCostUsd), $0.0000 for provider_error runs a resume superseded to run their jobs again, and $0.0000 charged for jobs an interrupted invocation never recorded (their journaled reservations).
- Charged against the cost cap (capChargedUsd): $4.7777: the true spend, plus the whole reservation of any job that threw, whose cost is unknown.

## Response models

- deepseek-flash

## Per variant

Descriptive only; use eval:compare for any A/B claim.

| variant | planned | observed | scored | resolved | rate | 95% CI | false success | empty patch | mean cost | mean rounds |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `baseline` | 46 | 46 | 46 | 34 | 73.9% | 60.9% to 87.0% | 10.9% | 4.3% | $0.0551 | 38.8 |
| `ctx-sandbox` | 46 | 46 | 46 | 36 | 78.3% | 65.2% to 89.1% | 13.0% | 2.2% | $0.0488 | 43.8 |

## Failure classes

| failure class | runs |
|---|---:|
| false_success | 11 |
| agent_budget_exhausted | 8 |
| empty_patch | 2 |
| environment_failure | 1 |

## Method

- Resolved is the official SWE-bench harness verdict on the extracted patch. The rate is over scored runs. Its 95% CI is a percentile bootstrap that resamples tasks, each task contributing its mean over its runs (4000 resamples).
- Scored runs exclude invalid_result, harness_error, grading_error, and provider_error rows. Efficiency statistics use scored runs; token and cost totals use every row.
- Costs use the manifest's dated peak list-price snapshot, so they are upper bounds.
