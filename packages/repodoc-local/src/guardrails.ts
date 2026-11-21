/**
 * guardrails.ts — Ported guardrail engine from the Python backend.
 * Runs pattern-regex and optional LLM rules against FileEntry objects.
 */

import fs from "fs";
import path from "path";
import { FileEntry } from "./file-walker.js";
import { GuardrailFinding } from "./types.js";
import { LocalLLM } from "./local-llm.js";

export interface GuardrailRule {
  id: string;
  name: string;
  category: "security" | "quality" | "custom";
  description: string;
  type: "pattern" | "llm";
  pattern?: string; // for type=pattern
  severity: "critical" | "warning" | "info";
}

// ── Built-in Rules (ported from guardrails_service.py) ───────────────────────

export const BUILTIN_RULES: GuardrailRule[] = [
  {
    id: "no_secrets",
    name: "No Hardcoded Secrets",
    category: "security",
    description: "Detects hardcoded API keys, passwords, tokens, credentials",
    type: "pattern",
    pattern:
      "(api[_-]?key|secret[_-]?key|password|passwd|access[_-]?token|auth[_-]?token|private[_-]?key)\\s*[=:]\\s*['\"][^'\"]{8,}['\"]",
    severity: "critical",
  },
  {
    id: "no_debug",
    name: "No Debug Statements",
    category: "quality",
    description: "No debugger, console.log, pdb.set_trace or breakpoint() in code",
    type: "pattern",
    pattern: "(debugger;|console\\.log\\(|pdb\\.set_trace\\(\\)|breakpoint\\(\\))",
    severity: "warning",
  },
  {
    id: "no_print",
    name: "No Print Statements",
    category: "quality",
    description: "No raw print() statements in production Python code",
    type: "pattern",
    pattern: "^\\s*print\\s*\\(",
    severity: "info",
  },
  {
    id: "no_todo",
    name: "No TODO/FIXME Comments",
    category: "quality",
    description: "No TODO, FIXME, HACK, or XXX comments in committed code",
    type: "pattern",
    pattern: "\\b(TODO|FIXME|HACK|XXX)\\b",
    severity: "info",
  },
  {
    id: "no_hardcoded_ips",
    name: "No Hardcoded IPs",
    category: "security",
    description: "Detects hardcoded private IP addresses that should be config variables",
    type: "pattern",
    pattern:
      "(?<!\\d)(?:192\\.168|10\\.\\d+|172\\.(?:1[6-9]|2\\d|3[01]))\\.\\d+\\.\\d+",
    severity: "warning",
  },
  {
    id: "no_eval",
    name: "No eval() Usage",
    category: "security",
    description: "Detects dangerous eval() or exec() calls",
    type: "pattern",
    pattern: "\\beval\\s*\\(",
    severity: "warning",
  },
  {
    id: "security_review",
    name: "AI Security Review",
    category: "security",
    description:
      "AI-powered detection of SQL injection, XSS, SSRF, path traversal, and other vulnerabilities",
    type: "llm",
    severity: "critical",
  },
  {
    id: "code_quality",
    name: "AI Code Quality",
    category: "quality",
    description: "AI-powered check for bad patterns, unhandled errors, and logical bugs",
    type: "llm",
    severity: "warning",
  },
];

// ── Pattern rule evaluation ───────────────────────────────────────────────────

function evaluatePatternRule(
  rule: GuardrailRule,
  file: FileEntry
): GuardrailFinding[] {
  if (!rule.pattern) return [];

  let regex: RegExp;
  try {
    const cleanPattern = rule.pattern.replace(/^\(\?i\)/, "");
    regex = new RegExp(cleanPattern, "im");
  } catch {
    console.warn(`[guardrails] Invalid regex in rule "${rule.id}"`);
    return [];
  }

  const findings: GuardrailFinding[] = [];
  const lines = file.content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    if (findings.length >= 5) break; // cap per-file per-rule, matching Python behaviour
    if (regex.test(lines[i])) {
      findings.push({
        ruleId: rule.id,
        ruleName: rule.name,
        severity: rule.severity,
        file: file.relativePath,
        line: i + 1,
        snippet: lines[i].trim().slice(0, 200),
      });
    }
  }

  return findings;
}

// ── LLM rule evaluation ───────────────────────────────────────────────────────

