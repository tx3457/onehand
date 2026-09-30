# Completion, recovery, and safety

[Back to README](../README.md)

The completion rules, recovery behavior, and limits of the tool safety policy.

## Completion signal

For `onehand run` and edit/auto chat, a plain assistant message is not a success signal. If the model stops without an accepted `finish_task`, the run is reported as failed.

## Completion and recovery semantics

1. The model must call `set_plan` before a write, command, or test.
2. File edits and general commands increment a mutation revision; commands are conservatively treated as potentially mutating.
3. Only a passing `run_tests` records that revision as verified.
   - `run_tests` accepts optional `targets` (test files, pytest node ids, or framework labels) for running a subset during iteration.
   - For local runs, a passing targeted run does **not** verify the latest change. `finish_task` still requires an untargeted passing run.
   - Only the SWE-bench harness enables targeted verification (`allowTargetedVerification`), because full suites there take hours.
4. Repeating the same failed tool action twice requires a plan update before further action.
5. `finish_task` is rejected while a step is incomplete, replanning is required, or the newest write lacks passing verification.
6. Each tool round is checkpointed when persistence is enabled. Resume rejects state from a different task, repository, provider, model, Git commit, worktree fingerprint, profile, or saved behavior identity before model completion or model-selected tool execution. Read-only checks compute the current repository/configuration identity first.

CLI `--resume` requires an explicit `--profile` matching the original run. State schema v4 stores the profile name/flags, the agent behavior fingerprint, and a run behavior fingerprint of the effective prompts, tools, inference settings and verification policy. Changing a test command, project instructions, system prompt, provider endpoint (including `OPENAI_BASE_URL`), or completion/verification policy cannot silently reuse an old run's verification. Total run budgets can be extended while resuming the same behavior; changing the per-turn output limit changes the inference identity.

The runner cannot inspect the internal endpoint or implementation of a library-injected provider/client, executor, or custom tool implementation. Library callers must preserve those implementations and supply a stable explicit endpoint when injecting their own provider. Credentials are not stored in the behavior identity; the identity is a configuration consistency check, not an attestation of arbitrary injected code.

Legacy states without this identity are rejected with an instruction to start a new run. There is no automatic migration that guesses the original profile. Existing files and historical evaluation artifacts are retained; selecting `baseline` does not bypass the legacy-state rejection.

Chat additionally persists a session manifest and the original file-checkpoint association. Its `prepared`/`running` task state distinguishes safe startup from a possibly started provider request without a saved run. A saved successful run is reconciled into the session without replay. Recovery restores declarative configuration, reloads project/user permissions, and discards transient approvals. See [persistent chat sessions](usage.md#persistent-chat-sessions) for commands and limitations.

Run budgets are checked before each tool and after tool completion, including elapsed time spent in the preceding model call or tool. Remaining calls in an already-returned batch receive explicit skipped results when a budget stops the run. This does not interrupt a tool already executing at the exact wall-time boundary; its own timeout/cancellation controls remain in effect.

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

Model requests are retried on HTTP 429/5xx, timeouts, and connection errors (including `ECONNREFUSED`), with exponential backoff up to the configured retry limit. A run against an unreachable endpoint fails after those retries.

These controls limit the model's direct tools. They do **not** isolate code executed by an allowed test/build program. Use a container or VM when stronger isolation is required.

The Docker executor is an isolation aid, not a security boundary against a hostile repository: host-side Git and file tools still operate on the bind-mounted checkout that container commands can write, and the file tools have a check-then-use window between validating a path and opening it.
