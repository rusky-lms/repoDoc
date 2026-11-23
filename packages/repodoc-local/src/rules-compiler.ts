// ─────────────────────────────────────────────────────────────────────────────
// repoDoc Local — Doc-to-Guardrails Compiler
// Turns ADR / LLD / HLD documents (.md / .txt) into enforceable repodoc.yml
// rules using the local Gemma model via Ollama. 100% offline: the document is
// read from disk, secret-redacted, and only ever sent to localhost:11434.
// ─────────────────────────────────────────────────────────────────────────────

import fs from "fs";
import path from "path";
import type { LocalLLM, LLMResponse } from "./local-llm.js";
import { redactSecrets } from "./secret-redactor.js";
import {
  BUILTIN_RULES,
  GuardrailRule,
  mergeRules,
  parseRepodocYml,
  serializeRepodocYml,
  validateRules,
} from "./guardrails.js";

export const SUPPORTED_DOC_EXTENSIONS = [".md", ".markdown", ".txt"];

/**
 * Gemma 4 runs with num_ctx 8192. Budget: ~600 tokens of instructions,
 * 2048 tokens reserved for output, the rest for the document chunk.
 * At a conservative ~3 chars/token, 12k chars per chunk fits comfortably.
 */
export const DEFAULT_CHUNK_CHARS = 12_000;
export const DEFAULT_MAX_CHUNKS = 8;

export interface CompileOptions {
  llm: Pick<LocalLLM, "complete">;
  chunkChars?: number;
  maxChunks?: number;
  debug?: boolean;
}

export interface CompileResult {
  rules: GuardrailRule[];
  warnings: string[];
  chunksProcessed: number;
  chunksTotal: number;
}

// ── Chunking ─────────────────────────────────────────────────────────────────

