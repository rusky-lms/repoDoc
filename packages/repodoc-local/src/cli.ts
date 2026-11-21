#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// repoDoc Local — CLI Entrypoint
// Design: dark brutalist terminal, emerald-400 (#4ADE80) on #0A0A0A
// ─────────────────────────────────────────────────────────────────────────────

import { Command, Option } from "commander";
import chalk from "chalk";
import { execSync } from "child_process";
import path from "path";
import type { CliOptions, ModelTier } from "./types.js";
import {
  detectHardware,
  selectModel,
  printHardwareReport,
} from "./hardware-detector.js";
import {
  ensureModel,
  isModelCached,
  MODEL_SPECS,
} from "./model-manager.js";
import { runAudit, checkNetwork } from "./security/audit.js";
import { LocalLLM } from "./local-llm.js";
import { runAgentLoop } from "./agent-loop.js";

// ── Version & Banner ──────────────────────────────────────────────────────────

const VERSION = "0.1.0";

function printBanner(): void {
  console.log(chalk.green(`repoDoc Local v${VERSION}`));
}

async function maybeShowLiveAppHint(): Promise<void> {
  try {
    const hasE4B = await isModelCached("gemma-4-e4b");
    const hasE2B = await isModelCached("gemma-4-e2b");
    if (!hasE4B && !hasE2B) {
      console.log(
        chalk.hex("#71717A")(
          "Prefer not to install? Use the live app: https://repodoc.app"
        )
      );
    }
  } catch {
    // Non-critical hint check
  }
}

// ── Program ───────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name("repodoc")
  .description(
    "repoDoc Local — offline AI-powered repository analysis and patch agent"
  )
  .version(VERSION, "-v, --version", "print version and exit")
  .addOption(
    new Option("--model <tier>", "model tier to use")
      .choices(["gemma-4-e4b", "gemma-4-e2b", "auto"])
      .default("auto")
  )
  .option("--offline", "disable all network calls", false)
  .option("--apply", "auto-apply generated patches", false)
  .option(
    "--run-tests",
    "run repo test suite after patching (opt-in, executes repository code)",
    false
  )
  .option("--json", "output machine-readable JSON", false)
  .option("--debug", "print prompt size, raw response, and done_reason", false)
  .option("--check-hardware", "print hardware info and recommended model, then exit")
  .option("--audit", "run security audit of package network capabilities")
  .option("--check-network", "verify inference process network isolation")
  .hook("preAction", async () => {
    if (!process.argv.includes("--json")) {
      printBanner();
      await maybeShowLiveAppHint();
    }
  });

// ── repodoc <path>  (default: analyze) ───────────────────────────────────────

