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

For `onehand run` and edit/auto chat, a plain assistant message is not a success signal. If the model stops without an accepted `finish_task`, the run is reported as failed.

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

## Web UI

```bash
onehand ui --port 0 --runs-dir ~/.onehand/runs --results-dir ./eval/results
onehand ui --open
```

The command prints a local URL with a single-use access token. Port `0` (the default) chooses a free port; `--open` launches the default browser. Defaults are `~/.onehand/runs` and `eval/results` under the current directory: run it from the repository root, or use `--results-dir` to browse another results folder. Ctrl+C stops the server. No provider keys, model calls, dependencies or frontend build step are needed.

- **Runs:** newest first, with task, repository basename, provider/model, status, stop reason, rounds, calls, tokens and update time. Run details show plan evidence, usage totals, the final message and trace events, including masking, sub-agents, permissions and checkpoints. Raw conversation history and stored tool outputs are excluded.
- **Checkpoints:** list the run repository's shadow-Git snapshots and display a colored unified diff against its current tree. There is no restore action. The existing `CheckpointStore.list()`/`diff()` methods may initialize or update internal shadow-Git metadata and temporary objects; they leave the source working tree and its Git history/index unchanged. Avoid concurrent checkpoint operations from other processes.
- **Evaluations:** per-variant metrics, SVG cost/resolved-rate bars, and safe Markdown views of `report.md`, `compare-*.md` and `analysis.md`. Directories named with `INVALID` or containing `INVALID.txt` are labeled invalidated and excluded from detail views. Unrecorded metrics display `—`, including token means absent from older per-variant summaries; the UI does not rerun evaluations.

The server binds only `127.0.0.1`. The one-time `?token=` URL is exchanged for an `HttpOnly; SameSite=Strict` session cookie and redirected to a clean URL. Keep that URL private; restart the server to obtain a new one. Every page, asset and API request requires authentication. Exact loopback Host headers and same-origin API Origin headers prevent DNS rebinding and cross-origin access. Only GET is accepted. CSP blocks inline scripts/styles and framing; responses also use `nosniff`, `no-referrer` and `no-store`.

Run/evaluation IDs must appear in the configured directories; artifact reads are realpath-confined to their selected directory, including symlink checks. State is redacted again and projected to display fields. Checkpoint reads go only through `CheckpointStore` for the repository recorded in that state. Responses are capped at 4 MiB, state files at 8 MiB, trace tails at 2 MiB and 2,000 events, reports at 256 KiB each (up to 20), and diffs at 512 KiB; truncated trace/diff views are labeled. Markdown HTML is escaped before rendering, and no remote resources are loaded.

## Interactive use

```bash
onehand chat --repo /path/to/trusted/repo --mode edit
onehand chat --repo /path/to/trusted/repo --mode ask \
  --provider deepseek --model deepseek-v4-pro --thinking enabled --reasoning-effort high
```

Chat defaults to `edit`. Mode defaults are:

| Mode | Read and plan | Write and execute | Completion |
| --- | --- | --- | --- |
| `ask` | Allowed | Denied | Plain answer |
| `edit` | Allowed | Ask for approval | Verified `finish_task` |
| `auto` | Allowed | Allowed | Verified `finish_task` |

For an approval, answer `y` (yes), `n` (no), or `a` (always for this session). Always approvals apply to the tool, or to the program for `run_command`. EOF and Ctrl+C at an approval deny that operation. Ctrl+C during a run cancels it and returns to the prompt; press it twice at an empty prompt to exit. `NO_COLOR` and redirected output disable ANSI styling.

Use `/mode ask|edit|auto` to switch modes, `/diff` to inspect the working-tree diff, `/undo` to restore the checkpoint before the last run's first mutation, and `/checkpoints` plus `/rewind <n>` to restore an older checkpoint (1 is newest). Edit and auto runs snapshot before the first write or execution in each model turn. Checkpoints live in `~/.onehand/checkpoints/`, separately from your repository's Git history and index; `ONEHAND_CHECKPOINT_DIR` overrides that location and must stay outside the work tree. Ignored and protected paths are excluded, and files over 5 MB are skipped with a note. Undo leaves excluded files untouched, including directories whose ignored contents would prevent restoring a snapshot file. Empty directories may remain. Use one chat session per repository at a time; checkpoint operations across processes are not serialized.

