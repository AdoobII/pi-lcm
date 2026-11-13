import { Type, Static } from "typebox";
import type { ToolDeps } from "./index.js";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { insertMemory } from "../store/memories.js";

const params = Type.Object({
  content: Type.String({ description: "Memory content to store" }),
  tags: Type.Optional(Type.Array(Type.String({ description: "Tags for the memory, use type: prefix for categories" }))),
});

type Params = Static<typeof params>;

export function lcmStore(pi: ExtensionAPI, deps: ToolDeps): void {
  const tool: ToolDefinition = {
    name: "lcm_store",
    label: "lcm_store",
    description: "Store a durable memory with optional tags",
    parameters: params,
    promptGuidelines: ["Use store for durable insights. Always include type: tags (e.g., type:preference, type:lesson) to categorize memories."],
    execute: async (action, params, _context, _signal, _extra) => {
      const p = params as Params;
      const db = deps.getDb();
      const projectId = deps.getProjectId();
      
      const memory = insertMemory(db, projectId, p.content, p.tags ?? [], "manual");
      
      return {
        content: [{ type: "text", text: `Stored memory ${memory.id}` }],
        details: {},
      };
    },
  };
  pi.registerTool(tool);
}
