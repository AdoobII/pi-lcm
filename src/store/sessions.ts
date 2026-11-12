import type { Db } from "../db/driver.js";

export function ensureSession(
  db: Db,
  projectId: string,
  sessionId: string,
  cwd: string,
  sessionFile?: string,
): void {
  const now = new Date().toISOString();
  
  if (sessionFile) {
    db.prepare(
      `INSERT INTO sessions (id, project_id, cwd, session_file, created_at, updated_at) 
       VALUES (?, ?, ?, ?, ?, ?) 
       ON CONFLICT(id) DO UPDATE SET updated_at = ?, session_file = ?`
    ).run(sessionId, projectId, cwd, sessionFile, now, now, now, sessionFile);
  } else {
    db.prepare(
      `INSERT INTO sessions (id, project_id, cwd, created_at, updated_at) 
       VALUES (?, ?, ?, ?, ?) 
       ON CONFLICT(id) DO UPDATE SET updated_at = ?`
    ).run(sessionId, projectId, cwd, now, now, now);
  }
}
