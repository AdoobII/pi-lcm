import type { Db } from "../db/driver.js";
import { getSummaries } from "../store/summaries.js";
import type { SummaryNode } from "../types.js";

export interface RenderOptions {
  renderBudget: number;
}

export interface RenderResult {
  text: string;
  nodeIds: string[];
}

/**
 * Compute the set of all descendant IDs for a given set of root nodes.
 * Walks childIds recursively.
 */
function computeDescendantIds(nodes: SummaryNode[]): Set<string> {
  const descendants = new Set<string>();
  const queue = [...nodes];

  while (queue.length > 0) {
    const node = queue.shift()!;
    for (const childId of node.childIds) {
      if (!descendants.has(childId)) {
        descendants.add(childId);
        const childNode = nodes.find((n) => n.id === childId);
        if (childNode) {
          queue.push(childNode);
        }
      }
    }
  }

  return descendants;
}

/**
 * Estimate token count from content by splitting on whitespace.
 */
function estimateTokenCount(content: string): number {
  return content.split(/\s+/).filter((t) => t.length > 0).length;
}

/**
 * Truncate content to fit within maxTokens, preserving at least minTokens.
 */
function truncateContent(content: string, maxTokens: number, minTokens: number): string {
  const tokens = content.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length <= maxTokens) {
    return content;
  }
  const targetTokens = Math.max(minTokens, maxTokens);
  return tokens.slice(0, targetTokens).join(" ");
}

/**
 * Render a summary context window for a session.
 */
export function renderContext(db: Db, sessionId: string, opts: RenderOptions): RenderResult {
  const { renderBudget } = opts;

  // Load all summaries for the session
  const allSummaries = getSummaries(db, sessionId);

  // Separate legacy nodes (kind === "legacy")
  const legacyNodes = allSummaries.filter((n) => n.kind === "legacy");
  // Sort legacy nodes: newest first (by createdAt DESC)
  legacyNodes.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  // Roots are non-legacy summaries with no parents and depth > 0
  const roots = allSummaries.filter(
    (n) => n.kind !== "legacy" && n.parentIds.length === 0 && n.depth > 0
  );
  // Sort roots by depth DESC, then createdAt ASC
  roots.sort((a, b) => {
    if (a.depth !== b.depth) {
      return b.depth - a.depth;
    }
    return a.createdAt.localeCompare(b.createdAt);
  });

  // Compute all descendants of roots
  const allDescendantIds = computeDescendantIds(roots);

  // Candidate leaves: depth-0 summaries not in descendant set, not legacy, and not roots
  const rootIds = new Set(roots.map((n) => n.id));
  const candidateLeaves = allSummaries.filter(
    (n) =>
      n.depth === 0 &&
      !allDescendantIds.has(n.id) &&
      n.kind !== "legacy" &&
      !rootIds.has(n.id)
  );
  // Sort candidate leaves: newest first (by createdAt DESC)
  candidateLeaves.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  // Build the result
  const selectedNodes: SummaryNode[] = [];
  const selectedIds: string[] = [];
  let usedTokens = 0;

  // Track truncated content for nodes
  const truncatedContent = new Map<string, string>();

  // Add legacy nodes first
  for (const node of legacyNodes) {
    selectedNodes.push(node);
    selectedIds.push(node.id);
    usedTokens += node.tokenCount;
  }

  // Add roots
  for (const node of roots) {
    selectedNodes.push(node);
    selectedIds.push(node.id);
    usedTokens += node.tokenCount;
  }

  // Check if legacy + roots exceed the budget
  const legacyAndRootsTokens = legacyNodes.reduce((sum, n) => sum + n.tokenCount, 0) +
    roots.reduce((sum, n) => sum + n.tokenCount, 0);

  if (legacyAndRootsTokens > renderBudget && roots.length > 0) {
    // Roots alone exceed budget - truncate the oldest root's content to fit
    const minTokens = 200;
    // Sort roots by createdAt to find oldest
    const sortedRootsByAge = [...roots].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const oldestRoot = sortedRootsByAge[0]!;

    // Calculate tokens used by other legacy nodes and roots
    const otherTokens = legacyAndRootsTokens - oldestRoot.tokenCount;
    const remainingForOldest = renderBudget - otherTokens;

    if (remainingForOldest >= minTokens) {
      // Truncate oldest root to fit
      const truncated = truncateContent(oldestRoot.content, remainingForOldest, minTokens);
      truncatedContent.set(oldestRoot.id, truncated);
      // Recalculate usedTokens
      usedTokens = legacyNodes.reduce((sum, n) => sum + n.tokenCount, 0);
      for (const node of roots) {
        if (node.id === oldestRoot.id) {
          usedTokens += estimateTokenCount(truncated);
        } else {
          usedTokens += node.tokenCount;
        }
      }
    } else {
      // Even with truncation to minimum, we can't fit all roots
      // Truncate oldest root to minimum
      const truncated = truncateContent(oldestRoot.content, minTokens, minTokens);
      truncatedContent.set(oldestRoot.id, truncated);
      usedTokens = renderBudget;
    }
  }

  // Add candidate leaves while within budget
  for (const leaf of candidateLeaves) {
    if (usedTokens + leaf.tokenCount <= renderBudget) {
      selectedNodes.push(leaf);
      selectedIds.push(leaf.id);
      usedTokens += leaf.tokenCount;
    }
  }

  // Render each selected node
  const renderedParts: string[] = [];
  for (const node of selectedNodes) {
    const content = truncatedContent.get(node.id) ?? node.content;
    let rendered = `Summary [${node.id}]:\n${content}`;

    // Append expand prompt if not already present
    if (!content.includes("Expand for details about:")) {
      rendered += "\nExpand for details about: exact commands, file paths, error text";
    }

    renderedParts.push(rendered);
  }

  // Wrap in context tags
  const text = `<lcm-context version="1">\n${renderedParts.join("\n")}\n</lcm-context>`;

  return { text, nodeIds: selectedIds };
}
