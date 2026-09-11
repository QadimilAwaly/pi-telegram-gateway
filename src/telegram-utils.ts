/**
 * Enhanced Telegram message formatting and splitting utilities.
 * Converts standard LLM Markdown/CLI outputs to safe, valid Telegram HTML.
 */

const MAX_TG_LENGTH = 4000;
const VOID_TAGS = new Set(["br", "hr", "img", "input"]);

/**
 * Remove ANSI escape sequences (colors, cursor movements, etc.)
 */
export function stripAnsi(text: string): string {
  if (!text) return "";
  return text.replace(
    /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
    ""
  );
}

/**
 * Escape raw text for Telegram HTML mode (&, <, >)
 */
export function escapeHtml(text: string): string {
  if (!text) return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Transform standard Markdown tables into clean, mobile-friendly structured lists or cards.
 */
export function formatMarkdownTable(tableText: string): string {
  const lines = tableText
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length < 2) return tableText;

  const parseRow = (row: string) => {
    return row
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim().replace(/^\*\*(.*?)\*\*$/, "$1"));
  };

  const headers = parseRow(lines[0] || "");
  const isSeparator = (line: string) => /^\|?[\s:-|-]+\|?$/.test(line);

  let startIndex = 1;
  if (lines[1] && isSeparator(lines[1])) {
    startIndex = 2;
  }

  const rows: string[][] = [];
  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i];
    if (!line || isSeparator(line)) continue;
    const cells = parseRow(line);
    if (cells.some((c) => c.length > 0)) {
      rows.push(cells);
    }
  }

  if (rows.length === 0) return tableText;

  // Case A: 2 columns table -> Bullet list with Bold keys
  if (headers.length === 2) {
    const outputLines: string[] = [];
    for (const row of rows) {
      const key = row[0] || "";
      const val = row[1] || "";
      outputLines.push(`• **${key}:** ${val}`);
    }
    return "\n" + outputLines.join("\n") + "\n";
  }

  // Case B: 3+ columns table -> Structured Cards
  const outputCards: string[] = [];
  for (const row of rows) {
    const title = row[0] || "Item";
    const details: string[] = [];
    for (let col = 1; col < headers.length; col++) {
      const headerName = headers[col] || `Detail ${col}`;
      const cellVal = row[col] || "-";
      details.push(`  • **${headerName}:** ${cellVal}`);
    }
    outputCards.push(`▪️ **${title}**\n${details.join("\n")}`);
  }

  return "\n" + outputCards.join("\n\n") + "\n";
}

/**
 * Convert LaTeX mathematical expressions into readable Unicode text for Telegram.
 */
export function latexToUnicode(latex: string): string {
  let s = latex.trim();

  // 1. Text and styling blocks: \text{...}, \mathrm{...}, \mathbf{...}, \mathit{...}
  s = s.replace(/\\(?:text|mathrm|mathbf|mathit)\{([^{}]*)\}/g, "$1");

  // 2. Fractions: \frac{a}{b} -> (a / b)
  s = s.replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, "($1 / $2)");

  // 3. Mathematical operators and relational symbols
  const symbolMap: Record<string, string> = {
    "\\\\gg": "≫",
    "\\\\ll": "≪",
    "\\\\geq|\\\\ge": "≥",
    "\\\\leq|\\\\le": "≤",
    "\\\\neq|\\\\ne": "≠",
    "\\\\approx": "≈",
    "\\\\equiv": "≡",
    "\\\\times": "×",
    "\\\\div": "÷",
    "\\\\pm": "±",
    "\\\\mp": "∓",
    "\\\\cdot": "·",
    "\\\\to|\\\\rightarrow": "→",
    "\\\\leftarrow": "←",
    "\\\\Rightarrow": "⇒",
    "\\\\Leftarrow": "⇐",
    "\\\\infty": "∞",
    "\\\\Delta": "Δ",
    "\\\\delta": "δ",
    "\\\\alpha": "α",
    "\\\\beta": "β",
    "\\\\gamma": "γ",
    "\\\\pi": "π",
    "\\\\mu": "µ",
    "\\\\sigma": "σ",
    "\\\\omega": "ω",
    "\\\\degree|\\^\\\\circ": "°",
    "\\\\sim": "~",
    "\\\\quad|\\\\qquad|\\\\;|\\\\,|\\\\:": " ",
  };

  for (const [pattern, repl] of Object.entries(symbolMap)) {
    s = s.replace(new RegExp(pattern, "g"), repl);
  }

  // 4. Subscripts map
  const subMap: Record<string, string> = {
    "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄",
    "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉",
    "+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎",
    "a": "ₐ", "e": "ₑ", "h": "ₕ", "i": "ᵢ", "j": "ⱼ",
    "k": "ₖ", "l": "ₗ", "m": "ₘ", "n": "ₙ", "o": "ₒ",
    "p": "ₚ", "r": "ᵣ", "s": "ₛ", "t": "ₜ", "u": "ᵤ",
    "v": "ᵥ", "x": "ₓ", ".": ".",
  };

  s = s.replace(/_\{([^}]+)\}/g, (_, chars) => {
    return chars.split("").map((c: string) => subMap[c] || c).join("");
  });
  s = s.replace(/_([0-9a-z])/gi, (_, c) => subMap[c.toLowerCase()] || c);

  // 5. Superscripts map
  const supMap: Record<string, string> = {
    "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴",
    "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
    "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾",
    "n": "ⁿ", "i": "ⁱ",
  };

  s = s.replace(/\^\{([^}]+)\}/g, (_, chars) => {
    return chars.split("").map((c: string) => supMap[c] || c).join("");
  });
  s = s.replace(/\^([0-9ni+-])/g, (_, c) => supMap[c] || c);

  // Clean leftover backslashes and redundant braces
  s = s.replace(/\\([a-zA-Z]+)/g, "$1");
  s = s.replace(/\{([^{}]*)\}/g, "$1");

  return s.trim().replace(/\s+/g, " ");
}

