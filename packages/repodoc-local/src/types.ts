// ─────────────────────────────────────────────────────────────────────────────
// repoDoc Local — Core Types
// Design: dark brutalist terminal aesthetic (#0A0A0A bg, emerald-400 accents)
// ─────────────────────────────────────────────────────────────────────────────

export type Platform = "win32" | "darwin" | "linux";
export type Arch = "x64" | "arm64";
export type GpuType = "cuda" | "metal" | "none";
export type ModelTier = "gemma-4-e4b" | "gemma-4-e2b";

// ── Hardware ─────────────────────────────────────────────────────────────────

export interface HardwareInfo {
  totalRam: number;      // GB
  availableRam: number;  // GB
  platform: Platform;
  arch: Arch;
  gpu?: { type: GpuType; vram?: number };
}

// ── Model ────────────────────────────────────────────────────────────────────

export interface ModelSpec {
  id: ModelTier;
  ollamaTag: string;
  sha256: string;         // placeholder, to be filled in Phase 0
  estimatedRamGb: number;
  downloadSizeGb: number;
}

// ── Explanations ─────────────────────────────────────────────────────────────

export type RiskLevel = "low" | "medium" | "high";

export interface Explanation {
  rule_id?: string;
  what: string;
  why: string;
  risk: {
    level: RiskLevel;
    check: string;
  };
}

// ── Analysis Results ──────────────────────────────────────────────────────────

export interface AnalysisResult {
  repoPath: string;
  model: ModelTier;
  guardrailFindings: GuardrailFinding[];
  bugs: BugFinding[];
  patches: Patch[];
  durationMs: number;
  runId?: string;
  llmError?: string;
  llmResponseInvalid?: boolean;
  invalidFiles?: string[];
}

export interface SavedRun {
  id: string;
  timestamp: string;
  repoPath: string;
  model: ModelTier;
  guardrailFindings: GuardrailFinding[];
  bugs: BugFinding[];
  patches: Patch[];
  durationMs: number;
  filesScanned: number;
  llmResponseInvalid?: boolean;
}

export interface GuardrailFinding {
  ruleId: string;
  ruleName: string;
  severity: "critical" | "warning" | "info";
  file: string;
  line?: number;
  snippet?: string;
}

export interface BugFinding {
  id: string;
  file: string;
  line?: number;
  description: string;
  confidence: number;
  explanation?: Explanation;
}

export interface Patch {
  bugId: string;
  file: string;
  diff: string;
  applied: boolean;
  explanation?: Explanation;
}

// ── CLI Options ───────────────────────────────────────────────────────────────

export interface CliOptions {
  model: ModelTier | "auto";
  offline: boolean;
  apply: boolean;
  runTests: boolean;
  json: boolean;
  debug?: boolean;
  openLive?: boolean;
}

// ── Network Check ─────────────────────────────────────────────────────────────

export interface NetworkStatus {
  online: boolean;
  ollamaReachable: boolean;
  latencyMs?: number;
}

// ── Hardware Check Result ─────────────────────────────────────────────────────

export interface HardwareCheckResult {
  hardware: HardwareInfo;
  recommendedModel: ModelTier;
  warnings: string[];
}
