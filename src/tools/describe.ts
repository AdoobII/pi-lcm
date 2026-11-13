import { Type, Static } from "typebox";
import type { ToolDeps } from "./index.js";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getSummary } from "../store/summaries.js";
import { countMessages } from "../store/messages.js";
import { countSummaries } from "../store/summaries.js";

const params = Type.Object({
  id: Type.String({ description: "Summary ID (starting with sum_) or session ID" }),
});

type Params = Static<typeof params>;

export function lcmDescribe(pi: ExtensionAPI, deps: ToolDeps): void {
  const tool: ToolDefinition = {
    name: "lcm_describe",
    label: "lcm_describe",
    description: "Get metadata about a summary or session",
    parameters: params,
    promptGuidelines: ["Use describe for metadata about summaries or sessions when you need to understand structure without expanding content."],
    execute: async (action, params, _context, _signal, _extra) => {
      const p = params as Params;
      const db = deps.getDb();
      const projectId = deps.getProjectId();
      
      if (p.id.startsWith("sum_")) {
        // Describe a summary
        const summary = getSummary(db, p.id);
        if (!summary) {
          return {
            content: [{ type: "text", text: `No summary with id ${p.id}` }],
            details: {},
          };
        }
        
        const lines = [
          `Summary ${summary.id}`,
          `  kind: ${summary.kind}`,
          `  depth: ${summary.depth}`,
          `  message count: ${summary.messageCount}`,
          `  seq bounds: ${summary.startSeq ?? "null"}-${summary.endSeq ?? "null"}`,
          `  parents: ${summary.parentIds.length > 0 ? summary.parentIds.join(", ") : "none"}`,
          `  children: ${summary.childIds.length > 0 ? summary.childIds.join(", ") : "none"}`,
          `  created: ${summary.createdAt}`,
          `  earliest: ${summary.earliestAt ?? "N/A"}`,
          `  latest: ${summary.latestAt ?? "N/A"}`,
          `  tokens: ${summary.tokenCount}`,
        ];
        
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: {},
        };
      } else {
        // Describe a session
        const messageCount = countMessages(db, projectId);
        const summaryCount = countSummaries(db, projectId);
        
        // Get session cwd from sessions table
        const sessionRow = db
          .prepare("SELECT cwd, created_at FROM sessions WHERE id = ?")
          .get<{ cwd: string; created_at: string }>(p.id);
        
        if (!sessionRow) {
          return {
            content: [{ type: "text", text: `No session with id ${p.id}` }],
            details: {},
          };
        }
        
        const lines = [
          `Session ${p.id}`,
          `  cwd: ${sessionRow.cwd}`,
          `  created_at: ${sessionRow.created_at}`,
          `  message count: ${messageCount}`,
          `  summary count: ${summaryCount}`,
        ];
        
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: {},
        };
      }
    },
  };
  pi.registerTool(tool);
}
