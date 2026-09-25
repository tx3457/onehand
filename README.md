# OneHand Coding Agent

OneHand is a local coding-agent CLI for repository-scoped maintenance tasks. It implements an explicit **inspect → plan → act → observe → revise → verify → finish** loop instead of treating a single model response as task completion.

The project is intentionally small enough to audit. The model can inspect code, make bounded file edits, run local verification commands, and decide the next action from the previous tool observation. A run succeeds only after every plan step is complete and a passing verification follows the latest write.

## What is implemented

- OpenAI Responses API and DeepSeek Chat Completions providers behind one normalized provider interface.
- Model-selected repository tools with runtime JSON-schema validation.
- Multi-round tool use: every tool result is returned to model history before the next decision.
- Plan-before-mutation gate, repeated-failure detection, replanning requirement, and explicit `finish_task` termination.
- Step, tool-call, input/output token, wall-clock, command-timeout, and API-retry budgets.
- Atomic file writes, repository realpath checks, protected secret/control paths, and a shell-free command allowlist.
- Pluggable command execution: local processes by default, or a `docker exec` adapter. With the adapter, commands and tests run inside a container, the model sees only container paths such as `/testbed`, and file tools keep editing the bind-mounted host checkout. It is a library option; the CLI always runs locally.
- Atomic `state.json` checkpoints and redacted JSONL traces with resume validation against task, repository, provider, model, and Git HEAD.

OneHand is a tool-using agent, not a general-purpose sandbox. Running tests or build programs can execute code from the target repository, so use it only with repositories you trust. See [SECURITY.md](SECURITY.md).

## Agent loop

```text
task
  ↓
model chooses inspection / planning / action tool
  ↓
runtime validates schema, plan gate, path, command, and budgets
  ↓
tool executes and returns a structured observation
  ↓
model updates the plan or chooses the next tool
  ↓
latest write verified + all steps complete + finish_task
```

A plain assistant message is not a success signal. If the model stops without an accepted `finish_task`, the run is reported as failed.

## Quick start

Requirements: Node.js 20 or newer.

```bash
npm ci
npm run build

export OPENAI_API_KEY=...
node dist/cli.js run "fix the failing test" \
  --repo /path/to/trusted/repo \
  --test "npm test"
```

DeepSeek-compatible usage:

```bash
export DEEPSEEK_API_KEY=...
node dist/cli.js run "fix the failing test" \
  --provider deepseek \
  --model deepseek-v4-pro \
  --thinking enabled \
  --reasoning-effort high \
  --repo /path/to/trusted/repo \
  --test "npm test"
```

Useful commands:

```bash
node dist/cli.js doctor
node dist/cli.js diff --repo /path/to/repo
node dist/cli.js run --help
```

An offline deterministic demo exercises the real planning gate, repository tools, atomic edit, test runner, explicit finish condition, checkpoint, and Git report without calling a model API:

```bash
npm run demo
```

The demo prints a prominent disclosure that provider decisions are scripted; it is regression evidence for the execution loop, not a model-quality result.

## Completion and recovery semantics

1. The model must call `set_plan` before a write, command, or test.
2. File edits and general commands increment a mutation revision; commands are conservatively treated as potentially mutating.
3. Only a passing `run_tests` records that revision as verified.
   - `run_tests` accepts optional `targets` (test files, pytest node ids, or framework labels) for running a subset during iteration.
   - For local runs, a passing targeted run does **not** verify the latest change. `finish_task` still requires an untargeted passing run.
   - Only the SWE-bench harness enables targeted verification (`allowTargetedVerification`), because full suites there take hours.
4. Repeating the same failed tool action twice requires a plan update before further action.
5. `finish_task` is rejected while a step is incomplete, replanning is required, or the newest write lacks passing verification.
6. Each tool round is checkpointed when persistence is enabled. Resume rejects state from a different task, repository, provider, model, or Git commit.

## Safety boundary

The default tool policy:

- rejects paths outside the repository, including symlink escapes;
- blocks `.env`, private-key, repository-control, and OneHand state paths;
- does not invoke a shell for model-selected commands;
- rejects shell operators, inline interpreter code, package installation, network clients, and mutating/networked Git commands;
- passes a small environment-variable allowlist to child processes;
- truncates large tool output, keeping both the head and the tail of command output so that trailing test failures stay visible;
- redacts common credential patterns in state and traces;
- runs host Git with fsmonitor, hooks, external diff drivers and textconv disabled, so repository-local Git configuration cannot run programs.

Model requests are retried on HTTP 429/5xx, timeouts, and connection errors (including `ECONNREFUSED`), with exponential backoff up to `--max-api-attempts`. As a result, a run against an unreachable endpoint fails after the retries rather than immediately.

These controls limit the model's direct tools. They do **not** isolate code executed by an allowed test/build program. Use a container or VM when stronger isolation is required.

The Docker executor is an isolation aid, not a security boundary against a hostile repository: host-side Git and file tools still operate on the bind-mounted checkout that container commands can write, and the file tools have a check-then-use window between validating a path and opening it.

