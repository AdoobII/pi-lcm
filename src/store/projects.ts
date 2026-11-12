import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { Db } from "../db/driver.js";

const projectRootCache = new Map<string, string>();

export function resolveProjectRoot(cwd: string): string {
  if (projectRootCache.has(cwd)) {
    return projectRootCache.get(cwd)!;
  }

  try {
    const root = execFileSync(
      "git",
      ["rev-parse", "--show-toplevel"],
      { cwd, encoding: "utf8" }
    ).trim();
    projectRootCache.set(cwd, root);
    return root;
  } catch {
    projectRootCache.set(cwd, cwd);
    return cwd;
  }
}

export function projectIdFor(root: string): string {
  return createHash("sha256").update(root).digest("hex").slice(0, 16);
}

export function ensureProject(db: Db, root: string): string {
  const id = projectIdFor(root);
  db.prepare(
    "INSERT OR IGNORE INTO projects (id, root, created_at) VALUES (?, ?, datetime('now'))"
  ).run(id, root);
  return id;
}
