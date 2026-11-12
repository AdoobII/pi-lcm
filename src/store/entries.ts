import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { MessageInput, MessageRole } from "../types.js";

const MAX_CONTENT_LENGTH = 100_000;

function truncateContent(content: string): string {
  if (content.length <= MAX_CONTENT_LENGTH) {
    return content;
  }
  return content.slice(0, MAX_CONTENT_LENGTH) + "\n[truncated]";
}

function formatTimestamp(ts: number | undefined): string | undefined {
  if (ts === undefined) return undefined;
  return new Date(ts).toISOString();
}

export function entryToMessage(
  entry: SessionEntry,
  opts: { storeThinking: boolean },
): MessageInput | null {
  // Only process message type entries
  if (entry.type !== "message") {
    return null;
  }

  const message = entry.message;
  const role = message.role;
  const entryTimestamp = entry.timestamp;
  const messageTimestamp = message.timestamp;

  // Handle system messages - skip them
  if (role === "system") {
    return null;
  }

  let content: string;
  let eventAt: string | undefined;

  switch (role) {
    case "user": {
      if (typeof message.content === "string") {
        content = message.content;
      } else if (Array.isArray(message.content)) {
        content = message.content
          .map((block) => {
            if (block.type === "text") {
              return block.text;
            } else if (block.type === "image") {
              return "[image]";
            }
            return "";
          })
          .join("");
      } else {
        content = String(message.content ?? "");
      }
      eventAt = formatTimestamp(messageTimestamp);
      break;
    }

    case "assistant": {
      if (!Array.isArray(message.content)) {
        content = String(message.content ?? "");
      } else {
        content = message.content
          .map((block) => {
            if (block.type === "text") {
              return block.text;
            } else if (block.type === "toolCall") {
              return `[Tool ${block.name}] ${JSON.stringify(block.arguments)}`;
            } else if (block.type === "thinking" && opts.storeThinking) {
              return block.thinking;
            }
            return "";
          })
          .join("");
      }
      eventAt = formatTimestamp(messageTimestamp);
      break;
    }

    case "toolResult": {
      if (typeof message.content === "string") {
        content = message.content;
      } else if (Array.isArray(message.content)) {
        content = message.content
          .map((block) => (block.type === "text" ? block.text : ""))
          .join("");
      } else {
        content = String(message.content ?? "");
      }
      content = truncateContent(content);
      eventAt = formatTimestamp(messageTimestamp);
      break;
    }

    case "custom": {
      // Skip pi-lcm:* custom types
      if (message.customType?.startsWith("pi-lcm:")) {
        return null;
      }
      if (typeof message.content === "string") {
        content = message.content;
      } else {
        content = String(message.content ?? "");
      }
      eventAt = formatTimestamp(messageTimestamp);
      break;
    }

    case "bashExecution": {
      // Skip when excludeFromContext is true
      if (message.excludeFromContext) {
        return null;
      }
      content = `${message.command}\n${message.output}`;
      content = truncateContent(content);
      eventAt = formatTimestamp(messageTimestamp);
      break;
    }

    default:
      return null;
  }

  // Trim content and check if empty
  content = content.trim();
  if (content === "") {
    return null;
  }

  return {
    entryId: entry.id,
    role: role as MessageRole,
    content,
    createdAt: entryTimestamp,
    eventAt,
  };
}
