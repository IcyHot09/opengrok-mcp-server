/**
 * Tests for Tasks 4.13, 4.14:
 * - 4.13: Request Origin Validation
 * - 4.14: Credential Rotation Warnings
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { checkCredentialAge, updateCredentialRotationTimestamp, getConfigDirectory, resetConfig } from "../server/config.js";

// ---------------------------------------------------------------------------
// Task 4.14: Credential Rotation Warnings
// ---------------------------------------------------------------------------

describe("Task 4.14 — Credential Age Checking", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opengrok-test-"));
  });

  afterEach(() => {
    // Clean up temp directory (recursively)
    const removeDir = (dir: string): void => {
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir);
        for (const file of files) {
          const filePath = path.join(dir, file);
          const stat = fs.statSync(filePath);
          if (stat.isDirectory()) {
            removeDir(filePath);
          } else {
            fs.unlinkSync(filePath);
          }
        }
        fs.rmdirSync(dir);
      }
    };
    removeDir(tmpDir);
  });

  it("returns null if state file doesn't exist", () => {
    const warning = checkCredentialAge(tmpDir);
    expect(warning).toBeNull();
  });

  it("returns null if credentials are recent (< 365 days)", () => {
    const stateFile = path.join(tmpDir, "last-credential-rotation.json");
    const recentDate = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    fs.writeFileSync(stateFile, JSON.stringify({ rotatedAt: recentDate }));

    const warning = checkCredentialAge(tmpDir);
    expect(warning).toBeNull();
  });

  it("returns warning if credentials are stale (> 365 days)", () => {
    const stateFile = path.join(tmpDir, "last-credential-rotation.json");
    const oldDate = new Date(Date.now() - 400 * 24 * 3600 * 1000).toISOString();
    fs.writeFileSync(stateFile, JSON.stringify({ rotatedAt: oldDate }));

    const warning = checkCredentialAge(tmpDir);
    expect(warning).toBeTruthy();
    expect(warning).toMatch(/Credentials not rotated in \d+ days/);
  });

  it("updateCredentialRotationTimestamp creates config directory", () => {
    const testDir = path.join(tmpDir, "new-config-dir");
    expect(fs.existsSync(testDir)).toBe(false);

    updateCredentialRotationTimestamp(testDir);

    expect(fs.existsSync(testDir)).toBe(true);
    const stateFile = path.join(testDir, "last-credential-rotation.json");
    expect(fs.existsSync(stateFile)).toBe(true);
  });

  it("updateCredentialRotationTimestamp writes ISO timestamp", () => {
    const stateFile = path.join(tmpDir, "last-credential-rotation.json");
    updateCredentialRotationTimestamp(tmpDir);

    const content = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    expect(content.rotatedAt).toBeTruthy();
    expect(new Date(content.rotatedAt).getTime()).toBeGreaterThan(0);
  });

  it("getConfigDirectory respects XDG_CONFIG_HOME", () => {
    const originalXdg = process.env.XDG_CONFIG_HOME;
    try {
      process.env.XDG_CONFIG_HOME = "/custom/config";
      const dir = getConfigDirectory();
      expect(dir.replace(/\\/g, "/")).toBe("/custom/config/opengrok-mcp");
    } finally {
      process.env.XDG_CONFIG_HOME = originalXdg;
    }
  });

  it("getConfigDirectory uses HOME/.config as fallback", () => {
    const originalXdg = process.env.XDG_CONFIG_HOME;
    const originalHome = process.env.HOME;
    try {
      delete process.env.XDG_CONFIG_HOME;
      process.env.HOME = "/home/testuser";
      const dir = getConfigDirectory();
      expect(dir.replace(/\\/g, "/")).toBe("/home/testuser/.config/opengrok-mcp");
    } finally {
      process.env.XDG_CONFIG_HOME = originalXdg;
      process.env.HOME = originalHome;
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: Config loading with credential tracking
// ---------------------------------------------------------------------------

describe("Config loading with credential tracking", () => {
  beforeEach(() => {
    resetConfig();
    process.env.OPENGROK_BASE_URL = "https://opengrok.test/source/";
  });

  afterEach(() => {
    resetConfig();
    delete process.env.OPENGROK_BASE_URL;
  });

  it("loadConfig returns a frozen config object", async () => {
    const { loadConfig } = await import("../server/config.js");
    const config = loadConfig();
    expect(Object.isFrozen(config)).toBe(true);
  });
});
