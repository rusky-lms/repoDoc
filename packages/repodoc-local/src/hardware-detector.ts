// ─────────────────────────────────────────────────────────────────────────────
// repoDoc Local — Hardware Detection
// Design: dark brutalist terminal aesthetic (#0A0A0A bg, emerald-400 accents)
// ─────────────────────────────────────────────────────────────────────────────

import os from "os";
import { execSync } from "child_process";
import chalk from "chalk";
import { HardwareInfo, ModelTier } from "./types.js";
import { MODEL_SPECS } from "./model-manager.js";

// ── GPU Detection Helpers ─────────────────────────────────────────────────────

function detectLinuxGpu(): HardwareInfo["gpu"] {
  try {
    const raw = execSync(
      "nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits",
      { stdio: ["pipe", "pipe", "pipe"] }
    )
      .toString()
      .trim();
    const vramMb = parseInt(raw.split("\n")[0].trim(), 10);
    if (!isNaN(vramMb)) {
      return { type: "cuda", vram: Math.round(vramMb / 1024) };
    }
  } catch {
    // nvidia-smi not available or no NVIDIA GPU
  }
  return { type: "none" };
}

function detectWindowsGpu(): HardwareInfo["gpu"] {
  try {
    const raw = execSync(
      "wmic path win32_VideoController get AdapterRAM /format:list",
      { stdio: ["pipe", "pipe", "pipe"] }
    ).toString();
    const match = raw.match(/AdapterRAM=(\d+)/);
    if (match) {
      const vramBytes = parseInt(match[1], 10);
      const vramGb = Math.round(vramBytes / (1024 ** 3));
      if (vramGb > 0) {
        return { type: "cuda", vram: vramGb };
      }
    }
  } catch {
    // wmic not available
  }
  return { type: "none" };
}

// ── Core Functions ────────────────────────────────────────────────────────────

export async function detectHardware(): Promise<HardwareInfo> {
  const totalRam = os.totalmem() / (1024 ** 3);
  const availableRam = os.freemem() / (1024 ** 3);
  const rawPlatform = os.platform();
  const rawArch = os.arch();

  // Normalise platform
  const platform = (
    rawPlatform === "win32" ? "win32"
    : rawPlatform === "darwin" ? "darwin"
    : "linux"
  ) as HardwareInfo["platform"];

  // Normalise arch
  const arch = (rawArch === "arm64" ? "arm64" : "x64") as HardwareInfo["arch"];

  // GPU detection per platform
  let gpu: HardwareInfo["gpu"];
  if (platform === "linux") {
    gpu = detectLinuxGpu();
  } else if (platform === "darwin") {
    // Apple Silicon Macs use unified memory via Metal
    gpu = { type: "metal" };
  } else {
    gpu = detectWindowsGpu();
  }

  return {
    totalRam: Math.round(totalRam * 10) / 10,
    availableRam: Math.round(availableRam * 10) / 10,
    platform,
    arch,
    gpu,
  };
}

export function canComfortablyRunE4B(hw: HardwareInfo): boolean {
  // Sufficient GPU VRAM path
  if (hw.gpu && hw.gpu.vram !== undefined && hw.gpu.vram >= 6) return true;
  // Sufficient RAM path: require at least 8 GB available RAM when no GPU with enough VRAM
  if (hw.availableRam >= 8) return true;
  return false;
}

export function selectModel(hw: HardwareInfo): ModelTier {
  return canComfortablyRunE4B(hw) ? "gemma-4-e4b" : "gemma-4-e2b";
}

export function printHardwareReport(
  hw: HardwareInfo,
  selected: ModelTier
): void {
  const divider = chalk.gray("────────────────────────────");

  const gpuLabel =
    hw.gpu?.type === "cuda"
      ? "NVIDIA"
      : hw.gpu?.type === "metal"
      ? "Apple Metal"
      : "None";

  const isE4B = selected === "gemma-4-e4b";
  const modelLabel = isE4B ? "Gemma 4 E4B" : "Gemma 4 E2B";
  const spec = MODEL_SPECS[selected];
  const downloadSize = `~${spec.downloadSizeGb} GB`;
  const ramEstimate = `~${spec.estimatedRamGb} GB`;

  console.log();
  console.log(chalk.bold.green("repoDoc Hardware Check"));
  console.log(divider);

  const pad = (label: string) => label.padEnd(17);
  console.log(
    `${chalk.gray(pad("OS:"))}${chalk.white(`${hw.platform} ${hw.arch}`)}`
  );
  console.log(
    `${chalk.gray(pad("RAM:"))}${chalk.white(`${hw.totalRam} GB`)}`
  );
  console.log(
    `${chalk.gray(pad("Available RAM:"))}${chalk.white(`${hw.availableRam} GB`)}`
  );
  console.log(
    `${chalk.gray(pad("GPU:"))}${chalk.white(gpuLabel)}`
  );
  if (hw.gpu?.vram !== undefined) {
    console.log(
      `${chalk.gray(pad("VRAM:"))}${chalk.white(`${hw.gpu.vram} GB`)}`
    );
  }

  console.log();
  console.log(chalk.bold("Recommended model:"));
  console.log(chalk.green(`✓ ${modelLabel} (${spec.ollamaTag})`));
  console.log();
  console.log(
    `${chalk.gray("Estimated download:")} ${chalk.white(`~${spec.downloadSizeGb} GB (approx.)`)}`
  );
  console.log(
    `${chalk.gray("Estimated memory:  ")} ${chalk.white(`~${spec.estimatedRamGb} GB (approx.)`)}`
  );
  console.log();
  console.log(
    chalk.dim("Run ") +
      chalk.cyan("`repodoc <path>`") +
      chalk.dim(" to analyze a repository.")
  );
  console.log();
}
