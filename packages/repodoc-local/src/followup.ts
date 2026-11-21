// ─────────────────────────────────────────────────────────────────────────────
// repoDoc Local — Follow-up & Chat
// Ask questions or chat interactively over saved analysis runs.
// Grounded strictly in saved findings, diffs, explanations, and file excerpts.
// ─────────────────────────────────────────────────────────────────────────────

import fs from "fs";
import path from "path";
import readline from "readline";
import chalk from "chalk";
import { LocalLLM } from "./local-llm.js";
import { loadRun } from "./persistence.js";
import { redactSecrets } from "./secret-redactor.js";
import { SavedRun, ModelTier } from "./types.js";

export interface FollowupOptions {
  repoPath: string;
  runId?: string;
  model?: ModelTier | "auto";
  offline?: boolean;
  debug?: boolean;
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

/**
 * Build grounded context from a saved run for a given question.
 */
export function buildFollowupContext(
  run: SavedRun,
  question: string,
  repoPath: string
): string {
  const qLower = question.toLowerCase();

  // Find relevant bugs or include all if run is small
  const relevantBugs = run.bugs.filter((b) => {
    return (
      qLower.includes(b.file.toLowerCase()) ||
      qLower.includes(b.id.toLowerCase()) ||
      (b.explanation?.rule_id && qLower.includes(b.explanation.rule_id.toLowerCase())) ||
      qLower.includes(b.description.toLowerCase())
    );
  });

  const selectedBugs =
    relevantBugs.length > 0 ? relevantBugs : run.bugs.slice(0, 5);

  const sections: string[] = [];

  // 1. Guardrail findings
  if (run.guardrailFindings.length > 0) {
    const gfLines = run.guardrailFindings
      .slice(0, 10)
      .map(
        (g) =>
          `  - [${g.severity.toUpperCase()}] ${g.ruleId} in ${g.file}${g.line ? `:${g.line}` : ""}: ${g.snippet ?? ""}`
      );
    sections.push(`### Guardrail Findings:\n${gfLines.join("\n")}`);
  } else {
    sections.push(`### Guardrail Findings:\n  No guardrail violations recorded.`);
  }

  // 2. Bugs, Patches & AI-generated explanations
  if (selectedBugs.length > 0) {
    const bugSections = selectedBugs.map((b) => {
      const patch = run.patches.find((p) => p.bugId === b.id || p.file === b.file);
      const exp = b.explanation ?? patch?.explanation;

      const lines = [
        `#### Bug ${b.id} (${b.file}${b.line ? `:${b.line}` : ""})`,
        `  Description: ${b.description}`,
      ];

      if (exp) {
        lines.push(`  [AI-generated explanation]`);
        if (exp.rule_id) lines.push(`    Rule:  ${exp.rule_id}`);
        lines.push(`    What:  ${exp.what}`);
        lines.push(`    Why:   ${exp.why}`);
        lines.push(`    Risk:  ${exp.risk.level} (${exp.risk.check})`);
      }

      if (patch && patch.diff) {
        lines.push(`  Patch diff:\n\`\`\`diff\n${patch.diff}\n\`\`\``);
      }

      return lines.join("\n");
    });

    sections.push(`### Relevant Bugs & Patches:\n${bugSections.join("\n\n")}`);
  } else {
    sections.push(`### Relevant Bugs & Patches:\n  No bugs recorded in this run.`);
  }

  // 3. Small file excerpt (if file exists locally)
  for (const b of selectedBugs) {
    const fullPath = path.resolve(repoPath, b.file);
    if (fs.existsSync(fullPath)) {
      try {
        const rawContent = fs.readFileSync(fullPath, "utf8");
        const redacted = redactSecrets(rawContent).redacted;
        const excerptLines = redacted.split("\n").slice(0, 60);
        sections.push(
          `### File Excerpt (${b.file}, first ${excerptLines.length} lines):\n\`\`\`\n${excerptLines.join("\n")}\n\`\`\``
        );
        break; // Include excerpt from one primary file to stay lean
      } catch {
        // ignore read error
      }
    }
  }

  return sections.join("\n\n");
}

/**
 * Answer a single follow-up question against a saved run.
 */
export async function askQuestion(
  question: string,
  opts: FollowupOptions,
  history: ChatTurn[] = []
): Promise<string> {
  const run = loadRun(opts.repoPath, opts.runId);
  const cleanQuestion = redactSecrets(question).redacted;

  const context = buildFollowupContext(run, cleanQuestion, opts.repoPath);

  const historyText =
    history.length > 0
      ? "\n### Previous Conversation Turns:\n" +
        history
          .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.content}`)
          .join("\n") +
        "\n"
      : "";

  const prompt = [
    `You are repoDoc Local assistant. You answer questions strictly using the saved repository analysis context below.`,
    `If the user's question cannot be answered from the saved analysis context, you MUST say: "I cannot answer this question from the saved analysis context."`,
    `Never invent files, line numbers, or explanations that are not present in the context.`,
    ``,
    `## Saved Analysis Context (Run ID: ${run.id}, Model: ${run.model}):`,
    context,
    historyText,
    `User Question: ${cleanQuestion}`,
    ``,
    `Provide a direct, helpful, and concise answer based ONLY on the context above:`,
  ].join("\n");

  if (opts.debug) {
    console.log(
      chalk.cyan(`\n[debug] Follow-up prompt size: ${prompt.length} chars (~${Math.round(prompt.length / 4)} tokens)`)
    );
  }

  const modelTier: ModelTier =
    opts.model && opts.model !== "auto" ? opts.model : run.model;
  const llm = new LocalLLM({ model: modelTier });

  const isAvail = await llm.isAvailable();
  if (!isAvail) {
    throw new Error(
      "Ollama service is not responding at http://localhost:11434. Start it with: ollama serve"
    );
  }

  const response = await llm.complete(prompt, {
    format: "", // plain text response
    think: false,
    options: {
      num_ctx: 8192,
      num_predict: 1024,
      temperature: 0,
    },
  });

  if (opts.debug) {
    console.log(chalk.cyan(`[debug] done_reason: ${response.doneReason ?? "unknown"}`));
    console.log(chalk.cyan(`[debug] Raw response:\n${response.text}\n`));
  }

  return response.text.trim();
}

