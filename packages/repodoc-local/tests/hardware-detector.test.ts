// ─────────────────────────────────────────────────────────────────────────────
// repoDoc Local — Tests: hardware-detector
// ─────────────────────────────────────────────────────────────────────────────

import { jest } from "@jest/globals";
import { selectModel, canComfortablyRunE4B, detectHardware } from "../src/hardware-detector.js";
import type { HardwareInfo } from "../src/types.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeHw(availableRam: number, totalRam = 16, vram?: number): HardwareInfo {
  return {
    totalRam,
    availableRam,
    platform: "linux",
    arch: "x64",
    gpu: vram !== undefined ? { type: "cuda", vram } : { type: "none" },
  };
}

// ── selectModel ────────────────────────────────────────────────────────────

describe("selectModel", () => {
  it("returns gemma-4-e4b when availableRam >= 8", () => {
    expect(selectModel(makeHw(8))).toBe("gemma-4-e4b");
    expect(selectModel(makeHw(10))).toBe("gemma-4-e4b");
    expect(selectModel(makeHw(12))).toBe("gemma-4-e4b");
    expect(selectModel(makeHw(32))).toBe("gemma-4-e4b");
  });

  it("returns gemma-4-e2b when availableRam < 8", () => {
    expect(selectModel(makeHw(7.9))).toBe("gemma-4-e2b");
    expect(selectModel(makeHw(4))).toBe("gemma-4-e2b");
    expect(selectModel(makeHw(0))).toBe("gemma-4-e2b");
  });

  it("returns gemma-4-e4b when gpu vram >= 6, even with low RAM", () => {
    const hw: HardwareInfo = {
      totalRam: 8,
      availableRam: 4,
      platform: "linux",
      arch: "x64",
      gpu: { type: "cuda", vram: 8 },
    };
    expect(selectModel(hw)).toBe("gemma-4-e4b");
  });

  it("returns gemma-4-e2b when gpu vram < 6 and RAM < 8", () => {
    const hw: HardwareInfo = {
      totalRam: 8,
      availableRam: 4,
      platform: "linux",
      arch: "x64",
      gpu: { type: "cuda", vram: 4 },
    };
    expect(selectModel(hw)).toBe("gemma-4-e2b");
  });
});

// ── canComfortablyRunE4B ───────────────────────────────────────────────────

describe("canComfortablyRunE4B", () => {
  it("returns true when availableRam >= 8", () => {
    expect(canComfortablyRunE4B(makeHw(8))).toBe(true);
    expect(canComfortablyRunE4B(makeHw(10))).toBe(true);
    expect(canComfortablyRunE4B(makeHw(16))).toBe(true);
  });

  it("returns false when availableRam < 8 and no GPU", () => {
    expect(canComfortablyRunE4B(makeHw(7.9))).toBe(false);
    expect(canComfortablyRunE4B(makeHw(2))).toBe(false);
  });
});

// ── detectHardware ─────────────────────────────────────────────────────────

jest.mock("os", () => ({
  totalmem: () => 17_179_869_184, // 16 GiB in bytes
  freemem: () => 11_811_160_064,  // ~11 GiB in bytes
  platform: () => "linux",
  arch: () => "x64",
}));

describe("detectHardware", () => {
  it("returns a valid HardwareInfo object", async () => {
    const hw = await detectHardware();

    expect(hw).toBeDefined();
    expect(typeof hw.totalRam).toBe("number");
    expect(typeof hw.availableRam).toBe("number");
    expect(hw.totalRam).toBeGreaterThan(0);
    expect(hw.availableRam).toBeGreaterThanOrEqual(0);
    expect(hw.availableRam).toBeLessThanOrEqual(hw.totalRam + 1); // allow rounding
    expect(["win32", "darwin", "linux"]).toContain(hw.platform);
    expect(["x64", "arm64"]).toContain(hw.arch);
  });

  it("reports platform as linux (mocked)", async () => {
    const hw = await detectHardware();
    expect(hw.platform).toBe("linux");
  });

  it("reports arch as x64 (mocked)", async () => {
    const hw = await detectHardware();
    expect(hw.arch).toBe("x64");
  });

  it("computes RAM from os values", async () => {
    const hw = await detectHardware();
    expect(hw.totalRam).toBeGreaterThan(0);
    expect(hw.availableRam).toBeGreaterThanOrEqual(0);
  });
});
