/**
 * file-walker.ts — Recursive repo file walker with language detection and skip logic.
 */

import fs from "fs";
import path from "path";
import { buildSkipList } from "./secret-redactor.js";

export interface FileEntry {
  relativePath: string;
  absolutePath: string;
  content: string;
  language: "python" | "typescript" | "javascript" | "unknown";
  lineCount: number;
}

/**
 * Detect source language from file extension.
 */
export function detectLanguage(filename: string): FileEntry["language"] {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".py") return "python";
  if (ext === ".ts" || ext === ".tsx") return "typescript";
  if (ext === ".js" || ext === ".jsx") return "javascript";
  return "unknown";
}

/**
 * Decide whether a relative path should be skipped.
 * Uses simple string checks (no minimatch dependency).
 */
export function shouldSkip(relativePath: string, skipList: string[]): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  const parts = normalized.split("/");
  const filename = parts[parts.length - 1];

  for (const pattern of skipList) {
    const p = pattern.replace(/\\/g, "/");

    // Glob like .git/**, node_modules/**, etc.
    if (p.endsWith("/**")) {
      const prefix = p.slice(0, -3);
      if (normalized === prefix || normalized.startsWith(prefix + "/")) return true;
      continue;
    }

    // Wildcard extension like *.min.js, *.lock
    if (p.startsWith("*.")) {
      const suffix = p.slice(1); // e.g. ".min.js"
      if (filename.endsWith(suffix)) return true;
      continue;
    }

    // Wildcard prefix like .env.*
    if (p.endsWith(".*")) {
      const base = p.slice(0, -2); // e.g. ".env"
      if (filename === base || filename.startsWith(base + ".")) return true;
      continue;
    }

    // Exact filename match (e.g. id_rsa, .env)
    if (!p.includes("/")) {
      if (filename === p) return true;
      // Also skip hidden dirs (e.g. .git, .idea, .vscode) anywhere in path
      if (p.startsWith(".") && parts.includes(p)) return true;
      continue;
    }

    // Exact relative path match
    if (normalized === p) return true;
  }

  // Always skip hidden directories at any level
  for (const part of parts.slice(0, -1)) {
    if (part.startsWith(".") && part !== ".") return true;
    if (part === "node_modules" || part === "__pycache__" || part === "venv") return true;
    if (part === "dist" || part === "build") return true;
  }

  return false;
}

/**
 * Recursively walk a repository directory, returning FileEntry objects.
 *
 * @param repoPath  Absolute path to the repo root.
 * @param opts      Optional limits: maxFiles (default 100), maxFileSizeKb (default 500).
 */
export async function walkRepo(
  repoPath: string,
  opts?: { maxFiles?: number; maxFileSizeKb?: number }
): Promise<FileEntry[]> {
  const maxFiles = opts?.maxFiles ?? 100;
  const maxFileSizeBytes = (opts?.maxFileSizeKb ?? 500) * 1024;
  const skipList = buildSkipList();

  // Resolve the canonical repo root to guard against symlink escape
  const canonicalRoot = fs.realpathSync(repoPath);

  const results: FileEntry[] = [];

  function recurse(dir: string): void {
    if (results.length >= maxFiles) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory — skip silently
    }

    for (const entry of entries) {
      if (results.length >= maxFiles) break;

      const absPath = path.join(dir, entry.name);
      const relPath = path.relative(canonicalRoot, absPath);

      if (shouldSkip(relPath, skipList)) continue;

      if (entry.isSymbolicLink()) {
        // Guard against symlink traversal
        let real: string;
        try {
          real = fs.realpathSync(absPath);
        } catch {
          continue;
        }
        if (!real.startsWith(canonicalRoot + path.sep) && real !== canonicalRoot) continue;
        // If the resolved path is a directory, recurse into it; otherwise treat as file below.
        try {
          const stat = fs.statSync(real);
          if (stat.isDirectory()) {
            recurse(real);
            continue;
          }
        } catch {
          continue;
        }
      }

      if (entry.isDirectory()) {
        recurse(absPath);
        continue;
      }

      if (!entry.isFile() && !entry.isSymbolicLink()) continue;

      // Check file size
      let stat: fs.Stats;
      try {
        stat = fs.statSync(absPath);
      } catch {
        continue;
      }
      if (stat.size > maxFileSizeBytes) continue;

      // Read content
      let content: string;
      try {
        content = fs.readFileSync(absPath, "utf8");
      } catch {
        continue; // binary or unreadable
      }

      results.push({
        relativePath: relPath,
        absolutePath: absPath,
        content,
        language: detectLanguage(entry.name),
        lineCount: content.split("\n").length,
      });
    }
  }

  recurse(canonicalRoot);
  return results;
}
