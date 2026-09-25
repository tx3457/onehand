# OneHand evaluation protocol

This directory contains a reproducible end-to-end evaluation harness for the coding-agent loop. Deterministic tests prove selected engineering invariants; the model-backed harness is intended to measure behavior with a real tool-calling model.

## Current evidence status

- Before the P0 evaluation migration, the repository had 43 deterministic unit/integration tests. The migration raised this to 55: 2 no-network OpenAI provider configuration-contract regressions and 10 independent deterministic Agent scenarios.
- The Phase 0 real-run fixes raise the suite to 98 tests. They cover defects that only a real model would have exposed:
  - DeepSeek requires `reasoning_content` to be sent back on every later request that carries tools, and the provider used to drop it.
  - Numeric usage counters were redacted as if they were secrets, which broke every evaluation row.
  - Text-only turns ended the run immediately.
  - Every runtime failure was misclassified as a model error.
- A follow-up round of fixes raises the suite to 108 tests. They close gaps in the harness's own auditability and resume correctness:
  - The cost cap forgot a thrown run's worst-case charge across a resume, because only the zero-cost row survived to disk. Every row now also records `capChargeUsd`, and a resume rebuilds `spent` from it.
  - A row that does not belong to its own job (wrong `taskId`/`repetition`/`evaluationId`) is now substituted before validation, instead of risking a confusing "Duplicate" failure.
  - The audit copy written to `invalid-results.jsonl` is now redacted, not the raw row.
  - `sourceFingerprint`, a hash of every `.ts` file under `src/` (the agent) and `eval/` (the harness that scores it), is frozen in the manifest and compared on resume, so any code change (not just a prompt/tool change) invalidates a stale resume.
  - `failureSignatures` keys are now hashed, and JSON-quoted credential forms (e.g. `"apiKey":"sk-…"`) are now redacted.
  - DeepSeek turns with no text and no tool calls now replay with `content: ""` instead of `content: null`, which some OpenAI-compatible validators reject.
- The execution-environment adapters for container-based runs (Phase 1 Stage A) raise the suite to 131 tests. None of them need Docker. They cover:
  - host/container path mapping;
  - the exact `docker exec` argv, with hostile arguments kept out of the `bash -c` script;
  - timeout, capture, and truncation through a fake `spawn`;
  - `/testbed` paths in the file tools and in `run_command`;
  - `run_tests` target validation and the operator-trusted test command;
  - the runner's instructions prefix, display root, and target hint;
  - the agent profile in the behavior fingerprint.
- The SWE-bench plumbing and self-check (Phase 1 Stage B1) raise the suite to 158 deterministic tests (+5 Docker-gated). The deterministic tests cover the official test-command parsing, the agent task text, split and exclusion loading, patch extraction on temporary Git repositories, official-harness report handling through a fake harness, and self-check classification. The Docker-gated tests run only with `ONEHAND_SWEBENCH_IT=1` and a locally pulled `django__django-11790` image.
- Phase 1 Stage B2 and Stage C, and the review fixes after them, raise the suite to 266 deterministic tests (+6 Docker-gated) in 27 files. They cover:
  - the shared job loop and the SWE-bench pipeline;
  - grading classification against realistic harness logs;
  - provider-outage re-runs and the circuit breaker;
  - the crash journal and the holdout ledger;
  - paired `eval:compare` statistics;
  - `eval:analyze` attribution.
- SWE-bench pipeline validity (2026-09-25; local artifacts, not yet published):
  - Self-check passed for all 50 dev instances. It used the Epoch images and harness 5.0.2.
  - Every gold patch resolved on 2 of 2 gradings, and every no-op patch stayed unresolved.
  - No instance is excluded.
  - Single-configuration diagnostic runs are not comparative claims.
- `tests/eval_runone_integration.test.ts` drives the real `runOne` path offline with a scripted DeepSeek client.
- `tests/eval_deterministic_suite.test.ts` uses scripted provider decisions but real local tools and temporary Git repositories. It covers multi-step completion, observation-driven recovery, repeated-failure replanning, false-success rejection, step/tool/token budgets, path/command safety, and bounded provider retries.
- The real-model `pilot` and `full` protocols below have **not been run for the current public evidence set**. There is therefore no published resolved rate, latency, token cost, or model-quality comparison.

## Task set

The task definitions in `tasks.ts` generate small temporary Git repositories. They do not contain private project code.

- `pilot`: 5 tasks, one per category, one repetition by default.
- `full`: 20 tasks, four per category, three repetitions by default.
- Categories: single-file repair, multi-file repair, feature implementation, refactoring, and diagnosis/safety.

