# Trace diagnostics: `ctx-sandbox` on swebench

> This is a DIAGNOSTIC of one configuration, not a comparative claim: it shows where tokens and time go in these runs, not that any change would help. Use eval:compare on paired A/B runs for that.

- Results: `eval/results/final-2026-09-26-holdout`; model `deepseek-flash`
- Runs analyzed: 46; rows excluded: none

## Bottleneck ranking

| rank | source of cumulative input tokens | share |
|---:|---|---:|
| 1 | assistant_output | 41.1% |
| 2 | tool:read_file | 25.5% |
| 3 | tool:search_code | 9.0% |
| 4 | tool:run_command | 7.2% |
| 5 | tool:run_tests | 7.2% |

| rank | time consumer | time | share |
|---:|---|---:|---:|
| 1 | model | 5582.7s | 46.0% |
| 2 | tool:run_tests | 3270.5s | 26.9% |
| 3 | runtime_overhead | 1644.7s | 13.5% |
| 4 | tool:run_command | 1617.9s | 13.3% |
| 5 | tool:list_files | 10.1s | 0.1% |

## Context growth

Each round re-sends the whole prompt, so a token added at round j of R counts R − j + 1 times toward cumulative input.

| source | tokens added | cumulative input tokens | share | observations | tokens per observation |
|---|---:|---:|---:|---:|---:|
| assistant_output | 1,106,620 | 27,778,985 | 41.1% | - | - |
| tool:read_file | 514,465 | 17,198,659 | 25.5% | 513 | 1,003 |
| tool:search_code | 152,801 | 6,053,665 | 9.0% | 532 | 287 |
| tool:run_command | 180,643 | 4,838,643 | 7.2% | 760 | 238 |
| tool:run_tests | 397,717 | 4,836,270 | 7.2% | 170 | 2,340 |
| initial_prompt | 105,103 | 4,612,239 | 6.8% | - | - |
| tool:update_plan | 61,963 | 851,548 | 1.3% | 249 | 249 |
| tool:list_files | 18,641 | 724,318 | 1.1% | 109 | 171 |
| tool:set_plan | 7,591 | 298,269 | 0.4% | 51 | 149 |
| tool:git_diff | 18,185 | 143,023 | 0.2% | 48 | 379 |
| tool:replace_text | 4,900 | 93,649 | 0.1% | 145 | 34 |
| tool:write_file | 3,427 | 76,079 | 0.1% | 103 | 33 |
| tool:git_status | 2,054 | 15,439 | 0.0% | 45 | 46 |
| tool:finish_task | 480 | 1,320 | 0.0% | 20 | 24 |
| tool:grep_files | 16 | 1,103 | 0.0% | 1 | 16 |
| other | 68 | 534 | 0.0% | - | - |

Cumulative input over the traced rounds: 67,523,743 tokens; the rows report 67,523,743.

- Round k's growth goes first to round k−1's output tokens (reasoning included), then to round k−1's tool observations in proportion to their bytes; what neither explains, including nudges, goes to other, which is negative when a prompt shrank.
- Tokens per observation divide a tool's added tokens by its observations that a later round re-sent; the last round's observations are never re-sent.

## Prompt size by round

