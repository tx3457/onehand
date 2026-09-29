# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
