import { describe, expect, it, vi, beforeEach } from "vitest";
import { createSummarizer, resolveModel, NoModelError } from "../../src/compact/summarizer.js";
import { DEFAULT_CONFIG } from "../../src/config.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model as PiModel, Api, TextContent } from "@earendil-works/pi-ai";

// Create a fake ExtensionContext
function createFakeContext(
  model: PiModel<Api> | null = null,
  modelRegistry: {
    find?: (...args: string[]) => PiModel<Api> | undefined;
    complete?: (...args: unknown[]) => Promise<{ content: TextContent[]; usage: unknown }>;
  } = {}
): ExtensionContext {
  return {
    model: model as PiModel<Api> | undefined,
    modelRegistry: {
      find: modelRegistry.find ?? (() => undefined),
      complete: modelRegistry.complete ?? (() => Promise.resolve({ content: [], usage: {} })),
    } as unknown as { find: (...args: string[]) => PiModel<Api> | undefined; complete: (...args: unknown[]) => Promise<{ content: TextContent[]; usage: unknown }> },
  } as unknown as ExtensionContext;
}

// Fake completion response
const fakeCompletionResponse = {
  content: [{ type: "text", text: "summary" } as TextContent],
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
};

describe("resolveModel", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns ctx.model when config.model is "active"', () => {
    const fakeModel = { id: "active-model" } as unknown as PiModel<Api>;
    const ctx = createFakeContext(fakeModel);
    const config = { ...DEFAULT_CONFIG, model: "active" };

    const result = resolveModel(ctx, config);
    expect(result).toBe(fakeModel);
  });

  it('returns model from modelRegistry.find when config.model is "test/test-model"', () => {
    const fakeModel = { id: "test-model" } as unknown as PiModel<Api>;
    const findMock = vi.fn().mockReturnValue(fakeModel);
    const ctx = createFakeContext(null, { find: findMock });
    const config = { ...DEFAULT_CONFIG, model: "test/test-model" };

    const result = resolveModel(ctx, config);
    expect(result).toBe(fakeModel);
    expect(findMock).toHaveBeenCalledWith("test", "test-model");
  });

  it('returns undefined when config.model is "test/missing"', () => {
    const findMock = vi.fn().mockReturnValue(undefined);
    const ctx = createFakeContext(null, { find: findMock });
    const config = { ...DEFAULT_CONFIG, model: "test/missing" };

    const result = resolveModel(ctx, config);
    expect(result).toBeUndefined();
    expect(findMock).toHaveBeenCalledWith("test", "missing");
  });

  it('returns undefined when config.model is null', () => {
    const ctx = createFakeContext();
    const config = { ...DEFAULT_CONFIG, model: null };

    const result = resolveModel(ctx, config);
    expect(result).toBeUndefined();
  });

  it('returns undefined for malformed model string', () => {
    const findMock = vi.fn();
    const ctx = createFakeContext(null, { find: findMock });
    const config = { ...DEFAULT_CONFIG, model: "invalid" };

    const result = resolveModel(ctx, config);
    expect(result).toBeUndefined();
    expect(findMock).not.toHaveBeenCalled();
  });

  it('returns undefined for empty model string parts', () => {
    const findMock = vi.fn();
    const ctx = createFakeContext(null, { find: findMock });
    const config = { ...DEFAULT_CONFIG, model: "provider/" };

    const result = resolveModel(ctx, config);
    expect(result).toBeUndefined();
    expect(findMock).not.toHaveBeenCalled();
  });
});