Root `AGENTS.md` instructions (or `ONEHAND.md` when absent) are loaded at startup, capped at 8 KB, and shown by `/memory`. Each new task also receives the last five inputs and answers, capped at 500 characters each. `/model <id>` changes the model, `/cost` shows session token totals, and `/help` lists commands. Cost is currently reported as tokens: the packaged CLI has no model-price catalog.

Optional `.onehand/config.json` permissions:

```json
{
  "permissions": {
    "allow": ["run_tests", "run_command:npm test"],
    "deny": ["run_command:npm run deploy"]
  }
}
```

Repeat `--allow <pattern>` and `--deny <pattern>` on `chat` for CLI rules. Denies always win, including over session approvals. Otherwise rules resolve from CLI to project config to `~/.onehand/config.json`, then the mode default. Command patterns compare the exact program and argument prefix; they are not shell globs. Explicit rules override mode defaults for writes and execution. Read and plan tools bypass the approval hook. Invalid config is a startup error. All modes and approvals remain subject to the hard path and command policy.

These features are opt-in library options (`onEvent`, `authorize`, `completion`, `checkpoints`, and `projectInstructions`). `onehand run` and evaluation calls retain their existing completion, prompts, budgets, and tracing behavior.

## MCP servers

Chat loads `mcpServers` from `~/.onehand/config.json` and the repository's `.onehand/config.json`. Project entries replace user entries with the same name. Servers start once per chat session and close when it exits. For example:

```json
{
  "mcpServers": {
    "docs": {
      "command": "node",
      "args": ["/absolute/path/to/docs-server.mjs"],
      "env": { "DOCS_ROOT": "/absolute/path/to/docs" },
      "cwd": "/absolute/path/to/docs",
      "enabled": true
    }
  },
  "permissions": {
    "allow": ["mcp__docs__search"],
    "deny": ["mcp__docs__delete"]
  }
}
```

`enabled` defaults to true; use false to disable an entry. The child inherits the SDK's safe environment plus the entry's explicit `env`, without inheriting OneHand's provider API keys. Only configure server commands you trust: the command starts at session startup, before tool-call approvals.

`/mcp` lists connected servers and their tools. Names use `mcp__<server>__<tool>`, sanitize unsupported characters, and fit within 64 characters; duplicate exposed names are warned about and dropped. Startup/discovery has a 10-second timeout per server; a failed server is skipped. Calls have a 60-second timeout and receive Ctrl+C cancellation, text output uses the normal output limit, and non-text blocks appear as omission notices.

In chat, MCP calls bypass planning but require permission. Their defaults are **deny in ask**, **ask in edit**, and **deny in auto**. Allow a single tool with `mcp__docs__search` or a server's tools with `mcp__docs__*`; deny rules still win. The library accepts an opt-in `extraTools: { definitions, execute }` adapter, which `McpManager` implements; supply `authorize` to enforce library-call permissions. Existing runs do not load MCP configuration automatically.

## Sub-agents

The `exploreSubagent` feature adds `explore({ question })`. It runs a separate, read-only agent and returns a report of at most 300 words with file paths and line numbers. Its history stays separate; the parent receives only its report. The `ctx-sandbox-plan-explore` profile enables this feature on top of `ctx-sandbox-plan` for the E9 evaluation arm.

Chat also exposes `review_changes({})`, and `/review` runs it directly using the latest task, tracked diff against `HEAD` (including staged changes), a status list for inspecting untracked files, and last plan. The diff/status context is capped at 30 KB. The reviewer reports concrete defects with file and line references or says `no blocking issues`. Review is enabled by `interactiveTools: ["review_changes"]` and is never included in evaluation profiles.

Both presets can list, search and read files, inspect Git status/diff, and use only read-only inspection commands when the parent enables `sandboxCommands`. They cannot write, run tests, manage plans, call MCP tools or start another sub-agent. They share the parent's remaining steps, tool calls, input/output tokens and wall time, capped further at 20 steps, 30 tool calls and 400,000 input tokens per child. Token and tool usage is included in parent totals; child rounds are reported separately as `subagentRounds` and consume the shared step budget. They inherit provider/model settings and use the parent's cache-isolation nonce with a `-sub<n>` suffix. Trace and REPL events mark when each child starts and finishes.

## Agent profiles

The library `runAgent({ profile: PROFILES.ctx, ... })` and SWE-bench `--variants` support seven named profiles:

