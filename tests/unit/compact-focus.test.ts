import { mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { openDatabase, type Db } from "../../src/db/driver.js";
import { migrate } from "../../src/db/schema.js";
import { ensureProject } from "../../src/store/projects.js";
import { ensureSession } from "../../src/store/sessions.js";
import { insertMessages } from "../../src/store/messages.js";
import { compactSpan, type CompactionDeps } from "../../src/compact/engine.js";
import { buildFocus, condensedPrompt, DEFAULT_COMPACTION_FOCUS, leafPrompt } from "../../src/compact/prompts.js";
import { DEFAULT_CONFIG } from "../../src/config.js";
import type { SummarizeOptions } from "../../src/types.js";
import { createFakePi } from "../helpers/fake-pi.js";

const summarizeCalls: SummarizeOptions[] = [];

vi.mock("../../src/compact/summarizer.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/compact/summarizer.js")>();
  return {
    ...original,
    createSummarizer: () => async (_text: string, opts: SummarizeOptions) => {
      summarizeCalls.push(opts);
      return { text: "## Goal\nship it\nExpand for details about: commands" };
    },
  };
});

describe("buildFocus", () => {
  it("build_focus_combines_user_and_default", () => {
    expect(buildFocus("  keep the auth rulings ", "keep file paths")).toBe("keep the auth rulings\n\nkeep file paths");
  });

  it("build_focus_returns_undefined_when_empty", () => {
    expect(buildFocus(undefined, "")).toBeUndefined();
    expect(buildFocus("  ", "  \n")).toBeUndefined();
  });

  it("build_focus_uses_whichever_side_is_present", () => {
    expect(buildFocus(undefined, "keep file paths")).toBe("keep file paths");
    expect(buildFocus("only user", "")).toBe("only user");
  });

  it("build_focus_non_string_config_uses_default_keep_list", () => {
    for (const bad of [undefined, null, 42, ["x"], {}]) {
      expect(buildFocus(undefined, bad as unknown as string)).toBe(DEFAULT_COMPACTION_FOCUS);
      expect(buildFocus("user", bad as unknown as string)).toBe(`user\n\n${DEFAULT_COMPACTION_FOCUS}`);
    }
  });

  it("default_focus_names_the_things_worth_keeping", () => {
    expect(DEFAULT_CONFIG.compactionFocus).toBe(DEFAULT_COMPACTION_FOCUS);
    for (const word of ["decisions", "file paths", "commit hashes", "open threads", "preferences", "re-read"]) {
      expect(DEFAULT_COMPACTION_FOCUS).toContain(word);
    }
  });
});

describe("operator directions in prompts", () => {
  it("leaf_and_condensed_prompts_contain_operator_directions", () => {
    expect(leafPrompt(0, false, "focus on auth")).toContain("## Operator directions\nfocus on auth");
    expect(condensedPrompt(1, "focus on auth")).toContain("## Operator directions\nfocus on auth");
    expect(condensedPrompt(1)).not.toContain("Operator directions");
  });
});

