// ─────────────────────────────────────────────────────────────────────────────
// repoDoc Local — Tests: rules generate, rules pull, and --rules <path>
// ─────────────────────────────────────────────────────────────────────────────

import fs from "fs";
import os from "os";
import path from "path";
import { jest } from "@jest/globals";
import {
  loadRulesFile,
  parseRepodocYml,
  resolveCustomRules,
  runGuardrails,
  serializeRepodocYml,
  validateRules,
} from "../src/guardrails.js";
import {
  chunkDocument,
  compileDocToYml,
  generateRulesFromText,
} from "../src/rules-compiler.js";
import {
  assertAllowedUrl,
  parseAndValidateRulesYaml,
  pullRules,
} from "../src/rules-sync.js";
import type { LLMResponse } from "../src/local-llm.js";
import type { FileEntry } from "../src/file-walker.js";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "repodoc-rules-test-"));
}

// ── 1. rules generate (ADR/LLD/HLD -> repodoc.yml) ───────────────────────────

describe("rules generate (doc-to-guardrails compiler)", () => {
  it("extracts regex and llm rules from an ADR markdown doc and writes valid repodoc.yml", async () => {
    const tmp = makeTempDir();
    const adrPath = path.join(tmp, "ADR-001.md");
    const outPath = path.join(tmp, "repodoc.yml");

    fs.writeFileSync(
      adrPath,
      [
        "# ADR-001: Database & Logging Standards",
        "1. Services MUST NOT call raw `SELECT *` queries.",
        "2. All outbound HTTP calls MUST specify an explicit timeout.",
      ].join("\n"),
      "utf8"
    );

    const mockComplete = jest.fn<
      (prompt: string, opts?: unknown) => Promise<LLMResponse>
    >().mockResolvedValue({
      text: JSON.stringify({
        rules: [
          {
            id: "no_select_star",
            name: "No SELECT * Queries",
            severity: "warning",
            category: "quality",
            description: "Services must not use SELECT * in SQL queries.",
            type: "regex",
            pattern: "SELECT\\s+\\*",
          },
          {
            id: "require_http_timeout",
            name: "Require HTTP Timeout",
            severity: "critical",
            category: "security",
            description: "All outbound HTTP requests must specify an explicit timeout.",
            type: "llm",
          },
        ],
      }),
      doneReason: "stop",
      durationMs: 42,
    });

    const result = await compileDocToYml(adrPath, outPath, {
      llm: { complete: mockComplete },
    });

    expect(mockComplete).toHaveBeenCalledTimes(1);
    expect(result.rules).toHaveLength(2);
    expect(result.rules[0]).toMatchObject({
      id: "no_select_star",
      type: "pattern",
      pattern: "SELECT\\s+\\*",
      severity: "warning",
    });
    expect(result.rules[1]).toMatchObject({
      id: "require_http_timeout",
      type: "llm",
      severity: "critical",
    });

    // Verify the written YAML parses back cleanly and passes schema validation
    const written = fs.readFileSync(outPath, "utf8");
    const parsed = parseRepodocYml(written);
    expect(parsed).toHaveLength(2);
    expect(validateRules(parsed)).toEqual([]);
    expect(parsed[0].pattern).toBe("SELECT\\s+\\*");

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("merges newly generated rules with existing repodoc.yml rules", async () => {
    const tmp = makeTempDir();
    const docPath = path.join(tmp, "lld.txt");
    const outPath = path.join(tmp, "repodoc.yml");

    fs.writeFileSync(
      outPath,
      serializeRepodocYml([
        {
          id: "existing_rule",
          name: "Existing Rule",
          category: "quality",
          type: "pattern",
          pattern: "FIXME",
          severity: "info",
          description: "Keep existing rule",
        },
      ]),
      "utf8"
    );
    fs.writeFileSync(docPath, "Never use md5 for password hashing.", "utf8");

    const mockComplete = jest.fn<
      (prompt: string, opts?: unknown) => Promise<LLMResponse>
    >().mockResolvedValue({
      text: JSON.stringify({
        rules: [
          {
            id: "no_md5",
            name: "No MD5 Hashing",
            severity: "critical",
            category: "security",
            description: "Never use MD5 for hashing.",
            type: "regex",
            pattern: "\\bmd5\\b",
          },
        ],
      }),
      doneReason: "stop",
      durationMs: 25,
    });

    const res = await compileDocToYml(docPath, outPath, {
      llm: { complete: mockComplete },
    });

    expect(res.existingRules).toBe(1);
    expect(res.totalRules).toBe(2);
    const parsed = parseRepodocYml(fs.readFileSync(outPath, "utf8"));
    expect(parsed.map((r) => r.id)).toEqual(["existing_rule", "no_md5"]);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("downgrades invalid regex from model into an llm rule with a warning", async () => {
    const mockComplete = jest.fn<
      (prompt: string, opts?: unknown) => Promise<LLMResponse>
    >().mockResolvedValue({
      text: JSON.stringify({
        rules: [
          {
            id: "broken_regex_rule",
            name: "Broken Regex",
            severity: "warning",
            category: "quality",
            description: "Must not do X",
            type: "regex",
            pattern: "([unclosed",
          },
        ],
      }),
      doneReason: "stop",
      durationMs: 10,
    });

    const res = await generateRulesFromText("Must not do X", "doc.md", {
      llm: { complete: mockComplete },
    });

    expect(res.rules[0].type).toBe("llm");
    expect(res.rules[0].pattern).toBeUndefined();
    expect(res.warnings.some((w) => w.includes("invalid regex"))).toBe(true);
  });

  it("chunks large documents to stay within Gemma 4 context budget", () => {
    const bigDoc = Array.from({ length: 10 }, (_, i) => `## Section ${i}\n${"a".repeat(2000)}`).join("\n\n");
    const chunks = chunkDocument(bigDoc, 5000);
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(5000);
    }
  });
});

// ── 2. rules pull (opt-in team sync) ─────────────────────────────────────────

describe("rules pull (team rules sync)", () => {
  const validYaml = [
    "version: 1",
    "name: 'Security Team Rules'",
    "rules:",
    "  - id: no_eval_team",
    "    name: 'No eval'",
    "    category: security",
    "    type: pattern",
    "    pattern: '\\beval\\s*\\('",
    "    severity: critical",
    "    description: 'Forbid eval calls'",
  ].join("\n");

  it("fetches, validates, and saves remote YAML rules locally", async () => {
    const tmp = makeTempDir();
    const outPath = path.join(tmp, "repodoc.yml");

    const mockFetch = jest.fn<typeof fetch>().mockResolvedValue(
      new Response(validYaml, {
        status: 200,
        headers: { "Content-Type": "text/yaml" },
      })
    );

    const res = await pullRules("https://repodocv1.onrender.com/api/guardrails/abc/export.yml", {
      outPath,
      fetchImpl: mockFetch,
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(res.rules).toHaveLength(1);
    expect(res.rules[0].id).toBe("no_eval_team");
    expect(fs.existsSync(outPath)).toBe(true);

    const saved = loadRulesFile(outPath);
    expect(saved).toHaveLength(1);
    expect(saved[0].id).toBe("no_eval_team");

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("rejects HTML or invalid YAML responses without writing to disk", async () => {
    const tmp = makeTempDir();
    const outPath = path.join(tmp, "repodoc.yml");

    const mockFetch = jest.fn<typeof fetch>().mockResolvedValue(
      new Response("<!DOCTYPE html><html><body>Not found</body></html>", { status: 200 })
    );

    await expect(
      pullRules("https://example.com/repodoc.yml", { outPath, fetchImpl: mockFetch })
    ).rejects.toThrow(/HTML/i);

    expect(fs.existsSync(outPath)).toBe(false);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("refuses to run under --offline mode and blocks non-HTTPS non-localhost URLs", async () => {
    const tmp = makeTempDir();
    const outPath = path.join(tmp, "repodoc.yml");

    await expect(
      pullRules("https://example.com/repodoc.yml", { outPath, offline: true })
    ).rejects.toThrow(/--offline/i);

    expect(() => assertAllowedUrl("http://evil.example.com/rules.yml")).toThrow(/https/i);
    expect(() => assertAllowedUrl("http://localhost:8000/api/guardrails/export.yml")).not.toThrow();
    expect(() => parseAndValidateRulesYaml("foo: bar")).toThrow(/rules:/i);

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

// ── 3. --rules <path> custom ruleset resolution & execution ──────────────────

describe("--rules <path> support", () => {
  it("loads and executes rules from an explicit custom YAML file instead of default repodoc.yml", async () => {
    const tmp = makeTempDir();
    const customPath = path.join(tmp, "custom-team.yml");

    fs.writeFileSync(
      customPath,
      serializeRepodocYml([
        {
          id: "no_legacy_v1_api",
          name: "No Legacy V1 API",
          category: "compliance",
          type: "pattern",
          pattern: "/api/v1/legacy",
          severity: "critical",
          description: "Legacy v1 endpoint is deprecated; use /api/v2.",
        },
      ]),
      "utf8"
    );

    const rules = resolveCustomRules(tmp, customPath);
    expect(rules).toHaveLength(1);
    expect(rules[0].id).toBe("no_legacy_v1_api");

    const file: FileEntry = {
      relativePath: "client.ts",
      absolutePath: path.join(tmp, "client.ts"),
      content: `const url = "https://service.internal/api/v1/legacy/orders";\n`,
      language: "typescript",
      lineCount: 1,
    };

    const findings = await runGuardrails([file], rules);
    expect(findings).toHaveLength(1);
    expect(findings[0].ruleId).toBe("no_legacy_v1_api");
    expect(findings[0].severity).toBe("critical");

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("throws a clear error when explicit --rules file does not exist", () => {
    expect(() => resolveCustomRules("/tmp", "/tmp/does-not-exist-repodoc.yml")).toThrow(
      /Rules file not found/i
    );
  });
});