/**
 * Converts standard Markdown (from Pi / LLM / CLI) to valid Telegram HTML.
 * Preserves code blocks, syntax highlighting tags, inline code, bold, italic,
 * links, blockquotes, headings, lists, and tables.
 */
export function markdownToTelegramHtml(markdown: string): string {
  if (!markdown) return "";

  // 1. Strip ANSI escape codes
  let text = stripAnsi(markdown);

  // 2. Extract and protect code blocks & inline code
  const codeBlocks: string[] = [];
  const inlineCodes: string[] = [];

  // Fenced code blocks ```lang\ncode\n```
  text = text.replace(/```([a-zA-Z0-9_-]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const trimmedCode = code.replace(/\n$/, "");
    const escapedCode = escapeHtml(trimmedCode);
    const html = lang
      ? `<pre><code class="language-${lang}">${escapedCode}</code></pre>`
      : `<pre>${escapedCode}</pre>`;
    const idx = codeBlocks.length;
    codeBlocks.push(html);
    return `%%CODE_BLOCK_${idx}%%`;
  });

  // Inline code `code`
  text = text.replace(/`([^`\n]+)`/g, (_, code) => {
    const idx = inlineCodes.length;
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
    return `%%INLINE_CODE_${idx}%%`;
  });

  // 2.1 Convert LaTeX Math ($$...$$ block math and $...$ inline math)
  const mathBlocks: string[] = [];
  const inlineMaths: string[] = [];

  // Block math: $$ ... $$
  text = text.replace(/\$\$([\s\S]*?)\$\$/g, (_, latex) => {
    const converted = latexToUnicode(latex);
    const escaped = escapeHtml(converted);
    const html = `\n<blockquote><b>${escaped}</b></blockquote>\n`;
    const idx = mathBlocks.length;
    mathBlocks.push(html);
    return `%%MATH_BLOCK_${idx}%%`;
  });

  // Inline math: $ ... $ (ignoring currency like $100)
  text = text.replace(/(^|[^\\])\$([^\$\n]+)\$(?!\$)/g, (match, prefix, latex) => {
    if (/^\d+(?:\.\d+)?$/.test(latex.trim())) {
      return match;
    }
    const converted = latexToUnicode(latex);
    const escaped = escapeHtml(converted);
    const idx = inlineMaths.length;
    inlineMaths.push(`<b>${escaped}</b>`);
    return `${prefix}%%MATH_INLINE_${idx}%%`;
  });

  // 3. Transform Markdown Tables into clean, mobile-friendly cards/lists
  text = text.replace(/(?:^[ \t]*\|.+\|[ \t]*$\n?){2,}/gm, (tableMatch) => {
    return formatMarkdownTable(tableMatch);
  });

  // 4. Escape HTML entities in the non-code text
  text = escapeHtml(text);

  // 5. Transform Markdown Headings (# Heading -> <b>Heading</b>)
  text = text.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");

  // 6. Horizontal rules (--- or *** or ___ alone on a line)
  text = text.replace(/^(?:[-*_]\s*){3,}$/gm, "— — —");

  // 7. Blockquotes (> quote)
  text = text.replace(/^(?:&gt;\s?([^\n]*)\n?)+/gm, (match) => {
    const lines = match
      .split("\n")
      .map((l) => l.replace(/^&gt;\s?/, "").trim())
      .filter((l) => l.length > 0)
      .join("\n");
    return `<blockquote>${lines}</blockquote>\n`;
  });

  // 8. Bold & Italic formatting
  // Bold + Italic: ***text*** or ___text___
  text = text.replace(/\*\*\*(.*?)\*\*\*/g, "<b><i>$1</i></b>");
  text = text.replace(/___(.*?)___/g, "<b><i>$1</i></b>");

  // Bold: **text** or __text__
  text = text.replace(/\*\*(.*?)\*\*/g, "<b>$1</b>");
  text = text.replace(/__(.*?)__/g, "<b>$1</b>");

  // Italic: *text* (word boundary or space)
  text = text.replace(/(^|\s|\W)\*([^*\n]+)\*($|\s|\W)/g, "$1<i>$2</i>$3");

  // Italic: _text_ (only whole word or spaced to avoid snake_case variable names)
  text = text.replace(/(^|\s)_([^_ \n]+)_($|\s)/g, "$1<i>$2</i>$3");

  // Strikethrough: ~~text~~
  text = text.replace(/~~(.*?)~~/g, "<s>$1</s>");

  // 9. Links: [text](url) -> <a href="url">text</a>
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2">$1</a>');

  // 10. Bullet lists: lines starting with * or - or + followed by space
  text = text.replace(/^[\t ]*[-*+]\s+/gm, "• ");

  // 11. Restore math blocks, code blocks & inline code
  text = text.replace(/%%MATH_BLOCK_(\d+)%%/g, (_, idx) => mathBlocks[Number(idx)] || "");
  text = text.replace(/%%MATH_INLINE_(\d+)%%/g, (_, idx) => inlineMaths[Number(idx)] || "");
  text = text.replace(/%%INLINE_CODE_(\d+)%%/g, (_, idx) => inlineCodes[Number(idx)] || "");
  text = text.replace(/%%CODE_BLOCK_(\d+)%%/g, (_, idx) => codeBlocks[Number(idx)] || "");

  // 12. Auto-balance any tags
  return balanceHtmlTags(text);
}

/**
 * Auto-close any unclosed HTML tags in proper reverse order.
 */
export function balanceHtmlTags(html: string): string {
  const openTags: string[] = [];
  const tagRegex = /<\/?([a-zA-Z0-9]+)(?:\s+[^>]*?)?(\/?)>/g;
  let match: RegExpExecArray | null;

  
  while ((match = tagRegex.exec(html)) !== null) {
    const fullTag = match[0];
    const tagName = match[1]?.toLowerCase();
    const isSelfClosing = match[2] === "/" || (tagName ? VOID_TAGS.has(tagName) : false);

    if (!tagName || isSelfClosing) continue;

    if (fullTag.startsWith("</")) {
      const last = openTags.lastIndexOf(tagName);
      if (last !== -1) {
        openTags.splice(last, 1);
      }
    } else {
      openTags.push(tagName);
    }
  }

  let result = html;
  while (openTags.length > 0) {
    const tag = openTags.pop();
    result += `</${tag}>`;
  }

  return result;
}

/**
 * Split HTML text into chunks safe for Telegram (<= 4000 chars),
 * safely balancing opening and closing HTML tags across chunk boundaries.
 */
export function splitMessage(htmlOrMarkdown: string, maxLength: number = MAX_TG_LENGTH): string[] {
  // If input is raw markdown, convert to HTML first
  const html = htmlOrMarkdown.includes("<") ? balanceHtmlTags(htmlOrMarkdown) : markdownToTelegramHtml(htmlOrMarkdown);

  if (html.length <= maxLength) {
    return [html];
  }

  const chunks: string[] = [];
  let remaining = html;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Effective boundary with buffer for tag closure
    const effectiveLimit = Math.max(500, maxLength - 100);
    let splitIdx = -1;

    // Prefer splitting at double newlines
    const doubleNewline = remaining.lastIndexOf("\n\n", effectiveLimit);
    if (doubleNewline !== -1 && doubleNewline > effectiveLimit / 3) {
      splitIdx = doubleNewline;
    } else {
      // Prefer single newline
      const singleNewline = remaining.lastIndexOf("\n", effectiveLimit);
      if (singleNewline !== -1 && singleNewline > effectiveLimit / 3) {
        splitIdx = singleNewline;
      } else {
        // Prefer space
        const space = remaining.lastIndexOf(" ", effectiveLimit);
        if (space !== -1 && space > effectiveLimit / 3) {
          splitIdx = space;
        } else {
          // Hard cut
          splitIdx = Math.min(effectiveLimit, remaining.length);
        }
      }
    }

    // Avoid splitting in the middle of an HTML tag (<...>)
    const lastOpenAngle = remaining.lastIndexOf("<", splitIdx);
    const lastCloseAngle = remaining.lastIndexOf(">", splitIdx);
    if (lastOpenAngle !== -1 && lastOpenAngle > lastCloseAngle) {
      if (lastOpenAngle > effectiveLimit / 3) {
        splitIdx = lastOpenAngle;
      } else {
        const nextClose = remaining.indexOf(">", splitIdx);
        if (nextClose !== -1 && nextClose < maxLength) {
          splitIdx = nextClose + 1;
        }
      }
    }

    const chunk = remaining.substring(0, splitIdx);
    remaining = remaining.substring(splitIdx).trimStart();

    // Inspect active open tags in this chunk, preserving full open tag with attributes
    interface OpenTagInfo {
      name: string;
      openTag: string;
    }
    const currentOpenTags: OpenTagInfo[] = [];
    const tagRegex = /<\/?([a-zA-Z0-9]+)(?:\s+[^>]*?)?(\/?)>/g;
    let match: RegExpExecArray | null;

    while ((match = tagRegex.exec(chunk)) !== null) {
      const fullTag = match[0];
      const tagName = match[1]?.toLowerCase();
      const isSelfClosing = match[2] === "/" || (tagName ? VOID_TAGS.has(tagName) : false);
      if (!tagName || isSelfClosing) continue;

      if (fullTag.startsWith("</")) {
        const last = currentOpenTags.map((t) => t.name).lastIndexOf(tagName);
        if (last !== -1) {
          currentOpenTags.splice(last, 1);
        }
      } else {
        currentOpenTags.push({ name: tagName, openTag: fullTag });
      }
    }

    // Close open tags on this chunk in reverse order
    let closingTags = "";
    for (let i = currentOpenTags.length - 1; i >= 0; i--) {
      const tag = currentOpenTags[i];
      if (tag) {
        closingTags += `</${tag.name}>`;
      }
    }

    chunks.push(chunk + closingTags);

    // Reopen tags for subsequent chunk in forward order, preserving attributes (e.g. <a href="...">)
    let reopeningTags = "";
    for (const tag of currentOpenTags) {
      reopeningTags += tag.openTag;
    }
    remaining = reopeningTags + remaining;
  }

  return chunks;
}

/**
 * Format a tool execution preview for live status notifications (Telegram HTML).
 */
export function formatToolStatus(toolName: string, input?: Record<string, any>): string {
  let summary = "";
  if (input) {
    if (input.command) {
      summary = input.command.length > 60 ? input.command.slice(0, 57) + "..." : input.command;
    } else if (input.path) {
      summary = input.path;
    } else if (input.query) {
      summary = input.query;
    } else {
      const keys = Object.keys(input);
      const firstKey = keys[0];
      if (firstKey !== undefined) {
        summary = `${firstKey}: ${String(input[firstKey]).slice(0, 40)}`;
      }
    }
  }

  const safeSummary = escapeHtml(summary);

  switch (toolName) {
    case "bash":
      return `⚙️ <code>${safeSummary || "Running command..."}</code>`;
    case "read":
      return `📖 Reading <code>${safeSummary || "file..."}</code>`;
    case "write":
      return `✏️ Writing <code>${safeSummary || "file..."}</code>`;
    case "edit":
      return `📝 Editing <code>${safeSummary || "file..."}</code>`;
    default:
      return `⚙️ Tool <b>${escapeHtml(toolName)}</b> ${safeSummary ? `<code>${safeSummary}</code>` : ""}`;
  }
}
