import { Type, Static } from "typebox";
import type { ToolDeps } from "./index.js";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { countMessages } from "../store/messages.js";
import { countSummaries } from "../store/summaries.js";
import { countMemories } from "../store/memories.js";

const params = Type.Object({});

type Params = Static<typeof params>;

export function lcmStats(pi: ExtensionAPI, deps: ToolDeps): void {
  const tool: ToolDefinition = {
    name: "lcm_stats",
    label: "lcm_stats",
    description: "Get statistics about the memory store",
    parameters: params,
    promptGuidelines: ["Use stats to check the current state of messages, summaries, memories, and token savings."],
    execute: async (action, params, _context, _signal, _extra) => {
      const db = deps.getDb();
      const projectId = deps.getProjectId();
      const dbPath = deps.getDbPath();
      
      // Count messages, summaries, memories
      const messages = countMessages(db, projectId);
      const summaries = countSummaries(db, projectId);
      const memories = countMemories(db, projectId);
      
      // Calculate tokenSavings
      // tokenSavings = sum of token_count over distinct messages covered by summary_messages
      //                minus sum of token_count over kind IN ('leaf','condensed') summaries
      
      // Get sum of token_count for distinct messages covered by summary_messages
      const coveredMessagesSum = db
        .prepare(`
          SELECT SUM(token_count) as total 
          FROM (SELECT DISTINCT m.id, m.token_count FROM messages m JOIN summary_messages sm ON m.id = sm.message_id WHERE m.project_id = ?)
        `)
        .get<{ total: number | null }>(projectId);
      
      const messagesTokenSum = coveredMessagesSum?.total ?? 0;
      
      // Get sum of token_count for leaf and condensed summaries
      const summariesTokenSum = db
        .prepare(`
          SELECT SUM(token_count) as total 
          FROM summaries 
          WHERE project_id = ? AND kind IN ('leaf', 'condensed')
        `)
        .get<{ total: number | null }>(projectId);
      
      const summariesTokenTotal = summariesTokenSum?.total ?? 0;
      const tokenSavings = messagesTokenSum - summariesTokenTotal;
      
      // Calculate compactions = count of kind = 'leaf' summaries
      const compactions = db
        .prepare(`
          SELECT COUNT(*) as count 
          FROM summaries 
          WHERE project_id = ? AND kind = 'leaf'
        `)
        .get<{ count: number }>(projectId);
      
      const lines = [
        `LCM Statistics`,
        `  messages: ${messages}`,
        `  summaries: ${summaries}`,
        `  memories: ${memories}`,
        `  dbPath: ${dbPath}`,
        `  tokenSavings: ${tokenSavings}`,
        `  compactions: ${compactions?.count ?? 0}`,
      ];
      
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {},
      };
    },
  };
  pi.registerTool(tool);
}
