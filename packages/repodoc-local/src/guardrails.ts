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
  category: "security" | "quality" | "compliance" | "custom";
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

// ── repodoc.yml schema: parse / serialize / validate ─────────────────────────
//
// Schema (shared with the hosted backend's export endpoint):
//
//   version: 1                      # optional
//   name: "My ruleset"              # optional
//   rules:
//     - id: no_console_log          # required, [A-Za-z0-9_.-]
//       name: 'No Console Logs'     # optional (defaults to id)
//       category: quality           # security | quality | compliance | custom
//       type: pattern               # pattern | llm
//       pattern: 'console\.log\('   # required when type = pattern
//       severity: warning           # critical | warning | info
//       description: '...'
//       enabled: true               # optional; `false` rules are skipped
//
// Strings may be bare, 'single-quoted' ('' escapes a quote) or
// "double-quoted" (backslash escapes, YAML-style).

export const VALID_SEVERITIES = ["critical", "warning", "info"] as const;
export const VALID_TYPES = ["pattern", "llm"] as const;
export const VALID_CATEGORIES = ["security", "quality", "compliance", "custom"] as const;

interface RawYmlRule {
  [key: string]: string | undefined;
}

/** Decode a single YAML scalar (bare, single- or double-quoted). */
function decodeScalar(raw: string): string {
  const v = raw.trim();
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) {
    return v.slice(1, -1).replace(/''/g, "'");
  }
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1).replace(/\\(.)/g, (_m, ch: string) => {
      switch (ch) {
        case "n": return "\n";
        case "t": return "\t";
        case '"': return '"';
        case "\\": return "\\";
        case "/": return "/";
        default: return "\\" + ch; // keep unknown escapes verbatim
      }
    });
  }
  // Bare scalar: strip trailing inline comment (" # ...")
  return v.replace(/\s+#.*$/, "");
}

/**
 * Lightweight parser for the repodoc.yml format (no external YAML dependency).
 * Supports top-level `key: value` pairs and a `rules:` list of flat maps.
 */
export function parseRepodocYml(text: string): GuardrailRule[] {
  const rules: GuardrailRule[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");

  let inRules = false;
  let current: RawYmlRule | null = null;

  const flush = () => {
    if (current && current.id && current.enabled !== "false") {
      const type = (current.type === "regex" ? "pattern" : current.type) ?? (current.pattern ? "pattern" : "llm");
      rules.push({
        id: current.id,
        name: current.name ?? current.id,
        category: (current.category as GuardrailRule["category"]) ?? "custom",
        description: current.description ?? "",
        type: type as GuardrailRule["type"],
        pattern: current.pattern,
        severity: (current.severity as GuardrailRule["severity"]) ?? "info",
      });
    }
    current = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;

    // Top-level key (no indentation)
    if (/^[A-Za-z_][\w-]*\s*:/.test(line)) {
      flush();
      inRules = /^rules\s*:/.test(line);
      continue;
    }
    if (!inRules) continue;

    // New list item: "  - key: value"
    const item = line.match(/^\s*-\s+([A-Za-z_]\w*)\s*:\s*(.*)$/);
    if (item) {
      flush();
      current = { [item[1]]: decodeScalar(item[2]) };
      continue;
    }

    // Continuation "    key: value"
    const kv = line.match(/^\s+([A-Za-z_]\w*)\s*:\s*(.*)$/);
    if (kv && current) {
      current[kv[1]] = decodeScalar(kv[2]);
    }
  }

  flush();
  return rules;
}

/** Encode a string as a YAML single-quoted scalar (safe for regex patterns). */
function encodeScalar(v: string): string {
  return `'${v.replace(/\n/g, " ").replace(/'/g, "''")}'`;
}

/** Serialize rules into repodoc.yml text that `parseRepodocYml` round-trips. */
export function serializeRepodocYml(
  rules: GuardrailRule[],
  header: { name?: string; comment?: string } = {}
): string {
  const out: string[] = [];
  out.push(`# ${header.comment ?? "repoDoc guardrail configuration"}`);
  out.push("# Edit freely, then run: repodoc <path> (or repodoc <path> --rules <file>)");
  out.push("version: 1");
  if (header.name) out.push(`name: ${encodeScalar(header.name)}`);
  out.push("rules:");
  for (const r of rules) {
    out.push(`  - id: ${r.id}`);
    out.push(`    name: ${encodeScalar(r.name)}`);
    out.push(`    category: ${r.category}`);
    out.push(`    type: ${r.type}`);
    if (r.type === "pattern" && r.pattern) out.push(`    pattern: ${encodeScalar(r.pattern)}`);
    out.push(`    severity: ${r.severity}`);
    out.push(`    description: ${encodeScalar(r.description ?? "")}`);
  }
  return out.join("\n") + "\n";
}

/**
 * Validate rules against the repodoc.yml schema.
 * Returns a list of human-readable errors (empty = valid).
 */
export function validateRules(rules: GuardrailRule[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  rules.forEach((r, i) => {
    const where = `rules[${i}]${r.id ? ` (${r.id})` : ""}`;
    if (!r.id || !/^[A-Za-z0-9_.-]+$/.test(r.id)) errors.push(`${where}: invalid or missing id`);
    if (seen.has(r.id)) errors.push(`${where}: duplicate id`);
    seen.add(r.id);
    if (!(VALID_TYPES as readonly string[]).includes(r.type)) {
      errors.push(`${where}: type must be one of ${VALID_TYPES.join(", ")}`);
    }
    if (!(VALID_SEVERITIES as readonly string[]).includes(r.severity)) {
      errors.push(`${where}: severity must be one of ${VALID_SEVERITIES.join(", ")}`);
    }
    if (!(VALID_CATEGORIES as readonly string[]).includes(r.category)) {
      errors.push(`${where}: category must be one of ${VALID_CATEGORIES.join(", ")}`);
    }
    if (r.type === "pattern") {
      if (!r.pattern) {
        errors.push(`${where}: pattern rules need a 'pattern'`);
      } else {
        try {
          new RegExp(r.pattern.replace(/^\(\?i\)/, ""), "im");
        } catch {
          errors.push(`${where}: pattern is not a valid regular expression`);
        }
      }
    }
  });
  return errors;
}

/** Merge rule lists by id; `incoming` replaces existing rules with the same id. */
export function mergeRules(existing: GuardrailRule[], incoming: GuardrailRule[]): GuardrailRule[] {
  const byId = new Map<string, GuardrailRule>();
  for (const r of existing) byId.set(r.id, r);
  for (const r of incoming) byId.set(r.id, r);
  return Array.from(byId.values());
}

/**
 * Load rules from an explicit YAML file (used by `--rules <path>`).
 * Throws on a missing file or an invalid schema, because the user asked for it.
 */
export function loadRulesFile(filePath: string): GuardrailRule[] {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Rules file not found: ${filePath}`);
  }
  const rules = parseRepodocYml(fs.readFileSync(filePath, "utf8"));
  const errors = validateRules(rules);
  if (errors.length > 0) {
    throw new Error(`Invalid rules file ${filePath}:\n  - ${errors.join("\n  - ")}`);
  }
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

/**
 * Resolve the custom rule set for a scan: an explicit `--rules <path>` wins,
 * otherwise fall back to `<repoPath>/repodoc.yml`.
 */
export function resolveCustomRules(repoPath: string, rulesPath?: string): GuardrailRule[] {
  if (rulesPath) return loadRulesFile(path.resolve(rulesPath));
  return loadRepoDocYml(repoPath);
}
