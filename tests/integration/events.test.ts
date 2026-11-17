import { mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import extension from "../../src/index.js";
import { createFakePi } from "../helpers/fake-pi.js";

let cleanup: (() => void) | undefined;

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

async function boot() {
  const cwd = mkdtempSync(join(tmpdir(), "pi-lcm-events-"));
  execFileSync("git", ["init", "-q"], { cwd, stdio: "ignore" });
  const previousHome = process.env.HOME;
  const previousModel = process.env.PI_LCM_MODEL;
  const previousDb = process.env.PI_LCM_DB_PATH;
  process.env.HOME = mkdtempSync(join(tmpdir(), "pi-lcm-home-"));
  process.env.PI_LCM_DB_PATH = ":memory:";
  delete process.env.PI_LCM_MODEL;
  const fake = createFakePi({ cwd });
  await extension(fake.api);
  cleanup = () => {
    process.env.HOME = previousHome;
    if (previousModel === undefined) delete process.env.PI_LCM_MODEL;
    else process.env.PI_LCM_MODEL = previousModel;
    if (previousDb === undefined) delete process.env.PI_LCM_DB_PATH;
    else process.env.PI_LCM_DB_PATH = previousDb;
  };
  return fake;
}

async function startSession(fake: Awaited<ReturnType<typeof boot>>) {
  await fake.emit("session_start", { type: "session_start", reason: "startup" });
  // Consume the one-shot restore block so prompt recall is not suppressed by surfaced ids.
  await recall(fake, "unrelated warmup");
}

async function recall(fake: Awaited<ReturnType<typeof boot>>, prompt: string): Promise<string[]> {
  const result = await fake.emit<unknown, { message: { content: string } }>("before_agent_start", {
    type: "before_agent_start",
    messageType: "user",
    prompt,
  });
  if (!result) return [];
  return result.message.content.split("\n").filter((line) => line.startsWith("- ["));
}

async function search(fake: Awaited<ReturnType<typeof boot>>, query: string): Promise<string> {
  const result = await fake.tools.get("lcm_grep")!.execute("c", { query }, undefined, undefined, fake.context);
  return JSON.stringify((result as { content: unknown }).content);
}

function storeNumbered(fake: Awaited<ReturnType<typeof boot>>, count: number, tags?: string[]) {
  for (let i = 1; i <= count; i++) {
    fake.emitBus("lcm:store", { content: `kubectl rollout runbook entry ${tags?.join("") ?? "plain"}${i}`, tags });
  }
}

describe("pi-lcm events", () => {
  it("lcm_store_event_inserts_memory", async () => {
    const fake = await boot();
    await startSession(fake);
    fake.emitBus("lcm:store", { content: "always run migrations before deploy", tags: ["mode:plan", "type:rule"] });
    const hits = await recall(fake, "migrations before deploy");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain("always run migrations before deploy");
    const stored = await search(fake, "migrations");
    expect(stored).toContain("always run migrations before deploy");
  });

  it("lcm_store_event_without_project_is_ignored", async () => {
    const fake = await boot();
    expect(() => fake.emitBus("lcm:store", { content: "no project yet" })).not.toThrow();
  });

  it("recall_config_raises_limit", async () => {
    const fake = await boot();
    await startSession(fake);
    storeNumbered(fake, 10);
    fake.emitBus("lcm:recall-config", { limit: 8 });
    const hits = await recall(fake, "kubectl rollout runbook");
    expect(hits).toHaveLength(8);
  });

  it("recall_config_filters_by_tag", async () => {
    const fake = await boot();
    await startSession(fake);
    // Equal tag-token counts keep bm25 ranks tied so every hit clears the score threshold.
    fake.emitBus("lcm:store", { content: "kubectl rollout runbook alpha", tags: ["mode:plan", "type:rule"] });
    fake.emitBus("lcm:store", { content: "kubectl rollout runbook beta", tags: ["mode:plan", "area:one"] });
    fake.emitBus("lcm:store", { content: "kubectl rollout runbook gamma", tags: ["type:rule", "area:two"] });
    fake.emitBus("lcm:recall-config", { tags: ["mode:plan", "type:rule"] });
    const hits = await recall(fake, "kubectl rollout runbook");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain("alpha");
  });

  it("recall_config_null_restores_defaults", async () => {
    const fake = await boot();
    await startSession(fake);
    storeNumbered(fake, 10);
    fake.emitBus("lcm:recall-config", { limit: 8 });
    fake.emitBus("lcm:recall-config", null);
    const hits = await recall(fake, "kubectl rollout runbook");
    expect(hits).toHaveLength(5);
  });

  it("override_survives_session_start", async () => {
    const fake = await boot();
    await startSession(fake);
    fake.emitBus("lcm:recall-config", { limit: 8 });
    await startSession(fake);
    storeNumbered(fake, 10);
    const hits = await recall(fake, "kubectl rollout runbook");
    expect(hits).toHaveLength(8);
  });

  it("recall_config_tag_filter_finds_match_ranked_below_twice_the_limit", async () => {
    const fake = await boot();
    await startSession(fake);
    // Ten fillers fill the default window (limit 5 * 2), so the target is the 11th hit.
    // The longer tail entry gets the minimum score, which keeps the target above the recall threshold.
    const withExtraWords = (label: string, extra: number) =>
      `kubectl rollout runbook ${label} ${"padding ".repeat(extra).trim()}`;
    for (let i = 1; i <= 10; i++) {
      fake.emitBus("lcm:store", { content: withExtraWords(`filler${i}`, 1), tags: ["area:one", "area:two"] });
    }
    fake.emitBus("lcm:store", { content: withExtraWords("target", 2), tags: ["mode:plan", "type:rule"] });
    fake.emitBus("lcm:store", { content: withExtraWords("tail", 40), tags: ["area:one", "area:two"] });
    fake.emitBus("lcm:recall-config", { tags: ["mode:plan", "type:rule"] });
    const hits = await recall(fake, "kubectl rollout runbook");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain("target");
  });
});
