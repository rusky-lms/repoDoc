// ─────────────────────────────────────────────────────────────────────────────
// repoDoc Local — Tests: guardrails
// ─────────────────────────────────────────────────────────────────────────────

import { BUILTIN_RULES, runGuardrails } from "../src/guardrails.js";
import type { FileEntry } from "../src/file-walker.js";
import type { GuardrailFinding } from "../src/types.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeFile(
  relativePath: string,
  content: string,
  language: FileEntry["language"] = "python"
): FileEntry {
  return {
    relativePath,
    absolutePath: `/tmp/${relativePath}`,
    content,
    language,
    lineCount: content.split("\n").length,
  };
}

function findingsForRule(findings: GuardrailFinding[], ruleId: string) {
  return findings.filter((f) => f.ruleId === ruleId);
}

// ── no_secrets ─────────────────────────────────────────────────────────────

describe("no_secrets rule", () => {
  it("catches api_key assignment with a long value", async () => {
    const file = makeFile(
      "config.py",
      `api_key = "supersecretkey123"\nother = "harmless"`
    );
    const findings = await runGuardrails([file], BUILTIN_RULES);
    const hits = findingsForRule(findings, "no_secrets");
    expect(hits.length).toBeGreaterThan(0);
  });

  it("catches password assignment", async () => {
    const file = makeFile("settings.py", `password = "hunter2password"`);
    const findings = await runGuardrails([file], BUILTIN_RULES);
    const hits = findingsForRule(findings, "no_secrets");
    expect(hits.length).toBeGreaterThan(0);
  });

  it("catches access_token with colon separator", async () => {
    const file = makeFile(
      "auth.ts",
      `const access_token = "eyJhbGciOiJIUzI1NiJ9.longtoken"`,
      "typescript"
    );
    const findings = await runGuardrails([file], BUILTIN_RULES);
    const hits = findingsForRule(findings, "no_secrets");
    expect(hits.length).toBeGreaterThan(0);
  });

  it("does NOT flag short values (< 8 chars) or empty strings", async () => {
    const file = makeFile(
      "example.py",
      `api_key = "short"\npassword = "tiny"`
    );
    const findings = await runGuardrails([file], BUILTIN_RULES);
    const hits = findingsForRule(findings, "no_secrets");
    expect(hits.length).toBe(0);
  });
});

// ── no_eval ────────────────────────────────────────────────────────────────

describe("no_eval rule", () => {
  it("catches eval() call in JavaScript", async () => {
    const file = makeFile(
      "index.js",
      `const result = eval(userInput);`,
      "javascript"
    );
    const findings = await runGuardrails([file], BUILTIN_RULES);
    const hits = findingsForRule(findings, "no_eval");
    expect(hits.length).toBeGreaterThan(0);
  });

  it("catches eval() in Python code", async () => {
    const file = makeFile("script.py", `result = eval(user_input)`);
    const findings = await runGuardrails([file], BUILTIN_RULES);
    const hits = findingsForRule(findings, "no_eval");
    expect(hits.length).toBeGreaterThan(0);
  });

  it("catches eval with leading whitespace", async () => {
    const file = makeFile("lib.ts", `  const x = eval("code")`, "typescript");
    const findings = await runGuardrails([file], BUILTIN_RULES);
    const hits = findingsForRule(findings, "no_eval");
    expect(hits.length).toBeGreaterThan(0);
  });
});

// ── clean code ─────────────────────────────────────────────────────────────

describe("clean code passes all rules", () => {
  it("produces no findings for safe TypeScript code", async () => {
    const file = makeFile(
      "utils.ts",
      `
export function add(a: number, b: number): number {
  return a + b;
}

export function greet(name: string): string {
  return \`Hello, \${name}!\`;
}
      `.trim(),
      "typescript"
    );
    const findings = await runGuardrails([file], BUILTIN_RULES);
    // Filter out info-level findings (TODO, print, debug) for "clean" test
    const critical = findings.filter(
      (f) => f.severity === "critical" || f.severity === "warning"
    );
    expect(critical.length).toBe(0);
  });

  it("produces no critical/warning findings for safe Python code", async () => {
    const file = makeFile(
      "helpers.py",
      `
def multiply(a: int, b: int) -> int:
    return a * b

def divide(a: float, b: float) -> float:
    if b == 0:
        raise ValueError("Cannot divide by zero")
    return a / b
      `.trim()
    );
    const findings = await runGuardrails([file], BUILTIN_RULES);
    const critical = findings.filter(
      (f) => f.severity === "critical" || f.severity === "warning"
    );
    expect(critical.length).toBe(0);
  });

  it("empty file produces zero findings", async () => {
    const file = makeFile("empty.ts", "", "typescript");
    const findings = await runGuardrails([file], BUILTIN_RULES);
    expect(findings.length).toBe(0);
  });
});

// ── BUILTIN_RULES sanity ───────────────────────────────────────────────────

describe("BUILTIN_RULES", () => {
  it("contains at least 6 rules", () => {
    expect(BUILTIN_RULES.length).toBeGreaterThanOrEqual(6);
  });

  it("includes no_secrets with critical severity", () => {
    const rule = BUILTIN_RULES.find((r) => r.id === "no_secrets");
    expect(rule).toBeDefined();
    expect(rule?.severity).toBe("critical");
  });

  it("includes no_eval with warning severity", () => {
    const rule = BUILTIN_RULES.find((r) => r.id === "no_eval");
    expect(rule).toBeDefined();
    expect(rule?.severity).toBe("warning");
  });

  it("every rule has a non-empty id, name and description", () => {
    for (const rule of BUILTIN_RULES) {
      expect(rule.id.length).toBeGreaterThan(0);
      expect(rule.name.length).toBeGreaterThan(0);
      expect(rule.description.length).toBeGreaterThan(0);
    }
  });
});
