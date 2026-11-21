// ─────────────────────────────────────────────────────────────────────────────
// repoDoc Local — Agent Loop (OODA: Observe → Decide → Act → Verify)
// Ported from backend/agent.py for fully offline local execution.
// Design: dark brutalist terminal aesthetic (#0A0A0A bg, emerald-400 accents)
// ─────────────────────────────────────────────────────────────────────────────

import { LocalLLM } from "./local-llm.js";
import { FileEntry, walkRepo } from "./file-walker.js";
import { runGuardrails, BUILTIN_RULES, loadRepoDocYml } from "./guardrails.js";
import { redactSecrets } from "./secret-redactor.js";
import {
  AnalysisResult,
  BugFinding,
  Patch,
  ModelTier,
  Explanation,
  RiskLevel,
} from "./types.js";
import { saveRun } from "./persistence.js";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import chalk from "chalk";

// ── Public Interfaces ─────────────────────────────────────────────────────────

export interface AgentOptions {
  repoPath: string;
  model: ModelTier;
  apply: boolean;
  runTests: boolean;
  offline: boolean;
  promptFile?: string;
  json: boolean;
  debug?: boolean;
}

export interface AgentStep {
  step: "observe" | "decide" | "act" | "verify";
  status: "running" | "done" | "error";
  message: string;
  timestamp: string;
}

export type StepCallback = (step: AgentStep) => void;

// ── Internal Helpers ──────────────────────────────────────────────────────────

function utcNow(): string {
  return new Date().toISOString();
}

function emit(
  onStep: StepCallback | undefined,
  step: AgentStep["step"],
  status: AgentStep["status"],
  message: string
): void {
  const s: AgentStep = { step, status, message, timestamp: utcNow() };
  onStep?.(s);
  if (!process.env["REPODOC_SILENT"]) {
    const icon =
      status === "done" ? chalk.green("✓")
      : status === "error" ? chalk.red("✗")
      : chalk.yellow("→");
    const stepLabel = chalk.bold(step.toUpperCase().padEnd(7));
    console.log(`  ${icon} ${chalk.gray(stepLabel)} ${message}`);
  }
}

/**
 * Build a compact file-map summary string for the LLM prompt.
 * Mirrors build_file_map() in agent.py.
 */
function buildFileMapSummary(files: FileEntry[]): string {
  const byLang: Record<string, string[]> = {};
  for (const f of files) {
    const lang = f.language;
    (byLang[lang] ??= []).push(f.relativePath);
  }

  const hasTests = files.some(
    (f) =>
      f.relativePath.includes("test") ||
      f.relativePath.includes("spec") ||
      f.relativePath.includes("__tests__")
  );

  const hasPytest =
    hasTests &&
    files.some((f) => f.language === "python" && f.relativePath.includes("test"));
  const hasJest =
    hasTests &&
    files.some(
      (f) =>
        (f.language === "typescript" || f.language === "javascript") &&
        (f.relativePath.includes("test") || f.relativePath.includes("spec"))
    );

  const dominantLang = Object.entries(byLang).sort(
    ([, a], [, b]) => b.length - a.length
  )[0]?.[0] ?? "unknown";

  const lines: string[] = [
    `language: ${dominantLang}`,
    `total_files: ${files.length}`,
    `test_framework: ${hasPytest ? "pytest" : hasJest ? "jest" : "none"}`,
    "",
  ];

  for (const [lang, paths] of Object.entries(byLang)) {
    lines.push(`${lang} files (${paths.length}):`);
    for (const p of paths.slice(0, 20)) {
      lines.push(`  - ${p}`);
    }
  }

  return lines.join("\n");
}

/**
 * Load a prompt template from the prompts/ directory adjacent to the
 * package root (or from opts.promptFile if set).
 */
