# repodoc-local

> **repoDoc Local** — offline AI-powered repository analysis and patch agent.

[![Node >=18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://www.typescriptlang.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## Overview

`repodoc-local` is the offline CLI component of [repoDoc](https://repodoc.app). It runs a local Gemma model via [Ollama](https://ollama.com) to analyse a repository, detect bugs, generate patches, and optionally apply them — all without sending your code to any cloud.

```
repoDoc Local v0.1.0
Analyzing ./my-project with model=auto
```

---

## Design

Terminal aesthetic: **dark brutalist** — `#0A0A0A` background, `#4ADE80` (emerald-400) accent, monospace output throughout.

---

## Installation

```bash
npm install -g repodoc-local
# or run without installing:
npx repodoc-local <path>
```

Requires [Ollama](https://ollama.com/download) to be running locally.

---

## Usage

```
repodoc [path] [options]
repodoc model pull [--model <tier>]
repodoc model list
repodoc model rm <tier>
repodoc open-live
```

### Global options

| Flag | Default | Description |
|------|---------|-------------|
| `--model <tier>` | `auto` | `gemma-4-e4b` \| `gemma-4-e2b` \| `auto` |
| `--offline` | `false` | Disable all network calls |
| `--apply` | `false` | Auto-apply generated patches |
| `--run-tests` | `false` | Run repo test suite after patching (opt-in, may be slow) |
| `--json` | `false` | Output machine-readable JSON |
| `--check-hardware` | — | Print hardware info and recommended model, then exit |
| `--audit` | — | Run security/guardrail audit only |
| `--check-network` | — | Check Ollama reachability and exit |

### Examples

```bash
# Analyse current directory (auto-select model)
repodoc .

# Analyse a specific repo with a specific model, apply patches
repodoc ~/projects/my-app --model gemma-4-e2b --apply

# Check if your hardware can run the models
repodoc --check-hardware

# Pull the recommended model
repodoc model pull

# Output JSON for CI pipelines
repodoc . --json
```

---

## Development

```bash
npm install
npm run build      # tsc → dist/
npm run dev        # ts-node src/cli.ts
npm test           # jest
```

---

## Model tiers

| Tier | Ollama tag | Est. RAM | Download |
|------|-----------|----------|----------|
| `gemma-4-e4b` | `gemma4:4b-instruct-e` | ~6 GB | ~3 GB |
| `gemma-4-e2b` | `gemma4:2b-instruct-e` | ~4 GB | ~2 GB |

`auto` selects the best tier based on available RAM detected at runtime.

---

## Prefer not to install?

Use the hosted live app: **https://repodoc.app**

---

## License

MIT © repoDoc contributors
