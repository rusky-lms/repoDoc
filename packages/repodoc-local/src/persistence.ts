// ─────────────────────────────────────────────────────────────────────────────
// repoDoc Local — Persistence
// Saves and retrieves analysis runs in .repodoc/runs/<run-id>.json.
// Zero data leaves the machine.
// ─────────────────────────────────────────────────────────────────────────────

import fs from "fs";
import path from "path";
import { AnalysisResult, SavedRun } from "./types.js";

/** Return the absolute path to .repodoc/runs for a repository. */
export function getRunsDir(repoPath: string): string {
  return path.join(path.resolve(repoPath), ".repodoc", "runs");
}

/**
 * Save an analysis run to .repodoc/runs/<run-id>.json.
 * Returns the generated runId.
 */
export function saveRun(
  repoPath: string,
  result: AnalysisResult,
  filesScanned: number
): string {
  const runsDir = getRunsDir(repoPath);
  if (!fs.existsSync(runsDir)) {
    fs.mkdirSync(runsDir, { recursive: true });
  }

  const runId = result.runId ?? `run-${Date.now()}`;
  const runFilePath = path.join(runsDir, `${runId}.json`);

  const savedRun: SavedRun = {
    id: runId,
    timestamp: new Date().toISOString(),
    repoPath: path.resolve(repoPath),
    model: result.model,
    guardrailFindings: result.guardrailFindings,
    bugs: result.bugs,
    patches: result.patches,
    durationMs: result.durationMs,
    filesScanned,
    llmResponseInvalid: result.llmResponseInvalid,
  };

  fs.writeFileSync(runFilePath, JSON.stringify(savedRun, null, 2), "utf8");
  return runId;
}

/**
 * List all available run IDs for a repository, sorted newest first.
 */
export function listRuns(repoPath: string): string[] {
  const runsDir = getRunsDir(repoPath);
  if (!fs.existsSync(runsDir)) {
    return [];
  }

  try {
    const files = fs
      .readdirSync(runsDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        const fullPath = path.join(runsDir, f);
        const stat = fs.statSync(fullPath);
        return { name: f.replace(/\.json$/, ""), mtime: stat.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);

    return files.map((f) => f.name);
  } catch {
    return [];
  }
}

/**
 * Load a run by ID, or the most recent run if no ID is supplied.
 */
export function loadRun(repoPath: string, runId?: string): SavedRun {
  const runsDir = getRunsDir(repoPath);

  let targetId = runId;
  if (!targetId) {
    const runs = listRuns(repoPath);
    if (runs.length === 0) {
      throw new Error(
        `No saved runs found in ${runsDir}. Please run 'repodoc' first to analyze the repository.`
      );
    }
    targetId = runs[0];
  }

  const fileName = targetId.endsWith(".json") ? targetId : `${targetId}.json`;
  const filePath = path.join(runsDir, fileName);

  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Run "${targetId}" not found in ${runsDir}. Available runs: ${listRuns(repoPath).join(", ") || "none"}`
    );
  }

  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw) as SavedRun;
  } catch (err) {
    throw new Error(`Failed to read or parse run file ${filePath}: ${err}`);
  }
}
