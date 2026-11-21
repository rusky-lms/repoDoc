# repodoc-local

> **Local-first AI bug fixer and guardrails. Code never leaves your machine. Powered by Gemma 4.**

[![npm version](https://img.shields.io/npm/v/repodoc-local.svg)](https://www.npmjs.com/package/repodoc-local)
[![Node >=18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

> [!WARNING]
> **Alpha Notice**: `repodoc-local` is currently in active alpha. It requires a local [Ollama](https://ollama.com) instance running on your machine to perform local model inference.

---

## What It Does

`repodoc-local` scans your codebase locally, executes zero-egress security guardrails, detects bugs with local Gemma 4 models, generates unified diff patches with AI-grounded explanations, and lets you ask follow-up questions or chat with the analysis context — completely offline.

- **Grounded Bug Detection**: Analyzes files one by one against static guardrail findings. Never invents nonexistent files or hallucinated lines.
- **AI-Generated Explanations**: Every patch includes structured rationale: `rule_id`, `what`, `why`, and `risk` assessment (level + double-check tips).
- **Interactive Follow-ups**: Query and chat against analysis runs using local conversational context.
- **Strict Local Privacy**: Zero external telemetry, zero cloud calls. All models run on your own hardware via Ollama.

---

## Prerequisites

1. **Node.js**: `>=18.0.0`
2. **Ollama**: Installed and running locally ([Download Ollama](https://ollama.com/download))
3. **Gemma 4 model**: Pulled via `repodoc model pull` or `ollama pull gemma4:e4b`

| Tier | Ollama Tag | Download Size | Required RAM | Target Hardware |
|------|------------|---------------|--------------|-----------------|
| `gemma-4-e4b` | `gemma4:e4b` | ~2.8 GB | ~5.5 GB | Recommended (8GB+ RAM) |
| `gemma-4-e2b` | `gemma4:e2b` | ~1.4 GB | ~3.0 GB | Lightweight (<8GB RAM) |

---

## Installation & Quick Start

```bash
# Global install via npm
npm install -g repodoc-local

# Check system hardware & recommended model
repodoc --check-hardware

# Download local model
repodoc model pull

# Run analysis on the current repository
repodoc .
```

You can also run directly with `npx`:

```bash
npx repodoc-local .
```

---

## Commands

### `repodoc [path] [options]`
Analyzes a repository at `[path]` (defaults to `.`):

```bash
# Analyze repository and output human-readable report
repodoc .

# Auto-apply verified patches
repodoc . --apply

# Output structured JSON (CI / automation)
repodoc . --json

# Run completely offline (skips LLM if model not local, runs static guardrails)
repodoc . --offline

# Debug mode (prints prompt tokens, raw model output, done_reason)
repodoc . --debug
```

### `repodoc ask "<question>"`
Ask natural language questions grounded in the latest analysis run (or specify `--run <id>`):

```bash
repodoc ask "Why was the no_eval patch recommended in auth.js?"
repodoc ask "Summarize all high-risk changes" --run run-1795225539813
```

### `repodoc chat`
Start an interactive terminal chat session grounded in the latest saved run:

```bash
repodoc chat
```

### `repodoc model <subcommand>`
Manage local Ollama models:

```bash
repodoc model pull [--model auto|gemma-4-e4b|gemma-4-e2b]
repodoc model list
repodoc model rm <tier>
```

### `repodoc open-live`
Opens the hosted live web app [https://repodoc.app](https://repodoc.app) in your default browser.

---

## Privacy Model & Security

`repodoc-local` is designed from the ground up for strict privacy and confidentiality:

1. **Zero External Egress**: Code is never sent to any external server or API. All LLM calls connect strictly to your local Ollama daemon (`http://127.0.0.1:11434`).
2. **Local Persistence**: Analysis results are persisted strictly inside your project at `.repodoc/runs/<run-id>.json`. Nothing leaves your filesystem.
3. **Automatic Secret Redaction**: Before any code context is passed to the local model or written to run files, sensitive strings (AWS keys, GitHub tokens, private keys, passwords, database URIs) are redacted in memory.
4. **Offline Flag**: Use `--offline` to ensure no network calls are initiated.
5. **No Hallucinations**: Prompt templates strictly ground the LLM to file contents and guardrail findings, preventing fabricated paths or phantom lines.

---

## License

MIT © repoDoc contributors
