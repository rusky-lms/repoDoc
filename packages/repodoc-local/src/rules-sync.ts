// ─────────────────────────────────────────────────────────────────────────────
// repoDoc Local — Team Rules Sync (`repodoc rules pull <url>`)
//
// This is an EXPLICIT, user-initiated CONFIG fetch. It is the only place in
// the package (besides `repodoc model pull`) that talks to a non-localhost
// host, and it is deliberately isolated from the scanning pipeline:
//   • it sends a bare GET with no body — no source code, paths or findings;
//   • it never imports the file walker, agent loop or run persistence;
//   • it is refused under --offline;
//   • the response is schema-validated before anything is written to disk.
// Code scans remain 100% offline / zero-egress.
// ─────────────────────────────────────────────────────────────────────────────

import fs from "fs";
import path from "path";
import {
  GuardrailRule,
  mergeRules,
  parseRepodocYml,
  serializeRepodocYml,
  validateRules,
} from "./guardrails.js";

export const MAX_RULES_BYTES = 512 * 1024; // 512 KB is plenty for a ruleset
export const PULL_TIMEOUT_MS = 15_000;

export interface PullOptions {
  outPath: string;
  offline?: boolean;
  merge?: boolean;
  fetchImpl?: typeof fetch;
}

export interface PullResult {
  url: string;
  outPath: string;
  rules: GuardrailRule[];
  totalRules: number;
}

/** Only https (or http to localhost for self-hosted dev) is allowed. */
export function assertAllowedUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid URL: ${raw}`);
  }
  const isLocal = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocal)) {
    throw new Error("Only https:// URLs are allowed for rules pull (http:// is permitted for localhost only).");
  }
  return url;
}

/** Parse + validate YAML text against the repodoc.yml schema. */
export function parseAndValidateRulesYaml(text: string): GuardrailRule[] {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Response is empty.");
  if (/^<(!doctype|html)/i.test(trimmed)) {
    throw new Error("Response is HTML, not YAML. Use the raw / export URL of the ruleset.");
  }
  if (!/^rules\s*:/m.test(trimmed)) {
    throw new Error("Response is not a repodoc.yml file (missing top-level `rules:` key).");
  }
  const rules = parseRepodocYml(trimmed);
  if (rules.length === 0) throw new Error("Ruleset contains no (enabled) rules.");
  const errors = validateRules(rules);
  if (errors.length > 0) {
    throw new Error(`Ruleset failed schema validation:\n  - ${errors.join("\n  - ")}`);
  }
  return rules;
}

/** Fetch a remote repodoc.yml, validate it, and write it locally. */
export async function pullRules(rawUrl: string, opts: PullOptions): Promise<PullResult> {
  if (opts.offline) {
    throw new Error("rules pull needs network access and is disabled by --offline.");
  }
  const url = assertAllowedUrl(rawUrl);
  const doFetch = opts.fetchImpl ?? fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PULL_TIMEOUT_MS);
  let res: Response;
  try {
    // Bare GET: no body, no repository data of any kind.
    res = await doFetch(url.toString(), {
      method: "GET",
      headers: { Accept: "text/yaml, application/x-yaml, text/plain" },
      signal: controller.signal,
    });
  } catch (err) {
    throw new Error(`Failed to fetch rules from ${url.host}: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new Error(`Rules server returned HTTP ${res.status} for ${url.host}${url.pathname}`);
  }

  const text = await res.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RULES_BYTES) {
    throw new Error(`Ruleset is larger than ${MAX_RULES_BYTES / 1024} KB; refusing to write it.`);
  }

  const rules = parseAndValidateRulesYaml(text);
  const existing =
    opts.merge && fs.existsSync(opts.outPath)
      ? parseRepodocYml(fs.readFileSync(opts.outPath, "utf8"))
      : [];
  const finalRules = opts.merge ? mergeRules(existing, rules) : rules;

  fs.mkdirSync(path.dirname(opts.outPath), { recursive: true });
  fs.writeFileSync(
    opts.outPath,
    serializeRepodocYml(finalRules, { comment: `repoDoc guardrails pulled from ${url.host}${url.pathname}` }),
    "utf8"
  );

  return { url: url.toString(), outPath: opts.outPath, rules, totalRules: finalRules.length };
}