Each task freezes a task hash, initial repository files, a public test, an acceptance test outside the model-visible repository, expected mutation semantics, and forbidden paths.

The task definitions and exact acceptance assertions in `tasks.ts` are public for auditability. In this project, "hidden" means that the acceptance test is materialized outside the evaluated model's repository at runtime; it does **not** mean a private, unseen, or contamination-resistant benchmark. Treat results on this public synthetic set as project diagnostics. A resume-grade generalization claim requires a separate unpublished holdout or an independent external evaluator.

## Resolved definition

A run is resolved only when all conditions hold:

1. OneHand accepts an explicit `finish_task` call.
2. A verification command invoked by the Agent passes after its latest action.
3. The harness public test passes independently.
4. The hidden acceptance test passes.
5. No forbidden path changed and no protected canary appears in the final report.
6. No controlled file or directory in the fixture parent changed, including the hidden test and task manifest.
7. Safety requests are explicitly refused or blocked, while diagnosis tasks include task-specific explanation evidence.
8. The observed mutation behavior matches the task (`required` or `none`).

This prevents a passing public test or an unsupported natural-language success claim from being counted as task completion.

## Metrics

`report.ts` records:

- run-level resolved rate and deterministic task-cluster bootstrap 95% confidence interval;
- per-category resolved rate;
- all-repetitions and any-repetition task success;
- false-success and correct safety/refusal rates;
- public/hidden test pass rates;
- forbidden and fixture-parent mutation counts plus blocked unsafe tool calls;
- recovery after observed tool failures;
- latency, model rounds, tool calls, token use, estimated cost, and failure classes.

Raw results are JSONL. The manifest freezes:

- the model configuration;
- `agentFingerprint`, a SHA-256 hash of the system prompt, the user-prompt template, the nudge texts, the tool definitions, and the agent profile's name and flags;
- `sourceFingerprint`, a SHA-256 hash combining the sorted relative paths and contents of every `.ts` file under `src/` and under `eval/`, so any agent or harness code change — including one with no prompt/tool/nudge effect, such as a message wording or truncation tweak — also invalidates a resume;
- budgets, including the per-turn output cap and the text-only nudge limit;
- the model-request timeout, the API attempt limit, and the retry delay;
- prices;
- task hashes (and, when `--task-ids` restricts the run, exactly that task list);
- the repetition count;
- the planned run count.

Resuming into an output directory whose manifest differs in any of these fails closed. The manifest also records the OneHand repository's `gitHead` and a `gitDirty` flag (whether `src/` or `eval/` had uncommitted changes) for provenance only; neither is compared, since they can change for reasons unrelated to evaluated behavior.

A report is incomplete if any planned run is missing, the cost cap stops execution, or any row is invalid. A row is invalid when it fails the result-integrity checks, including a row whose `taskId`, `repetition`, or `evaluationId` does not match the job it was produced for. For each invalid row:

- the original row, redacted, is appended to `invalid-results.jsonl` for audit;
- `results.jsonl` gets an `invalid_result` failure row instead;
- that row is charged the original row's cost when it is a valid number, and the worst-case run cost otherwise.

### Cost cap charges and resumes

Every row — normal, invalid-result, or thrown — records `capChargeUsd`: the amount actually counted against `--cost-cap-usd`. A normal row is charged its own `estimatedCostUsd`. An invalid-result row is charged the amount described above. A run that throws is recorded at zero `estimatedCostUsd` (its real usage is unknown) but is charged the worst-case run cost via `capChargeUsd`, so it still counts against the cap within that invocation. If the harness fails after the agent has run, the failure row keeps the run's real token usage and cost instead.

Resuming into an existing output directory rebuilds `spent` from each existing row's `capChargeUsd` (falling back to `estimatedCostUsd` for older rows without it), not from `estimatedCostUsd` alone. A thrown run's worst-case charge therefore still counts against the cap after a resume, exactly as it would have within one invocation. `summary.json` reports both figures: `estimatedCostUsd` (measured cost only) and `capChargedUsd` (the sum of what was actually charged against the cap, including worst-case and audited charges).

Costs are estimated at DeepSeek **peak** list prices, taken from a dated snapshot (`priceSnapshotFor` in `run.ts`). Off-peak billing is 50% of peak, so reported costs are upper bounds; relative A/B comparisons are unaffected. Thinking mode ignores `temperature`, so manifests record `temperature: null`.

## Local deterministic checks

```bash
npm run eval:deterministic
npm run eval:test
```

The first command runs exactly the 10 Agent scenarios. The second also runs the deterministic unit tests for task definitions, result integrity, and report aggregation. Neither command calls an external model or network service.

## Model-backed runs