/**
 * Launch an interactive in-memory chat session over a saved run.
 */
export async function startChat(opts: FollowupOptions): Promise<void> {
  const run = loadRun(opts.repoPath, opts.runId);

  console.log();
  console.log(chalk.bold.green("repoDoc Interactive Chat"));
  console.log(chalk.gray("────────────────────────────────────────"));
  console.log(`Run ID:      ${chalk.white(run.id)}`);
  console.log(`Timestamp:   ${chalk.gray(run.timestamp)}`);
  console.log(`Repository:  ${chalk.white(run.repoPath)}`);
  console.log(`Model:       ${chalk.cyan(run.model)}`);
  console.log(`Findings:    ${chalk.yellow(String(run.guardrailFindings.length))} guardrails, ${chalk.yellow(String(run.bugs.length))} bugs`);
  console.log(chalk.gray("────────────────────────────────────────"));
  console.log(
    chalk.dim("Type your question below. Type 'exit' or 'quit' to end session.\n")
  );

  const history: ChatTurn[] = [];

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const promptUser = (): Promise<string> =>
    new Promise((resolve) => {
      rl.question(chalk.green("repodoc> "), (answer) => {
        resolve(answer.trim());
      });
    });

  try {
    while (true) {
      const input = await promptUser();
      if (!input || input.toLowerCase() === "exit" || input.toLowerCase() === "quit") {
        console.log(chalk.gray("\nSession ended."));
        break;
      }

      try {
        // Keep last 4 turns (2 user, 2 assistant)
        const recentHistory = history.slice(-4);
        const answer = await askQuestion(input, opts, recentHistory);

        console.log();
        console.log(chalk.white(answer));
        console.log();

        history.push({ role: "user", content: input });
        history.push({ role: "assistant", content: answer });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.hex("#F87171")(`[error] ${msg}`));
        console.log();
      }
    }
  } finally {
    rl.close();
  }
}
