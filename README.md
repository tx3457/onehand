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
- truncates large tool output and redacts common credential patterns in state and traces.

These controls limit the model's direct tools. They do **not** isolate code executed by an allowed test/build program. Use a container or VM when stronger isolation is required.

## Verification

```bash
npm run typecheck
npm test
npm run build
```

The current local suite contains 43 deterministic tests covering the core loop, provider normalization, planning/finish gates, budgets, retry behavior, persistence/resume validation, path and command guards, secret redaction, file tools, Git tools, and the evaluation harness.

## Evaluation protocol

The checked-in harness uses synthetic, repository-local coding tasks so it can test behavior without exposing private code:

- 5-task pilot for protocol validation;
- 20 frozen tasks across single-file repair, multi-file repair, feature work, refactoring, and diagnosis/safety;
- 3 independent repetitions per full task;
- public tests plus acceptance tests stored outside the model-visible repository;
- resolved only when explicit agent completion, an Agent-invoked passing verification, both harness test layers, mutation semantics, forbidden-path checks, secret-canary checks, and integrity checks over the fixture-controlled parent directory all pass;
- run-level resolved rate with bootstrap confidence interval, false-success rate, safety/refusal outcomes, steps, tool calls, latency, token use, estimated cost, and failure classes.

The harness fails closed when runs are missing or the cost cap is reached. No headline result is claimed in this README until a complete run is available. See [eval/README.md](eval/README.md).

## Project status

OneHand is an auditable personal engineering project, not a production service. Current limitations include no OS-level sandbox, no distributed execution, no long-term semantic memory, and no benchmark claim against other agents.

## License

[MIT](LICENSE)