async function evaluateLlmRule(
  rule: GuardrailRule,
  file: FileEntry,
  llm: LocalLLM
): Promise<GuardrailFinding[]> {
  const truncated = file.content.slice(0, 6000);
  const prompt =
    `You are a strict code reviewer. Examine the provided source file.\n` +
    `Only flag genuine, high-confidence issues. Reply with valid JSON only — no markdown.\n` +
    `Schema: {"violations":[{"line":1,"reason":"short text","severity":"critical|warning|info"}]}\n\n` +
    `Focus: ${rule.description}\n\nFile: ${file.relativePath}\n\n${truncated}`;

  let raw: string;
  try {
    const res = await llm.complete(prompt);
    raw = res.text;
  } catch (err) {
    console.warn(`[guardrails] LLM rule "${rule.id}" error:`, err);
    return [];
  }

  try {
    // Strip markdown fences if present
    const cleaned = raw.replace(/```(?:json)?\n?/g, "").replace(/```$/g, "").trim();
    const data = JSON.parse(cleaned) as {
      violations?: { line?: number; reason?: string; severity?: string }[];
    };
    return (data.violations ?? []).slice(0, 5).map((v) => ({
      ruleId: rule.id,
      ruleName: rule.name,
      severity: (v.severity ?? rule.severity) as GuardrailFinding["severity"],
      file: file.relativePath,
      line: v.line,
      snippet: v.reason?.slice(0, 240),
    }));
  } catch {
    console.warn(`[guardrails] LLM rule "${rule.id}" returned non-JSON`);
    return [];
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run all provided rules against all provided files.
 * LLM rules are only evaluated when `llm` is supplied.
 */
export async function runGuardrails(
  files: FileEntry[],
  rules: GuardrailRule[],
  llm?: LocalLLM
): Promise<GuardrailFinding[]> {
  const findings: GuardrailFinding[] = [];

  for (const rule of rules) {
    for (const file of files) {
      if (rule.type === "pattern") {
        findings.push(...evaluatePatternRule(rule, file));
      } else if (rule.type === "llm" && llm) {
        findings.push(...(await evaluateLlmRule(rule, file, llm)));
      }

      // Global cap — mirrors Python's 15-violation limit
      if (findings.length >= 15) break;
    }
    if (findings.length >= 15) break;
  }

  return findings;
}

// ── repodoc.yml custom rule loader ───────────────────────────────────────────

interface RawYmlRule {
  id?: string;
  name?: string;
  category?: string;
  description?: string;
  type?: string;
  pattern?: string;
  severity?: string;
}

/**
 * Very lightweight "YAML" parser for the repodoc.yml format.
 * Supports only simple key: value pairs and a `rules:` list with indented items.
 * Falls back gracefully on any parse error.
 */
function parseRepodocYml(text: string): GuardrailRule[] {
  const rules: GuardrailRule[] = [];
  const lines = text.split("\n");

  let inRules = false;
  let current: RawYmlRule = {};

  const flush = () => {
    if (current.id) {
      rules.push({
        id: current.id,
        name: current.name ?? current.id,
        category: (current.category as GuardrailRule["category"]) ?? "custom",
        description: current.description ?? "",
        type: (current.type as GuardrailRule["type"]) ?? "pattern",
        pattern: current.pattern,
        severity: (current.severity as GuardrailRule["severity"]) ?? "info",
      });
    }
    current = {};
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (/^rules\s*:/.test(line)) {
      inRules = true;
      continue;
    }

    if (!inRules) continue;

    // A new list item
    if (/^\s+-\s+id\s*:/.test(line)) {
      flush();
      const m = line.match(/id\s*:\s*(.+)/);
      if (m) current.id = m[1].trim().replace(/^['"]|['"]$/g, "");
      continue;
    }

    // Key: value under current item
    const kv = line.match(/^\s+(\w+)\s*:\s*(.+)/);
    if (kv) {
      const key = kv[1] as keyof RawYmlRule;
      const val = kv[2].trim().replace(/^['"]|['"]$/g, "");
      (current as Record<string, string>)[key] = val;
    }
  }

  flush();
  return rules;
}

/**
 * Load custom guardrail rules from `<repoPath>/repodoc.yml`.
 * Returns an empty array if the file does not exist or cannot be parsed.
 */
export function loadRepoDocYml(repoPath: string): GuardrailRule[] {
  const ymlPath = path.join(repoPath, "repodoc.yml");
  let text: string;
  try {
    text = fs.readFileSync(ymlPath, "utf8");
  } catch {
    return [];
  }
  try {
    return parseRepodocYml(text);
  } catch (err) {
    console.warn("[guardrails] Failed to parse repodoc.yml:", err);
    return [];
  }
}
