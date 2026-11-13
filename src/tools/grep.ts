import { Type, Static } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ToolDeps } from "./index.js";
import type { Db } from "../db/driver.js";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { searchAll } from "../recall/search.js";
import type { SearchType, SearchHit } from "../types.js";

const params = Type.Object({
  query: Type.String({ description: "Search query" }),
  limit: Type.Optional(Type.Number({ description: "Maximum number of results", default: 10 })),
  type: Type.Optional(StringEnum(["all", "messages", "summaries", "memories"], { description: "Filter by type: all, messages, summaries, or memories" })),
});

type Params = Static<typeof params>;

function mapTypeToSearchTypes(type?: string): SearchType[] {
  if (!type || type === "all") {
    return ["message", "summary", "memory"];
  }
  // type is one of "messages", "summaries", "memories"
  const typeMap: Record<string, SearchType[]> = {
    messages: ["message"],
    summaries: ["summary"],
    memories: ["memory"],
  };
  return typeMap[type] ?? ["message", "summary", "memory"];
}

function formatHit(hit: SearchHit): string {
  const date = hit.createdAt.split("T")[0];
  const scoreStr = hit.score.toFixed(2);
  const typeLabel = hit.type;
  
  // Clean up the snippet by removing the highlight markers
  let snippet = hit.snippet;
  // Remove the [...] highlight markers from FTS
  snippet = snippet.replace(/\[/g, "").replace(/\]/g, "");
  
  const indentedSnippet = snippet.split("\n").map(line => `  ${line}`).join("\n");
  return `[${typeLabel}] ${hit.id} (score ${scoreStr}, ${date})\n${indentedSnippet}`;
}

export function lcmGrep(pi: ExtensionAPI, deps: ToolDeps): void {
  const tool: ToolDefinition = {
    name: "lcm_grep",
    label: "lcm_grep",
    description: "Search messages, summaries, and memories for a query",
    parameters: params,
    promptGuidelines: ["Use grep first to find relevant information across messages, summaries, and memories."],
    execute: async (action, params, _context, _signal, _extra) => {
      const p = params as Params;
      const db = deps.getDb();
      const projectId = deps.getProjectId();
      const limit = p.limit ?? 10;
      const types = mapTypeToSearchTypes(p.type as string | undefined);
      
      const hits = searchAll(db, projectId, p.query, { limit, types });
      
      const lines = hits.map(formatHit);
      const text = lines.length > 0 ? lines.join("\n\n") : "No results found.";
      
      return {
        content: [{ type: "text", text }],
        details: {},
      };
    },
  };
  pi.registerTool(tool);
}