describe("condensation focus", () => {
  let db: Db;
  let deps: CompactionDeps;

  beforeEach(async () => {
    db = await openDatabase(":memory:");
    migrate(db);
    const projectId = ensureProject(db, "/tmp/p");
    ensureSession(db, projectId, "s1", "/tmp/p");
    deps = {
      db, projectId, sessionId: "s1", config: { ...DEFAULT_CONFIG, condenseThreshold: 2 }, modelLimit: 12000,
      summarize: vi.fn(async () => ({ text: "## Goal\nship it\nExpand for details about: commands" })),
    };
  });

  function span(prefix: string, customInstructions?: string) {
    const stored = insertMessages(db, deps.projectId, "s1", Array.from({ length: 4 }, (_, i) => ({
      entryId: `${prefix}${i + 1}`, role: i % 2 === 0 ? "user" as const : "assistant" as const,
      content: `message ${i + 1}`, createdAt: `2026-01-01T00:00:0${i}.000Z`,
    })));
    return { messages: stored, firstKeptEntryId: "keep", tokensBefore: 100, previousWasOurs: false, customInstructions };
  }

  it("condensation_receives_the_focus", async () => {
    await compactSpan(deps, span("a", "keep the ledger path"));
    await compactSpan(deps, span("b", "keep the ledger path"));
    const calls = (deps.summarize as ReturnType<typeof vi.fn>).mock.calls as Array<[string, SummarizeOptions]>;
    const condensed = calls.filter(([, opts]) => opts.depth === 1);
    expect(condensed.length).toBeGreaterThan(0);
    for (const [, opts] of condensed) {
      expect(opts.customInstructions).toBe("keep the ledger path");
    }
  });

  it("condensation_without_focus_keeps_customInstructions_undefined", async () => {
    await compactSpan(deps, span("a"));
    await compactSpan(deps, span("b"));
    const calls = (deps.summarize as ReturnType<typeof vi.fn>).mock.calls as Array<[string, SummarizeOptions]>;
    const condensed = calls.filter(([, opts]) => opts.depth === 1);
    expect(condensed.length).toBeGreaterThan(0);
    expect(condensed.every(([, opts]) => opts.customInstructions === undefined)).toBe(true);
  });
});

describe("session_before_compact focus", () => {
  let restore: (() => void) | undefined;

  beforeEach(() => {
    summarizeCalls.length = 0;
  });

  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  async function compactWith(customInstructions: string | undefined) {
    const { default: extension } = await import("../../src/index.js");
    const entry = (id: string, parentId: string | null, role: "user" | "assistant", content: string) => ({
      type: "message", id, parentId, timestamp: "2026-01-01T00:00:00.000Z",
      message: { role, content, timestamp: 1 },
    }) as SessionEntry;
    const branch = [entry("e1", null, "user", "hello"), entry("e2", "e1", "assistant", "hi")];
    const cwd = mkdtempSync(join(tmpdir(), "pi-lcm-focus-"));
    execFileSync("git", ["init", "-q"], { cwd, stdio: "ignore" });
    const previous = { HOME: process.env.HOME, model: process.env.PI_LCM_MODEL, db: process.env.PI_LCM_DB_PATH };
    process.env.HOME = mkdtempSync(join(tmpdir(), "pi-lcm-home-"));
    process.env.PI_LCM_DB_PATH = ":memory:";
    process.env.PI_LCM_MODEL = "test/test-model";
    restore = () => {
      if (previous.HOME === undefined) delete process.env.HOME; else process.env.HOME = previous.HOME;
      if (previous.model === undefined) delete process.env.PI_LCM_MODEL; else process.env.PI_LCM_MODEL = previous.model;
      if (previous.db === undefined) delete process.env.PI_LCM_DB_PATH; else process.env.PI_LCM_DB_PATH = previous.db;
    };
    const fake = createFakePi({ cwd, branch });
    await extension(fake.api);
    await fake.emit("session_start", { type: "session_start", reason: "startup" });
    return fake.emit("session_before_compact", {
      type: "session_before_compact",
      preparation: { firstKeptEntryId: "e2", messagesToSummarize: [], turnPrefixMessages: [], isSplitTurn: false, tokensBefore: 100, fileOps: { readFiles: [], modifiedFiles: [] }, settings: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 } },
      branchEntries: branch,
      customInstructions,
      reason: "manual",
      willRetry: false,
      signal: new AbortController().signal,
    });
  }

  it("before_compact_passes_event_custom_instructions_to_the_span", async () => {
    const result = await compactWith("remember the migration plan");
    expect(result).toBeDefined();
    expect(summarizeCalls.length).toBeGreaterThan(0);
    expect(summarizeCalls[0]!.customInstructions).toBe(`remember the migration plan\n\n${DEFAULT_COMPACTION_FOCUS}`);
  });

  it("before_compact_without_user_focus_still_sends_the_default_focus", async () => {
    await compactWith(undefined);
    expect(summarizeCalls[0]!.customInstructions).toBe(DEFAULT_COMPACTION_FOCUS);
  });
});
