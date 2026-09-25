"""Freeze the SWE-bench Verified splits used by OneHand evaluations.

Run with the swebench virtualenv (outside this repository):
    ~/.onehand/swebench/.venv/bin/python eval/swebench/prepare_dataset.py

Writes:
  - eval/swebench/splits.json: dataset revision, the dev split (Verified Mini ids),
    and a stratified holdout sampled once from the remaining Verified ids.
  - ~/.onehand/swebench/data/verified.jsonl: full instance records, used only by the
    harness. It holds gold patches and test lists, so it never enters agent context
    and never enters this repository.
"""

import collections
import json
import random
from pathlib import Path

from datasets import load_dataset
from huggingface_hub import HfApi

VERIFIED = "SWE-bench/SWE-bench_Verified"
MINI = "MariusHobbhahn/swe-bench-verified-mini"
HOLDOUT_SIZE = 50
SEED = 20260925

repo_root = Path(__file__).resolve().parents[2]
splits_path = repo_root / "eval" / "swebench" / "splits.json"
data_dir = Path.home() / ".onehand" / "swebench" / "data"


def largest_remainder(counts: dict[str, int], total: int) -> dict[str, int]:
    population = sum(counts.values())
    quotas = {repo: total * n / population for repo, n in counts.items()}
    alloc = {repo: int(q) for repo, q in quotas.items()}
    by_remainder = sorted(counts, key=lambda repo: (-(quotas[repo] - alloc[repo]), repo))
    for repo in by_remainder[: total - sum(alloc.values())]:
        alloc[repo] += 1
    return alloc


def main() -> None:
    api = HfApi()
    verified_rev = api.dataset_info(VERIFIED).sha
    mini_rev = api.dataset_info(MINI).sha
    verified = load_dataset(VERIFIED, split="test", revision=verified_rev)
    mini_ids = sorted(r["instance_id"] for r in load_dataset(MINI, split="test", revision=mini_rev))
    by_id = {r["instance_id"]: r for r in verified}
    missing = [i for i in mini_ids if i not in by_id]
    if missing:
        raise SystemExit(f"Mini ids missing from {VERIFIED}: {missing}")

    remaining: dict[str, list[str]] = collections.defaultdict(list)
    for iid, row in by_id.items():
        if iid not in set(mini_ids):
            remaining[row["repo"]].append(iid)
    alloc = largest_remainder({repo: len(ids) for repo, ids in remaining.items()}, HOLDOUT_SIZE)
    rng = random.Random(SEED)
    holdout: list[str] = []
    for repo in sorted(remaining):
        holdout.extend(rng.sample(sorted(remaining[repo]), alloc[repo]))
    holdout.sort()

    data_dir.mkdir(parents=True, exist_ok=True)
    with (data_dir / "verified.jsonl").open("w", encoding="utf8") as out:
        for iid in sorted(by_id):
            out.write(json.dumps(by_id[iid]) + "\n")

    splits = {
        "schemaVersion": 1,
        "dataset": VERIFIED,
        "datasetRevision": verified_rev,
        "dev": {"name": "verified-mini", "source": MINI, "sourceRevision": mini_rev, "instanceIds": mini_ids},
        "holdout": {
            "name": "verified-holdout-50",
            "method": f"stratified by repo (largest remainder), random.Random({SEED}).sample per repo, excluding dev ids",
            "seed": SEED,
            "allocation": dict(sorted(alloc.items())),
            "instanceIds": holdout,
        },
    }
    splits_path.write_text(json.dumps(splits, indent=2) + "\n", encoding="utf8")
    print(f"verified={len(by_id)} rev={verified_rev[:12]} dev={len(mini_ids)} holdout={len(holdout)}")
    print("dev repos:", dict(collections.Counter(by_id[i]["repo"] for i in mini_ids)))
    print("holdout allocation:", dict(sorted(alloc.items())))


if __name__ == "__main__":
    main()