| round | runs | P50 prompt tokens | P95 prompt tokens |
|---:|---:|---:|---:|
| 1 | 46 | 2,155 | 3,043 |
| 2 | 46 | 2,764 | 5,559 |
| 3 | 46 | 4,132 | 6,976 |
| 4 | 46 | 5,433 | 10,195 |
| 5 | 46 | 6,441 | 11,422 |
| 6 | 46 | 7,984 | 14,585 |
| 7 | 46 | 9,303 | 14,683 |
| 8 | 46 | 10,389 | 18,194 |
| 9 | 46 | 11,623 | 19,672 |
| 10 | 46 | 12,418 | 20,153 |
| 11 | 46 | 13,482 | 20,999 |
| 12 | 46 | 14,579 | 22,945 |
| 13 | 45 | 15,654 | 24,216 |
| 14 | 44 | 16,377 | 25,112 |
| 15 | 44 | 17,392 | 26,269 |
| 16 | 44 | 19,286 | 29,110 |
| 17 | 44 | 20,348 | 31,601 |
| 18 | 44 | 21,520 | 33,403 |
| 19 | 43 | 22,685 | 35,340 |
| 20 | 39 | 23,725 | 37,724 |
| 21 | 37 | 25,309 | 40,688 |
| 22 | 37 | 25,916 | 45,011 |
| 23 | 37 | 27,592 | 49,625 |
| 24 | 37 | 29,091 | 50,653 |
| 25 | 35 | 30,196 | 51,170 |
| 26 | 35 | 31,296 | 56,830 |
| 27 | 34 | 31,514 | 63,759 |
| 28 | 34 | 32,565 | 65,975 |
| 29 | 33 | 33,304 | 67,079 |
| 30 | 32 | 34,561 | 68,787 |
| 31 | 31 | 35,211 | 68,968 |
| 32 | 31 | 36,768 | 69,682 |
| 33 | 31 | 38,679 | 69,985 |
| 34 | 31 | 39,151 | 70,814 |
| 35 | 31 | 41,334 | 73,233 |
| 36 | 29 | 43,108 | 75,754 |
| 37 | 26 | 44,740 | 76,466 |
| 38 | 26 | 45,506 | 78,665 |
| 39 | 26 | 46,610 | 83,324 |
| 40 | 26 | 47,253 | 86,223 |
| 41 | 25 | 49,677 | 86,997 |
| 42 | 25 | 50,598 | 87,542 |
| 43 | 24 | 51,567 | 89,174 |
| 44 | 24 | 53,207 | 89,810 |
| 45 | 24 | 56,210 | 92,325 |
| 46 | 23 | 58,628 | 94,086 |
| 47 | 21 | 56,902 | 95,527 |
| 48 | 20 | 58,320 | 96,560 |
| 49 | 18 | 58,457 | 98,100 |
| 50 | 15 | 58,794 | 100,636 |
| 51 | 15 | 60,570 | 101,448 |
| 52 | 15 | 62,538 | 102,099 |
| 53 | 14 | 64,327 | 102,634 |
| 54 | 14 | 65,140 | 105,439 |
| 55 | 13 | 65,865 | 98,694 |
| 56 | 13 | 68,728 | 99,491 |
| 57 | 13 | 68,994 | 99,740 |
| 58 | 13 | 70,425 | 99,998 |
| 59 | 13 | 70,907 | 100,340 |
| 60 | 12 | 63,547 | 101,690 |
| 61 | 11 | 74,358 | 102,428 |
| 62 | 10 | 64,811 | 87,158 |
| 63 | 10 | 67,616 | 87,291 |
| 64 | 10 | 69,465 | 88,265 |
| 65 | 10 | 69,672 | 88,791 |
| 66 | 9 | 71,136 | 87,891 |
| 67 | 9 | 71,310 | 88,768 |
| 68 | 9 | 76,610 | 93,327 |
| 69 | 7 | 72,202 | 99,237 |
| 70 | 6 | 72,714 | 89,045 |
| 71 | 6 | 73,916 | 90,965 |
| 72 | 5 | 74,892 | 78,759 |
| 73 | 5 | 76,503 | 79,274 |
| 74 | 4 | 72,427 | 80,119 |
| 75 | 2 | 69,701 | 73,537 |
| 76 | 2 | 69,797 | 73,973 |
| 77 | 2 | 70,120 | 74,797 |
| 78 | 2 | 72,278 | 75,054 |
| 79 | 1 | 75,231 | 75,231 |
| 80 | 1 | 75,618 | 75,618 |

Peak context per run: max 124,700, P50 51,394, P95 102,428, mean 55,971 tokens.

## Governance overhead

