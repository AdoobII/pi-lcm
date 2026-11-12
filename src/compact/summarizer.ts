import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model as PiModel, AssistantMessage, TextContent, Api } from "@earendil-works/pi-ai";
import type { LcmConfig, SummarizeOptions, SummarizeResult, Summarizer } from "../types.js";
import { leafPrompt, condensedPrompt } from "./prompts.js";
import { uuidv7 } from "@earendil-works/pi-ai";

export class NoModelError extends Error {
  constructor() {
    super("No model available for summarization");
    this.name = "NoModelError";
  }
}

export function resolveModel(ctx: ExtensionContext, config: LcmConfig): PiModel<Api> | undefined {
  if (config.model === "active") {
    return ctx.model as PiModel<Api> | undefined;
  }
  if (config.model === null) {
    return undefined;
  }
  // config.model is "provider/id"
  const modelString = config.model as string;
  const parts = modelString.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return undefined;
  }
  return ctx.modelRegistry.find(parts[0], parts[1]) as PiModel<Api> | undefined;
}

export function createSummarizer(ctx: ExtensionContext, config: LcmConfig): Summarizer {
  const model = resolveModel(ctx, config) as PiModel<Api> | undefined;
  if (!model) {
    throw new NoModelError();
  }

  return async (text: string, opts: SummarizeOptions): Promise<SummarizeResult> => {
    const prompt = opts.depth === 0 ? leafPrompt(opts.depth, opts.aggressive, opts.customInstructions) : condensedPrompt(opts.depth, opts.customInstructions);
    const maxTokens = opts.depth === 0 ? Math.min(4096, config.leafSummaryBudget * 2) : Math.min(4096, config.condensedSummaryBudget * 2);

    const response = await ctx.modelRegistry.complete(model, {
      messages: [{
        role: "user",
        content: [{ type: "text", text: `${prompt}\n\n<conversation>\n${text}\n</conversation>` }],
        timestamp: Date.now(),
      }],
    }, {
      maxTokens,
      signal: opts.signal,
      cacheRetention: "none",
      sessionId: uuidv7(),
    });

    const resultText = response.content.filter((block): block is TextContent => block.type === "text").map((b: TextContent) => b.text).join("");

    if (resultText.trim() === "") {
      throw new Error("Summarization returned empty text");
    }

    return {
      text: resultText,
      usage: response.usage,
    };
  };
}
