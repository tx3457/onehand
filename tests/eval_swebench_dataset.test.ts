import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildUserPrompt } from "../src/agent/prompt.js";
import { parseCommand } from "../src/tools/command.js";
import {
  AGENT_TASK_INSTRUCTIONS, agentTaskFor, imageFor, importPackageFor, loadExclusions, loadRecords, loadSplits, loadSwebenchSplit,
  normalizeRecord, officialTestTargets, SwebenchRecord, swebenchDataPath, TARGET_HINTS, taskHashFor, testCommandFor
} from "../eval/swebench/dataset.js";
import { cleanupTempDir, makeTempDir } from "./helpers.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map(cleanupTempDir)));

function diffFor(files: string[]): string {
  return files.map((file) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-a\n+b\n`).join("");
}

// Mirrors the official eval_script layout: setup, the test patch in a heredoc, then the marked test command.
function recordFor(repo: string, command: string, testFiles: string[], preamble: string[] = [], id = "owner__repo-1"): SwebenchRecord {
  const testPatch = diffFor(testFiles);
  return normalizeRecord({
    instance_id: id, repo, base_commit: "abc123", environment_setup_commit: "def456", version: "1.0",
    created_at: "2020-01-01T00:00:00Z", difficulty: "<15 min fix", eval_type: "pass_and_fail",
    image: `swebench/sweb.eval.x86_64.${id}:latest`, log_parser: "parse_log_pytest",
    patch: diffFor(["pkg/mod.py"]), test_patch: testPatch, problem_statement: "The widget breaks.", hints_text: "",
    eval_script: [
      "#!/bin/bash", "set -uxo pipefail", "source /opt/miniconda3/bin/activate", "conda activate testbed", "cd /testbed",
      ...preamble,
      "git apply -v - <<'EOF_114329324912'", testPatch, "export INSIDE_HEREDOC=1", "EOF_114329324912",
      ": '>>>>> Start Test Output'", command, ": '>>>>> End Test Output'", "git checkout abc123 tests"
    ].join("\n"),
    FAIL_TO_PASS: '["test_a"]',
    PASS_TO_PASS: []
  });
}

function tokens(command: string): string[] {
  const parsed = parseCommand(command);
  return [parsed.program, ...parsed.args];
}

describe("SWE-bench test commands", () => {
  it("splits a Django command into the base runner, the locale exports, and dotted labels", () => {
    const record = recordFor(
      "django/django",
      "./tests/runtests.py --verbosity 2 --settings=test_sqlite --parallel 1 auth_tests.test_forms forms_tests.widget_tests.test_checkboxinput",
      ["tests/auth_tests/test_forms.py", "tests/forms_tests/widget_tests/test_checkboxinput.py"],
      [
        "sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen && locale-gen",
        "export LANG=en_US.UTF-8", "export LANGUAGE=en_US:en", "export LC_ALL=en_US.UTF-8"
      ]
    );
    const command = testCommandFor(record);
    expect(command).toEqual({
      base: "./tests/runtests.py --verbosity 2 --settings=test_sqlite --parallel 1",
      env: { LANG: "en_US.UTF-8", LANGUAGE: "en_US:en", LC_ALL: "en_US.UTF-8" },
      targetHint: "Django test labels relative to tests/, e.g. <app_tests>.<test_module_name> or <app_tests>.<test_module_name>.<TestCaseClass>.<test_method>",
      family: "django"
    });
    expect(officialTestTargets(record)).toEqual(["auth_tests.test_forms", "forms_tests.widget_tests.test_checkboxinput"]);
    expect(tokens(command.base)).toEqual(["./tests/runtests.py", "--verbosity", "2", "--settings=test_sqlite", "--parallel", "1"]);
  });

  it("moves the sympy PYTHONWARNINGS prefix into the environment", () => {
    const record = recordFor(
      "sympy/sympy",
      "PYTHONWARNINGS='ignore::UserWarning,ignore::SyntaxWarning' bin/test -C --verbose sympy/printing/tests/test_python.py sympy/printing/tests/test_str.py",
      ["sympy/printing/tests/test_python.py", "sympy/printing/tests/test_str.py"]
    );
    expect(testCommandFor(record)).toEqual({
      base: "bin/test -C --verbose",
      env: { PYTHONWARNINGS: "ignore::UserWarning,ignore::SyntaxWarning" },
      targetHint: "test file paths, e.g. <path/to/test_file_name.py>",
      family: "sympy"
    });
    expect(officialTestTargets(record)).toEqual(["sympy/printing/tests/test_python.py", "sympy/printing/tests/test_str.py"]);
  });

  it("keeps tox's -- separator and strips sphinx targets, including non-Python test files", () => {
    const record = recordFor(
      "sphinx-doc/sphinx",
      "tox --current-env -epy39 -v -- tests/roots/test-toctree-index/conf.py tests/roots/test-toctree-index/index.rst tests/test_environment_toctree.py",
      ["tests/roots/test-toctree-index/conf.py", "tests/roots/test-toctree-index/index.rst", "tests/roots/test-toctree-index/text.txt", "tests/test_environment_toctree.py"]
    );
    const command = testCommandFor(record);
    expect(command).toMatchObject({ base: "tox --current-env -epy39 -v --", env: {}, family: "sphinx" });
    expect(command.targetHint).toBe("test file paths or pytest node ids, e.g. <path/to/test_file_name.py> or <path/to/test_file_name.py>::<test_function_name>");
    expect(tokens(command.base)).toEqual(["tox", "--current-env", "-epy39", "-v", "--"]);
    expect(officialTestTargets(record)).toHaveLength(3);
  });

  it("strips pytest targets after plain and option-heavy bases", () => {
    const multi = recordFor("pydata/xarray", "pytest -rA xarray/tests/test_dataarray.py xarray/tests/test_dataset.py",
      ["xarray/tests/test_dataarray.py", "xarray/tests/test_dataset.py"]);
    expect(testCommandFor(multi)).toMatchObject({ base: "pytest -rA", env: {}, family: "pytest" });
    expect(officialTestTargets(multi)).toEqual(["xarray/tests/test_dataarray.py", "xarray/tests/test_dataset.py"]);
    const classic = recordFor("astropy/astropy", "pytest -rA -vv -o console_output_style=classic --tb=no astropy/utils/tests/test_misc.py",
      ["astropy/utils/tests/test_misc.py"]);
    expect(testCommandFor(classic).base).toBe("pytest -rA -vv -o console_output_style=classic --tb=no");
    expect(tokens(testCommandFor(classic).base)).toEqual(["pytest", "-rA", "-vv", "-o", "console_output_style=classic", "--tb=no"]);
  });

  it("quotes base tokens so that parseCommand round-trips them", () => {
    const record = recordFor("psf/requests", `pytest -rA -k "not slow and it's" -o 'addopts=-p no:cacheprovider' test_requests.py`,
      ["test_requests.py"]);
    const { base } = testCommandFor(record);
    expect(base).toBe(`pytest -rA -k 'not slow and it'"'"'s' -o 'addopts=-p no:cacheprovider'`);
    expect(tokens(base)).toEqual(["pytest", "-rA", "-k", "not slow and it's", "-o", "addopts=-p no:cacheprovider"]);
  });

  it("fails closed when a target would stay in the base command or the command is unexpected", () => {
    const pytest = (command: string) => () => testCommandFor(recordFor("pydata/xarray", command, ["tests/test_a.py", "tests/test_b.py"]));
    expect(pytest("pytest -rA tests/test_a.py -x tests/test_b.py")).toThrow(/test targets remain in the base command: tests\/test_a.py/);
    expect(pytest("pytest -rA tests/unrelated.py tests/test_a.py")).toThrow(/test targets remain in the base command: tests\/unrelated.py/);
    expect(pytest("pytest -rA tests/unrelated.py")).toThrow(/ends with no test_patch target/);
    expect(pytest("python -m pytest tests/test_a.py")).toThrow(/unexpected pytest test program python/);
    expect(pytest("pytest -rA tests/test_a.py 2>&1")).toThrow(/Shell operator/);
    expect(pytest("pytest -rA $EXTRA tests/test_a.py")).toThrow(/shell expansion/);
    const django = recordFor("django/django", "./tests/runtests.py --parallel 1 auth_tests.test_forms --verbosity 2 auth_tests.test_views",
      ["tests/auth_tests/test_forms.py", "tests/auth_tests/test_views.py"]);
    expect(() => testCommandFor(django)).toThrow(/test targets remain in the base command: auth_tests.test_forms/);
    const twoLines = recordFor("pydata/xarray", "pytest -rA tests/test_a.py\npytest -rA tests/test_b.py", ["tests/test_a.py", "tests/test_b.py"]);
    expect(() => testCommandFor(twoLines)).toThrow(/expected one test command line, found 2/);
    const unterminated = normalizeRecord({
      ...recordFor("pydata/xarray", "pytest -rA tests/test_a.py", ["tests/test_a.py"]),
      eval_script: ["cat <<-'EOF'", "\texport HIDDEN=1", "\tEOF", ": '>>>>> Start Test Output'", "pytest -rA tests/test_a.py", ": '>>>>> End Test Output'"].join("\n")
    });
    expect(() => testCommandFor(unterminated)).toThrow(/unterminated heredoc \(EOF\)/);
  });
});

describe("SWE-bench records", () => {
  it("builds the agent task from the problem statement and fixed instructions only", () => {
    const record = normalizeRecord({
      ...recordFor("django/django", "./tests/runtests.py auth_tests.test_forms", ["tests/auth_tests/test_forms.py"]),
      problem_statement: "\nISSUE-MARKER: the form drops maxlength.\n",
      patch: "GOLD-PATCH-MARKER",
      test_patch: "TEST-PATCH-MARKER",
      hints_text: "HINTS-MARKER",
      eval_script: "EVAL-SCRIPT-MARKER",
      FAIL_TO_PASS: ["test_f2p_marker (auth_tests.test_forms.AuthenticationFormTest)"],
      PASS_TO_PASS: ["test_p2p_marker (auth_tests.test_forms.AuthenticationFormTest)"]
    });
    const task = agentTaskFor(record);
    expect(task).toBe(`${AGENT_TASK_INSTRUCTIONS}\n\n<issue>\nISSUE-MARKER: the form drops maxlength.\n</issue>\n`);
    expect(task).toContain("/testbed/.scratch/");
    for (const marker of ["GOLD-PATCH", "TEST-PATCH", "HINTS", "EVAL-SCRIPT", "f2p_marker", "p2p_marker", "AuthenticationFormTest"]) {
      expect(task).not.toContain(marker);
    }
  });

  it("normalizes test lists and hashes the full record independently of key order", () => {
    const record = recordFor("pydata/xarray", "pytest -rA tests/test_a.py", ["tests/test_a.py"]);
    expect(record.FAIL_TO_PASS).toEqual(["test_a"]);
    const reordered = normalizeRecord(Object.fromEntries(Object.entries({ ...record, FAIL_TO_PASS: JSON.stringify(["test_a"]) }).reverse()));
    expect(taskHashFor(reordered)).toBe(taskHashFor(record));
    expect(taskHashFor(record)).toMatch(/^[0-9a-f]{64}$/);
    for (const field of ["problem_statement", "test_patch", "version"] as const) {
      expect(taskHashFor({ ...record, [field]: `${record[field]}x` })).not.toBe(taskHashFor(record));
    }
    expect(taskHashFor({ ...record, PASS_TO_PASS: ["test_new"] })).not.toBe(taskHashFor(record));
    expect(() => normalizeRecord({ ...record, image: undefined })).toThrow(/image must be a string/);
    expect(() => normalizeRecord({ ...record, PASS_TO_PASS: '{"a": 1}' })).toThrow(/PASS_TO_PASS must be a list/);
  });

  it("maps each instance to Epoch's image by its verbatim instance id, or to the record's own image", () => {
    const record = { instance_id: "django__django-11790", image: "swebench/sweb.eval.x86_64.django_1776_django-11790:latest" };
    expect(imageFor(record, "epoch")).toBe("ghcr.io/epoch-research/swe-bench.eval.x86_64.django__django-11790:latest");
    expect(imageFor(record, "official")).toBe("swebench/sweb.eval.x86_64.django_1776_django-11790:latest");
    expect(imageFor({ instance_id: "sphinx-doc__sphinx-8551", image: "x" }, "epoch"))
      .toBe("ghcr.io/epoch-research/swe-bench.eval.x86_64.sphinx-doc__sphinx-8551:latest");
  });

  it("maps every evaluated repository to its import package", () => {
    expect(Object.fromEntries([
      "django/django", "sphinx-doc/sphinx", "sympy/sympy", "scikit-learn/scikit-learn", "matplotlib/matplotlib", "astropy/astropy",
      "pydata/xarray", "pytest-dev/pytest", "psf/requests", "pylint-dev/pylint", "mwaskom/seaborn", "pallets/flask"
    ].map((repo) => [repo, importPackageFor(repo)]))).toEqual({
      "django/django": "django", "sphinx-doc/sphinx": "sphinx", "sympy/sympy": "sympy", "scikit-learn/scikit-learn": "sklearn",
      "matplotlib/matplotlib": "matplotlib", "astropy/astropy": "astropy", "pydata/xarray": "xarray", "pytest-dev/pytest": "_pytest",
      "psf/requests": "requests", "pylint-dev/pylint": "pylint", "mwaskom/seaborn": "seaborn", "pallets/flask": "flask"
    });
    expect(() => importPackageFor("owner/unknown")).toThrow(/No import package/);
  });
});

describe("SWE-bench splits and exclusions", () => {
  it("keeps the frozen splits valid and the checked-in exclusions well formed", async () => {
    const splits = await loadSplits();
    expect(splits.dev.instanceIds).toHaveLength(50);
    expect(splits.holdout.instanceIds).toHaveLength(50);
    expect(splits.dev.instanceIds).toContain("django__django-11790");
    expect(Array.isArray(await loadExclusions())).toBe(true);
  });

  it("validates split ids against the data file and filters exclusions", async () => {
    const dir = await makeTempDir("onehand-swe-splits-");
    dirs.push(dir);
    const file = (name: string) => path.join(dir, name);
    const ids = { dev: ["a__a-1", "a__a-2", "a__a-3"], holdout: ["b__b-1"] };
    const writeSplits = (dev: string[], holdout: string[]) => writeFile(file("splits.json"), JSON.stringify({
      schemaVersion: 1, dataset: "SWE-bench/SWE-bench_Verified", datasetRevision: "rev1",
      dev: { name: "dev", instanceIds: dev }, holdout: { name: "holdout", instanceIds: holdout }
    }));
    const data = [...ids.dev, ...ids.holdout, "c__c-1"]
      .map((id) => JSON.stringify(recordFor("pydata/xarray", "pytest -rA tests/test_a.py", ["tests/test_a.py"], [], id))).join("\n") + "\n";
    await writeFile(file("data.jsonl"), data);
    await writeSplits(ids.dev, ids.holdout);
    const writeExclusions = (value: unknown) => writeFile(file("exclusions.json"), JSON.stringify(value));
    const files = { splits: file("splits.json"), data: file("data.jsonl"), exclusions: file("exclusions.json") };

    await writeExclusions([{ instanceId: "a__a-2", reason: "gold patch unresolved", evidence: "selfcheck run x" }]);
    const dev = await loadSwebenchSplit("dev", files);
    expect(dev).toMatchObject({
      split: "dev",
      datasetRevision: "rev1",
      dataFileSha256: createHash("sha256").update(data).digest("hex"),
      instanceIds: ["a__a-1", "a__a-3"],
      exclusions: [{ instanceId: "a__a-2", reason: "gold patch unresolved", evidence: "selfcheck run x" }]
    });
    expect(dev.records.size).toBe(5);
    expect(await loadSwebenchSplit("holdout", files)).toMatchObject({ instanceIds: ["b__b-1"], exclusions: [] });

    for (const [value, error] of [
      [[{ instanceId: "a__a-1", reason: "r" }], /evidence must be a non-empty string/],
      [[{ instanceId: "a__a-1", reason: "r", evidence: "e" }, { instanceId: "a__a-1", reason: "r", evidence: "e" }], /excluded twice/],
      [[{ instanceId: "c__c-1", reason: "r", evidence: "e" }], /outside dev and holdout/],
      [{ instanceId: "a__a-1" }, /expected a list/]
    ] as const) {
      await writeExclusions(value);
      await expect(loadSwebenchSplit("dev", files)).rejects.toThrow(error);
    }
    await writeExclusions([]);
    await writeSplits([...ids.dev, "z__z-9"], ids.holdout);
    await expect(loadSwebenchSplit("dev", files)).rejects.toThrow(/no record for split ids: z__z-9/);
    await writeSplits(ids.dev, [...ids.holdout, "a__a-1"]);
    await expect(loadSwebenchSplit("dev", files)).rejects.toThrow(/dev and holdout share a__a-1/);
    await writeSplits([...ids.dev, "a__a-1"], ids.holdout);
    await expect(loadSwebenchSplit("dev", files)).rejects.toThrow(/lists an instance id twice/);
  });
});

// Plain words that locate nothing. Any other token of a hint, placeholder names included, must occur in no
// dev or holdout instance's hidden tests.
const GENERIC_WORDS = new Set(["test", "tests", "path", "paths", "file", "pytest", "Django"]);
const DATA_FILE = swebenchDataPath();

describe.skipIf(!existsSync(DATA_FILE))("SWE-bench prompt leak check over every dev and holdout instance", () => {
  let records: SwebenchRecord[] = [];

  beforeAll(async () => {
    const [splits, { records: all }] = await Promise.all([loadSplits(), loadRecords(DATA_FILE)]);
    records = [...splits.dev.instanceIds, ...splits.holdout.instanceIds].map((id) => all.get(id)!);
  }, 60_000);

  it("keeps every target hint to placeholders that name nothing in any instance's hidden tests", () => {
    expect(records).toHaveLength(100);
    expect(TARGET_HINTS.length).toBeGreaterThanOrEqual(3);
    for (const hint of TARGET_HINTS) {
      // Anything shaped like an identifier (an underscore, a digit, an inner capital) sits inside a <placeholder>.
      const literal = hint.replace(/<[^<>\s]+>/g, " ");
      expect((literal.match(/[A-Za-z0-9_]+/g) ?? []).filter((token) => /[_0-9]|[a-z][A-Z]/.test(token)), hint).toEqual([]);
      const tokens = [...new Set(hint.match(/[A-Za-z0-9_]+/g) ?? [])].filter((token) => token.length >= 4 && !GENERIC_WORDS.has(token));
      expect(tokens.length, hint).toBeGreaterThan(0);
      for (const record of records) {
        const hidden = [record.test_patch, ...record.FAIL_TO_PASS, ...record.PASS_TO_PASS].join("\n");
        for (const token of tokens) {
          expect(new RegExp(`(?<![A-Za-z0-9_])${token}(?![A-Za-z0-9_])`).test(hidden), `${record.instance_id}: "${token}" from "${hint}"`).toBe(false);
        }
      }
    }
  });

  it("shows the agent no FAIL_TO_PASS test name in its task or its target hint", () => {
    for (const record of records) {
      const command = testCommandFor(record);
      const prompt = buildUserPrompt({ task: agentTaskFor(record), repo: "/testbed", testCommand: command.base, testTargetHint: command.targetHint });
      expect(prompt).toContain(`Test targets: ${command.targetHint}`);
      for (const test of record.FAIL_TO_PASS) {
        // Django names a test "method (module.Class)"; its label is module.Class.method.
        const django = /^(\w+) \(([\w.]+)\)$/.exec(test);
        for (const name of [test, ...(django ? [`${django[2]}.${django[1]}`] : [])]) {
          expect(prompt.includes(name), `${record.instance_id}: ${name}`).toBe(false);
        }
      }
    }
  });
});