- Governance tool calls (set_plan, update_plan, finish_task): 354 of 2782 tool calls (12.7%); set_plan 51, update_plan 249, finish_task 54.
- Rounds whose tool calls are all governance tools: 218 of 2013 rounds (10.8%).

## Redundant reads

- 195 of 513 read_file calls (38.0%) re-read a path already read successfully, with no successful write_file or replace_text to it in between.

## Tool failures

A failure is a call that was rejected, errored, or timed out: 255 of 2782 tool calls (9.2%). Failing test runs are observations, not failures: 41.

| tool | calls | failures | failure rate |
|---|---:|---:|---:|
| run_command | 762 | 157 | 20.6% |
| search_code | 532 | 31 | 5.8% |
| update_plan | 249 | 23 | 9.2% |
| finish_task | 54 | 20 | 37.0% |
| run_tests | 170 | 8 | 4.7% |
| list_files | 109 | 4 | 3.7% |
| set_plan | 51 | 4 | 7.8% |
| read_file | 513 | 3 | 0.6% |
| replace_text | 145 | 2 | 1.4% |
| write_file | 103 | 2 | 1.9% |
| grep_files | 1 | 1 | 100.0% |
| git_diff | 48 | 0 | 0.0% |
| git_status | 45 | 0 | 0.0% |

| error category | failures |
|---|---:|
| policy | 113 |
| plan_gate | 64 |
| schema | 59 |
| not_found | 7 |
| timeout | 5 |
| other | 5 |
| unknown_tool | 1 |
| environment | 1 |

| failures | error (truncated) |
|---:|---|
| 39 | Call set_plan before modifying files |
| 24 | arguments.contextLines must be <= 5 |
| 23 | arguments.stepId must be a number |
| 20 | Path escapes repository root: / |
| 20 | Run a passing verification after the most recent file change |
| 10 | Path escapes repository root: /tmp |
| 7 | Git mutation or network operation is disabled: git branch |
| 6 | Program is outside the local execution allowlist: mkdir |
| 5 | Git mutation or network operation is disabled: git tag |
| 5 | Repeated failure requires update_plan before continuing |

## Time

| component | time | share |
|---|---:|---:|
| model (Σ model_turn.latencyMs) | 5582.7s | 46.0% |
| tools (Σ tool_result.durationMs) | 4911.4s | 40.5% |
| runtime overhead (run duration − model − tools, at least 0) | 1644.7s | 13.5% |

Run durations total 12138.7s; 0 run(s) had model plus tool time above their duration, so their overhead was clamped to 0.

| tool | calls | total | P50 | P95 |
|---|---:|---:|---:|---:|
| run_tests | 170 | 3270.5s | 1.4s | 41.0s |
| run_command | 762 | 1617.9s | 222ms | 1.5s |
| list_files | 109 | 10.1s | 34ms | 377ms |
| search_code | 532 | 9.9s | 16ms | 37ms |
| git_status | 45 | 1.2s | 27ms | 51ms |
| git_diff | 48 | 1.1s | 22ms | 44ms |
| read_file | 513 | 406ms | 1ms | 2ms |
| replace_text | 145 | 199ms | 1ms | 3ms |
| write_file | 103 | 87ms | 1ms | 2ms |
| update_plan | 249 | 46ms | 0ms | 1ms |
| finish_task | 54 | 20ms | 0ms | 1ms |
| set_plan | 51 | 16ms | 0ms | 1ms |
| grep_files | 1 | 0ms | 0ms | 0ms |

## Outcomes

| stop reason | runs |
|---|---:|
| explicit_finish | 34 |
| token_budget | 10 |
| step_budget | 1 |
| runtime_error | 1 |

- Text-only turns: 2; nudges sent: 2, in 2 run(s).
- Turns that hit the output limit (finishReason length): 1; runs stopped by output_limit: 0.
- environment_failure events: 1.

P50 and P95 are nearest-rank percentiles.