The loader reads only allowlisted DeepSeek variable names from the supplied environment file and never writes the key to the manifest or results.

The commands below document the protocol; they are not evidence that either run has completed. The default model is `deepseek-flash`. `--task-ids` restricts a run to named tasks from the split, and that restricted list is what the manifest freezes.

```bash
# One-task smoke run
npm run eval:pilot -- \
  --env-file /absolute/path/to/private.env \
  --output eval/results/smoke \
  --task-ids pilot-single-add \
  --concurrency 1 \
  --cost-cap-usd 1

npm run eval:pilot -- \
  --env-file /absolute/path/to/private.env \
  --output eval/results/pilot \
  --concurrency 2 \
  --cost-cap-usd 20

npm run eval:full -- \
  --env-file /absolute/path/to/private.env \
  --output eval/results/full \
  --concurrency 2 \
  --cost-cap-usd 20
```

Do not commit environment files or any raw artifact that contains a secret. Review generated artifacts before publishing.

### Running a SWE-bench evaluation

```bash
# One-time setup, outside this repository: the swebench 5.0.2 harness in ~/.onehand/swebench/.venv.
# Freeze the splits. They are already frozen in eval/swebench/splits.json; don't regenerate them for an evaluation in progress.
~/.onehand/swebench/.venv/bin/python eval/swebench/prepare_dataset.py

# 1. Validate the pipeline for each instance: gold must resolve, no-op must not.
npm run eval:swebench -- selfcheck --split dev --repeat 2 --image-source epoch --output eval/results/selfcheck-dev

# 2. Run variants in one interleaved evaluation, e.g. a baseline diagnostic or an A/B window.
npm run eval:swebench -- run --split dev --variants baseline,ctx,ctx-sandbox,ctx-sandbox-mask,full --repetitions 1 --concurrency 4 \
  --cost-cap-usd 12 --model deepseek-flash --env-file /absolute/path/to/private.env \
  --output eval/results/<name>

# 3. Rebuild summary.json/report.md; runs are idempotent.
npm run eval:swebench -- report --output eval/results/<name>

# 4. Paired A/B statistics. These are the only source of comparative claims.
npm run eval:compare -- --results eval/results/<name> --a baseline --b <variant> --output eval/results/<name>/compare

# 5. Diagnose where tokens and time go for one configuration.
npm run eval:analyze -- --results eval/results/<name> --variant baseline --output eval/results/<name>/analysis
```

The holdout split additionally needs `--split holdout --confirm-holdout`, and is recorded in the holdout ledger.

### SWE-bench environment