/** Split a document on paragraph / heading boundaries into <= maxChars chunks. */
export function chunkDocument(text: string, maxChars = DEFAULT_CHUNK_CHARS): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];
  if (normalized.length <= maxChars) return [normalized];

  const blocks = normalized.split(/\n(?=#{1,6}\s)|\n{2,}/);
  const chunks: string[] = [];
  let current = "";
  for (const block of blocks) {
    // Hard-split pathological blocks that alone exceed the budget
    const pieces: string[] = [];
    for (let i = 0; i < block.length; i += maxChars) pieces.push(block.slice(i, i + maxChars));
    for (const piece of pieces) {
      if (current && current.length + piece.length + 2 > maxChars) {
        chunks.push(current);
        current = "";
      }
      current = current ? `${current}\n\n${piece}` : piece;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// ── Prompt ───────────────────────────────────────────────────────────────────

export function buildCompilerPrompt(chunk: string, sourceName: string, part: number, total: number): string {
  return [
    `You convert software architecture documents (ADR, LLD, HLD) into enforceable code guardrails.`,
    `Read the document excerpt below (part ${part} of ${total} of "${sourceName}").`,
    `Extract ONLY concrete, checkable engineering rules stated or clearly implied as MUST / MUST NOT / SHALL / NEVER / ALWAYS.`,
    `Ignore background, goals, history, and anything that cannot be checked in source code.`,
    `Never invent rules that are not grounded in the text.`,
    ``,
    `For each rule return:`,
    `- id: short snake_case identifier`,
    `- name: short human-readable title`,
    `- severity: "critical" | "warning" | "info"`,
    `- category: "security" | "quality" | "compliance"`,
    `- description: one sentence stating the must / must-not rule`,
    `- type: "regex" if a single-line regular expression can detect a VIOLATION in source code, otherwise "llm"`,
    `- pattern: JavaScript regex (no slashes, no flags) matching a violating line; only when type is "regex"`,
    ``,
    `Respond with ONLY JSON: {"rules":[{"id":"no_direct_db_from_ui","name":"...","severity":"warning","category":"quality","description":"...","type":"regex","pattern":"..."}]}`,
    `If the excerpt contains no enforceable rules, respond with {"rules":[]}.`,
    ``,
    `--- DOCUMENT EXCERPT START ---`,
    chunk,
    `--- DOCUMENT EXCERPT END ---`,
  ].join("\n");
}

// ── Normalization ────────────────────────────────────────────────────────────

const BUILTIN_IDS = new Set(BUILTIN_RULES.map((r) => r.id));

export function slugifyId(raw: string): string {
  return (
    raw
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 60) || "doc_rule"
  );
}

function normalizeSeverity(v: unknown): GuardrailRule["severity"] {
  const s = String(v ?? "").toLowerCase();
  if (["critical", "high", "error", "blocker", "must"].includes(s)) return "critical";
  if (["info", "low", "minor", "note"].includes(s)) return "info";
  return "warning";
}

function normalizeCategory(v: unknown): GuardrailRule["category"] {
  const s = String(v ?? "").toLowerCase();
  if (s === "security" || s === "quality" || s === "compliance") return s;
  return "custom";
}

/** Convert one raw LLM rule object into a valid GuardrailRule (or null). */
export function normalizeGeneratedRule(
  raw: unknown,
  warnings: string[] = []
): GuardrailRule | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const name = String(r["name"] ?? r["id"] ?? "").trim();
  const description = String(r["description"] ?? "").trim();
  if (!name && !description) return null;

  let id = slugifyId(String(r["id"] ?? name));
  if (BUILTIN_IDS.has(id)) id = `doc_${id}`;

  const wantsPattern = ["regex", "pattern"].includes(String(r["type"] ?? "").toLowerCase());
  let pattern = typeof r["pattern"] === "string" ? (r["pattern"] as string).trim() : "";
  // Strip accidental /.../flags wrappers
  const slashForm = pattern.match(/^\/(.+)\/[gimsuy]*$/);
  if (slashForm) pattern = slashForm[1];

  let type: GuardrailRule["type"] = "llm";
  if (wantsPattern && pattern) {
    try {
      new RegExp(pattern.replace(/^\(\?i\)/, ""), "im");
      type = "pattern";
    } catch {
      warnings.push(`Rule "${id}": invalid regex from model; converted to an llm (semantic) rule.`);
    }
  }

  return {
    id,
    name: name || id,
    category: normalizeCategory(r["category"]),
    description: description || name,
    type,
    pattern: type === "pattern" ? pattern : undefined,
    severity: normalizeSeverity(r["severity"]),
  };
}

function parseRulesJson(text: string): unknown[] | null {
  const cleaned = text.replace(/```(?:json)?\n?/g, "").replace(/```$/g, "").trim();
  try {
    const data = JSON.parse(cleaned) as { rules?: unknown };
    return Array.isArray(data?.rules) ? (data.rules as unknown[]) : null;
  } catch {
    return null;
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Extract rules from raw document text using the local LLM. */
export async function generateRulesFromText(
  text: string,
  sourceName: string,
  opts: CompileOptions
): Promise<CompileResult> {
  const warnings: string[] = [];
  const { redacted, count } = redactSecrets(text);
  if (count > 0) warnings.push(`Redacted ${count} secret-like value(s) before sending to the local model.`);

  const allChunks = chunkDocument(redacted, opts.chunkChars ?? DEFAULT_CHUNK_CHARS);
  const maxChunks = opts.maxChunks ?? DEFAULT_MAX_CHUNKS;
  const chunks = allChunks.slice(0, maxChunks);
  if (allChunks.length > chunks.length) {
    warnings.push(
      `Document is long: processed the first ${chunks.length} of ${allChunks.length} sections. Split it into smaller docs for full coverage.`
    );
  }

  const collected: GuardrailRule[] = [];
  let validChunks = 0;

  for (let i = 0; i < chunks.length; i++) {
    const prompt = buildCompilerPrompt(chunks[i], sourceName, i + 1, chunks.length);
    if (opts.debug) {
      console.log(`[debug] rules generate chunk ${i + 1}/${chunks.length}: ${prompt.length} chars (~${Math.ceil(prompt.length / 4)} tokens)`);
    }

    let res: LLMResponse;
    try {
      res = await opts.llm.complete(prompt, {
        format: "json",
        think: false,
        options: { num_ctx: 8192, num_predict: 2048, temperature: 0 },
      });
    } catch (err) {
      throw new Error(`Local LLM call failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (opts.debug) {
      console.log(`[debug] done_reason: ${res.doneReason ?? "unknown"}`);
      console.log(`[debug] raw response:\n${res.text}\n`);
    }

    const rawRules = parseRulesJson(res.text);
    if (!rawRules) {
      warnings.push(
        res.doneReason === "length"
          ? `Section ${i + 1}: LLM response truncated (done_reason=length); skipped.`
          : `Section ${i + 1}: LLM response was not valid JSON; skipped.`
      );
      continue;
    }
    validChunks++;
    for (const raw of rawRules) {
      const rule = normalizeGeneratedRule(raw, warnings);
      if (rule) collected.push(rule);
    }
  }

  if (chunks.length > 0 && validChunks === 0) {
    throw new Error("LLM response invalid: no section produced parseable JSON. Re-run with --debug.");
  }

  // De-duplicate ids (suffix collisions from different sections)
  const seen = new Map<string, number>();
  const rules = collected.map((r) => {
    const n = seen.get(r.id) ?? 0;
    seen.set(r.id, n + 1);
    return n === 0 ? r : { ...r, id: `${r.id}_${n + 1}` };
  });

  const errors = validateRules(rules);
  if (errors.length > 0) {
    throw new Error(`Generated rules failed schema validation:\n  - ${errors.join("\n  - ")}`);
  }

  return { rules, warnings, chunksProcessed: chunks.length, chunksTotal: allChunks.length };
}

/** Read an ADR/LLD/HLD file, compile it to rules and write/merge into `outPath`. */
export async function compileDocToYml(
  docPath: string,
  outPath: string,
  opts: CompileOptions
): Promise<CompileResult & { outPath: string; totalRules: number; existingRules: number }> {
  const ext = path.extname(docPath).toLowerCase();
  if (!SUPPORTED_DOC_EXTENSIONS.includes(ext)) {
    throw new Error(`Unsupported file type "${ext}". Use one of: ${SUPPORTED_DOC_EXTENSIONS.join(", ")}`);
  }
  if (!fs.existsSync(docPath)) throw new Error(`File not found: ${docPath}`);

  const text = fs.readFileSync(docPath, "utf8");
  if (!text.trim()) throw new Error(`File is empty: ${docPath}`);

  const result = await generateRulesFromText(text, path.basename(docPath), opts);

  const existing = fs.existsSync(outPath) ? parseRepodocYml(fs.readFileSync(outPath, "utf8")) : [];
  const merged = mergeRules(existing, result.rules);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(
    outPath,
    serializeRepodocYml(merged, { comment: `repoDoc guardrails (includes rules generated from ${path.basename(docPath)})` }),
    "utf8"
  );

  return { ...result, outPath, totalRules: merged.length, existingRules: existing.length };
}
