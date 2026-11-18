import type { Db } from "./db/driver.js";
import type { Model as PiModel, Api } from "@earendil-works/pi-ai";
import type { RecallState } from "./recall/inject.js";
import { createRecallState } from "./recall/inject.js";
import type { LcmConfig } from "./types.js";

export interface ExtensionState {
  db: Db | null;
  dbPromise: Promise<Db> | null;
  dbPath: string | null;
  projectRoot: string | null;
  projectId: string | null;
  sessionId: string | null;
  lastSyncedEntryId: string | null;
  isCompacting: boolean;
  compactRequested: boolean;
  justCompacted: boolean;
  lastFailure: { tokens: number } | null;
  recall: RecallState;
  modelChoice: string | null;
  model: PiModel<Api> | null;
  disabled: boolean;
  config: LcmConfig;
}

export function createExtensionState(): ExtensionState {
  return {
    db: null,
    dbPromise: null,
    dbPath: null,
    projectRoot: null,
    projectId: null,
    sessionId: null,
    lastSyncedEntryId: null,
    isCompacting: false,
    compactRequested: false,
    justCompacted: false,
    lastFailure: null,
    recall: createRecallState(),
    modelChoice: null,
    model: null,
    disabled: false,
    config: {} as LcmConfig,
  };
}
