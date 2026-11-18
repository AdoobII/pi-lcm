import type { MemoryDraft } from "../types.js";

export const DEFAULT_COMPACTION_FOCUS = [
  "Keep these in the summary:",
  "- rulings and decisions, with their reasons",
  "- file paths and commit hashes",
  "- open threads and unfinished work",
  "- user preferences",
  "- any ledger or plan path, with an instruction to re-read it after compaction",
].join("\n");

export function buildFocus(userFocus: string | undefined, configFocus: string): string | undefined {
  const parts = [userFocus?.trim() ?? "", configFocus.trim()].filter((part) => part !== "");
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

export function leafPrompt(depth: number, aggressive: boolean, customInstructions?: string): string {
  const role = "You compress conversation history into a durable summary";
  const sections = [
    "## Goal",
    "## Constraints & Preferences",
    "## Progress",
    "### Done",
    "### In Progress",
    "### Blocked",
    "## Key Decisions",
    "## Next Steps",
    "## Critical Context",
  ].join("\n\n");

  const footer = [
    "",
    "Expand for details about:",
    "- any specifics that were dropped to fit the budget",
    "",
    "<memories>",
    // JSON array of { "content": string, "tags": string[] }, tags starting with type:
    '[{"content":"","tags":[]}]',
    "</memories>",
  ].join("\n");

  const aggressiveNote = aggressive ? "\n\nBe aggressive in compression." : "";
  const operatorDirections = customInstructions ? `\n\n## Operator directions\n${customInstructions}` : "";

  return [role, "", sections, aggressiveNote, operatorDirections, footer].join("\n");
}

export function condensedPrompt(depth: number, customInstructions?: string): string {
  const role = "You compress conversation history into a durable summary";
  const instruction = [
    "Condense the child summaries below into a single coherent summary.",
    "Preserve all decisions, state changes, and actionable next steps.",
    "Drop repetition and redundant context.",
    "Keep the footer instruction.",
    "Please condense the information.",
  ].join(" ");

  const footer = [
    "",
    "Expand for details about:",
    "- any specifics that were dropped to fit the budget",
    "",
    "<memories>",
    '[{"content":"","tags":[]}]',
    "</memories>",
  ].join("\n");

  const operatorDirections = customInstructions ? `\n\n## Operator directions\n${customInstructions}` : "";

  return [role, "", instruction, operatorDirections, footer].join("\n");
}

export function parseMemories(text: string): MemoryDraft[] {
  const match = text.match(/<memories>([\s\S]*?)<\/memories>/);
  if (!match) {
    return [];
  }

  try {
    const parsed = JSON.parse(match[1] || "");
    if (!Array.isArray(parsed)) {
      return [];
    }

    const result: MemoryDraft[] = [];
    for (const entry of parsed) {
      if (entry && typeof entry === "object") {
        const content = entry.content;
        if (typeof content === "string" && content.trim() !== "") {
          const tags = Array.isArray(entry.tags) ? entry.tags.filter((t: unknown): t is string => typeof t === "string") : [];
          result.push({ content: content.trim(), tags });
        }
      }
    }
    return result;
  } catch {
    return [];
  }
}
