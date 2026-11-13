import { openDatabase } from "../../src/db/driver.js";
import { migrate } from "../../src/db/schema.js";
import { ensureProject } from "../../src/store/projects.js";
import { projectIdFor } from "../../src/store/projects.js";
import type { Db } from "../../src/db/driver.js";

export async function createTestDb(): Promise<{ db: Db; projectId: string }> {
  const db = await openDatabase(":memory:");
  migrate(db);
  
  const projectRoot = "/tmp/test-project";
  const projectId = projectIdFor(projectRoot);
  ensureProject(db, projectRoot);
  
  return { db, projectId };
}