function loadPromptTemplate(
  opts: AgentOptions
): string {
  if (opts.promptFile && fs.existsSync(opts.promptFile)) {
    return fs.readFileSync(opts.promptFile, "utf8");
  }

  // Look for the prompts/ folder next to the package
  const candidates = [
    // 1. Alongside the installed package (dist/../prompts/)
    path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "prompts"),
    // 2. Relative to cwd (dev mode)
    path.resolve(process.cwd(), "prompts"),
  ];

  const templateName =
    opts.model === "gemma-4-e4b" ? "analyze-e4b.txt" : "analyze-e2b.txt";

  for (const dir of candidates) {
    const full = path.join(dir, templateName);
    if (fs.existsSync(full)) {
      return fs.readFileSync(full, "utf8");
    }
  }

  // Fallback inline template so the loop works without prompt files
  return opts.model === "gemma-4-e4b"
    ? FALLBACK_E4B_PROMPT
    : FALLBACK_E2B_PROMPT;
}

const FALLBACK_E4B_PROMPT = `You are a code-analysis assistant.

## Repository file map
{{FILE_MAP}}

## Guardrail findings (pre-scan)
{{GUARDRAIL_RESULTS}}

## Code to analyse
{{CODE}}

Identify the top 3 bugs or issues. For each bug output:
- id: short slug (e.g. bug-1)
- file: relative file path
- description: what is wrong and why
- confidence: 0.0 – 1.0

Respond with ONLY valid JSON:
{ "bugs": [{ "id": string, "file": string, "description": string, "confidence": number }] }`;

const FALLBACK_E2B_PROMPT = `You are a code-analysis assistant. Find at most 2 bugs. Keep descriptions under 50 words.

## File map
{{FILE_MAP}}

## Guardrail findings
{{GUARDRAIL_RESULTS}}

## Code
{{CODE}}

Respond with ONLY valid JSON:
{ "bugs": [{ "id": string, "file": string, "description": string, "confidence": number }] }`;

/**
 * Extract the first JSON object from a (possibly noisy) LLM response.
 */
function extractJson(text: string): unknown {
  // Try direct parse first
  try {
    return JSON.parse(text.trim());
  } catch {
    // Try to find JSON block between ```json ... ``` fences
    const fenced = text.match(/```json\s*([\s\S]+?)\s*```/);
    if (fenced?.[1]) {
      try {
        return JSON.parse(fenced[1]);
      } catch {
        // fall through
      }
    }
    // Try to find bare { ... }
    const bare = text.match(/\{[\s\S]+\}/);
    if (bare?.[0]) {
      try {
        return JSON.parse(bare[0]);
      } catch {
        // fall through
      }
    }
    return null;
  }
}

/**
 * Detect which test command this repo uses.
 * Returns null if none can be determined.
 */
function detectTestCommand(
  repoPath: string,
  files: FileEntry[]
): { cmd: string; args: string[] } | null {
  const hasPy = files.some((f) => f.language === "python");
  const hasJs = files.some(
    (f) => f.language === "typescript" || f.language === "javascript"
  );

  if (hasPy) {
    // Check for pytest presence
    const hasPytest =
      fs.existsSync(path.join(repoPath, "pytest.ini")) ||
      fs.existsSync(path.join(repoPath, "setup.cfg")) ||
      files.some((f) => f.relativePath.includes("conftest"));
    if (hasPytest || files.some((f) => f.relativePath.includes("test_"))) {
      return { cmd: "pytest", args: ["-x", "--tb=short", "-q", "--no-header"] };
    }
  }

  if (hasJs && fs.existsSync(path.join(repoPath, "package.json"))) {
    return { cmd: "npm", args: ["test", "--", "--passWithNoTests"] };
  }

  return null;
}

// ── Main Loop ─────────────────────────────────────────────────────────────────

