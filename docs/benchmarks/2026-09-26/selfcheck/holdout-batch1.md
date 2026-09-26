# SWE-bench self-check

- Split: holdout; gold gradings per instance: 2; run: selfcheck-2026-09-26T02-44-53-458Z-dedb27; images: epoch
- Dataset revision: 78f471bf655a3137b2e8a75af1501690ec009ec3; data file sha256: faf8fab974e851c5065a84d2a46e6c77ab99143d2f3d0a9922c81105514403dd
- Harness: swebench 5.0.2; started 2026-09-26T02:44:53.458Z
- Result: 26 pass, 1 fail, 0 error, of 27

Gold: the gold patch, extracted like an agent patch, must be resolved every time. No-op: a comment appended to a
source file must stay unresolved. Tests: the agent's run_tests in the container with the official targets, after the
test patch alone (expected to fail) and after the gold patch too (expected to pass).

| Instance | Gold resolved | No-op | Tests before gold | Tests after gold | Status |
| --- | --- | --- | --- | --- | --- |
| astropy__astropy-13453 | 2/2 | unresolved | exit 1, 1.4s | exit 0, 1.4s | pass |
| astropy__astropy-14365 | 2/2 | unresolved | exit 1, 1.3s | exit 0, 1.3s | pass |
| astropy__astropy-7166 | 2/2 | unresolved | exit 1, 0.9s | exit 0, 0.9s | pass |
| django__django-10880 | 2/2 | unresolved | exit 1, 0.8s | exit 0, 0.7s | pass |
| django__django-11276 | 2/2 | unresolved | exit 1, 5.0s | exit 0, 5.1s | pass |
| django__django-11532 | 2/2 | unresolved | exit 1, 0.8s | exit 0, 1.8s | pass |
| django__django-13212 | 2/2 | unresolved | exit 1, 0.7s | exit 0, 0.7s | pass |
| django__django-13315 | 2/2 | unresolved | exit 1, 1.1s | exit 0, 1.1s | pass |
| django__django-13410 | 2/2 | unresolved | exit 1, 0.6s | exit 0, 0.6s | pass |
| django__django-13569 | 2/2 | unresolved | exit 1, 0.8s | exit 0, 0.8s | pass |
| django__django-13837 | 2/2 | unresolved | exit 1, 1.0s | exit 0, 1.0s | pass |
| django__django-14170 | 2/2 | unresolved | exit 1, 0.9s | exit 0, 0.9s | pass |
| django__django-14493 | 2/2 | unresolved | exit 1, 1.2s | exit 0, 1.3s | pass |
| django__django-14792 | 2/2 | unresolved | exit 1, 0.6s | exit 0, 0.6s | pass |
| django__django-15104 | 2/2 | unresolved | exit 1, 0.7s | exit 0, 0.7s | pass |
| django__django-15380 | 2/2 | unresolved | exit 1, 0.7s | exit 0, 0.7s | pass |
| django__django-15563 | 2/2 | unresolved | exit 1, 0.8s | exit 0, 0.8s | pass |
| django__django-15695 | 2/2 | unresolved | exit 1, 1.5s | exit 0, 1.5s | pass |
| django__django-15731 | 2/2 | unresolved | exit 1, 0.7s | exit 0, 0.7s | pass |
| django__django-16082 | 2/2 | unresolved | exit 1, 0.9s | exit 0, 0.9s | pass |
| django__django-16139 | 2/2 | unresolved | exit 1, 0.9s | exit 0, 0.9s | pass |
| django__django-16263 | 2/2 | unresolved | exit 1, 0.8s | exit 0, 0.8s | pass |
| django__django-16612 | 2/2 | unresolved | exit 1, 16.4s | exit 0, 16.3s | pass |
| django__django-16661 | 2/2 | unresolved | exit 1, 0.8s | exit 0, 0.8s | pass |
| django__django-16901 | 2/2 | unresolved | exit 1, 0.7s | exit 0, 0.7s | pass |
| matplotlib__matplotlib-13989 | 2/2 | unresolved | exit 1, 34.6s | exit 1, 34.0s | pass |
| psf__requests-2317 | 0/2 | unresolved | not run | not run | fail |

## Findings

- matplotlib__matplotlib-13989 (warning): tests did not pass after the gold patch (exit 1)
- psf__requests-2317 (failure): gold patch unresolved on 2 of 2 gradings
- psf__requests-2317 (error): adapter: Sanity check failed: import requests resolved to "/opt/miniconda3/envs/testbed/lib/python3.9/site-packages/requests/__init__.py" (exit 0: )

## Suggested exclusions

- psf__requests-2317: gold patch unresolved on 2 of 2 gradings
