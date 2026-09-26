# SWE-bench evaluation: dev, `baseline`, `ctx-sandbox`

> A/B claims come only from `npm run eval:compare` on paired variants. A single-variant run is a diagnostic of one configuration, not a comparison.

- Evaluation `swebench-dev-2026-09-25T22-25-30-604Z-9f5f1d`; model `deepseek-flash` (thinking enabled, reasoning effort high); images: epoch
- Dataset revision `78f471bf655a3137b2e8a75af1501690ec009ec3`; data file sha256 `faf8fab974e851c5065a84d2a46e6c77ab99143d2f3d0a9922c81105514403dd`; swebench 5.0.2
- Plan: 50 instance(s) × 3 repetition(s) × 2 variant(s) = 300 run(s); 0 instance(s) excluded by self-check
- Cost cap $25.00, with $0.3000 reserved per run in flight; limits are checked before each model turn, so a run can exceed its reservation by at most one turn's usage

## Completeness

COMPLETE.

| planned | observed | missing | invalid_result | harness_error | grading_error | provider_error | environment_failure | test timeout | out of memory | tests errored | cap reached |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| 300 | 300 | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | no |

A run that an environment failure ended is complete: it keeps its real usage and cost and its graded verdict, and is counted separately above. So is a run whose patch made grading time out, run out of memory, or error after the tests ran: like the official harness, it is scored unresolved. invalid_result, harness_error, grading_error, and provider_error rows leave the evaluation incomplete and are left out of every statistic below; a resume runs the job of every provider_error row again.

## Resolved

- 216 of 300 scored run(s) resolved: 72.0% (task-cluster bootstrap 95% CI 60.7% to 82.7%); pooled over every variant, see Per variant
- False success (finish_task accepted, not resolved): 8 of 300 (2.7%)

| repository | runs | resolved | rate | 95% CI |
|---|---:|---:|---:|---:|
| django/django | 150 | 124 | 82.7% | 69.3% to 94.0% |
| sphinx-doc/sphinx | 150 | 92 | 61.3% | 44.0% to 78.7% |

| difficulty | runs | resolved | rate | 95% CI |
|---|---:|---:|---:|---:|
| 1-4 hours | 42 | 12 | 28.6% | 7.1% to 57.1% |
| 15 min - 1 hour | 138 | 96 | 69.6% | 52.2% to 86.2% |
| <15 min fix | 114 | 108 | 94.7% | 86.8% to 100.0% |
| >4 hours | 6 | 0 | 0.0% | 0.0% to 0.0% |

## Claimed success × resolved

| | resolved | not resolved |
|---|---:|---:|
| claimed success | 175 | 8 (false success) |
| no success claim | 41 | 76 |

## Patches

- Empty patches: 32 of 300 (10.7%); the harness does not run on an empty patch, so it is unresolved.
- Non-empty patches the harness could not apply: 0

## Efficiency per scored run

| metric | mean | P50 | P95 | max |
|---|---:|---:|---:|---:|
| model rounds | 42.4 | 42.0 | 68.0 | 80.0 |
| tool calls | 60.7 | 61.0 | 98.0 | 115.0 |
| input tokens | 1,788,939 | 1,688,988 | 3,090,604 | 3,130,508 |
| output tokens | 27,224 | 23,132 | 58,249 | 95,156 |
| reasoning tokens | 21,028 | 16,780 | 50,375 | 87,274 |
| cost (final attempt) | $0.0588 | $0.0555 | $0.1071 | $0.1466 |
| job duration (setup to grading) | 198.3s | 157.9s | 466.8s | 1428.6s |

- Cache hit rate: 97.1% of scored input tokens
- All rows: 536,681,755 input tokens (520,984,192 cache hits), 8,167,341 output tokens (6,308,280 reasoning)

## Cost

- Per-task metric (estimatedCostUsd): $17.6360 over all rows; per resolved run: $0.0816. Each row counts only its final attempt, the one its trajectory describes, so a provider outage does not bias the cost of the variant it hit. The efficiency table and eval:compare use this figure.
- True spend (totalSpendUsd): $17.6360: the per-task metric, plus $0.0000 for attempts a provider outage ended before the job re-ran them (retryCostUsd), $0.0000 for provider_error runs a resume superseded to run their jobs again, and $0.0000 charged for jobs an interrupted invocation never recorded (their journaled reservations).
- Charged against the cost cap (capChargedUsd): $17.6360: the true spend, plus the whole reservation of any job that threw, whose cost is unknown.

## Response models

- deepseek-flash

## Per variant

Descriptive only; use eval:compare for any A/B claim.

| variant | planned | observed | scored | resolved | rate | 95% CI | false success | empty patch | mean cost | mean rounds |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `baseline` | 150 | 150 | 150 | 108 | 72.0% | 60.0% to 82.7% | 1.3% | 11.3% | $0.0624 | 41.6 |
| `ctx-sandbox` | 150 | 150 | 150 | 108 | 72.0% | 60.7% to 83.3% | 4.0% | 10.0% | $0.0551 | 43.2 |

## Failure classes

| failure class | runs |
|---|---:|
| agent_budget_exhausted | 44 |
| empty_patch | 31 |
| false_success | 8 |
| environment_failure | 1 |

## Method

- Resolved is the official SWE-bench harness verdict on the extracted patch. The rate is over scored runs. Its 95% CI is a percentile bootstrap that resamples tasks, each task contributing its mean over its runs (4000 resamples).
- Scored runs exclude invalid_result, harness_error, grading_error, and provider_error rows. Efficiency statistics use scored runs; token and cost totals use every row.
- Costs use the manifest's dated peak list-price snapshot, so they are upper bounds.
