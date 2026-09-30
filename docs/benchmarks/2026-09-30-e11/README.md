# E11 development evaluation: prepared, not run

This protocol evaluates the revised budget and close-out notices. No real-model E11 result is available yet. The current execution environment has the SWE-bench Python environment and dataset, but no Docker/Podman executable or Docker socket. API spending and the execution host still need to be established.

The implementation and offline checks are documented in [engineering-validation.md](engineering-validation.md); [candidate.json](candidate.json) identifies the verified candidate. These files do not contain a real-model outcome.

That candidate records the reliability changes before subsequent chat-entry improvements. It is a historical engineering snapshot, not a fingerprint of every later working-tree change. Before running this protocol, validate and freeze the then-current source/configuration in a fresh evaluation manifest; do not reuse the older source fingerprint for a newer checkout.

## Question and arms

Does E11 help the agent finish a correctly solved task before exhausting its budget, without increasing false success or materially reducing resolution?

- A: `ctx-sandbox`.
- B: `ctx-sandbox-notices`.
- Both arms run the same candidate source, including resume-identity and per-tool budget fixes. Only E11 differs between arms; comparing historical baseline runs with new notice runs would confound those changes.
- Local `ctx` remains the default; this experiment does not enable E11 by default.

The [machine-readable protocol](protocol.json) fixes the 25-task development subset already used by `swebench-dev25-ctx-r1` (13 Django, 12 Sphinx). Task membership was copied before observing any new E11 outcomes. This is an exploratory development study: the tasks and failure patterns influenced the feature design. It is not a fresh holdout or a replication of the frozen 2026-09-26 window.

## Measurements and interpretation

The two primary rate metrics, compared as B minus A, are:

1. `resolvedAndFinished`: the official harness resolves the patch, and the agent reports `success` with `explicit_finish`. An increase is favorable.
2. `resolvedBudgetExhausted`: the official harness resolves the patch, but the agent reports `budget_exhausted`. A decrease is favorable. A decrease alone is insufficient: it could also occur if fewer patches resolve.

Use the existing paired task-cluster bootstrap (10,000 resamples, seed 20260930) with two-sided tests and Holm correction over these two metrics. Repetitions are averaged within each task; they are not independent task samples. Separately report the existing resolved non-inferiority interval at the explicitly stated 10 percentage-point margin. That interval is a secondary guardrail, not an additional Holm-corrected primary test.

Report false success, estimated peak-price cost, input tokens and rounds as secondary exploratory metrics, with paired intervals from `eval:compare`. Record all outcomes, including null or adverse results. Do not extend the sample, change seeds or omit tasks to obtain a positive result. Do not conclude that a nonsignificant difference proves equality or that this small development study establishes generalization.

The summary additionally reports recorded budget/close-out notices, explicit finishes after the last close-out, and model rounds from that notice through finish (inclusive of the notice's round). It separately records whether the final write revision equals its passing-verification revision. Legacy traces without revision evidence are **unknown**; `agentVerificationPassed` only means some test passed earlier. Notice telemetry includes known/unknown denominators: no recorded notice in a run with unknown telemetry does not establish zero notices.

## Before model execution

1. Complete candidate tests and independent review. Confirm the budget and repetition count in `protocol.json` before the first model call.
2. On the chosen Docker host, confirm the installed harness, dataset checksum, and all 25 existing Epoch image IDs. The evaluation never pulls images automatically.
3. Run the gold/no-op pipeline self-check into a new directory. Preserve any errors; resolve infrastructure problems or stop incomplete instead of silently changing task membership. Do not modify the existing exclusions or holdout ledger.
4. Save this protocol, the candidate source diff, and the exact command alongside the new results. The generated manifest freezes source/profile fingerprints, image IDs, model, limits, scheduling and prices. An uncommitted source snapshot is permitted and must retain its `gitDirty` provenance. The manifest's source fingerprint must not change during the run or resume.
5. Keep credentials and raw traces in private/ignored storage. Publish only reviewed aggregate artifacts. Use a fresh result directory; preserve the frozen 2026-09-26 files unchanged.

## Commands

These commands are preparation instructions, not evidence of execution. The proposed window is 25 tasks × 2 arms × 1 repetition, with a $10 estimated-cost cap. The harness uses the pinned peak-price snapshot, not a live billing guarantee; per-turn accounting can overshoot a reservation. Confirm the budget before invoking `run`.

```bash
e11_ids=$(node --input-type=module -e 'import fs from "node:fs"; const p=JSON.parse(fs.readFileSync("docs/benchmarks/2026-09-30-e11/protocol.json", "utf8")); console.log(p.instanceIds.join(","));')

npm run eval:swebench -- selfcheck --split dev --task-ids "$e11_ids" \
  --repeat 2 --concurrency 4 --image-source epoch \
  --output eval/results/e11-dev25-selfcheck

npm run eval:swebench -- run --split dev --task-ids "$e11_ids" \
  --variants ctx-sandbox,ctx-sandbox-notices --repetitions 1 --concurrency 4 \
  --model deepseek-flash --image-source epoch --schedule-seed 20260930 \
  --cost-cap-usd 10 --env-file /absolute/path/to/private.env \
  --output eval/results/e11-dev25-r1

npm run eval:compare -- --results eval/results/e11-dev25-r1 \
  --a ctx-sandbox --b ctx-sandbox-notices \
  --primary resolvedAndFinished,resolvedBudgetExhausted \
  --margin 0.1 --bootstrap 10000 --seed 20260930 \
  --output eval/results/e11-dev25-r1/compare
```

If the cap or an infrastructure failure prevents completion, retain the partial window and report it as incomplete. Resume only with the same configuration and source fingerprint. An incomplete or offline-only run cannot establish E11's effect on real-model performance. For incomplete windows, the comparator retains descriptive estimates but suppresses table p-values and sets JSON significance/non-inferiority decisions to `null`.
