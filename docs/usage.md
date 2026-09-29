# Using OneHand

[Back to README](../README.md)

Installation, interactive commands, the local Web UI, profiles, and implemented features.

## Overview

OneHand is a local coding-agent CLI for repository-scoped maintenance tasks. It implements an explicit **inspect → plan → act → observe → revise → verify → finish** loop instead of treating a single model response as task completion.

The model can inspect code, make bounded file edits, run local verification commands, and decide the next action from the previous tool observation. Editing runs succeed only after every plan step is complete and a passing verification follows the latest write; ask-mode chat can finish with a plain answer.

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

## Interactive use

```bash
onehand chat --repo /path/to/trusted/repo --mode edit
onehand chat --repo /path/to/trusted/repo --mode ask \
  --provider deepseek --model deepseek-v4-pro --thinking enabled --reasoning-effort high
```

Chat defaults to `edit` mode and the `ctx` profile. Both `run` and `chat` accept `--profile baseline`; profiles requiring Docker are rejected locally. Mode defaults are:

| Mode | Read and plan | Write and execute | Completion |
| --- | --- | --- | --- |
| `ask` | Allowed | Denied | Plain answer |
| `edit` | Allowed | Ask for approval | Verified `finish_task` |
| `auto` | Allowed | Allowed | Verified `finish_task` |

For an approval, answer `y` (yes), `n` (no), or `a` (always for this session). Always approvals apply to the tool, or to the program for `run_command`. EOF and Ctrl+C at an approval deny that operation. Ctrl+C during a run cancels it and returns to the prompt; press it twice at an empty prompt to exit. `NO_COLOR` and redirected output disable ANSI styling.

Use `/mode ask|edit|auto` to switch modes, `/diff` to inspect the working-tree diff, `/undo` to restore the checkpoint before the last run's first mutation, and `/checkpoints` plus `/rewind <n>` to restore an older checkpoint (1 is newest). Edit and auto runs snapshot before the first write or execution in each model turn. Checkpoints live in `~/.onehand/checkpoints/`, separately from your repository's Git history and index; `ONEHAND_CHECKPOINT_DIR` overrides that location and must stay outside the work tree. Ignored and protected paths are excluded, and files over 5 MB are skipped with a note. Undo leaves excluded files untouched, including directories whose ignored contents would prevent restoring a snapshot file. Empty directories may remain. Use one chat session per repository at a time; checkpoint operations across processes are not serialized.

Root `AGENTS.md` instructions (or `ONEHAND.md` when absent) are loaded at startup, capped at 8 KB, and shown by `/memory`. Each new task also receives the last five inputs and answers, capped at 500 characters each. `/model <id>` changes the model; `/profile <name>` switches the local profile, which also appears in the banner and `/help`.

Run status and `/cost` show tokens plus estimated USD for catalogued models, using the current UTC peak/off-peak rate. Session estimates keep each model's usage separate; unknown models show tokens only, and mixed sessions label partial estimates. Prices are a local snapshot, not a billing record; Chinese public-holiday exceptions are not encoded in the weekday schedule. Evaluation manifests retain their pinned peak-price snapshots.

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

Interactive features are opt-in library options (`onEvent`, `authorize`, `completion`, `checkpoints`, and `projectInstructions`). The library defaults to `baseline`; evaluation calls pass explicit profiles. The local CLI selects `ctx` without changing those evaluation settings.

## Web UI

```bash
onehand ui --port 0 --runs-dir ~/.onehand/runs --results-dir ./eval/results
onehand ui --open
```

The command prints a local URL with a single-use access token. Port `0` (the default) chooses a free port; `--open` launches the default browser. Defaults are `~/.onehand/runs` and `eval/results` under the current directory: run it from the repository root, or use `--results-dir` to browse another results folder. Ctrl+C stops the server. No provider keys, model calls, dependencies or frontend build step are needed.

- **Runs:** newest first, with task, repository basename, provider/model, status, stop reason, rounds, calls, tokens and update time. Run details show plan evidence, usage totals, the final message and trace events, including masking, sub-agents, permissions and checkpoints. Raw conversation history and stored tool outputs are excluded.
- **Checkpoints:** list the run repository's shadow-Git snapshots and display a colored unified diff against its current tree. There is no restore action. The existing `CheckpointStore.list()`/`diff()` methods may initialize or update internal shadow-Git metadata and temporary objects; they leave the source working tree and its Git history/index unchanged. Avoid concurrent checkpoint operations from other processes.
- **Evaluations:** per-variant metrics, readable run completeness, overall token means, SVG cost/resolved-rate bars, and safe Markdown views of `report.md`, `compare-*.md` and `analysis.md`. Directories named with `INVALID` or containing `INVALID.txt` are labeled invalidated and excluded from detail views. A single variant can use the recorded overall token means; missing per-variant metrics display `—`. The UI does not rerun evaluations.