program
  .argument("[path]", "path to the repository to analyse", ".")
  .action(async (repoPath: string, options: CliOptions & Record<string, boolean>) => {
    // 1. Handle standalone inspection flags
    if (options.checkHardware) {
      const hw = await detectHardware();
      const sel = selectModel(hw);
      printHardwareReport(hw, sel);
      return;
    }

    if (options.checkNetwork) {
      await checkNetwork();
      return;
    }

    if (options.audit) {
      await runAudit();
      return;
    }

    // 2. Resolve parameters
    const targetPath = path.resolve(process.cwd(), repoPath);
    let model = options.model as ModelTier | "auto";
    const offline = Boolean(options.offline);
    const apply = Boolean(options.apply);
    const runTests = Boolean(options.runTests);
    const json = Boolean(options.json);
    const debug = Boolean(options.debug);

    if (runTests && !json) {
      console.log(
        chalk.hex("#FACC15")(
          "[warn] --run-tests is opt-in and executes code from the target repository."
        )
      );
    }

    // 3. Model selection (hardware aware)
    if (model === "auto") {
      const hw = await detectHardware();
      model = selectModel(hw);
      if (!json) {
        console.log(
          chalk.hex("#A1A1AA")(
            `Hardware auto-detect: selected model ${chalk.green(model)} (${hw.availableRam} GB RAM available)`
          )
        );
      }
    }

    // 4. Ensure model availability
    let modelCached = false;
    try {
      await ensureModel(model, { offline, force: false });
      modelCached = true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (offline) {
        if (!json) {
          console.log(
            chalk.hex("#FACC15")(
              `[offline] Model ${model} is not cached locally.\n` +
              `          Continuing with zero-egress pattern guardrails and secret audit.`
            )
          );
        }
      } else {
        console.error(chalk.hex("#F87171")(`[error] ${msg}`));
        process.exit(1);
      }
    }

    // 5. Check LLM availability
    const llm = new LocalLLM({ model });
    if (modelCached) {
      const isAvail = await llm.isAvailable();
      if (!isAvail && !json) {
        console.log(
          chalk.hex("#FACC15")(
            "[warn] Ollama service not responding at http://localhost:11434.\n" +
              "       Pattern guardrails and file scanning will still run.\n" +
              "       Start Ollama with: ollama serve"
          )
        );
      }
    }

    if (!json) {
      console.log(
        chalk.hex("#A1A1AA")(
          `Analyzing ${chalk.white(targetPath)} with model=${chalk.green(model)}` +
            (offline ? chalk.hex("#FACC15")(" [offline]") : "") +
            (apply ? chalk.hex("#4ADE80")(" [apply]") : "") +
            (runTests ? chalk.hex("#FACC15")(" [run-tests]") : "")
        )
      );
      console.log();
    }

    // 6. Run OODA agent loop
    try {
      const result = await runAgentLoop(
        llm,
        {
          repoPath: targetPath,
          model,
          apply,
          runTests,
          offline,
          json,
          debug,
        }
      );

      if (json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log();
        console.log(chalk.bold.green("repoDoc Analysis Complete"));
        console.log(chalk.gray("────────────────────────────────────────"));
        console.log(`Repository:         ${chalk.white(result.repoPath)}`);
        console.log(`Model:              ${chalk.cyan(result.model)}`);
        console.log(`Duration:           ${chalk.white(`${result.durationMs}ms`)}`);
        console.log(
          `Guardrail Findings: ${chalk.yellow(String(result.guardrailFindings.length))}`
        );
        if (result.llmResponseInvalid || (result.invalidFiles && result.invalidFiles.length > 0)) {
          console.log(
            `Bugs Detected:      ${chalk.hex("#F87171")("[LLM response invalid]")}`
          );
          console.log(
            `Patches Generated:  ${chalk.hex("#71717A")("[SKIPPED]")}`
          );
          console.log();
          console.log(
            chalk.hex("#FACC15")(
              "⚠ WARNING: LLM response invalid (response truncated or failed JSON parsing)."
            )
          );
          if (result.invalidFiles) {
            console.log(
              chalk.hex("#F87171")(
                `  Affected files: ${result.invalidFiles.join(", ")}`
              )
            );
          }
        } else if (result.llmError || !modelCached) {
          console.log(
            `Bugs Detected:      ${chalk.hex("#F87171")("[SKIPPED - LLM unavailable]")}`
          );
          console.log(
            `Patches Generated:  ${chalk.hex("#71717A")("[SKIPPED]")}`
          );
          console.log();
          console.log(
            chalk.hex("#FACC15")(
              "⚠ WARNING: LLM bug detection and patch generation could not be performed."
            )
          );
          if (!modelCached) {
            console.log(
              chalk.hex("#F87171")(
                `  Reason: Model ${result.model} is not cached locally. Run \`repodoc model pull\` or start Ollama.`
              )
            );
          } else if (result.llmError) {
            console.log(
              chalk.hex("#F87171")(
                `  Reason: ${result.llmError.split("\n")[0]}`
              )
            );
          }
        } else {
          console.log(
            `Bugs Detected:      ${chalk.yellow(String(result.bugs.length))}`
          );
          console.log(
            `Patches Generated:  ${chalk.green(String(result.patches.length))}`
          );
        }
        console.log();
      }

      if (
        result.llmError ||
        !modelCached ||
        result.llmResponseInvalid ||
        (result.invalidFiles && result.invalidFiles.length > 0)
      ) {
        process.exit(1);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(chalk.hex("#F87171")(`[error] Analysis failed: ${msg}`));
      process.exit(1);
    }
  });

// ── repodoc model <sub-command> ───────────────────────────────────────────────

const modelCmd = program
  .command("model")
  .description("manage local Ollama models");

modelCmd
  .command("pull")
  .description("pull the selected model via Ollama")
  .addOption(
    new Option("--model <tier>", "model tier to pull")
      .choices(["gemma-4-e4b", "gemma-4-e2b", "auto"])
      .default("auto")
  )
  .action(async (options: { model: string }) => {
    let tier = options.model as ModelTier | "auto";
    if (tier === "auto") {
      const hw = await detectHardware();
      tier = selectModel(hw);
      console.log(
        chalk.hex("#A1A1AA")(`Selected ${chalk.green(tier)} based on available hardware.`)
      );
    }
    await ensureModel(tier, { offline: false, force: true });
  });

modelCmd
  .command("list")
  .description("list locally available models")
  .action(async () => {
    console.log();
    console.log(chalk.bold.green("repoDoc Model Status"));
    console.log(chalk.gray("────────────────────────────────────────"));
    for (const [tier, spec] of Object.entries(MODEL_SPECS) as [ModelTier, typeof MODEL_SPECS[ModelTier]][]) {
      const cached = await isModelCached(tier);
      const status = cached
        ? chalk.green("✓ Cached locally")
        : chalk.hex("#71717A")("Not downloaded");
      console.log(
        `  ${chalk.bold(tier.padEnd(14))}  ${chalk.cyan(spec.ollamaTag.padEnd(12))}  ${status}  ${chalk.dim(`(~${spec.downloadSizeGb} GB)`)}`
      );
    }
    console.log();
  });

modelCmd
  .command("rm")
  .argument("<tier>", "model tier to remove (gemma-4-e4b or gemma-4-e2b)")
  .description("remove a locally cached model")
  .action((tier: string) => {
    if (tier !== "gemma-4-e4b" && tier !== "gemma-4-e2b") {
      console.error(
        chalk.hex("#F87171")(`Invalid tier: ${tier}. Choose gemma-4-e4b or gemma-4-e2b`)
      );
      process.exit(1);
    }
    const spec = MODEL_SPECS[tier as ModelTier];
    try {
      console.log(chalk.gray(`Removing model: ${spec.ollamaTag}...`));
      execSync(`ollama rm ${spec.ollamaTag}`, { stdio: "inherit" });
      console.log(chalk.green(`✓ Model ${tier} (${spec.ollamaTag}) removed.`));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(chalk.hex("#F87171")(`Failed to remove model: ${msg}`));
    }
  });

// ── repodoc open-live ─────────────────────────────────────────────────────────

program
  .command("open-live")
  .description("open repoDoc live app in the default browser")
  .action(() => {
    const liveUrl = "https://repodoc.app";
    console.log(chalk.green(`Opening ${liveUrl} ...`));
    const platform = process.platform;
    try {
      if (platform === "darwin") {
        execSync(`open ${liveUrl}`);
      } else if (platform === "win32") {
        execSync(`start ${liveUrl}`);
      } else {
        execSync(`xdg-open ${liveUrl} >/dev/null 2>&1 &`);
      }
    } catch {
      console.log(chalk.hex("#A1A1AA")(`Please open ${liveUrl} in your browser.`));
    }
  });

// ── Parse ─────────────────────────────────────────────────────────────────────

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(chalk.hex("#F87171")("[error]"), err);
  process.exit(1);
});
