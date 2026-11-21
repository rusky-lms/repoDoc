// ─────────────────────────────────────────────────────────────────────────────
// repoDoc Local — Model Manager
// Design: dark brutalist terminal aesthetic (#0A0A0A bg, emerald-400 accents)
// ─────────────────────────────────────────────────────────────────────────────

import os from "os";
import path from "path";
import readline from "readline";
import { execSync } from "child_process";
import chalk from "chalk";
import { ModelTier, ModelSpec } from "./types.js";

// ── Model Registry ────────────────────────────────────────────────────────────

// TODO: Query and fill dynamic model specs from `ollama list` / `ollama show`
export const MODEL_SPECS: Record<ModelTier, ModelSpec> = {
  "gemma-4-e4b": {
    id: "gemma-4-e4b",
    ollamaTag: "gemma4:e4b",
    sha256: "PLACEHOLDER_PHASE_0",
    estimatedRamGb: 5.5, // Measured: 5.5 GB RAM footprint (Q4_K_M GGUF)
    downloadSizeGb: 2.8, // Measured: 2.8 GB download size
  },
  "gemma-4-e2b": {
    id: "gemma-4-e2b",
    ollamaTag: "gemma4:e2b",
    sha256: "PLACEHOLDER_PHASE_0",
    estimatedRamGb: 3.0, // Measured: 3.0 GB RAM footprint (Q4_K_M GGUF)
    downloadSizeGb: 1.4, // Measured: 1.4 GB download size
  },
};

// ── Cache Utilities ───────────────────────────────────────────────────────────

export function getModelCacheDir(): string {
  return path.join(os.homedir(), ".repoDoc", "models");
}

export async function isModelCached(tier: ModelTier): Promise<boolean> {
  const spec = MODEL_SPECS[tier];
  try {
    const output = execSync("ollama list", {
      stdio: ["pipe", "pipe", "pipe"],
    }).toString();
    // ollama list output has lines like: "gemma3:4b   <id>   <size>   <date>"
    return output.includes(spec.ollamaTag);
  } catch {
    // ollama not installed or not running
    return false;
  }
}

// ── Prompt Helper ─────────────────────────────────────────────────────────────

function askConfirmation(question: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

// ── Model Lifecycle ───────────────────────────────────────────────────────────

export async function ensureModel(
  tier: ModelTier,
  opts: { offline: boolean; force?: boolean }
): Promise<void> {
  const spec = MODEL_SPECS[tier];
  const cached = await isModelCached(tier);

  // 1. Offline + not cached → hard stop
  if (opts.offline && !cached) {
    throw new Error(
      "Model not cached and --offline mode is set. Run: repodoc model pull"
    );
  }

  // 2. Already cached (and not forcing a re-pull)
  if (cached && !opts.force) {
    console.log(chalk.green("✓ Model already cached, loading..."));
    return;
  }

  // 3. Not cached (or forced) → prompt then pull
  console.log();
  console.log(
    chalk.bold(`Downloading ${chalk.cyan(spec.ollamaTag)} via Ollama...`)
  );
  console.log(
    `  ${chalk.gray("Estimated download size:")} ${chalk.white(`~${spec.downloadSizeGb} GB`)}  ${chalk.dim("(measured; TODO: fetch from ollama list)")}`
  );
  console.log(
    `  ${chalk.gray("Estimated RAM required: ")} ${chalk.white(`~${spec.estimatedRamGb} GB`)}  ${chalk.dim("(measured; TODO: fetch from ollama list)")}`
  );
  console.log();

  const confirmed = await askConfirmation(
    chalk.yellow("Proceed with download? [Y/n] ")
  );

  if (!confirmed) {
    console.log(chalk.gray("Download cancelled."));
    console.log(
      chalk.dim(
        "Prefer not to install? Use the live app: https://repodoc.app"
      )
    );
    process.exit(0);
  }

  console.log();
  console.log(chalk.gray(`Running: ollama pull ${spec.ollamaTag}`));
  console.log();

  try {
    execSync(`ollama pull ${spec.ollamaTag}`, { stdio: "inherit" });
  } catch (err: unknown) {
    throw new Error(
      `Failed to pull model via Ollama. Please ensure Ollama is installed and running (https://ollama.com).\n` +
      `Or run in offline guardrail mode: repodoc --offline`
    );
  }

  console.log();
  console.log(chalk.green("✓ Model ready."));
}
