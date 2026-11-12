import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type { DbPathOptions, LcmConfig } from "../types.js";

export function resolveDbPath(opts: DbPathOptions): string {
  const { config, projectRoot, projectId, trusted } = opts;

  // If config.dbPath is set, use it
  if (config.dbPath) {
    if (config.dbPath.startsWith("/") || /^[a-zA-Z]:\\/.test(config.dbPath)) {
      // Absolute path
      return config.dbPath;
    }
    // Relative path - resolve from project root
    return resolve(projectRoot, config.dbPath);
  }

  // Default paths
  if (trusted) {
    return join(projectRoot, CONFIG_DIR_NAME, "lcm", `${projectId}.db`);
  } else {
    return join(homedir(), ".pi", "agent", "lcm", `${projectId}.db`);
  }
}

export function ensureDbDirectory(dbPath: string, projectLocal: boolean): void {
  // Return immediately for in-memory or file: paths
  if (dbPath === ":memory:" || dbPath.startsWith("file:")) {
    return;
  }

  const dir = dirname(dbPath);
  mkdirSync(dir, { recursive: true });

  if (projectLocal) {
    const gitignorePath = join(dir, ".gitignore");
    if (!existsSync(gitignorePath)) {
      writeFileSync(gitignorePath, "*\n");
    }
  }
}
