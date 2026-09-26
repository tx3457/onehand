# Trace diagnostics: `ctx-sandbox-plan-explore` on swebench

> This is a DIAGNOSTIC of one configuration, not a comparative claim: it shows where tokens and time go in these runs, not that any change would help. Use eval:compare on paired A/B runs for that.

- Results: `eval/results/swebench-dev25-plan-explore-r1`; model `deepseek-flash`
- Runs analyzed: 25; rows excluded: none

## Bottleneck ranking

| rank | source of cumulative input tokens | share |
|---:|---|---:|
| 1 | assistant_output | 39.5% |
| 2 | tool:read_file | 31.1% |
| 3 | tool:run_tests | 8.7% |
| 4 | tool:run_command | 8.2% |
| 5 | initial_prompt | 7.1% |

| rank | time consumer | time | share |
|---:|---|---:|---:|
| 1 | model | 3254.2s | 67.2% |
| 2 | tool:run_command | 755.3s | 15.6% |
| 3 | runtime_overhead | 675.5s | 13.9% |
| 4 | tool:run_tests | 150.7s | 3.1% |
| 5 | tool:search_code | 4.7s | 0.1% |

## Context growth

Each round re-sends the whole prompt, so a token added at round j of R counts R − j + 1 times toward cumulative input.

| source | tokens added | cumulative input tokens | share | observations | tokens per observation |
|---|---:|---:|---:|---:|---:|
| assistant_output | 621,887 | 14,289,719 | 39.5% | - | - |
| tool:read_file | 333,054 | 11,255,069 | 31.1% | 333 | 1,000 |
| tool:run_tests | 285,114 | 3,136,151 | 8.7% | 66 | 4,320 |
| tool:run_command | 141,616 | 2,965,316 | 8.2% | 427 | 332 |
| initial_prompt | 61,202 | 2,552,295 | 7.1% | - | - |
| tool:search_code | 34,436 | 1,253,766 | 3.5% | 260 | 132 |
| tool:list_files | 10,604 | 384,758 | 1.1% | 55 | 193 |
| tool:set_plan | 3,779 | 122,989 | 0.3% | 32 | 118 |
| tool:update_plan | 8,592 | 83,489 | 0.2% | 35 | 245 |
| tool:git_diff | 8,010 | 53,441 | 0.1% | 21 | 381 |
| tool:write_file | 2,183 | 31,612 | 0.1% | 67 | 33 |
| tool:replace_text | 2,226 | 31,031 | 0.1% | 68 | 33 |
| tool:git_status | 867 | 7,378 | 0.0% | 20 | 43 |
| tool:finish_task | 120 | 240 | 0.0% | 5 | 24 |
| tool:glob | 3 | 49 | 0.0% | 1 | 3 |

Cumulative input over the traced rounds: 36,167,302 tokens; the rows report 36,167,302.

- Round k's growth goes first to round k−1's output tokens (reasoning included), then to round k−1's tool observations in proportion to their bytes; what neither explains, including nudges, goes to other, which is negative when a prompt shrank.
- Tokens per observation divide a tool's added tokens by its observations that a later round re-sent; the last round's observations are never re-sent.

## Prompt size by round

| round | runs | P50 prompt tokens | P95 prompt tokens |
|---:|---:|---:|---:|
| 1 | 25 | 2,374 | 2,816 |
| 2 | 25 | 3,174 | 5,249 |
| 3 | 25 | 5,026 | 7,830 |
| 4 | 25 | 5,779 | 9,925 |
| 5 | 25 | 6,689 | 12,777 |
| 6 | 25 | 7,624 | 15,103 |
| 7 | 25 | 9,396 | 16,986 |
| 8 | 25 | 10,161 | 18,410 |
| 9 | 25 | 10,990 | 18,651 |
| 10 | 25 | 12,813 | 19,230 |
| 11 | 25 | 14,431 | 19,529 |
| 12 | 25 | 15,141 | 21,420 |
| 13 | 25 | 16,680 | 23,968 |
| 14 | 23 | 18,069 | 24,098 |
| 15 | 23 | 19,535 | 24,755 |
| 16 | 23 | 19,972 | 26,709 |
| 17 | 23 | 20,588 | 27,229 |
| 18 | 22 | 21,170 | 28,038 |
| 19 | 22 | 21,935 | 29,601 |
| 20 | 22 | 24,521 | 29,990 |
| 21 | 21 | 26,830 | 31,278 |
| 22 | 19 | 27,590 | 45,710 |
| 23 | 18 | 26,695 | 46,063 |
| 24 | 18 | 29,682 | 47,375 |
| 25 | 18 | 30,263 | 47,909 |
| 26 | 17 | 32,970 | 53,424 |
| 27 | 15 | 34,673 | 43,765 |
| 28 | 15 | 35,057 | 46,393 |
| 29 | 15 | 35,731 | 47,009 |
| 30 | 15 | 40,397 | 48,153 |
| 31 | 15 | 41,456 | 48,850 |
| 32 | 15 | 42,341 | 54,151 |
| 33 | 13 | 39,099 | 50,213 |
| 34 | 13 | 43,221 | 52,258 |
| 35 | 13 | 43,670 | 59,600 |
| 36 | 13 | 45,878 | 60,156 |
| 37 | 13 | 46,973 | 67,771 |
| 38 | 12 | 48,270 | 68,074 |
| 39 | 12 | 49,269 | 68,560 |
| 40 | 12 | 50,128 | 68,777 |
| 41 | 12 | 53,888 | 75,654 |
| 42 | 12 | 58,931 | 78,708 |
| 43 | 12 | 64,883 | 82,774 |
| 44 | 12 | 65,949 | 86,364 |
| 45 | 12 | 68,846 | 86,672 |
| 46 | 12 | 69,387 | 87,505 |
| 47 | 12 | 72,599 | 95,773 |
| 48 | 10 | 77,707 | 96,907 |
| 49 | 10 | 77,854 | 97,411 |
| 50 | 10 | 81,336 | 101,795 |
| 51 | 10 | 82,973 | 102,594 |
| 52 | 10 | 84,604 | 108,998 |
| 53 | 9 | 84,903 | 97,862 |
| 54 | 9 | 86,032 | 101,787 |
| 55 | 9 | 89,087 | 104,673 |
| 56 | 9 | 89,944 | 105,138 |
| 57 | 8 | 83,705 | 108,099 |
| 58 | 7 | 84,467 | 109,773 |
| 59 | 7 | 85,255 | 110,327 |
| 60 | 7 | 86,441 | 118,088 |
| 61 | 7 | 87,501 | 118,672 |
| 62 | 7 | 88,498 | 119,027 |
| 63 | 6 | 87,713 | 119,194 |
| 64 | 5 | 87,875 | 120,117 |
| 65 | 3 | 86,366 | 88,507 |
| 66 | 3 | 87,027 | 88,703 |
| 67 | 2 | 86,265 | 89,987 |
| 68 | 1 | 92,183 | 92,183 |
| 69 | 1 | 92,381 | 92,381 |
| 70 | 1 | 93,306 | 93,306 |
| 71 | 1 | 95,244 | 95,244 |
| 72 | 1 | 95,915 | 95,915 |
| 73 | 1 | 96,165 | 96,165 |