describe("createSummarizer", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('throws NoModelError when no model is resolved', () => {
    const ctx = createFakeContext();
    const config = { ...DEFAULT_CONFIG, model: null };

    expect(() => createSummarizer(ctx, config)).toThrow(NoModelError);
    expect(() => createSummarizer(ctx, config)).toThrow("No model available for summarization");
  });

  it('uses leafPrompt and correct maxTokens for depth 0', async () => {
    const fakeModel = { id: "test-model" } as unknown as PiModel<Api>;
    const completeMock = vi.fn().mockResolvedValue(fakeCompletionResponse);
    const ctx = createFakeContext(fakeModel, { complete: completeMock });
    const config = { ...DEFAULT_CONFIG, model: "active", leafSummaryBudget: 1200 };

    const summarizer = createSummarizer(ctx, config);
    await summarizer("test conversation", { depth: 0, aggressive: false });

    expect(completeMock).toHaveBeenCalled();
    const callArgs = completeMock.mock.calls[0]!;
    
    // Check the prompt contains leaf prompt elements
    const messages = callArgs[1] as { messages: Array<{ content: Array<{ text: string }> }> };
    const promptText = messages.messages[0]!.content[0]!.text;
    expect(promptText).toContain("## Goal");
    expect(promptText).toContain("<conversation>");
    expect(promptText).toContain("test conversation");

    // Check maxTokens
    const options = callArgs[2] as { maxTokens: number };
    expect(options.maxTokens).toBe(Math.min(4096, 1200 * 2));
  });

  it('uses condensedPrompt and correct maxTokens for depth 1', async () => {
    const fakeModel = { id: "test-model" } as unknown as PiModel<Api>;
    const completeMock = vi.fn().mockResolvedValue(fakeCompletionResponse);
    const ctx = createFakeContext(fakeModel, { complete: completeMock });
    const config = { ...DEFAULT_CONFIG, model: "active", condensedSummaryBudget: 2000 };

    const summarizer = createSummarizer(ctx, config);
    await summarizer("test conversation", { depth: 1, aggressive: false });

    expect(completeMock).toHaveBeenCalled();
    const callArgs = completeMock.mock.calls[0]!;
    
    // Check the prompt contains condensed prompt elements
    const messages = callArgs[1] as { messages: Array<{ content: Array<{ text: string }> }> };
    const promptText = messages.messages[0]!.content[0]!.text;
    expect(promptText).toContain("condense");
    expect(promptText).toContain("<conversation>");

    // Check maxTokens
    const options = callArgs[2] as { maxTokens: number };
    expect(options.maxTokens).toBe(Math.min(4096, 2000 * 2));
  });

  it('passes cacheRetention: "none" and sessionId to complete call', async () => {
    const fakeModel = { id: "test-model" } as unknown as PiModel<Api>;
    const completeMock = vi.fn().mockResolvedValue(fakeCompletionResponse);
    const ctx = createFakeContext(fakeModel, { complete: completeMock });
    const config = { ...DEFAULT_CONFIG, model: "active" };

    const summarizer = createSummarizer(ctx, config);
    await summarizer("test conversation", { depth: 0, aggressive: false });

    const callArgs = completeMock.mock.calls[0]!;
    const options = callArgs[2] as { cacheRetention: string; sessionId: string };
    
    expect(options.cacheRetention).toBe("none");
    expect(options.sessionId).toBeDefined();
    expect(typeof options.sessionId).toBe("string");
    expect(options.sessionId.length).toBeGreaterThan(0);
  });

  it('throws when text response is empty', async () => {
    const fakeModel = { id: "test-model" } as unknown as PiModel<Api>;
    const emptyResponse = {
      content: [{ type: "text", text: "   " } as TextContent],
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    
    const completeMock = vi.fn().mockResolvedValue(emptyResponse);
    const ctx = createFakeContext(fakeModel, { complete: completeMock });
    const config = { ...DEFAULT_CONFIG, model: "active" };

    const summarizer = createSummarizer(ctx, config);
    await expect(summarizer("test conversation", { depth: 0, aggressive: false })).rejects.toThrow();
  });

  it('returns text and usage from response', async () => {
    const fakeModel = { id: "test-model" } as unknown as PiModel<Api>;
    const completeMock = vi.fn().mockResolvedValue(fakeCompletionResponse);
    const ctx = createFakeContext(fakeModel, { complete: completeMock });
    const config = { ...DEFAULT_CONFIG, model: "active" };

    const summarizer = createSummarizer(ctx, config);
    const result = await summarizer("test conversation", { depth: 0, aggressive: false });

    expect(result.text).toBe("summary");
    expect(result.usage).toEqual(fakeCompletionResponse.usage);
  });

  it('passes signal to complete call', async () => {
    const fakeModel = { id: "test-model" } as unknown as PiModel<Api>;
    const signal = { aborted: false } as unknown as AbortSignal;
    const completeMock = vi.fn().mockResolvedValue(fakeCompletionResponse);
    const ctx = createFakeContext(fakeModel, { complete: completeMock });
    const config = { ...DEFAULT_CONFIG, model: "active" };

    const summarizer = createSummarizer(ctx, config);
    await summarizer("test conversation", { depth: 0, aggressive: false, signal });

    const callArgs = completeMock.mock.calls[0]!;
    const options = callArgs[2] as { signal: AbortSignal };
    expect(options.signal).toBe(signal);
  });
});