export async function runAgentLoop(
  llm: LocalLLM,
  opts: AgentOptions,
  onStep?: StepCallback
): Promise<AnalysisResult> {
  if (opts.json) {
    process.env["REPODOC_SILENT"] = "1";
  }
  const startMs = Date.now();
  const repoPath = path.resolve(opts.repoPath);

  // ── OBSERVE ────────────────────────────────────────────────────────────────
  emit(onStep, "observe", "running", "Walking repository…");

  let files: FileEntry[];
  try {
    files = await walkRepo(repoPath);
  } catch (err) {
    emit(onStep, "observe", "error", `Failed to walk repo: ${err}`);
    throw err;
  }

  // Redact secrets from every file in-place (content only, not paths)
  const redactedFiles: FileEntry[] = files.map((f) => ({
    ...f,
    content: redactSecrets(f.content).redacted,
  }));

  // Load custom + built-in rules
  const customRules = loadRepoDocYml(repoPath);
  const allRules = [...BUILTIN_RULES, ...customRules];

  // Run pattern-based guardrails (no LLM needed)
  const patternRules = allRules.filter((r) => r.type === "pattern");
  const guardrailFindings = await runGuardrails(redactedFiles, patternRules);

  emit(
    onStep,
    "observe",
    "done",
    `Scanned ${files.length} files · ${guardrailFindings.length} guardrail finding(s)`
  );

  // ── DECIDE ─────────────────────────────────────────────────────────────────
  emit(
    onStep,
    "decide",
    "running",
    `Analyzing ${redactedFiles.length} file(s) individually with LLM…`
  );

  const bugs: BugFinding[] = [];
  const invalidFiles: string[] = [];
  const fileErrors: { file: string; reason: string }[] = [];
  let llmReachable = true;
  let llmGeneralError: string | undefined;

  for (const f of redactedFiles) {
    const fileFindings = guardrailFindings.filter(
      (g) => g.file === f.relativePath
    );

    const findingsSummary =
      fileFindings.length === 0
        ? "No guardrail violations."
        : fileFindings
            .map(
              (g) =>
                `[${g.severity.toUpperCase()}] ${g.ruleId}${g.line !== undefined ? `:${g.line}` : ""}: ${g.snippet ?? ""}`
            )
            .join("\n");

    const singleFilePrompt = [
      `You are a strict code review assistant examining the file "${f.relativePath}".`,
      `Never invent file names or lines that are not in this file context.`,
      `Grounded strictly in the guardrail findings and code below, identify real bugs or defects in this file.`,
      ``,
      `## Guardrail Findings for this file:`,
      findingsSummary,
      ``,
      `## File Content (${f.relativePath}):`,
      `\`\`\`${f.language}`,
      f.content.slice(0, 16_000),
      `\`\`\``,
      ``,
      `For every bug:`,
      `- id: short identifier (e.g. "bug-1")`,
      `- file: MUST be "${f.relativePath}"`,
      `- line: exact line number in this file where problem occurs (or null)`,
      `- rule_id: matching guardrail rule ID if applicable, or null`,
      `- what: concise statement of the problem (1–2 sentences)`,
      `- why: 1–3 sentences explaining why the change fixes it, grounded ONLY in finding, rule and diff`,
      `- risk: {"level": "low" | "medium" | "high", "check": "what developer should double-check"}`,
      `- diff: unified diff patch fixing the bug`,
      ``,
      `Respond with ONLY a JSON object in this format:`,
      `{"bugs":[{"id":"bug-1","file":"${f.relativePath}","line":1,"rule_id":"no_eval","what":"...","why":"...","risk":{"level":"low","check":"..."},"diff":"..."}]}`,
      `If there are no bugs, respond with: {"bugs":[]}`,
    ].join("\n");

    if (opts.debug) {
      const estimatedTokens = Math.round(singleFilePrompt.length / 4);
      console.log(
        chalk.cyan(
          `\n[debug] Prompt size for ${f.relativePath}: ${singleFilePrompt.length} chars (~${estimatedTokens} tokens)`
        )
      );
    }

    try {
      const response = await llm.complete(singleFilePrompt);

      if (opts.debug) {
        console.log(
          chalk.cyan(`[debug] done_reason: ${response.doneReason ?? "unknown"}`)
        );
        console.log(
          chalk.cyan(`[debug] Raw response:\n${response.text}\n`)
        );
      }

      // Check if truncated
      if (response.doneReason === "length") {
        invalidFiles.push(f.relativePath);
        fileErrors.push({
          file: f.relativePath,
          reason: "response truncated (done_reason == length)",
        });
        continue;
      }

      const parsed = extractJson(response.text);
      if (!parsed || typeof parsed !== "object" || !("bugs" in parsed)) {
        invalidFiles.push(f.relativePath);
        fileErrors.push({
          file: f.relativePath,
          reason: "failed JSON parsing",
        });
        continue;
      }

      const rawBugs = (parsed as { bugs: unknown[] }).bugs;
      if (Array.isArray(rawBugs)) {
        const fileBugs = rawBugs
          .filter(
            (b): b is Record<string, unknown> =>
              typeof b === "object" && b !== null
          )
          .map((b, idx) => {
            const rawRisk =
              typeof b["risk"] === "object" && b["risk"] !== null
                ? (b["risk"] as Record<string, unknown>)
                : {};
            const riskLevel = ["low", "medium", "high"].includes(
              String(rawRisk["level"])
            )
              ? (rawRisk["level"] as RiskLevel)
              : "medium";
            const riskCheck = String(
              rawRisk["check"] ?? "Review proposed changes carefully"
            );

            const whatText = String(b["what"] || b["description"] || "");
            const whyText = String(b["why"] || "Resolves identified defect.");

            const explanation: Explanation = {
              rule_id: b["rule_id"] ? String(b["rule_id"]) : undefined,
              what: whatText,
              why: whyText,
              risk: {
                level: riskLevel,
                check: riskCheck,
              },
            };

            return {
              id: String(b["id"] ?? `bug-${bugs.length + idx + 1}`),
              file: f.relativePath, // never invent file names!
              line: typeof b["line"] === "number" ? b["line"] : undefined,
              description: whatText,
              confidence: Number(b["confidence"] ?? 0.8),
              explanation,
              _diff: typeof b["diff"] === "string" ? b["diff"] : undefined,
            };
          });
        bugs.push(...fileBugs);
      } else {
        invalidFiles.push(f.relativePath);
        fileErrors.push({
          file: f.relativePath,
          reason: "JSON 'bugs' property is not an array",
        });
      }
    } catch (err: unknown) {
      llmReachable = false;
      llmGeneralError = err instanceof Error ? err.message : String(err);
      if (opts.debug) {
        console.log(
          chalk.red(`[debug] LLM call failed for ${f.relativePath}: ${llmGeneralError}`)
        );
      }
      invalidFiles.push(f.relativePath);
      fileErrors.push({
        file: f.relativePath,
        reason: llmGeneralError.split("\n")[0],
      });
      break;
    }
  }

  const hasInvalidResponse = invalidFiles.length > 0;
  if (!llmReachable) {
    emit(
      onStep,
      "decide",
      "error",
      `LLM call failed (${fileErrors[0]?.reason ?? "connection error"}). Bug detection skipped.`
    );
  } else if (hasInvalidResponse) {
    emit(
      onStep,
      "decide",
      "error",
      `LLM response invalid for ${invalidFiles.length} file(s) (truncated or parse error).`
    );
  } else {
    emit(
      onStep,
      "decide",
      "done",
      `LLM identified ${bugs.length} bug(s) across ${redactedFiles.length} file(s)`
    );
  }

  // ── ACT ────────────────────────────────────────────────────────────────────
  const patches: Patch[] = [];
  const patchDir = path.join(repoPath, ".repodoc", "patches");

  if (!llmReachable) {
    emit(onStep, "act", "error", "Patch generation skipped (LLM unavailable)");
  } else if (bugs.length === 0 && hasInvalidResponse) {
    emit(onStep, "act", "error", "Patch generation skipped (LLM response invalid)");
  } else {
    emit(onStep, "act", "running", `Generating patches for ${bugs.length} bug(s)…`);

    if (opts.apply && bugs.length > 0) {
      fs.mkdirSync(patchDir, { recursive: true });
    }

    for (const bug of bugs as (BugFinding & { _diff?: string })[]) {
      let diffText = bug._diff ?? "";

      if (!diffText) {
        // Find the file content for this bug
        const targetFile = redactedFiles.find((f) => f.relativePath === bug.file);
        const fileContent = targetFile?.content ?? "(file not found)";

        const patchPrompt = [
          `Here is the bug: ${bug.description}`,
          `Explanation: ${bug.explanation?.what ?? ""} Why: ${bug.explanation?.why ?? ""}`,
          ``,
          `Here is the file (${bug.file}):`,
          "```",
          fileContent,
          "```",
          ``,
          `Output ONLY a unified diff patch that fixes this bug. Do not include any explanation.`,
        ].join("\n");

        if (opts.debug) {
          console.log(
            chalk.cyan(`\n[debug] Generating patch diff for ${bug.id} (${bug.file})`)
          );
        }

        try {
          const patchResponse = await llm.complete(patchPrompt, { format: "" });
          const diffMatch =
            patchResponse.text.match(/```diff\s*([\s\S]+?)\s*```/) ??
            patchResponse.text.match(/```\s*([\s\S]+?)\s*```/) ??
            patchResponse.text.match(/(---[\s\S]+)/);
          diffText = diffMatch?.[1] ?? patchResponse.text.trim();
          if (opts.debug) {
            console.log(
              chalk.cyan(`[debug] done_reason: ${patchResponse.doneReason ?? "unknown"}`)
            );
            console.log(chalk.cyan(`[debug] Raw diff response:\n${diffText}\n`));
          }
        } catch (err) {
          emit(onStep, "act", "error", `Patch generation failed for ${bug.id}: ${err}`);
          patches.push({
            bugId: bug.id,
            file: bug.file,
            diff: "",
            applied: false,
            explanation: bug.explanation,
          });
          continue;
        }
      }

      let applied = false;
      if (opts.apply && diffText) {
        const patchPath = path.join(patchDir, `${bug.id}.diff`);
        fs.writeFileSync(patchPath, diffText, "utf8");
        try {
          execSync(`git apply --check "${patchPath}"`, {
            cwd: repoPath,
            stdio: ["pipe", "pipe", "pipe"],
          });
          execSync(`git apply "${patchPath}"`, {
            cwd: repoPath,
            stdio: ["pipe", "pipe", "pipe"],
          });
          applied = true;
        } catch {
          // git apply failed — patch written but not applied
          applied = false;
        }
      }

      patches.push({
        bugId: bug.id,
        file: bug.file,
        diff: diffText,
        applied,
        explanation: bug.explanation,
      });
    }

    emit(
      onStep,
      "act",
      "done",
      `Generated ${patches.length} patch(es)${opts.apply ? ` · ${patches.filter((p) => p.applied).length} applied` : " (dry run)"}`
    );
  }

  // ── VERIFY ─────────────────────────────────────────────────────────────────
  emit(onStep, "verify", "running", "Running verification…");

  if (opts.runTests) {
    console.log(
      chalk.yellow(
        "\n  ⚠ --run-tests is set. This will execute the repository's own test suite.\n"
      )
    );
    const testCmd = detectTestCommand(repoPath, files);
    if (testCmd) {
      try {
        const result = execSync(
          `${testCmd.cmd} ${testCmd.args.join(" ")}`,
          { cwd: repoPath, stdio: ["pipe", "pipe", "pipe"], timeout: 120_000 }
        ).toString("utf8");
        console.log(chalk.gray(result.slice(0, 2000)));
      } catch (err: unknown) {
        const e = err as { stdout?: Buffer; stderr?: Buffer; message?: string };
        const out = e.stdout?.toString("utf8") ?? "";
        const errOut = e.stderr?.toString("utf8") ?? "";
        console.log(chalk.red("Test run output:"));
        console.log(chalk.gray((out + errOut).slice(0, 2000)));
      }
    } else {
      console.log(chalk.gray("  No test command detected for this repository."));
    }
  }

  // Print generated patches with AI-generated explanations in CLI
  if (!opts.json && patches.length > 0) {
    console.log(chalk.bold.green("\n─── Generated Patches & Explanations ─────────────"));
    for (const [idx, p] of patches.entries()) {
      console.log();
      console.log(
        chalk.bold(
          `Patch #${idx + 1}: ${chalk.cyan(p.bugId)} (${chalk.white(p.file)})` +
            (p.applied ? chalk.green(" [applied]") : "")
        )
      );
      if (p.explanation) {
        console.log(chalk.cyan("  [AI-generated explanation]"));
        if (p.explanation.rule_id) {
          console.log(`    ${chalk.gray("Rule:")}  ${chalk.white(p.explanation.rule_id)}`);
        }
        console.log(`    ${chalk.gray("What:")}  ${chalk.white(p.explanation.what)}`);
        console.log(`    ${chalk.gray("Why:")}   ${chalk.white(p.explanation.why)}`);
        const riskColor =
          p.explanation.risk.level === "low"
            ? chalk.green
            : p.explanation.risk.level === "high"
            ? chalk.red
            : chalk.yellow;
        console.log(
          `    ${chalk.gray("Risk:")}  ${riskColor(p.explanation.risk.level.toUpperCase())} — ${chalk.dim(p.explanation.risk.check)}`
        );
      }
      if (p.diff) {
        console.log(chalk.gray("  Diff preview:"));
        const diffPreview = p.diff.split("\n").slice(0, 8).join("\n");
        console.log(chalk.dim(diffPreview));
      }
    }
    console.log(chalk.bold.green("──────────────────────────────────────────────────"));
  }

  // Print summary
  const durationMs = Date.now() - startMs;

  let runId: string | undefined;
  try {
    runId = saveRun(
      repoPath,
      {
        repoPath,
        model: opts.model,
        guardrailFindings,
        bugs,
        patches,
        durationMs,
        llmError: !llmReachable ? (llmGeneralError ?? "LLM connection failed") : undefined,
        llmResponseInvalid: hasInvalidResponse,
        invalidFiles: hasInvalidResponse ? invalidFiles : undefined,
      },
      files.length
    );
  } catch (err) {
    if (opts.debug) {
      console.log(chalk.red(`[debug] Failed to save run: ${err}`));
    }
  }

  if (!opts.json) {
    console.log();
    console.log(chalk.bold.green("─── repoDoc Analysis Summary ────────────────────"));
    console.log(`  ${chalk.gray("Files scanned:")}    ${chalk.white(files.length)}`);
    console.log(
      `  ${chalk.gray("Guardrail findings:")} ${chalk.white(guardrailFindings.length)}`
    );
    if (!llmReachable) {
      console.log(
        `  ${chalk.gray("Bugs found:")}       ${chalk.hex("#F87171")("[SKIPPED — LLM failed/unavailable]")}`
      );
      console.log(
        `  ${chalk.gray("Patches generated:")} ${chalk.hex("#71717A")("[SKIPPED]")}`
      );
      console.log();
      console.log(
        chalk.hex("#FACC15")("  ⚠ WARNING: LLM reasoning could not be completed.")
      );
      console.log(
        chalk.hex("#F87171")(`    ${fileErrors[0]?.reason ?? "LLM connection failed"}`)
      );
    } else if (hasInvalidResponse) {
      console.log(
        `  ${chalk.gray("Bugs found:")}       ${chalk.hex("#F87171")("[LLM response invalid]")}`
      );
      console.log(
        `  ${chalk.gray("Patches generated:")} ${chalk.hex("#71717A")("[SKIPPED]")}`
      );
      console.log();
      console.log(
        chalk.hex("#FACC15")("  ⚠ WARNING: LLM response invalid")
      );
      for (const err of fileErrors) {
        console.log(
          chalk.hex("#F87171")(`    ${err.file}: ${err.reason}`)
        );
      }
    } else {
      console.log(`  ${chalk.gray("Bugs found:")}       ${chalk.white(bugs.length)}`);
      console.log(`  ${chalk.gray("Patches generated:")} ${chalk.white(patches.length)}`);
    }
    console.log(`  ${chalk.gray("Duration:")}         ${chalk.white(durationMs + "ms")}`);
    if (runId) {
      console.log(`  ${chalk.gray("Run saved:")}        ${chalk.white(`.repodoc/runs/${runId}.json`)}`);
    }
    console.log(chalk.bold.green("──────────────────────────────────────────────────"));
    console.log();
  }

  if (!llmReachable || hasInvalidResponse) {
    emit(onStep, "verify", "error", "Analysis finished with LLM errors");
  } else {
    emit(onStep, "verify", "done", "Analysis complete");
  }

  return {
    repoPath,
    model: opts.model,
    guardrailFindings,
    bugs,
    patches,
    durationMs,
    runId,
    llmError: !llmReachable ? (llmGeneralError ?? "LLM connection failed") : undefined,
    llmResponseInvalid: hasInvalidResponse,
    invalidFiles: hasInvalidResponse ? invalidFiles : undefined,
  };
}
