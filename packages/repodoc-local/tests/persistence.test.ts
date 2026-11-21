import fs from "fs";
import path from "path";
import os from "os";
import { saveRun, loadRun, listRuns, getRunsDir } from "../src/persistence.js";
import { AnalysisResult, SavedRun } from "../src/types.js";

describe("Persistence (.repodoc/runs)", () => {
  let tmpRepo: string;

  beforeEach(() => {
    tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "repodoc-persistence-"));
  });

  afterEach(() => {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  });

  it("saves a run to .repodoc/runs/<run-id>.json with findings, diffs, explanations, model", () => {
    const mockResult: AnalysisResult = {
      repoPath: tmpRepo,
      model: "gemma-4-e4b",
      durationMs: 120,
      guardrailFindings: [
        {
          ruleId: "no_eval",
          ruleName: "No eval() Usage",
          severity: "warning",
          file: "src/calc.js",
          line: 12,
          snippet: "eval(expr)",
        },
      ],
      bugs: [
        {
          id: "bug-1",
          file: "src/calc.js",
          line: 12,
          description: "Use of eval() introduces arbitrary code execution risks.",
          confidence: 0.95,
          explanation: {
            rule_id: "no_eval",
            what: "eval() executes arbitrary code strings.",
            why: "Replacing eval with a safe expression parser prevents code injection.",
            risk: {
              level: "low",
              check: "Verify all mathematical operators remain supported.",
            },
          },
        },
      ],
      patches: [
        {
          bugId: "bug-1",
          file: "src/calc.js",
          diff: "--- a/src/calc.js\n+++ b/src/calc.js\n@@ -12,1 +12,1 @@\n-eval(expr);\n+safeEval(expr);",
          applied: false,
          explanation: {
            rule_id: "no_eval",
            what: "eval() executes arbitrary code strings.",
            why: "Replacing eval with a safe expression parser prevents code injection.",
            risk: {
              level: "low",
              check: "Verify all mathematical operators remain supported.",
            },
          },
        },
      ],
    };

    const runId = saveRun(tmpRepo, mockResult, 5);
    expect(runId).toBeDefined();

    const runsDir = getRunsDir(tmpRepo);
    const runFile = path.join(runsDir, `${runId}.json`);
    expect(fs.existsSync(runFile)).toBe(true);

    const saved: SavedRun = JSON.parse(fs.readFileSync(runFile, "utf8"));
    expect(saved.id).toBe(runId);
    expect(saved.model).toBe("gemma-4-e4b");
    expect(saved.filesScanned).toBe(5);
    expect(saved.guardrailFindings.length).toBe(1);
    expect(saved.bugs[0].explanation?.what).toContain("eval()");
    expect(saved.patches[0].diff).toContain("-eval(expr);");
    expect(saved.patches[0].explanation?.why).toContain("safe expression parser");
  });

  it("lists runs sorted newest first and loads the latest run by default", async () => {
    const mockResult1: AnalysisResult = {
      repoPath: tmpRepo,
      model: "gemma-4-e4b",
      durationMs: 50,
      guardrailFindings: [],
      bugs: [],
      patches: [],
      runId: "run-first",
    };

    const mockResult2: AnalysisResult = {
      repoPath: tmpRepo,
      model: "gemma-4-e2b",
      durationMs: 70,
      guardrailFindings: [],
      bugs: [],
      patches: [],
      runId: "run-second",
    };

    saveRun(tmpRepo, mockResult1, 2);
    // ensure distinct mtime
    await new Promise((r) => setTimeout(r, 20));
    saveRun(tmpRepo, mockResult2, 4);

    const runs = listRuns(tmpRepo);
    expect(runs).toContain("run-first");
    expect(runs).toContain("run-second");
    expect(runs[0]).toBe("run-second"); // newest first

    // Load latest (no ID supplied)
    const latest = loadRun(tmpRepo);
    expect(latest.id).toBe("run-second");
    expect(latest.model).toBe("gemma-4-e2b");

    // Load specific run
    const first = loadRun(tmpRepo, "run-first");
    expect(first.id).toBe("run-first");
  });

  it("throws a clear error when loading from a repo with no runs", () => {
    expect(() => loadRun(tmpRepo)).toThrow(/No saved runs found/);
  });
});
