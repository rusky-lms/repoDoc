# PRD: repoDoc — Local-First Edition

## 1. Problem
repoDoc currently relies on a cloud-deployed LLM to reason over repo contents. For orgs with proprietary codebases, sending source code to a hosted/cloud LLM is a non-starter from a security/compliance standpoint. Teams need repoDoc's value (AI-generated repo documentation/understanding) without any code ever leaving the machine.

## 2. Goal
Ship repoDoc as an **npm package** that runs 100% locally:
- No network calls containing repo/source code.
- Reasoning handled by a **small local LM — Qwen3-Coder 7B (primary)**, installed as a dependency of the package (not a separate manual setup step).
- **Gemma 3 4B as an automatic fallback** for machines with low RAM/VRAM that can't comfortably run the 7B model.
- Works out of the box with `npm install` + a CLI/API call — no external cloud API keys required.

## 3. Non-goals (for v1)
- Not targeting multi-user hosted/server deployment (that's the existing cloud product's job).
- Not supporting arbitrary swap-in of any local model in v1 — pin to Qwen3-Coder 7B (+ Gemma 3 4B fallback) first, generalize later.
- Not optimizing for GPU clusters — target dev laptops / CI runners (CPU or consumer GPU).

## 4. Key constraints / risks to resolve early
- **Model size vs npm distribution**: even at 7B/4B, quantized GGUF weights (roughly Q4) land around 4-5GB (Qwen3-Coder 7B) and 2-3GB (Gemma 3 4B) — much more tractable than a 20B model, but still too big for the npm tarball itself. The package ships only the *runtime/wrapper* at install time; model download happens lazily on first run, **after** hardware detection decides which single model to fetch (see §4a) — never both.
- **Inference engine choice**: need a Node-friendly local inference backend — candidates: `node-llama-cpp` (llama.cpp bindings, GGUF), or shelling out to a locally-installed **Ollama** instance. llama.cpp-based is more "batteries included" (no separate daemon the user must install); Ollama is simpler to integrate but adds an external dependency. Whichever is chosen must support both target models.
- **Quality tradeoff**: Qwen3-Coder 7B is code-specialized, which fits repoDoc's use case well; Gemma 3 4B is a general-purpose fallback, so expect a quality drop on the low-RAM path — worth setting expectations (e.g. a CLI warning: "running in fallback mode, output quality may be reduced").
- **License check** on both Qwen3-Coder 7B and Gemma 3 4B for redistribution/bundling as a dependency.
- **Cross-platform builds**: llama.cpp native bindings need prebuilt binaries per OS/arch (mac arm64/x64, linux, windows) — packaging/CI complexity.

## 4a. Hardware detection & model selection (decide-before-download)
Core principle: **detect first, download only the one model that fits.** No downloading both and picking a winner after.

```
npm install repodoc-local
     ↓
Install lightweight repoDoc runtime — NO model download
     ↓
First `repodoc` execution
     ↓
Hardware detection (RAM, CPU arch, OS, GPU/VRAM)
     ↓
Select compatible model (with safety margin, see below)
     ↓
Check local cache → download ONLY the selected model → verify checksum
     ↓
Run inference locally
```

**Detector scope** — not RAM alone; also CPU architecture, OS, and GPU/VRAM availability, since those affect which backend/build (CPU vs CUDA vs Metal) gets used:

```ts
type HardwareInfo = {
  totalRam: number;
  availableRam: number;
  platform: "win32" | "darwin" | "linux";
  arch: "x64" | "arm64";
  gpu?: {
    type: "cuda" | "metal" | "none";
    vram?: number;
  };
};

function selectModel(hw: HardwareInfo): "qwen3-coder-7b" | "gemma-3-4b" {
  return canComfortablyRunQwen(hw) ? "qwen3-coder-7b" : "gemma-3-4b";
}
```

**Safety margin, not raw comparison** — "available RAM > model requirement" is the wrong check, because the OS and other running apps (IDE, browser, etc.) are already consuming memory, and loading the model on top of that causes memory pressure. Requirement needs a margin added on top:

```
Qwen estimated requirement = 6 GB
Safety margin               = 2 GB
---------------------------------
Required available RAM      = 8 GB

available RAM >= 8 GB  → Qwen3-Coder 7B
available RAM <  8 GB  → Gemma 3 4B
```

The exact requirement + margin numbers for both models come out of Phase 0 benchmarking below, not guesswork.

**Cache check before download** — hardware detection and model selection should not automatically trigger a download; if the selected model is already present in the local cache, skip straight to loading it:

```
Hardware detection → Model selection → Check local cache
                                              ↓
                                    ┌─────────┴─────────┐
                                    ↓                   ↓
                                 exists              missing
                                    ↓                   ↓
                              NO DOWNLOAD          Ask user → Download
                                    ↓                   ↓
                                    └─────────┬─────────┘
                                              ↓
                                          Load model
```

**Manual override** — auto-selection is the default, but the user can force a specific model via CLI flag, bypassing hardware detection entirely:

```
repodoc .                        → auto-detect and select
repodoc . --model qwen3-coder-7b → force Qwen3-Coder 7B
repodoc . --model gemma-3-4b     → force Gemma 3 4B
```

**`--check-hardware` diagnostic command** — lets a user inspect the detected hardware and recommended model before running anything, without triggering a download:

