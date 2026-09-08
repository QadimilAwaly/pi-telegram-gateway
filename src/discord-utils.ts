/**
 * Utility functions for Discord message formatting, splitting, and rendering.
 */

/**
 * Splits a message into chunks of <= maxLength (default 1950 to leave room for wrapping),
 * preserving markdown codeblocks across splits.
 */
export function splitDiscordMessage(text: string, maxLength: number = 1950): string[] {
  if (!text || text.length <= maxLength) {
    return [text || ""];
  }

  const chunks: string[] = [];
  let remaining = text;
  let inCodeBlock = false;
  let codeBlockLang = "";

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Determine candidate slice
    let sliceLength = maxLength;
    let candidate = remaining.slice(0, sliceLength);

    // Look for good break points: double newline, single newline, space
    let breakIndex = candidate.lastIndexOf("\n\n");
    if (breakIndex < maxLength * 0.5) {
      breakIndex = candidate.lastIndexOf("\n");
    }
    if (breakIndex < maxLength * 0.5) {
      breakIndex = candidate.lastIndexOf(" ");
    }
    if (breakIndex < maxLength * 0.3) {
      breakIndex = maxLength;
    }

    let chunk = remaining.slice(0, breakIndex);
    remaining = remaining.slice(breakIndex).trimStart();

    // Check code blocks balance in this chunk
    const codeBlockMatches = chunk.match(/```([a-zA-Z0-9_-]*)/g) || [];
    const totalBackticks = (chunk.match(/```/g) || []).length;

    if (totalBackticks % 2 !== 0) {
      // Unclosed code block in this chunk
      const lastMatch = codeBlockMatches[codeBlockMatches.length - 1];
      if (lastMatch) {
        codeBlockLang = lastMatch.replace("```", "").trim();
      }
      chunk += "\n```";
      inCodeBlock = true;
    } else if (inCodeBlock) {
      // Chunk started inside a code block and closed it
      chunk = `\`\`\`${codeBlockLang}\n` + chunk;
      inCodeBlock = false;
      codeBlockLang = "";
    }

    chunks.push(chunk);
  }

  return chunks.filter((c) => c.trim().length > 0);
}

/**
 * Formats tool execution progress cleanly for Discord
 */
export function formatDiscordToolStatus(name: string, input?: any): string {
  let paramPreview = "";
  if (input) {
    const parsed = typeof input === "string" ? (() => { try { return JSON.parse(input); } catch { return null; } })() : input;
    if (parsed) {
      if (parsed.command) {
        paramPreview = `\`${parsed.command.slice(0, 60)}${parsed.command.length > 60 ? "..." : ""}\``;
      } else if (parsed.path) {
        paramPreview = `\`${parsed.path}\``;
      } else if (parsed.query) {
        paramPreview = `"${parsed.query.slice(0, 50)}"`;
      }
    } else if (typeof input === "string") {
      paramPreview = input.slice(0, 50);
    }
  }

  const iconMap: Record<string, string> = {
    bash: "⚙️",
    edit: "✏️",
    read: "📖",
    write: "📝",
    web_search: "🔍",
    fetch_webpage: "🌐",
    manage_plan: "📋",
    generate_image: "🎨",
    recall_past_conversation: "🧠",
  };

  const icon = iconMap[name] || "🔧";
  return `${icon} **Executing \`${name}\`** ${paramPreview}`.trim();
}
