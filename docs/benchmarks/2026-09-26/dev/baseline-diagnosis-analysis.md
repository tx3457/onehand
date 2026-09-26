# Trace diagnostics: `baseline` on swebench

> This is a DIAGNOSTIC of one configuration, not a comparative claim: it shows where tokens and time go in these runs, not that any change would help. Use eval:compare on paired A/B runs for that.

- Results: `eval/results/swebench-baseline-dev-r1`; model `deepseek-flash`
- Runs analyzed: 50; rows excluded: none

## Bottleneck ranking

| rank | source of cumulative input tokens | share |
|---:|---|---:|
| 1 | tool:read_file | 44.7% |
| 2 | assistant_output | 25.4% |
| 3 | tool:search_code | 11.4% |
| 4 | tool:run_tests | 4.5% |
| 5 | tool:run_command | 4.2% |

| rank | time consumer | time | share |
|---:|---|---:|---:|
| 1 | model | 6936.1s | 75.2% |
| 2 | runtime_overhead | 1264.7s | 13.7% |
| 3 | tool:run_tests | 884.3s | 9.6% |
| 4 | tool:run_command | 117.0s | 1.3% |
| 5 | tool:search_code | 13.4s | 0.1% |

## Context growth

Each round re-sends the whole prompt, so a token added at round j of R counts R − j + 1 times toward cumulative input.

| source | tokens added | cumulative input tokens | share | observations | tokens per observation |
|---|---:|---:|---:|---:|---:|
| tool:read_file | 1,610,575 | 42,878,429 | 44.7% | 455 | 3,540 |
| assistant_output | 1,276,141 | 24,410,761 | 25.4% | - | - |
| tool:search_code | 388,710 | 10,890,590 | 11.4% | 763 | 509 |
| tool:run_tests | 532,069 | 4,304,226 | 4.5% | 130 | 4,093 |
| tool:run_command | 201,624 | 4,051,253 | 4.2% | 526 | 383 |
| initial_prompt | 103,785 | 4,029,845 | 4.2% | - | - |
| tool:list_files | 129,903 | 3,629,316 | 3.8% | 178 | 730 |
| tool:update_plan | 84,200 | 1,022,115 | 1.1% | 230 | 366 |
| tool:set_plan | 12,541 | 416,646 | 0.4% | 60 | 209 |
| tool:write_file | 7,959 | 136,244 | 0.1% | 176 | 45 |
| tool:git_diff | 12,743 | 78,494 | 0.1% | 45 | 283 |
| tool:replace_text | 6,120 | 70,442 | 0.1% | 132 | 46 |
| tool:git_status | 2,612 | 24,679 | 0.0% | 51 | 51 |
| tool:finish_task | 417 | 1,134 | 0.0% | 10 | 42 |
| other | 30 | 390 | 0.0% | - | - |

Cumulative input over the traced rounds: 95,944,564 tokens; the rows report 95,944,564.

- Round k's growth goes first to round k−1's output tokens (reasoning included), then to round k−1's tool observations in proportion to their bytes; what neither explains, including nudges, goes to other, which is negative when a prompt shrank.
- Tokens per observation divide a tool's added tokens by its observations that a later round re-sent; the last round's observations are never re-sent.

## Prompt size by round

| round | runs | P50 prompt tokens | P95 prompt tokens |
|---:|---:|---:|---:|
| 1 | 50 | 1,950 | 2,793 |
| 2 | 50 | 3,268 | 11,407 |
| 3 | 50 | 6,211 | 18,866 |
| 4 | 50 | 9,141 | 26,140 |
| 5 | 50 | 11,824 | 28,030 |
| 6 | 50 | 14,042 | 31,349 |
| 7 | 50 | 16,169 | 34,048 |
| 8 | 50 | 19,216 | 38,432 |
| 9 | 50 | 21,627 | 38,685 |
| 10 | 50 | 23,719 | 42,449 |
| 11 | 50 | 26,982 | 47,796 |
| 12 | 50 | 28,252 | 67,166 |
| 13 | 49 | 31,401 | 67,383 |
| 14 | 49 | 33,377 | 69,014 |
| 15 | 49 | 35,631 | 78,475 |
| 16 | 49 | 38,001 | 86,479 |
| 17 | 49 | 40,021 | 87,488 |
| 18 | 49 | 40,363 | 89,646 |
| 19 | 49 | 40,582 | 90,680 |
| 20 | 47 | 45,444 | 91,863 |
| 21 | 46 | 45,746 | 93,953 |
| 22 | 46 | 46,732 | 95,748 |
| 23 | 44 | 49,628 | 87,667 |
| 24 | 44 | 52,472 | 96,306 |
| 25 | 42 | 53,398 | 96,533 |
| 26 | 40 | 55,640 | 96,899 |
| 27 | 39 | 59,811 | 103,669 |
| 28 | 38 | 59,985 | 104,290 |
| 29 | 36 | 67,662 | 111,868 |
| 30 | 36 | 76,000 | 114,205 |
| 31 | 36 | 77,830 | 114,448 |
| 32 | 35 | 82,364 | 114,728 |
| 33 | 34 | 82,882 | 120,319 |
| 34 | 32 | 83,613 | 121,800 |
| 35 | 28 | 84,666 | 123,311 |
| 36 | 27 | 85,053 | 124,650 |
| 37 | 26 | 80,028 | 119,261 |
| 38 | 24 | 89,466 | 113,867 |
| 39 | 24 | 92,954 | 119,929 |
| 40 | 22 | 95,112 | 121,816 |
| 41 | 22 | 95,635 | 126,117 |
| 42 | 20 | 97,733 | 128,734 |
| 43 | 19 | 99,036 | 136,250 |
| 44 | 17 | 100,801 | 139,018 |
| 45 | 15 | 97,411 | 138,203 |
| 46 | 14 | 92,960 | 141,527 |
| 47 | 12 | 89,968 | 142,031 |
| 48 | 12 | 90,219 | 143,863 |
| 49 | 12 | 99,559 | 145,472 |
| 50 | 11 | 101,593 | 158,677 |
| 51 | 9 | 93,678 | 112,190 |
| 52 | 9 | 93,827 | 113,041 |
| 53 | 8 | 93,847 | 105,972 |
| 54 | 6 | 94,600 | 106,700 |
| 55 | 6 | 96,430 | 108,693 |
| 56 | 5 | 99,325 | 108,912 |
| 57 | 5 | 100,007 | 109,605 |
| 58 | 4 | 96,394 | 110,891 |
| 59 | 3 | 97,265 | 111,764 |
| 60 | 3 | 97,910 | 112,384 |
| 61 | 2 | 97,885 | 112,603 |
| 62 | 2 | 98,242 | 114,181 |

