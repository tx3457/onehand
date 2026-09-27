# Verification and evaluation

[Back to README](../README.md)

Offline verification coverage, evaluation protocols, and the measured results with their caveats.

## Verification

```bash
npm run typecheck
npm test
npm run build
npm run demo
npm run eval:deterministic
```

The local suite has 612 self-contained deterministic tests, 2 local-dataset checks, and 6 Docker-gated tests in 60 files. Offline validation with the local dataset passes 614 tests and skips the 6 Docker tests:

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
- Profile tests preserve pinned fingerprints, exercise masking for DeepSeek and OpenAI histories with trace/checkpoint/resume checks, and cover lean plan transactions, inspection gates, and real-content mutation tracking. CLI/REPL tests cover local defaults, switching, Docker rejection, sub-agents, and estimated costs; pricing tests preserve evaluation snapshots. A scripted `full` run exercises both features together without Docker or network access.
- Evaluation-harness tests for: the cost cap surviving a resume for a thrown run's worst-case charge; a mis-keyed row being substituted instead of crashing a later "Duplicate" check; the audited copy in `invalid-results.jsonl` staying redacted; and the source fingerprint changing when any tracked file changes.
- An offline integration test that drives the real evaluation `runOne` path with a scripted DeepSeek client, including that the trace's frozen budgets match the manifest exactly.
- SWE-bench plumbing tests:
  - official test-command parsing and the agent task text;
  - a leak test over all 100 dev and holdout instances. Target hints and prompts must contain no hidden test names or files. It runs when the local dataset is present.
  - split, exclusion and holdout-ledger handling;
  - patch extraction;
  - grading classification against realistic fake-harness logs (test timeout, OOM, apply failure, container unavailable);
  - external mini-swe-agent reference grading with fake Docker/harness, usage pricing, resume, report disclaimers, and CLI validation;
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

The harness fails closed when runs are missing or the cost cap is reached. Published numbers come only from the pre-registered final window in [docs/benchmarks/2026-09-26](benchmarks/2026-09-26/README.md). See [eval/README.md](../eval/README.md) for the protocol.

## Results (SWE-bench Verified, pre-registered)

Measured with the same model (`deepseek-flash`) and budgets in one pre-registered final window, graded by the official harness. See the full report, with deviations and limitations, in [docs/benchmarks/2026-09-26](benchmarks/2026-09-26/README.md).

| dataset | resolved: baseline → `ctx-sandbox` | cost per run (95% CI) |
|---|---|---|
| Verified Mini (dev set), 50 tasks × 3 runs | 72.0% → 72.0% (non-inferior at a 10 pp margin) | **−20.7%** (−28.0% to −13.1%) |
| Holdout (never used in development), 46 tasks × 1 run | 73.9% → 78.3% (non-inferior at a 10 pp margin) | **−16.1%** (−28.1% to −2.5%) |

`ctx-sandbox` bundles three changes. The descriptive mechanism shifts below come from the same final window; component effects are not isolated:
- Line-numbered, byte-bounded file windows and grouped search: tokens per `read_file` fall from about 2.7–3.1k to about 1.0k.
- Compact plain-text observations.
- A sandbox-aware command policy: the `run_command` policy-rejection rate roughly halves (31.8% → 16.5% on Mini, 25.4% → 13.9% on the holdout).

The resolved rate did not detectably change. It is non-inferior at a 10 pp margin, but the CIs allow small losses. Development-stage experiments that did not pay off (observation masking was 32% more expensive; lean planning and an explore sub-agent gave no gain) are reported in the same document. For reference, mini-swe-agent 2.4.6, run with the same model, the same 80-step ceiling and a $1.08 cost cap matched to OneHand's worst-case run cost, resolved 72% on Mini at $0.059 per run. This is descriptive only, not a controlled comparison.
