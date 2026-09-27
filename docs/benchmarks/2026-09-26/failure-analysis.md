# Where OneHand fails: post-hoc analysis of the 2026-09-26 window

This analysis was done after the final window closed, on the same 392 runs (Mini 300, holdout 92, both arms pooled). It was **not pre-registered**: the categories were chosen while looking at the data, and the counts below are descriptive, without confidence intervals. The pre-registered results are in [README.md](README.md).

Aggregate counts, including per-arm and per-difficulty splits, are in [failure-analysis.json](failure-analysis.json). They were produced by [`eval/swebench/failure_analysis.py`](../../../eval/swebench/failure_analysis.py) from the unpublished per-run rows. The reference patches were used only for the list of files they change; no reference patch content is published.

## Outcome of every run

Each run is placed in exactly one row.

| outcome | Mini (300 runs) | Holdout (92 runs) |
|---|---:|---:|
| Resolved | 216 (72.0%) | 70 (76.1%) |
| Budget exhausted, no source change (no patch, or only paths classified as test files) | 39 (13.0%) | 5 (5.4%) |
| Budget exhausted, patch touches a file the reference patch changes | 33 (11.0%) | 5 (5.4%) |
| Budget exhausted, patch changes other source files | 3 (1.0%) | 0 |
| Agent finished and claimed success, hidden tests fail | 8 (2.7%) | 11 (12.0%) |
| Runtime error | 1 (0.3%) | 1 (1.1%) |

On the holdout, 9 of the 11 false successes touched a reference-patch file and 2 changed other source files.

## Findings

**1. Running out of budget is the main failure on Mini.**
- 75 of the 84 unresolved Mini runs (89%) ended with the budget exhausted. On the holdout it was 10 of 22.
- The limit that binds is cumulative input tokens (3M per run), not rounds: 115 of 116 exhaustions on Mini and 25 of 26 on the holdout were `token_budget`. They happened at a median of 59 and 61.5 model rounds, below the 80-round cap. Every round resends the history, so cumulative input grows faster than the round count.
- `ctx-sandbox` hit the budget less often: 42.7% → 34.7% of runs on Mini, 32.6% → 23.9% on the holdout. This is consistent with its lower cumulative input, though the resolved rate showed no detectable change.
- Exhaustion tracks the SWE-bench difficulty label (both datasets pooled):

  | difficulty | runs | resolved | budget exhausted |
  |---|---:|---:|---:|
  | < 15 min | 152 | 142 (93.4%) | 21 (13.8%) |
  | 15 min – 1 hour | 182 | 128 (70.3%) | 72 (39.6%) |
  | 1 – 4 hours | 50 | 16 (32.0%) | 43 (86.0%) |
  | > 4 hours | 8 | 0 | 6 |

**2. Failed runs usually edit the right files.** This is coarse, file-level evidence: it does not show that the right lines were changed.
- Of the unresolved runs that changed source code, the patch touched a file that the reference patch also changes in 41 of 44 on Mini and 14 of 16 on the holdout.
- In all 16 unresolved runs whose patch missed the reference files, the agent had opened at least one reference file with `read_file`.
- Among unresolved runs that the harness scored, most failed the target tests with no failure among the previously passing tests: 41 of 52 on Mini (plus 3 whose task has no such tests) and 15 of 19 on the holdout. Regressions, where some previously passing test failed, were 8 of 52 and 4 of 19.

**3. Self-verification disagrees with the hidden tests more often on the holdout.**
- False success was 8 of 300 runs on Mini but 11 of 92 on the holdout, where it is half of all failures (11 of 22).
- Mini covers two repositories (django and sphinx). The holdout spans nine, although 25 of its 46 tasks also come from django or sphinx. We have not tested why the gap is larger there.

**4. Some runs solve the task but do not stop.**
- 41 Mini runs and 16 holdout runs exhausted the budget yet were graded resolved, because the harness grades the working tree at the end of the run. In interactive use, these runs would be reported as budget failures.
- In 35 of 41 and 13 of 16 of them, the agent's own verification had passed at least once during the run. In 37 of 41 and 12 of 16, the plan still had open steps, and `finish_task` requires every step to be complete.
- The median gap between the last successful `write_file` or `replace_text` call on a patched file and exhaustion was 7 model rounds on Mini and 12 on the holdout. Changes made through commands are not tracked by this measure.

**5. Run-to-run variance matters for about a fifth of the tasks.** Of the 50 Mini tasks, run 6 times each (3 repetitions × 2 arms), 30 were resolved every time, 9 never, and 11 sometimes.

**6. Both runtime errors had the same cause.** The model called `run_command` with `cwd` set to `/testbed/.scratch`, a directory that did not exist. `docker exec` could not change into it, and the Docker executor reported an execution-environment failure, which ends the run. A missing working directory should instead come back to the model as an ordinary tool error. This is not fixed in the evaluated commit.

**7. Calls to tools that do not exist were rare:** 4 calls in 392 runs (`grep`, `bash`, `run_code`, `grep_files`), each rejected by the tool registry.

## What this suggests

These are hypotheses for future work, not tested results.
- **Stopping (finding 4):** show the model its remaining budget, and prompt it to close out the plan once the latest write is verified and the diff has not changed for several rounds.
- **Verification (finding 3):** before accepting `finish_task`, run the existing tests closest to the changed files, or use the review sub-agent, which is implemented but was not evaluated.
- **Budget (finding 1):** cheaper context already reduced exhaustion. The remaining lever is a larger budget, which trades off against cost.
- **Executor (finding 6):** return a missing `cwd` to the model as a tool error.

## Limitations

- Post-hoc and exploratory; categories were defined after seeing the data. Both arms are pooled unless stated.
- File overlap with the reference patch is a coarse localization measure. A correct fix can legitimately change other files, and touching the right file does not mean the right lines were changed.
- A file counts as a test file by its path (`tests/` or `testing/` directories, `test_*` or `*_test.py` names, `conftest.py`).
- One model (`deepseek-flash`) and one budget setting.

## Reproduce

```bash
python eval/swebench/failure_analysis.py --dataset <SWE-bench Verified jsonl> \
  --results mini=<mini results dir> --results holdout=<holdout results dir> --json <out.json>
```

The per-run rows (`results.jsonl`) are not published; see [README.md](README.md#reproduce) for how to regenerate them.
