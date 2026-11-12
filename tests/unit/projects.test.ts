import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { projectIdFor, resolveProjectRoot } from "../../src/store/projects.js";
import { ensureDbDirectory, resolveDbPath } from "../../src/db/path.js";
import { DEFAULT_CONFIG } from "../../src/config.js";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-lcm-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

describe("project identity", () => {
  it("resolves a nested cwd to the git root", () => {
    const root = tempRepo();
    const nested = join(root, "a", "b");
    mkdirSync(nested, { recursive: true });
    expect(resolveProjectRoot(nested)).toBe(root);
  });

  it("produces a stable 16-char hash", () => {
    const id = projectIdFor("/tmp/some/project");
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(projectIdFor("/tmp/some/project")).toBe(id);
    expect(projectIdFor("/tmp/other/project")).not.toBe(id);
  });
});

describe("resolveDbPath", () => {
  it("uses the project-local path when trusted", () => {
    const root = tempRepo();
    const path = resolveDbPath({
      cwd: root, projectRoot: root, projectId: "abc123", config: DEFAULT_CONFIG, trusted: true,
    });
    expect(path).toBe(join(root, CONFIG_DIR_NAME, "lcm", "abc123.db"));
  });

  it("falls back to the global path when untrusted", () => {
    const root = tempRepo();
    const path = resolveDbPath({
      cwd: root, projectRoot: root, projectId: "abc123", config: DEFAULT_CONFIG, trusted: false,
    });
    expect(path).toContain(join(".pi", "agent", "lcm", "abc123.db"));
  });

  it("writes a .gitignore inside a project-local directory", () => {
    const root = tempRepo();
    const path = join(root, ".pi", "lcm", "abc123.db");
    ensureDbDirectory(path, true);
    expect(existsSync(join(root, ".pi", "lcm", ".gitignore"))).toBe(true);
    expect(existsSync(join(root, ".pi", "lcm"))).toBe(true);
    writeFileSync(join(root, ".pi", "lcm", "marker"), "x");
  });
});