## Verification

```bash
npm run typecheck
npm test
npm run build
npm run eval:deterministic
```

The local suite has 266 deterministic tests (+6 Docker-gated) in 27 files:

- A 10-scenario Agent suite, run against temporary Git fixtures. It covers multi-step completion, observation-driven recovery, repeated failures and replanning, false-success prevention, budgets, safety boundaries, and bounded provider retry.
- Provider-contract tests. One checks that DeepSeek `reasoning_content` is sent back on later tool-carrying requests; another checks that no `temperature` is sent in thinking mode; another checks that a reasoning-only, tool-call-free turn replays with string content instead of `content: null`.
- Persistence tests: a save/load round trip, redaction rules that keep numeric usage counters, and redaction of JSON-quoted credential forms (e.g. `"apiKey":"sk-…"`).
- Runner tests for:
  - text-only turns;
  - output-limit and runtime-error stop reasons;
  - lazy worktree fingerprints;
  - hashed `failureSignatures` keys, so a failed tool call's raw arguments never reach `state.json`.
- Tool tests for:
  - mode-preserving atomic writes;
  - head-and-tail output truncation;
  - literal and regex search, including the ripgrep-unavailable fallback forced independently of whether `rg` is actually installed.
- Execution-environment tests, none of which need Docker:
  - host/container path mapping;
  - the exact `docker exec` argv, including hostile arguments that stay positional and never enter the `bash -c` script;
  - timeout, capture, and truncation through a fake `spawn`;
  - `/testbed` paths in every file tool and in `run_command`;
  - `run_tests` target validation and the operator-trusted test command.
- Fingerprint tests for the pure `fingerprintOf` hash and its sensitivity to any single input change, and for the agent-profile part of the behavior fingerprint.
- Evaluation-harness tests for: the cost cap surviving a resume for a thrown run's worst-case charge; a mis-keyed row being substituted instead of crashing a later "Duplicate" check; the audited copy in `invalid-results.jsonl` staying redacted; and the source fingerprint changing when any tracked file changes.
- An offline integration test that drives the real evaluation `runOne` path with a scripted DeepSeek client, including that the trace's frozen budgets match the manifest exactly.
- SWE-bench plumbing tests:
  - official test-command parsing and the agent task text;
  - a leak test over all 100 dev and holdout instances. Target hints and prompts must contain no hidden test names or files. It runs when the local dataset is present.
  - split, exclusion and holdout-ledger handling;
  - patch extraction;
  - grading classification against realistic fake-harness logs (test timeout, OOM, apply failure, container unavailable);
  - self-check classification.
- SWE-bench pipeline tests:
  - the shared job loop: cost cap, crash journal, invalid-row substitution, provider-error re-runs and the circuit breaker;
  - `runInstance` with fake Docker and harness;
  - a deterministic schedule;
  - manifest compatibility;
  - summary math;
  - paired `compare` statistics (bootstrap, Holm, non-inferiority, identity checks);
  - `analyze` attribution.
- The 6 Docker-gated tests run only with `ONEHAND_SWEBENCH_IT=1` and a locally pulled `django__django-11790` image. One of them is an end-to-end SWE-bench job with a scripted provider.

All providers in these tests are fake or scripted. This is evidence that the execution loop works, not a real-model success rate.

## Evaluation protocol

`npm run eval:deterministic` runs the 10 independent, offline Agent scenarios. `npm run eval:test` also includes deterministic tests for the model-backed harness itself.

The checked-in harness uses synthetic, repository-local coding tasks so it can test behavior without exposing private code:

- 5-task pilot for protocol validation;
- 20 frozen tasks across single-file repair, multi-file repair, feature work, refactoring, and diagnosis/safety;
- 3 independent repetitions per full task;
- public tests plus acceptance tests stored outside the model-visible repository;
- resolved only when explicit agent completion, an Agent-invoked passing verification, both harness test layers, mutation semantics, forbidden-path checks, secret-canary checks, and integrity checks over the fixture-controlled parent directory all pass;
- run-level resolved rate with bootstrap confidence interval, false-success rate, safety/refusal outcomes, steps, tool calls, latency, token use, estimated cost, and failure classes.

The checked-in task definitions and exact acceptance assertions are public. "Hidden" refers only to runtime isolation from the model-visible fixture, not to a private or contamination-resistant benchmark. Any future result on this set is a project diagnostic; broader resume claims require a separate unpublished holdout or an independent evaluator.

The harness fails closed when runs are missing or the cost cap is reached. **No real-model pilot or full evaluation has been run for the current public evidence set**, so this README claims no resolved rate, latency, token cost, or model-quality result. See [eval/README.md](eval/README.md).

## Project status

OneHand is an auditable personal engineering project, not a production service. Current limitations include no OS-level sandbox, no distributed execution, no long-term semantic memory, and no benchmark claim against other agents.

## License

[MIT](LICENSE)
