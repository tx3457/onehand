"""Post-hoc failure analysis of a SWE-bench evaluation window.

Reads the evaluation's results.jsonl files and, for localization only, the
file paths touched by each instance's reference patch. The reference patches
themselves are never printed or written out; only aggregate counts are.

Usage:
  python eval/swebench/failure_analysis.py --dataset <verified.jsonl> \
      --results mini=<dir> --results holdout=<dir> [--json out.json]
"""

from __future__ import annotations

import argparse
import collections
import json
import re
import statistics
from pathlib import Path

WRITE_TOOLS = {"write_file", "replace_text"}
KNOWN_TOOLS = {
    "list_files", "read_file", "search_code", "run_command", "run_tests", "write_file",
    "replace_text", "set_plan", "update_plan", "git_status", "git_diff", "finish_task",
}
DIFF_HEADER = re.compile(r"^diff --git a/(\S+) b/(\S+)$", re.MULTILINE)


def reference_files(dataset: Path, ids: set[str]) -> dict[str, set[str]]:
    files: dict[str, set[str]] = {}
    with dataset.open() as fh:
        for line in fh:
            record = json.loads(line)
            if record["instance_id"] in ids:
                files[record["instance_id"]] = {m.group(2) for m in DIFF_HEADER.finditer(record["patch"])}
    return files


def normalize(path: str) -> str:
    return path.removeprefix("/testbed/").removeprefix("./")


def trace_facts(row: dict) -> dict:
    tools = [e["data"] for e in row["traceEvents"] if e["event"] == "tool_result"]
    reads = {normalize(t["arguments"].get("path", "")) for t in tools if t["name"] == "read_file"}
    patched = {normalize(p) for p in row.get("patchFiles") or []}
    write_rounds = [
        t["round"] for t in tools
        if t["name"] in WRITE_TOOLS and t.get("ok") and normalize(t["arguments"].get("path", "")) in patched
    ]
    unknown = [t["name"] for t in tools if t["name"] not in KNOWN_TOOLS]
    return {
        "reads": reads,
        "last_patch_write_round": max(write_rounds) if write_rounds else None,
        "unknown_tools": unknown,
    }


def classify(row: dict, gold: set[str]) -> str:
    if row["resolved"]:
        return "resolved"
    if row["stopReason"] == "runtime_error":
        return "runtime_error"
    exhausted = row["agentStatus"] == "budget_exhausted"
    if row["emptyPatch"]:
        return "budget_no_patch" if exhausted else "finished_no_patch"
    touched = {normalize(p) for p in row.get("patchFiles") or []}
    prefix = "budget" if exhausted else "claimed_success"
    if touched & gold:
        return f"{prefix}_right_file"
    if all(is_test_path(p) for p in touched):
        return f"{prefix}_test_files_only"
    return f"{prefix}_wrong_file"


def is_test_path(path: str) -> bool:
    parts = path.split("/")
    name = parts[-1]
    return "tests" in parts[:-1] or "testing" in parts[:-1] or name.startswith("test_") or name.endswith(
        "_test.py") or name == "conftest.py"


def pct(n: int, d: int) -> str:
    return f"{n}/{d} ({100 * n / d:.1f}%)" if d else "0/0"