Peak context per run: max 158,677, P50 98,242, P95 138,647, mean 87,389 tokens.

## Governance overhead

- Governance tool calls (set_plan, update_plan, finish_task): 330 of 2786 tool calls (11.8%); set_plan 60, update_plan 231, finish_task 39.
- Rounds whose tool calls are all governance tools: 188 of 1905 rounds (9.9%).

## Redundant reads

- 82 of 455 read_file calls (18.0%) re-read a path already read successfully, with no successful write_file or replace_text to it in between.

## Tool failures

A failure is a call that was rejected, errored, or timed out: 328 of 2786 tool calls (11.8%). Failing test runs are observations, not failures: 37.

| tool | calls | failures | failure rate |
|---|---:|---:|---:|
| run_command | 526 | 260 | 49.4% |
| list_files | 178 | 30 | 16.9% |
| finish_task | 39 | 10 | 25.6% |
| set_plan | 60 | 9 | 15.0% |
| write_file | 176 | 5 | 2.8% |
| replace_text | 132 | 4 | 3.0% |
| read_file | 455 | 3 | 0.7% |
| update_plan | 231 | 3 | 1.3% |
| search_code | 763 | 2 | 0.3% |
| run_tests | 130 | 2 | 1.5% |
| git_status | 51 | 0 | 0.0% |
| git_diff | 45 | 0 | 0.0% |

| error category | failures |
|---|---:|
| policy | 200 |
| plan_gate | 94 |
| not_found | 20 |
| schema | 13 |
| other | 1 |

| failures | error (truncated) |
|---:|---|
| 52 | Use the dedicated repository tool instead of run_command: git |
| 43 | Call set_plan before modifying files |
| 41 | Repeated failure requires update_plan before continuing |
| 37 | Inline code execution is disabled for model tools: python -c |
| 32 | Use the dedicated repository tool instead of run_command: sed |
| 10 | Inline code execution is disabled for model tools: python3 -c |
| 9 | arguments.steps[0] must be a string |
| 9 | Run a passing verification after the most recent file change |
| 9 | Use the dedicated repository tool instead of run_command: find |
| 9 | Use the dedicated repository tool instead of run_command: grep |

## Time

| component | time | share |
|---|---:|---:|
| model (Σ model_turn.latencyMs) | 6936.1s | 75.2% |
| tools (Σ tool_result.durationMs) | 1019.9s | 11.1% |
| runtime overhead (run duration − model − tools, at least 0) | 1264.7s | 13.7% |

Run durations total 9220.7s; 0 run(s) had model plus tool time above their duration, so their overhead was clamped to 0.

| tool | calls | total | P50 | P95 |
|---|---:|---:|---:|---:|
| run_tests | 130 | 884.3s | 1.1s | 6.3s |
| run_command | 526 | 117.0s | 195ms | 564ms |
| search_code | 763 | 13.4s | 17ms | 31ms |
| list_files | 178 | 2.0s | 1ms | 79ms |
| git_status | 51 | 1.4s | 25ms | 46ms |
| git_diff | 45 | 1.1s | 20ms | 43ms |
| read_file | 455 | 293ms | 1ms | 2ms |
| replace_text | 132 | 184ms | 1ms | 3ms |
| write_file | 176 | 184ms | 1ms | 2ms |
| update_plan | 231 | 20ms | 0ms | 1ms |
| set_plan | 60 | 13ms | 0ms | 1ms |
| finish_task | 39 | 10ms | 0ms | 1ms |

## Outcomes

| stop reason | runs |
|---|---:|
| explicit_finish | 29 |
| token_budget | 21 |

- Text-only turns: 1; nudges sent: 1, in 1 run(s).
- Turns that hit the output limit (finishReason length): 1; runs stopped by output_limit: 0.
- environment_failure events: 0.

P50 and P95 are nearest-rank percentiles.