Peak context per run: max 120,117, P50 54,151, P95 108,998, mean 60,548 tokens.

## Governance overhead

- Governance tool calls (set_plan, update_plan, finish_task): 91 of 1409 tool calls (6.5%); set_plan 32, update_plan 35, finish_task 24.
- Rounds whose tool calls are all governance tools: 82 of 1023 rounds (8.0%).

## Redundant reads

- 129 of 333 read_file calls (38.7%) re-read a path already read successfully, with no successful write_file or replace_text to it in between.

## Tool failures

A failure is a call that was rejected, errored, or timed out: 124 of 1409 tool calls (8.8%). Failing test runs are observations, not failures: 16.

| tool | calls | failures | failure rate |
|---|---:|---:|---:|
| run_command | 427 | 88 | 20.6% |
| search_code | 260 | 12 | 4.6% |
| set_plan | 32 | 7 | 21.9% |
| read_file | 333 | 5 | 1.5% |
| finish_task | 24 | 5 | 20.8% |
| list_files | 55 | 4 | 7.3% |
| replace_text | 68 | 1 | 1.5% |
| run_tests | 66 | 1 | 1.5% |
| glob | 1 | 1 | 100.0% |
| write_file | 67 | 0 | 0.0% |
| update_plan | 35 | 0 | 0.0% |
| git_diff | 21 | 0 | 0.0% |
| git_status | 20 | 0 | 0.0% |

| error category | failures |
|---|---:|
| policy | 68 |
| schema | 24 |
| plan_gate | 24 |
| not_found | 3 |
| other | 3 |
| unknown_tool | 1 |
| timeout | 1 |

| failures | error (truncated) |
|---:|---|
| 15 | Call set_plan before modifying files |
| 15 | Path escapes repository root: / |
| 10 | arguments.contextLines must be <= 5 |
| 6 | arguments.steps[0] must be a string |
| 5 | Git mutation or network operation is disabled: git -c |
| 5 | Git mutation or network operation is disabled: git branch |
| 5 | Run a passing verification after the most recent file change |
| 4 | Repeated failure requires update_plan before continuing |
| 3 | Git mutation or network operation is disabled: git count-objects |
| 3 | Git mutation or network operation is disabled: git stash |

## Time

| component | time | share |
|---|---:|---:|
| model (Σ model_turn.latencyMs) | 3254.2s | 67.2% |
| tools (Σ tool_result.durationMs) | 916.0s | 18.9% |
| runtime overhead (run duration − model − tools, at least 0) | 675.5s | 13.9% |

Run durations total 4845.8s; 0 run(s) had model plus tool time above their duration, so their overhead was clamped to 0.

| tool | calls | total | P50 | P95 |
|---|---:|---:|---:|---:|
| run_command | 427 | 755.3s | 270ms | 789ms |
| run_tests | 66 | 150.7s | 1.3s | 4.7s |
| search_code | 260 | 4.7s | 15ms | 34ms |
| list_files | 55 | 3.8s | 44ms | 339ms |
| git_diff | 21 | 589ms | 24ms | 52ms |
| git_status | 20 | 543ms | 28ms | 37ms |
| read_file | 333 | 268ms | 1ms | 2ms |
| replace_text | 68 | 113ms | 1ms | 4ms |
| write_file | 67 | 97ms | 1ms | 3ms |
| update_plan | 35 | 12ms | 0ms | 1ms |
| finish_task | 24 | 8ms | 0ms | 1ms |
| set_plan | 32 | 5ms | 0ms | 1ms |
| glob | 1 | 1ms | 1ms | 1ms |

## Outcomes

| stop reason | runs |
|---|---:|
| explicit_finish | 19 |
| token_budget | 6 |

- Text-only turns: 0; nudges sent: 0, in 0 run(s).
- Turns that hit the output limit (finishReason length): 0; runs stopped by output_limit: 0.
- environment_failure events: 0.

P50 and P95 are nearest-rank percentiles.