def analyze(name: str, rows: list[dict], gold: dict[str, set[str]]) -> dict:
    out: dict = {"dataset": name, "runs": len(rows)}
    classes = collections.Counter()
    by_arm = collections.defaultdict(collections.Counter)
    by_difficulty = collections.defaultdict(lambda: [0, 0, 0])  # runs, resolved, budget_exhausted
    unresolved_tests = collections.Counter()
    exhausted_rounds, exhausted_resolved = [], 0
    exhausted_after_write = []
    exhausted_resolved_verified = exhausted_resolved_plan_open = 0
    runtime_errors = []
    unknown_tool_calls = 0
    read_but_missed = 0
    wrong_file_runs = 0
    per_task = collections.defaultdict(lambda: [0, 0])
    for row in rows:
        g = gold[row["taskId"]]
        cls = classify(row, g)
        facts = trace_facts(row)
        classes[cls] += 1
        by_arm[row["variant"]][cls] += 1
        by_arm[row["variant"]]["_budget_exhausted"] += row["agentStatus"] == "budget_exhausted"
        diff = by_difficulty[row.get("difficulty") or "unknown"]
        diff[0] += 1
        diff[1] += bool(row["resolved"])
        diff[2] += row["agentStatus"] == "budget_exhausted"
        per_task[row["taskId"]][0] += 1
        per_task[row["taskId"]][1] += bool(row["resolved"])
        unknown_tool_calls += len(facts["unknown_tools"])
        if row["agentStatus"] == "budget_exhausted":
            exhausted_rounds.append(row["modelRounds"])
            exhausted_resolved += bool(row["resolved"])
            if row["resolved"]:
                exhausted_resolved_verified += bool(row["agentVerificationPassed"])
                steps = row["traceEvents"][-1]["data"].get("plan", {}).get("steps", [])
                exhausted_resolved_plan_open += not steps or any(s["status"] != "completed" for s in steps)
                if facts["last_patch_write_round"] is not None:
                    exhausted_after_write.append(row["modelRounds"] - facts["last_patch_write_round"])
        if cls == "runtime_error":
            runtime_errors.append((row.get("finalMessage") or "").splitlines()[0][:200])
        if cls.endswith(("wrong_file", "test_files_only")):
            wrong_file_runs += 1
            read_but_missed += bool(facts["reads"] & g)
        if not row["resolved"] and row["gradingOutcome"] == "scored":
            f2p_fail = (row.get("f2p") or {}).get("failure", 0) > 0
            p2p = row.get("p2p") or {}
            p2p_state = "p2p_fail" if p2p.get("failure", 0) > 0 else "p2p_pass" if p2p.get("success", 0) > 0 else "p2p_none"
            unresolved_tests[("f2p_fail" if f2p_fail else "f2p_pass") + "+" + p2p_state] += 1
    out["classes"] = dict(classes)
    out["by_arm"] = {arm: dict(c) for arm, c in by_arm.items()}
    out["by_difficulty"] = {k: {"runs": v[0], "resolved": v[1], "budget_exhausted": v[2]} for k, v in by_difficulty.items()}
    out["unresolved_scored_tests"] = dict(unresolved_tests)
    out["budget_exhausted"] = {
        "runs": len(exhausted_rounds),
        "median_rounds": statistics.median(exhausted_rounds) if exhausted_rounds else None,
        "resolved_anyway": exhausted_resolved,
        "resolved_anyway_verification_passed": exhausted_resolved_verified,
        "resolved_anyway_plan_open": exhausted_resolved_plan_open,
        "median_rounds_after_last_patch_write_when_resolved": statistics.median(exhausted_after_write) if exhausted_after_write else None,
        "stop_reasons": dict(collections.Counter(r["stopReason"] for r in rows if r["agentStatus"] == "budget_exhausted")),
    }
    out["runtime_errors"] = runtime_errors
    out["wrong_file"] = {"runs": wrong_file_runs, "read_a_reference_file": read_but_missed}
    out["unknown_tool_calls"] = unknown_tool_calls
    counts = collections.Counter()
    for runs, solved in per_task.values():
        counts["always" if solved == runs else "never" if solved == 0 else "sometimes"] += 1
    out["tasks"] = dict(counts)
    return out


def report(result: dict) -> None:
    n = result["runs"]
    c = result["classes"]
    print(f"\n## {result['dataset']} ({n} runs)")
    for key in sorted(c, key=lambda k: -c[k]):
        print(f"- {key}: {pct(c[key], n)}")
    for arm, cc in result["by_arm"].items():
        runs = sum(v for k, v in cc.items() if not k.startswith("_"))
        print(f"- arm {arm}: resolved {pct(cc.get('resolved', 0), runs)}, budget exhausted {pct(cc['_budget_exhausted'], runs)}")
    print("- by difficulty:", json.dumps(result["by_difficulty"], ensure_ascii=False))
    print("- unresolved scored runs by test outcome:", result["unresolved_scored_tests"])
    print("- budget exhausted:", result["budget_exhausted"])
    print("- wrong-file runs:", result["wrong_file"])
    print("- tasks resolved always/sometimes/never:", result["tasks"])
    print("- calls to tools that do not exist:", result["unknown_tool_calls"])
    print("- runtime errors:", result["runtime_errors"])


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--results", action="append", required=True, help="name=results_dir")
    parser.add_argument("--json", type=Path)
    args = parser.parse_args()
    loaded = {}
    for spec in args.results:
        name, directory = spec.split("=", 1)
        with (Path(directory) / "results.jsonl").open() as fh:
            loaded[name] = [json.loads(line) for line in fh]
    ids = {row["taskId"] for rows in loaded.values() for row in rows}
    gold = reference_files(args.dataset, ids)
    results = [analyze(name, rows, gold) for name, rows in loaded.items()]
    for result in results:
        report(result)
    if args.json:
        args.json.write_text(json.dumps(results, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
