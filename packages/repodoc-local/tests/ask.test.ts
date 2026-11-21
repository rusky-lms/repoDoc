import { jest } from "@jest/globals";
import fs from "fs";
import path from "path";
import os from "os";
import { saveRun } from "../src/persistence.js";
import { buildFollowupContext, askQuestion } from "../src/followup.js";
import { AnalysisResult, SavedRun } from "../src/types.js";

describe("Follow-up ask flow & context building", () => {
  let tmpRepo: string;

  beforeEach(() => {
    tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "repodoc-ask-"));
    // Create a dummy file with a secret that should be redacted
    fs.mkdirSync(path.join(tmpRepo, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRepo, "src", "auth.js"),
      'const api_key = "secret_1234567890";\nfunction verify() { return eval("2+2"); }\n'
    );
  });

  afterEach(() => {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  });

  const sampleResult: AnalysisResult = {
    repoPath: "",
    model: "gemma-4-e4b",
    durationMs: 95,
    guardrailFindings: [
      {
        ruleId: "no_eval",
        ruleName: "No eval() Usage",
        severity: "warning",
        file: "src/auth.js",
        line: 2,
        snippet: 'eval("2+2")',
      },
    ],
    bugs: [
      {
        id: "bug-auth-1",
        file: "src/auth.js",
        line: 2,
        description: "Dangerous eval() in verify function",
        confidence: 0.9,
        explanation: {
          rule_id: "no_eval",
          what: "Dynamic evaluation executes arbitrary string expressions.",
          why: "Using strict arithmetic logic prevents injection.",
          risk: {
            level: "medium",
            check: "Ensure dynamic formulas are not required.",
          },
        },
      },
    ],
    patches: [
      {
        bugId: "bug-auth-1",
        file: "src/auth.js",
        diff: '--- a/src/auth.js\n+++ b/src/auth.js\n@@ -2,1 +2,1 @@\n-function verify() { return eval("2+2"); }\n+function verify() { return 4; }',
        applied: false,
        explanation: {
          rule_id: "no_eval",
          what: "Dynamic evaluation executes arbitrary string expressions.",
          why: "Using strict arithmetic logic prevents injection.",
          risk: {
            level: "medium",
            check: "Ensure dynamic formulas are not required.",
          },
        },
      },
    ],
  };

  it("builds grounded context containing finding, diff, AI explanation and redacted file excerpt", () => {
    sampleResult.repoPath = tmpRepo;
    const runId = saveRun(tmpRepo, sampleResult, 1);
    const run: SavedRun = {
      ...sampleResult,
      id: runId,
      timestamp: new Date().toISOString(),
      filesScanned: 1,
    };

    const context = buildFollowupContext(run, "Why did you change eval in auth.js?", tmpRepo);

    expect(context).toContain("no_eval");
    expect(context).toContain("bug-auth-1");
    expect(context).toContain("[AI-generated explanation]");
    expect(context).toContain("Dynamic evaluation executes arbitrary string expressions");
    expect(context).toContain("Using strict arithmetic logic prevents injection");
    expect(context).toContain("medium");
    expect(context).toContain("Patch diff:");
    expect(context).toContain("+function verify() { return 4; }");

    // Secret in file excerpt must be redacted
    expect(context).toContain("[REDACTED:API_KEY]");
    expect(context).not.toContain("secret_1234567890");
  });

  it("asks Ollama with num_ctx 8192, think: false, temperature: 0", async () => {
    sampleResult.repoPath = tmpRepo;
    saveRun(tmpRepo, sampleResult, 1);

    const originalFetch = global.fetch;
    let capturedBody: any;
    try {
      global.fetch = jest.fn(async (url: any, init: any) => {
        if (String(url).includes("/api/tags")) {
          return { ok: true } as any;
        }
        capturedBody = JSON.parse(init.body);
        return {
          ok: true,
          json: async () => ({
            response: "The change replaces eval() with static computation to avoid code injection.",
            done: true,
            done_reason: "stop",
          }),
        } as any;
      }) as any;

      const answer = await askQuestion("Why was this patch suggested for auth.js?", {
        repoPath: tmpRepo,
        model: "gemma-4-e4b",
      });

      expect(answer).toContain("eval()");
      expect(capturedBody).toBeDefined();
      expect(capturedBody.think).toBe(false);
      expect(capturedBody.options.num_ctx).toBe(8192);
      expect(capturedBody.options.temperature).toBe(0);
      expect(capturedBody.prompt).toContain("Saved Analysis Context");
      expect(capturedBody.prompt).toContain("If the user's question cannot be answered");
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("redacts secrets in the question itself", async () => {
    sampleResult.repoPath = tmpRepo;
    saveRun(tmpRepo, sampleResult, 1);

    const originalFetch = global.fetch;
    let capturedPrompt: string = "";
    try {
      global.fetch = jest.fn(async (url: any, init: any) => {
        if (String(url).includes("/api/tags")) return { ok: true } as any;
        const b = JSON.parse(init.body);
        capturedPrompt = b.prompt;
        return {
          ok: true,
          json: async () => ({
            response: "I cannot answer this question from the saved analysis context.",
            done: true,
          }),
        } as any;
      }) as any;

      await askQuestion('Does the run know about my password="supersecret123"?', {
        repoPath: tmpRepo,
      });

      expect(capturedPrompt).toContain("[REDACTED:PASSWORD]");
      expect(capturedPrompt).not.toContain("supersecret123");
    } finally {
      global.fetch = originalFetch;
    }
  });
});