- **Images.** By default, every step uses Epoch AI's drop-in rebuilds of the official instance images, `ghcr.io/epoch-research/swe-bench.eval.x86_64.<instance_id>:latest`, with the instance id used verbatim (no `_1776_` rewrite). Pulling the official images from Docker Hub is too slow on the evaluation machine. `--image-source official` uses each record's own `swebench/...` image instead, and `selfcheck.json` records which source ran. The workspace copy, the agent's container, and the official harness all use the same image. The harness reads the image from the dataset record, so grading passes it a one-instance dataset file with `image` rewritten. OneHand never pulls an image; a missing one is an infrastructure error. Before any job runs, an evaluation resolves every instance image to its local ID and freezes the IDs in the manifest (`imageIds`, compared on resume). Each run checks its image against that ID before preparing its workspace and again right before grading, and the harness then grades in the pinned ID itself; a mismatch stops the evaluation without a retry.
- **Workspace.** `/testbed` is copied out of the image, and its `.git` is replaced by a single commit of the working tree. The image's history (tags and reflog) reaches commits made after the issue, which would leak the fix.
- **Container.** The checkout is bind-mounted at `/testbed` with `.git` mounted read-only. Commands run as the host user's uid:gid, not root, with `--network none`, `--cap-drop=ALL`, `--security-opt=no-new-privileges`, `--init`, `--pids-limit 1024`, 2 CPUs, and 4 GB of memory. The container and its workspace directory share an opaque name, `onehand-<16 hex>`, so neither the container nor the bind mount's host path (visible inside the container) names the instance or the variant; each name's mapping goes to stderr and into the row as `containerName`. Host-side Git runs without fsmonitor, hooks, external diff or textconv drivers, and global or system config.
- **Target hints.** The agent's `Test targets:` line gives examples as `<placeholders>` only. A test checks that no identifier-like token of any hint (placeholder names included; only generic words such as `test`, `file`, or `pytest` are exempt) occurs in any dev or holdout instance's test patch, FAIL_TO_PASS, or PASS_TO_PASS, and that no FAIL_TO_PASS name appears in the task or the hint.
- **Harness.** Grading uses the official SWE-bench harness, `swebench` 5.0.2, from `~/.onehand/swebench/.venv` (`ONEHAND_SWEBENCH_PYTHON` overrides the interpreter). Self-check reports record the version that ran.
- **Grading outcomes.** A patch-caused failure is scored unresolved, as the official harness scores it, and is not retried: the patch did not apply, the tests timed out, the tests ran out of memory (`out_of_memory`, `Killed`, `Cannot allocate memory`), or the harness failed after the tests ran. The row's `gradingOutcome` records which (`scored` when the harness wrote a report), and the evaluation stays complete. Only an unavailable environment is retried (3 attempts): the harness's own log shows `container_unavailable`, a Docker API error, or a host I/O failure, or the harness stopped before the tests started. A report's `container_unavailable` reason is not such evidence, because the harness derives it from `test_output.txt` alone, which the patched code writes; that report's verdict stands. `patchApplied` comes from the harness log's `>>>>> Applied Patch` / `>>>>> Patch Apply Failed` markers, since `report.json` also reports `patch_successfully_applied: false` whenever the test log cannot be parsed. The manifest's `infraPolicy` states every rule, including the provider-outage retry and patch extraction.
- **Provider outages.** A run ended by status 429 or 5xx, a timeout, or a network failure (no response, or a socket code such as `ECONNRESET` or `UND_ERR_SOCKET`) is retried once as a whole job. The row describes the final attempt: `estimatedCostUsd` is that attempt's cost alone, so an outage does not bias the cost of the variant it hit; `retryCostUsd` is the discarded attempt's cost (0 without a retry); `capChargeUsd` is their sum. A second outage makes a `provider_error` row, excluded and incomplete. Such a row is not a completed job: a resume moves it, redacted, to `superseded-results.jsonl` (`{at, reason: "provider_error rerun", row}`), rewrites `results.jsonl` atomically without it, and runs the job again, while the superseded row's `capChargeUsd` keeps counting against the cap. Status 401, 402, 403, or 404 stops the evaluation at once, since every later run would fail the same way. The runner itself also retries these network failures within a run.
- **Provider circuit breaker.** After `--provider-breaker` consecutive `provider_error` rows (default 3, frozen in the manifest as `infraPolicy.provider.circuitBreakerAfter`), counted in the order jobs finish across workers, no new job starts: the jobs in flight finish, and the summary is incomplete with `stopReason: "provider_circuit_open"`. Any other row resets the count. Resume once the provider recovers; the `provider_error` jobs then run again with the ones that never started.
- **Cost cap.** Every job start (with its reservation) is appended to `eval-journal.jsonl` before the job runs. On resume, a journaled start with no row (a job in flight when the invocation died) is charged its reservation against the cap, with a warning; no row is added. A start whose row a resume superseded is marked in the journal, so it is not charged as a crash; `superseded-results.jsonl` charges it instead. Limits are checked before each model turn, so one run can exceed its reservation by at most one turn's usage.
- **Cost figures.** `summary.json` and `report.md` keep the per-task metric apart from the spend. `measuredCostUsd` sums `estimatedCostUsd` (final attempts only); it is the figure the efficiency statistics use, and `eval:compare` compares `estimatedCostUsd` and adds a note when either arm has `retryCostUsd`. `totalSpendUsd` is the true spend: `measuredCostUsd` + `retryCostUsd` (discarded outage attempts) + `supersededChargeUsd` (superseded `provider_error` rows) + `unfinishedChargeUsd` (reservations of jobs an interrupted invocation never recorded). `capChargedUsd` is what the cap counted: the true spend plus the whole reservation of any job that threw.
- **Holdout ledger.** Every holdout evaluation is appended to `~/.onehand/swebench/holdout-ledger.jsonl` (`ONEHAND_HOLDOUT_LEDGER` overrides the path). Once it has an entry, a holdout run starts only as a resume of that same evaluation, or with `--allow-holdout-rerun "<reason>"`, which records the reason in the manifest and the ledger.
- **Comparisons.** `eval:compare` refuses result directories that differ in the dataset, images (per instance), harness version, agent or container limits, model, provider, endpoint, or inference settings, and a variant whose rows come from different agent or source versions. It warns when the two arms come from evaluations of different source. Its completeness verdict is the evaluation summary's.
- **Self-check.** Before an evaluation uses an instance, `npm run eval:swebench -- selfcheck` must pass for it with the same image source. The gold patch, extracted the way an agent patch is, must resolve on every grading; a no-op patch must stay unresolved; and the agent's `run_tests` must start the test runner in the container. An instance that fails becomes a suggested exclusion.
