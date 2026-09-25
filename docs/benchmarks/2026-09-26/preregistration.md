# Pre-registration: OneHand final evaluation window

Registered at: 2026-09-25T22:24:58Z (before any run of this window). Source commit: `12c58c7`.

This file is committed before the final window starts. Any deviation from it is reported alongside the results.

## Question

On SWE-bench Verified, with the same model and budgets, does OneHand's context engineering and sandbox-aware command policy lower the cost per run without lowering the resolved rate?

The configuration under test is profile `ctx-sandbox`:
- E4, on-demand retrieval;
- E3, compact observations;
- E8, a sandbox-aware command policy.

It is compared with profile `baseline`, which is OneHand v0.2 plus the pre-registered baseline fixes.

## Arms

| arm | profile | agent fingerprint |
|---|---|---|
| A | `baseline` | `674793f83c5ac14a6ed46e1fd0e4327b964cbb2101250aa7db05fc7102486f09` |
| B | `ctx-sandbox` | `e7797b1a43ae1c14f94e6335b3098e02925ed010db410e8b565696c90c833792` |

External reference, descriptive only and not a hypothesis test: mini-swe-agent 2.4.6 with the same model on Mini × 1.
- **Model:** `deepseek/deepseek-flash` through LiteLLM, with reasoning effort high.
- **Budgets:** step limit 80 and a cost limit of $1.08 at peak prices, matching OneHand's round budget and worst-case run cost.
- **Container:** network disabled.
- **Images:** derived from the same Epoch images, with `/testbed/.git` rebuilt as a single commit, the same leakage control as OneHand.
- **Grading:** with `eval:swebench grade-external`, through the same harness.
- **Disclosure:** this run started at 2026-09-25T22:05:58Z, before this file was committed. Its configuration is recorded here exactly as it was run.

## Data

- **Mini:** `MariusHobbhahn/swe-bench-verified-mini`, 50 instances (django and sphinx).
  - This is the development set. Every design decision was made on its 25-instance subset "dev25" (every other id in sorted order), so Mini results carry optimization bias.
  - 3 repetitions per arm.
- **Holdout:** 50 Verified instances stratified by repository across 10 repositories, with seed 20260925 (`eval/swebench/splits.json`).
  - It was never used for development, so it is the confirmatory set.
  - 1 repetition per arm. It runs once and is recorded in the holdout ledger.
- **Holdout self-check:** before any agent run, a holdout instance must pass the pipeline self-check. The gold patch must resolve on 2 of 2 gradings, and a no-op patch must stay unresolved. Instances that fail are excluded, and the exclusion list is published.

## Protocol

- **Model:** `deepseek-flash`, thinking enabled, reasoning effort `high`, no temperature. Every response's `model` field is recorded.
- **Budgets per run**, identical for both arms: 80 model rounds, 150 tool calls, 3M cumulative input tokens, 150k output tokens, 30 minutes, 600 s per command, and 16,384 output tokens per turn.
- **Environment:**
  - Epoch AI instance images pinned by image ID, a single-commit `.git` mounted read-only, and no network in the container.
  - Grading uses the official swebench 5.0.2 harness.
  - Infrastructure and provider-outage handling follow the manifest's `infraPolicy`.
- **Scheduling:** both arms are interleaved in one window. The arm order within each instance and repetition is randomized (schedule seed 20260925). Each run gets a cache-isolation nonce. All runs are off-peak.

## Metrics and tests

**Primary**, per dataset; within each dataset the two are Holm-corrected at α = 0.05:
1. `estimatedCostUsd` per run, at the peak price basis. It is a paired log-ratio, reported as the change in the geometric mean with a 95% CI. **Hypothesis:** B is cheaper (two-sided test).
2. The resolved rate, as a non-inferiority test with a **10 pp margin**. B is non-inferior if the lower bound of the 95% CI of B − A lies above −10 pp. A CI that lies entirely above 0 is reported as an improvement.

**Statistics:**
- Each task's repetitions are averaged, and the tasks are then paired.
- 10,000 bootstrap resamples of tasks, seed 20260925, via `npm run eval:compare`.
- Mini and holdout are reported separately. A pooled 100-task estimate of the resolved-rate difference is reported as secondary.

**Secondary:** model rounds, cumulative input and output tokens, tool-failure rate, empty-patch rate, false-success rate, wall time, and cost per resolved task.

**Mechanism** metrics, descriptive, from `npm run eval:analyze`:
- read_file's share of cumulative input tokens, and tokens per read (E4/E3);
- the policy-rejection rate of run_command (E8).

## Development findings reported as such (not re-tested in this window)

From dev25, single runs:
- observation masking (E5) raised cost by 32%;
- lean planning (E1) cut plan bookkeeping but not cost or rounds;
- the explore sub-agent (E9) went unused.

These are reported as development-stage results, with their dev CIs, and are not claims.

## Cost control

- A cost cap of $40 (Mini $25, holdout $15) for the window at the peak price basis, with a reservation of $0.30 per run in flight.
- The descoping order if the cap is approached: first the external reference, then Mini repetitions 3 → 2. The holdout is never cut.
