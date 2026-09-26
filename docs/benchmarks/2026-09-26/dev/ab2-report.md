# SWE-bench evaluation: dev, `ctx-sandbox`, `ctx-sandbox-mask`, `full`

> A/B claims come only from `npm run eval:compare` on paired variants. A single-variant run is a diagnostic of one configuration, not a comparison.

- Evaluation `swebench-dev-2026-09-25T19-13-20-783Z-4e4788`; model `deepseek-flash` (thinking enabled, reasoning effort high); images: epoch
- Dataset revision `78f471bf655a3137b2e8a75af1501690ec009ec3`; data file sha256 `faf8fab974e851c5065a84d2a46e6c77ab99143d2f3d0a9922c81105514403dd`; swebench 5.0.2
- Plan: 25 instance(s) × 1 repetition(s) × 3 variant(s) = 75 run(s); 0 instance(s) excluded by self-check
- Cost cap $6.00, with $0.3000 reserved per run in flight; limits are checked before each model turn, so a run can exceed its reservation by at most one turn's usage

## Completeness

INCOMPLETE: 5 planned run(s) missing.

| planned | observed | missing | invalid_result | harness_error | grading_error | provider_error | environment_failure | test timeout | out of memory | tests errored | cap reached |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| 75 | 70 | 5 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | no |

A run that an environment failure ended is complete: it keeps its real usage and cost and its graded verdict, and is counted separately above. So is a run whose patch made grading time out, run out of memory, or error after the tests ran: like the official harness, it is scored unresolved. invalid_result, harness_error, grading_error, and provider_error rows leave the evaluation incomplete and are left out of every statistic below; a resume runs the job of every provider_error row again.

## Resolved

- 59 of 70 scored run(s) resolved: 84.3% (task-cluster bootstrap 95% CI 69.4% to 97.2%); pooled over every variant, see Per variant
- False success (finish_task accepted, not resolved): 0 of 70 (0.0%)

| repository | runs | resolved | rate | 95% CI |
|---|---:|---:|---:|---:|
| django/django | 39 | 33 | 84.6% | 61.5% to 100.0% |
| sphinx-doc/sphinx | 31 | 26 | 83.9% | 63.6% to 100.0% |

| difficulty | runs | resolved | rate | 95% CI |
|---|---:|---:|---:|---:|
| 1-4 hours | 3 | 0 | 0.0% | 0.0% to 0.0% |
| 15 min - 1 hour | 36 | 31 | 86.1% | 66.7% to 100.0% |
| <15 min fix | 28 | 28 | 100.0% | 100.0% to 100.0% |
| >4 hours | 3 | 0 | 0.0% | 0.0% to 0.0% |

## Claimed success × resolved

| | resolved | not resolved |
|---|---:|---:|
| claimed success | 53 | 0 (false success) |
| no success claim | 6 | 11 |

## Patches

- Empty patches: 7 of 70 (10.0%); the harness does not run on an empty patch, so it is unresolved.
- Non-empty patches the harness could not apply: 0

## Efficiency per scored run

| metric | mean | P50 | P95 | max |
|---|---:|---:|---:|---:|
| model rounds | 44.0 | 36.0 | 80.0 | 80.0 |
| tool calls | 62.6 | 52.0 | 121.0 | 137.0 |
| input tokens | 1,219,019 | 896,406 | 3,049,827 | 3,103,822 |
| output tokens | 25,349 | 16,531 | 65,041 | 72,452 |
| reasoning tokens | 18,676 | 9,818 | 55,188 | 61,870 |
| cost (final attempt) | $0.0542 | $0.0408 | $0.1251 | $0.1479 |
| job duration (setup to grading) | 186.6s | 137.1s | 426.3s | 539.1s |

- Cache hit rate: 95.4% of scored input tokens
- All rows: 85,331,317 input tokens (81,419,648 cache hits), 1,774,406 output tokens (1,307,304 reasoning)

## Cost

- Per-task metric (estimatedCostUsd): $3.7913 over all rows; per resolved run: $0.0643. Each row counts only its final attempt, the one its trajectory describes, so a provider outage does not bias the cost of the variant it hit. The efficiency table and eval:compare use this figure.
- True spend (totalSpendUsd): $4.9913: the per-task metric, plus $0.0000 for attempts a provider outage ended before the job re-ran them (retryCostUsd), $0.0000 for provider_error runs a resume superseded to run their jobs again, and $1.2000 charged for jobs an interrupted invocation never recorded (their journaled reservations).
- Charged against the cost cap (capChargedUsd): $4.9913: the true spend, plus the whole reservation of any job that threw, whose cost is unknown.

## Response models

- deepseek-flash

## Per variant

Descriptive only; use eval:compare for any A/B claim.

| variant | planned | observed | scored | resolved | rate | 95% CI | false success | empty patch | mean cost | mean rounds |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `ctx-sandbox` | 25 | 24 | 24 | 20 | 83.3% | 66.7% to 95.8% | 0.0% | 12.5% | $0.0461 | 38.2 |
| `ctx-sandbox-mask` | 25 | 23 | 23 | 20 | 87.0% | 73.9% to 100.0% | 0.0% | 13.0% | $0.0617 | 49.9 |
| `full` | 25 | 23 | 23 | 19 | 82.6% | 65.2% to 95.7% | 0.0% | 4.3% | $0.0550 | 44.0 |

## Failure classes

| failure class | runs |
|---|---:|
| empty_patch | 6 |
| agent_budget_exhausted | 4 |
| environment_failure | 1 |

## Method

- Resolved is the official SWE-bench harness verdict on the extracted patch. The rate is over scored runs. Its 95% CI is a percentile bootstrap that resamples tasks, each task contributing its mean over its runs (4000 resamples).
- Scored runs exclude invalid_result, harness_error, grading_error, and provider_error rows. Efficiency statistics use scored runs; token and cost totals use every row.
- Costs use the manifest's dated peak list-price snapshot, so they are upper bounds.
