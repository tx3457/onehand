# Reliability changes: engineering validation

Status: **offline engineering verification passed; real-model E11 evaluation not run**.

The candidate is an uncommitted change on `v0.4-dev`, based on `f1bea5377cc20f2551fa514d6142c1d37f7012bd`. [candidate.json](candidate.json) records its source fingerprint, all nine profile fingerprints and verification status. The two E11 fingerprints changed with the corrected notice text; all seven pre-E11 profile fingerprints match their pinned values. Runtime fixes change the source fingerprint even when a profile's prompt/tool fingerprint is preserved.

## What changed

- Resume state v4 binds profile identity and agent/run fingerprints. Mismatches in prompts, test commands, verification policy, inference settings or an internally constructed provider's effective endpoint are rejected before a model completion or model-selected tool runs. Legacy states without identity require a new run; they are not silently migrated.
- Token, tool and elapsed-time budgets are checked at tool boundaries. Ordinary tools from the last admitted parent model response still execute after earlier child usage; new child usage that exhausts the shared step budget stops the remaining siblings. Skipped calls retain paired history results.
- E11 recognizes verified active and completed-awaiting-finish states, including no-edit tasks, while excluding blocked/replan/unverified, answer-mode and child cases. One generic template describes the tracked mutation revision accurately for both conservative and content-aware tracking. The shared text module removes a runtime/fingerprint import cycle.
- Evaluation compares `resolvedAndFinished` and `resolvedBudgetExhausted` separately from resolution and false success. Final verification uses recorded revisions. Missing telemetry is unknown. Incomplete A/B windows retain descriptive estimates but no affirmative significance/non-inferiority decision.

## Verification

| Check | Result |
|---|---|
| `npm run typecheck` | Passed for source and evaluation TypeScript |
| `npm test` | 61 files passed; 673 tests passed; 6 Docker-gated tests skipped; no unhandled errors |
| `npm run build` | Passed |
| `npm run demo` | Scripted provider, real tools/tests; `success` / `explicit_finish` |
| `npm run eval:deterministic` | 10 scenarios passed |
| `git diff --check` | Passed |
| Seven historical profile fingerprints | Exact matches |
| Frozen 2026-09-26 reports, split and exclusions | No diff |
| Independent code/security review | APPROVE, no remaining findings |
| Independent architecture review | CLEAR, no required changes |

The repository has no separate lint script; the existing strict TypeScript checks and diff hygiene were used. Tests run without provider keys and with network-dependent Docker integration disabled. Deterministic fixtures exercise the real runner, persistence, tool result pairing and trace-to-summary path; their scripted decisions and fixture grading verdicts are not model-quality evidence.

Regressions were observed failing before fixes for resume drift, missing identity, tool/model elapsed-time stopping, close-out state coverage, final-parent-turn shared budgets, answer-mode threshold notices, completion metrics, unknown evidence and incomplete-window decisions. A full-suite checkpoint test exposed a pre-existing fixed-delay race; the final test waits for actual tool entry and always awaits cleanup. Wall-time regressions use a controlled clock.

## Remaining work and limits

The real comparison in [protocol.json](protocol.json) has not started. The current execution environment has the Python SWE-bench environment and dataset, but no Docker/Podman/nerdctl executable or Docker socket, including after a read-only escalated check. No evaluation-provider API calls were made, so this evaluation incurred no provider API cost. Execution-host information and the cost/repetition constraint remain pending.

After those prerequisites are available, run the new self-check and paired window, verify completeness, then publish its aggregate result under this directory. Preserve all historical frozen artifacts. The full requested goal remains incomplete until that empirical evaluation is either performed or the user explicitly changes its scope.

Already-running tools retain their own timeout/cancellation behavior; the total run deadline is enforced at tool boundaries. Library-injected provider/client/executor implementations remain opaque and must be kept consistent by their caller. See [the recovery contract](../../safety.md).
