# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.4.0] - 2026-10-01

### Added

- Added persistent chat sessions. `--session-dir` and `--resume` restore the saved configuration, the unfinished task, cumulative usage and its first checkpoint, and `/discard` archives an unfinished task. After a crash in which a provider request may already have started, chat refuses to replay it.
- Added an exclusive per-repository chat lock kept in a private Git store outside the repository. Only a confirmed-dead owner on the same host can be reclaimed, and the lock error prints a command that clears a stale lock. Checkpoint operations serialize across processes.
- Added `onehand doctor`, which runs fixed Git and rg probes and can check that a provider key is present, without model calls. Missing Git exits nonzero.
- Added the opt-in `budgetNotices` flag and the experimental E11 `ctx-notices` and `ctx-sandbox-notices` profiles. E11 has not been evaluated, and the local default remains `ctx`. Its development protocol is prepared in `docs/benchmarks/2026-09-30-e11/`.
- Evaluation comparisons now report `resolvedAndFinished` and `resolvedBudgetExhausted`, treat missing telemetry as unknown, and withhold significance and non-inferiority decisions for incomplete windows.

### Changed

- Raised the local `run` and `chat` default budgets to 60 rounds, 120 tool calls, 2,000,000 input tokens, 100,000 output tokens and 30 minutes. These limits cover 112 of the 144 resolved `ctx-sandbox` runs in the 2026-09-26 window, where the previous defaults covered 20. Library defaults are unchanged.
- Resume state schema v4 binds the profile and the behavior identity: effective prompts, tools, inference settings, test command and verification policy. Legacy states are rejected, not migrated.
- Budgets are now checked at tool boundaries, including time spent in the preceding model call or tool. Skipped calls keep paired results.
- JavaScript test detection requires a non-empty `scripts.test` and follows `packageManager` or an unambiguous lockfile. Python detection selects pytest only from `pytest.ini` or `[tool.pytest.ini_options]`; other Python projects need `--test`.
- The path guard also rejects symlinks that resolve to protected files.

### Fixed

- In the Docker executor, a command `cwd` that does not exist in the container now returns a recoverable tool error instead of ending the run as an environment failure (post-hoc failure-analysis finding 6).

## [0.3.0] - 2026-09-28

### Added

- Added `ctx` and `ctx-sandbox` profiles with line-numbered, byte-bounded read windows instead of whole-file reads, grouped search results, gitignore-aware file listings, compact text observations, and an isolated-container command policy. Added experimental observation-masking, lean-planning, and explore-sub-agent profiles.
- Added `onehand chat` with ask, edit, and auto modes; layered permissions; cancellation; project instructions; session context; model and profile switching; and token and estimated-cost displays.
- Added shadow-Git checkpoints with `/undo`, `/rewind`, and `/checkpoints`, without modifying the target repository's Git history or index.
- Added MCP server support with per-tool permissions, connection and call timeouts, and bounded output; failed servers are skipped.
- Added budget-sharing, read-only `explore` and `review_changes` sub-agents for interactive use, plus the `/review` command.
- Added a local, authenticated, read-only Web UI for runs, checkpoint diffs, and evaluation artifacts.

### Changed

- Local `run` and `chat` commands now default to the measured `ctx` profile. Evaluation profiles remain explicit and fingerprinted, and profiles that require a Docker executor are rejected by local execution.
- Command capture now keeps bounded stream heads and tails, incrementally retains failure lines, and stops commands whose output exceeds 64 MiB.
- Pricing calculations moved into a shared module; chat estimates use peak/off-peak rates while evaluation manifests retain pinned price snapshots.
- Documentation is split from the README into focused usage, extension, safety, and evaluation guides. Package and CLI versions are updated to 0.3.0.

### Fixed

- Preserved provider reasoning content across rounds, kept usage counters out of secret redaction, prevented a text-only turn from ending an editing run, and distinguished runtime failures from model failures.
- Preserved command-output tails and existing file modes during atomic writes.
- Made evaluation manifests record behavior-affecting settings, agent fingerprints, and source fingerprints so incompatible runs cannot be mixed or resumed.
- Prevented unbounded child-process output from exhausting memory or throwing from the close handler; over-limit output now ends with an explicit non-timeout error.

### Evaluation

- Added the SWE-bench Verified pipeline with isolated non-root containers, no-network execution, pinned Epoch image IDs, single-commit read-only Git history, official `swebench` 5.0.2 grading, resumable cost caps, outage handling, holdout controls, paired bootstrap comparison, and context/failure analysis.
- Added external-prediction grading through the same harness and price calculation, with a frozen manifest for pinned inputs and images.
- Pre-registered and published the 2026-09-26 final evaluation. On Verified Mini, `ctx-sandbox` matched the baseline's 72.0% resolved rate and reduced cost per run by 20.7% (95% CI: 13.1% to 28.0% lower). On the untouched 46-task holdout, resolved rate was 73.9% to 78.3% and cost per run fell 16.1% (95% CI: 2.5% to 28.1% lower). Both resolved-rate comparisons met the pre-registered 10 percentage-point non-inferiority criterion; neither establishes an accuracy gain.
- Published descriptive mechanism results, development-stage comparisons, self-checks, deviations, and limitations. Observation masking increased development cost, while lean planning and the explore sub-agent showed no gain in their development tests.
- Reported mini-swe-agent 2.4.6 as a descriptive external reference: 36 of 50 Verified Mini tasks resolved at an estimated $0.0592 per run. Tool interfaces, control flow, and limits differed, so this is not a controlled framework comparison.
- Added a post-hoc, not pre-registered failure analysis of the final window (`eval/swebench/failure_analysis.py`, `docs/benchmarks/2026-09-26/failure-analysis.md`). It found that a missing `cwd` passed to `run_command` in the Docker executor ends the run instead of returning a tool error; this is not yet fixed.
- Corrected the final report's window end times, Holm-family wording, holdout cost-cap deviation, command-policy mechanism metric, non-inferiority language, and bundled-profile attribution after independent verification.

## [0.2.0]

The starting point of this work. With the pre-registered baseline fixes listed under 0.3.0 "Fixed", it forms arm A (`baseline`) of the 2026-09-26 evaluation.
