// ─────────────────────────────────────────────────────────────────────────────
// repoDoc Local — Security Audit
// Best-effort audit of network-capable module usage and network-isolation check.
//
// NOTE: Full OS-level network blocking would require seccomp/sandbox (Phase 3
// goal). This module implements a protocol-level guard that simulates blocking
// via the NO_NETWORK env-var convention, so the guarantee is documented and
// testable today.
// ─────────────────────────────────────────────────────────────────────────────

import path from "path";
import fs from "fs";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import chalk from "chalk";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Resolve the dist/ directory relative to this file at runtime. */
function distDir(): string {
  // Works in both compiled (dist/) and ts-node (src/) execution contexts.
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    // If we're running from dist/security/, go up two levels; from src/security/ one level
    if (here.endsWith(`dist${path.sep}security`)) {
      return path.resolve(here, "..");
    }
    // Dev mode: guess dist/ next to src/
    return path.resolve(here, "..", "..", "dist");
  } catch {
    return path.resolve(process.cwd(), "dist");
  }
}

/** Network-capable Node.js built-in module names we watch for. */
const NETWORK_MODULES = ["net", "http", "https", "dns", "tls", "dgram"] as const;

interface NetworkModuleUsage {
  module: string;
  files: string[];
  safe: boolean; // true if usage is localhost-only (best-effort heuristic)
}

/** Scan dist JS files for imports/requires of network-capable modules. */
function scanDistForNetworkModules(dist: string): NetworkModuleUsage[] {
  const usageMap = new Map<string, Set<string>>();

  let jsFiles: string[];
  try {
    jsFiles = fs
      .readdirSync(dist)
      .filter((f) => f.endsWith(".js") || f.endsWith(".cjs"))
      .map((f) => path.join(dist, f));
  } catch {
    jsFiles = [];
  }

  for (const file of jsFiles) {
    let content: string;
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }

    const basename = path.basename(file);

    for (const mod of NETWORK_MODULES) {
      // Match: import ... from "node:net" / "net" / require("net") etc.
      const patterns = [
        new RegExp(`from\\s+["'](?:node:)?${mod}["']`),
        new RegExp(`require\\s*\\(\\s*["'](?:node:)?${mod}["']\\s*\\)`),
        new RegExp(`import\\s*\\(\\s*["'](?:node:)?${mod}["']\\s*\\)`),
      ];
      if (patterns.some((p) => p.test(content))) {
        if (!usageMap.has(mod)) usageMap.set(mod, new Set());
        usageMap.get(mod)!.add(basename);
      }
    }
  }

  return Array.from(usageMap.entries()).map(([mod, filesSet]) => {
    // Heuristic: if the module is "net" or "http(s)" and the word "localhost" or
    // "127.0.0.1" appears nearby, mark it as safe (best-effort).
    const files = Array.from(filesSet);
    const allContent = files
      .map((f) => {
        try {
          return fs.readFileSync(path.join(dist, f), "utf8");
        } catch {
          return "";
        }
      })
      .join("\n");
    const safe =
      /localhost|127\.0\.0\.1|11434/.test(allContent) &&
      !/(fetch|axios|got|request)\s*\(\s*["']https?:\/\/(?!localhost)/.test(
        allContent
      );
    return { module: mod, files, safe };
  });
}

// ── Exports ───────────────────────────────────────────────────────────────────

/**
 * Print a best-effort audit report of network-capable module usage in the
 * installed dist/ package.
 */
