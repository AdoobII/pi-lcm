import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOG_DIR = join(homedir(), ".pi", "agent", "lcm");
const LOG_PATH = join(LOG_DIR, "pi-lcm.log");
const LOG_PATH_1 = join(LOG_DIR, "pi-lcm.log.1");
const MAX_LOG_SIZE = 1_000_000; // 1 MB

async function ensureLogDir(): Promise<void> {
  try {
    await fs.mkdir(LOG_DIR, { recursive: true });
  } catch {
    // Ignore errors
  }
}

async function rotateLog(): Promise<void> {
  try {
    await fs.rename(LOG_PATH, LOG_PATH_1);
  } catch {
    // Ignore errors
  }
}

async function checkRotate(): Promise<void> {
  try {
    const stats = await fs.stat(LOG_PATH);
    if (stats.size >= MAX_LOG_SIZE) {
      await rotateLog();
    }
  } catch {
    // Ignore errors
  }
}

function formatTimestamp(): string {
  return new Date().toISOString();
}

function formatMessage(level: string, message: string): string {
  return `[${formatTimestamp()}] ${level} ${message}`;
}

async function appendLog(level: string, message: string): Promise<void> {
  try {
    await ensureLogDir();
    await checkRotate();
    const line = formatMessage(level, message) + "\n";
    await fs.appendFile(LOG_PATH, line);
  } catch {
    // Swallow all errors
  }
}

export function logError(message: string): void {
  appendLog("ERROR", message).catch(() => {});
}

export function logWarn(message: string): void {
  appendLog("WARN", message).catch(() => {});
}

export function logDebug(message: string): void {
  if (process.env.PI_LCM_DEBUG === "1") {
    appendLog("DEBUG", message).catch(() => {});
  }
}