The server binds only `127.0.0.1`. The one-time `?token=` URL is exchanged for an `HttpOnly; SameSite=Strict` session cookie and redirected to a clean URL. Keep that URL private; restart the server to obtain a new one. Every page, asset and API request requires authentication. Exact loopback Host headers and same-origin API Origin headers prevent DNS rebinding and cross-origin access. Only GET is accepted. CSP blocks inline scripts/styles and framing; responses also use `nosniff`, `no-referrer` and `no-store`.

Run/evaluation IDs must appear in the configured directories; artifact reads are realpath-confined to their selected directory, including symlink checks. State is redacted again and projected to display fields. Checkpoint reads go only through `CheckpointStore` for the repository recorded in that state. Responses are capped at 4 MiB, state files at 8 MiB, trace tails at 2 MiB and 2,000 events, reports at 256 KiB each (up to 20), and diffs at 512 KiB; truncated trace/diff views are labeled. Markdown HTML is escaped before rendering, and no remote resources are loaded.

## Agent profiles

The library `runAgent({ profile: PROFILES.ctx, ... })` and SWE-bench `--variants` support nine named profiles:

- `baseline`: unchanged tool definitions, prompts, JSON observations, and command policy.
- `ctx`: windowed, numbered reads; grouped search and gitignore-aware directory listings (E4); compact text observations (E3).
- `ctx-notices`: `ctx` plus experimental budget and verified-stability notices (E11). It can run locally, but has not yet been evaluated.
- `ctx-sandbox`: `ctx` plus inline Python/Node and read-only git/grep/sed commands in an isolated container (E8). Requires a Docker executor; local executors reject it.
- `ctx-sandbox-notices`: `ctx-sandbox` plus experimental budget and verified-stability notices (E11). It requires a Docker executor and has not yet been evaluated.
- `ctx-sandbox-mask`: `ctx-sandbox` plus deterministic observation masking (E5). When the previous response reports more than 48,000 prompt tokens, retain the newest complete tool rounds within a 48 KiB serialized-history budget (at least 2, at most 10). Assistant text, reasoning, and tool results all count toward that budget; the minimum 2 rounds may exceed it. Apply a masking block only if the full history, including its replacement context note, shrinks by at least 32 KiB. Otherwise history and note placement remain untouched, preserving the prompt-cache prefix. A real event refreshes the plan/modified-files note, checkpoints masked history, and traces `bytesRemoved`, `bytesKept`, and `keptRounds`.
- `full`: `ctx-sandbox-mask` plus lean planning (E1): atomic batched `update_plan`, transactional `finish_task stepEvidence`, pre-plan tests and read-only inspection, and content-based mutation tracking.
- `ctx-sandbox-plan`: `ctx-sandbox` plus lean planning (E1), without observation masking.
- `ctx-sandbox-plan-explore`: `ctx-sandbox-plan` plus the isolated, budget-sharing `explore` sub-agent (E9).

Feature flags are validated booleans and default to false. Unknown flags are rejected. Local `run` and `chat` still default to `ctx`; `ctx-notices` is the only new notice profile accepted locally, while all `sandboxCommands` profiles require a Docker executor.

All seven v0.3.0 profiles retain their original prompts, tool schemas, and behavior fingerprints. The two notice profiles have distinct fingerprints that include their effective prompt and fixed runtime notice templates. The two `ctx-sandbox-plan` profiles remain included in normal `PROFILES` enumeration. Masking makes no extra model calls and does not discount token budgets. Lean-planning profiles hash their effective lean prompt and tool schemas in their behavior fingerprints.

## What is implemented

- OpenAI Responses and DeepSeek providers, schema-validated repository tools, verified completion, and step/token/time/retry budgets.
- Nine profiles with experiment flags for retrieval (E4), compact observations (E3), sandbox commands (E8), masking (E5), lean planning (E1), explore (E9), and budget notices (E11). E11 has not yet been evaluated. Local `run` and `chat` default to `ctx`; `--profile baseline` remains available.
- `onehand chat` with ask/edit/auto modes, approvals, cancellation, profile/model switching, token totals, and estimated USD for catalogued models.
- Shadow-Git checkpoints with undo/rewind, plus resumable run state and redacted traces.
- Root `AGENTS.md` / `ONEHAND.md` instructions, session context, and optional MCP servers with tool permissions.
- Read-only explore and review sub-agents with separate histories and shared budgets.
- A local Web UI for runs, checkpoint diffs, evaluation completeness, metrics, and reports.
- Offline deterministic scenarios and a SWE-bench harness with explicit profiles, container execution, grading, manifests, cost caps, and dev/holdout splits.
- Atomic writes, confined paths, protected secrets, and a shell-free local command policy. Docker execution is a library/harness option; the CLI runs locally.

OneHand is a tool-using agent, not a general-purpose sandbox. Running tests or build programs can execute code from the target repository, so use it only with repositories you trust. See [SECURITY.md](../SECURITY.md).
