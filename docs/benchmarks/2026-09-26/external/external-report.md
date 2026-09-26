# External SWE-bench reference: mini-swe-agent-2.4.6

> This is an external descriptive reference, not a paired controlled comparison with OneHand.

**COMPLETE.**

- Split: dev; model used for pricing: deepseek-flash; observed 50 of 50 planned run(s).
- Resolved: 36/50 (72.0%; bootstrap 95% CI 60.0% to 84.0%).
- Mean/median estimated cost: $0.059196 / $0.059721; total $2.959786; cost per resolved $0.082216.

## Setup differences

mini-swe-agent used a bash tool and its own step and cost limits from each trajectory config. OneHand uses its own tool interface, planning flow, and limits, so these results do not isolate an agent-framework effect.

- 50 run(s): step_limit=80; cost_limit=1.08; network was disabled via run args.

## Mean usage per run

- Model rounds 49.48; input tokens 2121871.82 (2084339.20 cache hit, 37532.62 cache miss); output tokens 29524.92; reasoning tokens 22885.78.

## Exit statuses

| status | runs |
|---|---:|
| LimitsExceeded | 12 |
| Submitted | 38 |

## Grading outcomes

| outcome | runs |
|---|---:|
| empty_patch | 12 |
| scored | 38 |

## Method

- Patches were graded with the same official SWE-bench harness 5.0.2 path and pinned Epoch images used by OneHand.
- A model round is one response carrying usage. The resolved-rate interval uses the shared deterministic 4000-resample percentile bootstrap (95% CI) over runs.
- Costs are list-price estimates from the recorded price snapshot. Reasoning tokens are a subset of output tokens and are not charged a second time.
- For an incomplete report, statistics cover graded rows only; ungraded infrastructure-pending instances remain outside the observed denominator.