- `baseline`: unchanged tool definitions, prompts, JSON observations, and command policy.
- `ctx`: windowed, numbered reads; grouped search and directory summaries (E4); compact text observations (E3).
- `ctx-sandbox`: `ctx` plus inline Python/Node and read-only git/grep/sed commands in an isolated container (E8). Requires a Docker executor; local executors reject it.
- `ctx-sandbox-mask`: `ctx-sandbox` plus deterministic observation masking (E5). When the previous response reports more than 48,000 prompt tokens, retain the newest complete tool rounds within a 48 KiB serialized-history budget (at least 2, at most 10). Assistant text, reasoning, and tool results all count toward that budget; the minimum 2 rounds may exceed it. Apply a masking block only if the full history, including its replacement context note, shrinks by at least 32 KiB. Otherwise history and note placement remain untouched, preserving the prompt-cache prefix. A real event refreshes the plan/modified-files note, checkpoints masked history, and traces `bytesRemoved`, `bytesKept`, and `keptRounds`.
- `full`: `ctx-sandbox-mask` plus lean planning (E1): atomic batched `update_plan`, transactional `finish_task stepEvidence`, pre-plan tests and read-only inspection, and content-based mutation tracking.
- `ctx-sandbox-plan`: `ctx-sandbox` plus lean planning (E1), without observation masking.
- `ctx-sandbox-plan-explore`: `ctx-sandbox-plan` plus the isolated, budget-sharing `explore` sub-agent (E9).

Feature flags are validated booleans and default to false. Unknown flags are rejected. The CLI still uses `baseline`.

All five historical profiles retain their original prompts, tool schemas, and behavior fingerprints. The two `ctx-sandbox-plan` profiles have distinct fingerprints and are included in normal `PROFILES` enumeration. Masking makes no extra model calls and does not discount token budgets. Lean-planning profiles hash their effective lean prompt and tool schemas in their behavior fingerprints.

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

With `leanPlanning`, `run_tests` and sandbox read-only inspection can run before a plan or while a replan is required. Edits, inline code, and other commands still require a plan. `update_plan` accepts `updates: [{ stepId, status, evidence? }]` (1–8 entries); only `set_plan` or an update carrying non-empty evidence clears required replanning. That evidence must name the failure. `finish_task` can complete remaining steps using `stepEvidence: [{ stepId, evidence }]`; rejection restores the entire previous plan. Commands and tests increment the write revision only when repository content changes, and no-op file edits preserve verification.

Lean mutation checks stream the content of paths reported by hardened host `git status --porcelain`, including non-ignored untracked files and executable-bit changes. A dirty protected path or an unreadable/truncated status makes content tracking unavailable; protected content is never read. Commands and tests still run, preserve their actual results, and conservatively count as a change, with a note appended to any existing result note. A passing full test run verifies that change after it is recorded; targeted-only tests retain their verification restriction. The inspection classifier is conservative for `sed`: script files, unknown options, and scripts containing `e`, `w`, or `W` remain gated, including benign uses of those characters. Ordinary numeric-range reads such as `sed -n '1,20p' file` remain available before planning.

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

The local suite has 532 self-contained deterministic tests, 2 local-dataset checks, and 6 Docker-gated tests in 55 files:

- A 10-scenario Agent suite, run against temporary Git fixtures. It covers multi-step completion, observation-driven recovery, repeated failures and replanning, false-success prevention, budgets, safety boundaries, and bounded provider retry.
- Provider-contract tests. One checks that DeepSeek `reasoning_content` is sent back on later tool-carrying requests; another checks that no `temperature` is sent in thinking mode; another checks that a reasoning-only, tool-call-free turn replays with string content instead of `content: null`.
- Persistence tests: a save/load round trip, redaction rules that keep numeric usage counters, and redaction of JSON-quoted credential forms (e.g. `"apiKey":"sk-…"`).
- Web UI tests use loopback servers on port 0 and local fixtures: one-time authentication, Host/Origin/method guards, confined reads, bounded/redacted projections, concurrent sessions/deletions, checkpoint diffs, evaluation completeness/invalidation and safe bounded Markdown rendering.
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
- MCP tests use the official SDK with in-memory and local stdio transports, including discovery, collisions, configuration, permissions, errors, timeouts and scripted runner integration. Sub-agent tests cover isolation, shared budgets, read-only tools, depth limits and REPL review.
- Phase 2 profile tests pin all three existing fingerprints, exercise masking for DeepSeek and OpenAI histories with trace/checkpoint/resume checks, and cover lean plan transactions, inspection gates, and real-content mutation tracking. A scripted `full` run exercises both features together without Docker or network access.
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