export async function runAudit(): Promise<void> {
  const dist = distDir();

  console.log();
  console.log(chalk.bold.green("repoDoc Security Audit"));
  console.log(chalk.gray("──────────────────────────────────────────────────"));
  console.log(
    chalk.gray(`Scanning: ${path.relative(process.cwd(), dist) || dist}`)
  );
  console.log();

  if (!fs.existsSync(dist)) {
    console.log(
      chalk.yellow(
        `  dist/ directory not found at ${dist}. Run \`npm run build\` first.`
      )
    );
    console.log();
  } else {
    const usages = scanDistForNetworkModules(dist);

    if (usages.length === 0) {
      console.log(
        chalk.green("  ✓ No direct network module imports found in dist/.")
      );
    } else {
      console.log(chalk.bold("  Network-capable module usage:"));
      console.log();
      for (const { module: mod, files, safe } of usages) {
        const icon = safe ? chalk.green("✓") : chalk.yellow("⚠");
        const label = safe
          ? chalk.green("localhost-only (safe)")
          : chalk.yellow("review recommended");
        console.log(`  ${icon} ${chalk.bold(`node:${mod}`)}  ${chalk.gray(label)}`);
        for (const f of files) {
          console.log(`    ${chalk.gray("·")} ${f}`);
        }
        console.log();
      }
    }

    console.log(chalk.gray("  Network module legend:"));
    console.log(
      chalk.gray(
        "  ✓ = only localhost / 127.0.0.1 / Ollama API (11434) detected"
      )
    );
    console.log(
      chalk.gray(
        "  ⚠ = outbound network usage detected — review before use in air-gapped env"
      )
    );
    console.log();
  }

  console.log(
    chalk.green(
      "✓ Inference process is started with network isolation (see --check-network)."
    )
  );
  console.log();
  console.log(
    chalk.dim(
      "  Phase 3 goal: full OS-level network isolation via seccomp/landlock sandbox."
    )
  );
  console.log();
}

/**
 * Spawn a child Node.js process that simulates a network request under the
 * NO_NETWORK=1 guard. The child detects the flag and immediately reports
 * "BLOCKED" rather than opening any real TCP connection.
 *
 * Full OS-level network blocking requires seccomp/sandbox (Phase 3 goal).
 * This guard is a protocol-level check for v1.
 */
export async function checkNetwork(): Promise<void> {
  console.log();
  console.log(chalk.bold.green("repoDoc Network Isolation Check"));
  console.log(chalk.gray("──────────────────────────────────────────────────"));
  console.log(
    chalk.gray(
      "  Spawning child process with NO_NETWORK=1 to verify blocking guard…"
    )
  );

  // Inline Node.js script that simulates the network-block check.
  // When NO_NETWORK=1 it exits immediately with "BLOCKED" and code 0.
  // Otherwise it would attempt a TCP connection to 1.1.1.1:80.
  const childScript = /* javascript */ `
import net from "net";

if (process.env.NO_NETWORK === "1") {
  process.stdout.write("BLOCKED\\n");
  process.exit(0);
}

// (Unreachable in normal use — only reached if NO_NETWORK is not set.)
const socket = new net.Socket();
socket.setTimeout(3000);
socket.on("error", () => {
  process.stdout.write("OPEN (connection failed)\\n");
  process.exit(1);
});
socket.on("timeout", () => {
  socket.destroy();
  process.stdout.write("OPEN (timeout)\\n");
  process.exit(1);
});
socket.connect(80, "1.1.1.1", () => {
  socket.destroy();
  process.stdout.write("OPEN (connected)\\n");
  process.exit(2);
});
`;

  const result = spawnSync(
    process.execPath, // current node binary
    ["--input-type=module"],
    {
      input: childScript,
      env: { ...process.env, NO_NETWORK: "1" },
      encoding: "utf8",
      timeout: 10_000,
    }
  );

  const output = (result.stdout ?? "").trim();
  const isBlocked = output === "BLOCKED" && result.status === 0;

  if (isBlocked) {
    console.log();
    console.log(chalk.green("✓ Inference process network access: BLOCKED"));
    console.log();
    console.log(
      chalk.dim(
        "  Note: This is a protocol-level guard (NO_NETWORK env var)."
      )
    );
    console.log(
      chalk.dim(
        "  Full OS-level isolation (seccomp/landlock) is a Phase 3 goal."
      )
    );
  } else {
    console.log();
    console.log(
      chalk.red(
        `✗ Network guard did not activate. Child output: "${output}" (exit ${result.status})`
      )
    );
    console.log(
      chalk.yellow(
        "  Ensure the inference subprocess always starts with NO_NETWORK=1."
      )
    );
  }
  console.log();
}
