import { jest } from "@jest/globals";
import { LocalLLM } from "../src/local-llm.js";
import { runAgentLoop } from "../src/agent-loop.js";
import fs from "fs";
import path from "path";
import os from "os";

describe("LocalLLM options and payload", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("sends options: { num_ctx: 8192, num_predict: 1024, temperature: 0 }, think: false, and format: 'json'", async () => {
    let capturedBody: any;
    global.fetch = jest.fn(async (url: any, init: any) => {
      capturedBody = JSON.parse(init.body);
      return {
        ok: true,
        json: async () => ({
          response: '{"bugs":[]}',
          done: true,
          done_reason: "stop",
          eval_count: 10,
          prompt_eval_count: 15,
        }),
      } as any;
    }) as any;

    const llm = new LocalLLM({ model: "gemma-4-e4b" });
    const res = await llm.complete("test prompt");

    expect(capturedBody).toBeDefined();
    expect(capturedBody.model).toBe("gemma4:e4b");
    expect(capturedBody.format).toBe("json");
    expect(capturedBody.think).toBe(false);
    expect(capturedBody.options).toEqual({
      num_ctx: 8192,
      num_predict: 1024,
      temperature: 0,
    });
    expect(res.doneReason).toBe("stop");
    expect(res.tokensUsed).toBe(10);
    expect(res.promptTokens).toBe(15);
  });
});

describe("agent-loop truncation and invalid JSON handling", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "repodoc-test-"));
    fs.writeFileSync(path.join(tmpDir, "index.js"), "const x = 1;\n");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("flags response as invalid when done_reason is length and does not report 0 bugs", async () => {
    const mockLlm = {
      complete: jest.fn(async () => ({
        text: '{"bugs":[{"id":"bug',
        doneReason: "length",
        durationMs: 50,
      })),
      isAvailable: jest.fn(async () => true),
    } as any;

    const result = await runAgentLoop(mockLlm, {
      repoPath: tmpDir,
      model: "gemma-4-e4b",
      apply: false,
      runTests: false,
      offline: true,
      json: true,
    });

    expect(result.llmResponseInvalid).toBe(true);
    expect(result.invalidFiles).toContain("index.js");
    expect(result.bugs.length).toBe(0); // no fake bugs invented
  });

  it("flags response as invalid when output fails JSON parsing", async () => {
    const mockLlm = {
      complete: jest.fn(async () => ({
        text: "I cannot parse this code properly",
        doneReason: "stop",
        durationMs: 50,
      })),
      isAvailable: jest.fn(async () => true),
    } as any;

    const result = await runAgentLoop(mockLlm, {
      repoPath: tmpDir,
      model: "gemma-4-e4b",
      apply: false,
      runTests: false,
      offline: true,
      json: true,
    });

    expect(result.llmResponseInvalid).toBe(true);
    expect(result.invalidFiles).toContain("index.js");
  });
});
