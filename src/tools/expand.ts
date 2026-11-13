import { Type, Static } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ToolDeps } from "./index.js";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getMessagesForSummary } from "../store/messages.js";
import { getMessagesBySeqRange } from "../store/messages.js";
import { getSummary } from "../store/summaries.js";
import { searchAll } from "../recall/search.js";
import { estimateTokens } from "../util/tokens.js";

const params = Type.Object({
  target: Type.String({ description: "Target to expand: sum_* ID, messages:N-M range, or free text query" }),
  format: Type.Optional(StringEnum(["full", "condensed"], { description: "Output format: full or condensed" })),
});

type Params = Static<typeof params>;

function formatCondensedSummary(summaryContent: string): string {
  return summaryContent;
}

function formatCondensedMessages(messages: Array<{ role: string; content: string }>): string {
  return messages.map(m => m.content.slice(0, 500)).join("\n");
}

function formatFullMessages(messages: Array<{ role: string; content: string }>, budget: number): string {
  let totalTokens = 0;
  const parts: string[] = [];
  
  for (const msg of messages) {
    const contentTokens = estimateTokens(`[${msg.role}] ${msg.content}`);
    if (totalTokens + contentTokens > budget) {
      parts.push(`[${msg.role}] ${msg.content.slice(0, 200)}...[truncated]`);
      totalTokens += contentTokens;
      break;
    }
    parts.push(`[${msg.role}] ${msg.content}`);
    totalTokens += contentTokens;
  }
  
  return parts.join("\n\n");
}

export function lcmExpand(pi: ExtensionAPI, deps: ToolDeps): void {
  const tool: ToolDefinition = {
    name: "lcm_expand",
    label: "lcm_expand",
    description: "Expand a summary, message range, or search result to see full content",
    parameters: params,
    promptGuidelines: ["Use expand for exact detail when you need to see the full content of messages or summaries."],
    execute: async (action, params, _context, _signal, _extra) => {
      const p = params as Params;
      const db = deps.getDb();
      const projectId = deps.getProjectId();
      const sessionId = deps.getSessionId();
      const config = deps.config;
      const format = p.format ?? "full";
      
      let messages: Array<{ role: string; content: string }> = [];
      let summaryContent: string | null = null;
      
      if (p.target.startsWith("sum_")) {
        // Expand a summary - get its messages
        const storedMessages = getMessagesForSummary(db, p.target);
        messages = storedMessages.map(m => ({ role: m.role, content: m.content }));
        
        // Also get the summary content itself
        const summary = getSummary(db, p.target);
        if (summary) {
          summaryContent = summary.content;
        }
      } else if (p.target.startsWith("messages:")) {
        // Expand a message range: messages:N-M
        const match = p.target.match(/^messages:(\d+)-(\d+)$/);
        if (match) {
          const startSeq = parseInt(match[1]!, 10);
          const endSeq = parseInt(match[2]!, 10);
          // M is inclusive, so use M + 1 as endSeq
          const storedMessages = getMessagesBySeqRange(db, sessionId, startSeq, endSeq + 1);
          messages = storedMessages.map(m => ({ role: m.role, content: m.content }));
        }
      } else {
        // Free text - search and expand the top summary hit
        const hits = searchAll(db, projectId, p.target, { limit: 1, types: ["summary"] });
        if (hits.length > 0 && hits[0]!.type === "summary") {
          const storedMessages = getMessagesForSummary(db, hits[0]!.id);
          messages = storedMessages.map(m => ({ role: m.role, content: m.content }));
          
          const summary = getSummary(db, hits[0]!.id);
          if (summary) {
            summaryContent = summary.content;
          }
        }
      }
      
      let text: string;
      if (format === "condensed") {
        // For condensed: if we have a summary target, return summary text alone
        // Otherwise return first 500 chars of each message
        if (p.target.startsWith("sum_") && summaryContent) {
          text = formatCondensedSummary(summaryContent);
        } else {
          text = formatCondensedMessages(messages);
        }
      } else {
        // full format: render messages as [role] content blocks
        text = formatFullMessages(messages, config.expandBudget);
      }
      
      if (text.length === 0) {
        text = "No content found for target.";
      }
      
      return {
        content: [{ type: "text", text }],
        details: {},
      };
    },
  };
  pi.registerTool(tool);
}