```
$ repodoc --check-hardware

repoDoc Hardware Check
────────────────────────────
OS:              Linux x64
RAM:             16 GB
Available RAM:   11.8 GB
GPU:             NVIDIA
VRAM:            8 GB

Recommended model:
✓ Qwen3-Coder 7B

Estimated download: ~5 GB
Estimated memory:   ~6 GB

Run `repodoc` to continue.
```

## 5. Users
Developers/orgs currently using or evaluating repoDoc who are blocked by "no code leaves our network" policy.

## 6. High-level architecture change
Current: CLI/backend → cloud LLM API → response
Target: CLI/backend → local inference wrapper (loads gpt-oss-20B via llama.cpp/Ollama) → response, entirely offline after model download.

---

## 7. Phased plan

### Phase 0 — Feasibility & model decision (spike, ~1 week)
- [ ] Benchmark Qwen3-Coder 7B (quantized GGUF, Q4/Q5) on target dev-laptop specs (CPU-only, and Apple Silicon/Metal) — measure load time, tokens/sec, and actual RAM footprint (not the theoretical model size).
- [ ] Benchmark Gemma 3 4B the same way, as the fallback path.
- [ ] From the above, derive the RAM requirement + safety margin for each model (see §4a) — this sets the real selection threshold, not a guessed number.
- [ ] Decide inference engine: `node-llama-cpp` vs shelling out to local Ollama vs other (e.g. MLC-LLM) — must support both models cleanly, and ideally both CPU and GPU (CUDA/Metal) code paths.
- [ ] Confirm both models' licenses permit redistribution/bundling.
- [ ] A/B output quality on both models against a few sample repos to set expectations for the fallback-mode quality drop.

### Phase 1 — Local inference core
- [ ] Build a minimal `LocalLLM` module: load model, run prompt, stream/return completion — abstracted behind the same interface the current cloud-LLM code path uses.
- [ ] Build the `hardware-detector` module (RAM, CPU arch, OS, GPU/VRAM) and `selectModel()` logic with safety-margin thresholds from Phase 0, per §4a.
- [ ] Implement model weight fetch + local cache (checksum-verified download into `~/.repoDoc/models`) — triggered only after hardware detection has picked a single model, **and only if that model isn't already in the cache**; never download both, never re-download a cached model.
- [ ] Add a clear CLI message when running in fallback mode (model + expected quality impact), and a manual override flag (`--model qwen3-coder-7b` / `--model gemma-3-4b`) to force one model or the other, skipping auto-detection.
- [ ] Add a `--check-hardware` diagnostic command that prints detected OS/RAM/GPU/VRAM, the recommended model, and estimated download/memory footprint — without downloading or running anything (see §4a for expected output format).

### Phase 2 — Swap the reasoning layer
- [ ] Identify every place in `backend/` where the current repoDoc calls the cloud LLM.
- [ ] Replace those calls with the new `LocalLLM` module behind a feature flag (`REPO_DOC_MODE=local`).
- [ ] Adapt prompts/chunking for each model's context window vs. whatever cloud model is used today (likely needs more aggressive chunking/summarization of repo content) — tune separately for Qwen3-Coder 7B and Gemma 3 4B since output style/reliability will differ.
- [ ] Re-validate output quality vs. cloud baseline on a few sample repos (accuracy of docs generated).

### Phase 3 — Package as npm module
- [ ] Restructure repo so the local-first path can be published as a standalone npm package (CLI bin + programmatic API).
- [ ] `postinstall` script: detect OS/arch, pull correct native inference binary, do NOT auto-download the multi-GB model on install (do it lazily on first run, with explicit user confirmation of download size).
- [ ] Strip/guard any residual network calls unrelated to model download (telemetry, cloud fallback, etc.) so it's provably local — this is the actual sellable guarantee for security-conscious orgs.
- [ ] Write clear docs: hardware requirements, first-run download flow, offline behavior after that.

### Phase 4 — Testing & hardening
- [ ] Test on clean machines (no prior model cache) across macOS/Linux/Windows.
- [ ] Test in a network-isolated environment to confirm zero code egress post-setup.
- [ ] Add CI job that runs the local pipeline against a sample repo end-to-end.
- [ ] Load/latency test on a "minimum spec" machine to validate the hardware requirements documented in Phase 3.

### Phase 5 — Release
- [ ] Publish npm package (versioned, e.g. `repodoc-local`).
- [ ] Write a short security/architecture doc orgs can hand to their security team ("what leaves the machine, when, and why") — this is likely the actual deciding factor for adoption.
- [ ] Gather feedback from 1–2 pilot orgs before wider announcement.

---

## 8. Open questions
- Is Qwen3-Coder 7B's quality sufficient for the reasoning tasks repoDoc needs, at the quantization level that's actually runnable locally? Worth a quick A/B against current cloud model output before committing further engineering time.
- What's the exact RAM threshold for triggering the Gemma 3 4B fallback (e.g. <8GB free → fallback)? Needs a number from Phase 0 benchmarking, not a guess.
- Do you want to support GPU acceleration (CUDA/Metal) in v1, or CPU-only first and GPU as fast-follow?
- Should the model download be bundled optionally via separate packages (e.g. "repodoc-model-qwen3-coder-7b", "repodoc-model-gemma3-4b") so users who already have local weights (e.g. via Ollama) can skip the download?