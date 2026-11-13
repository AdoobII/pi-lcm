import type { LcmConfig } from "../types.js";
import type { Db } from "../db/driver.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { lcmGrep } from "./grep.js";
import { lcmDescribe } from "./describe.js";
import { lcmExpand } from "./expand.js";
import { lcmStore } from "./store.js";
import { lcmStats } from "./stats.js";

export interface ToolDeps {
  getDb(): Db;
  getDbPath(): string;
  getProjectId(): string;
  getSessionId(): string;
  config: LcmConfig;
}

export function registerTools(pi: ExtensionAPI, deps: ToolDeps): void {
  lcmGrep(pi, deps);
  lcmDescribe(pi, deps);
  lcmExpand(pi, deps);
  lcmStore(pi, deps);
  lcmStats(pi, deps);
}
