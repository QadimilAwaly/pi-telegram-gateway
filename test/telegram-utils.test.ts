import { describe, it, expect } from "bun:test";
import { splitMessage, balanceHtmlTags, markdownToTelegramHtml } from "../src/telegram-utils";

describe("Telegram Message Splitting & Tag Preservation", () => {
  it("preserves HTML attributes across chunk boundaries", () => {
    const longContent = "b".repeat(3500);
    const htmlInput = `<a href="https://example.com/target">${longContent} after boundary</a>`;
    const chunks = splitMessage(htmlInput, 1500);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]!.endsWith("</a>")).toBe(true);
    expect(chunks[1]!.startsWith('<a href="https://example.com/target">')).toBe(true);
    expect(chunks[chunks.length - 1]!.endsWith("</a>")).toBe(true);
  });

  it("preserves code block language attributes across chunk boundaries", () => {
    const code = "console.log('line');\n".repeat(200);
    const htmlInput = `<pre><code class="language-typescript">${code}</code></pre>`;
    const chunks = splitMessage(htmlInput, 1500);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]!.endsWith("</code></pre>")).toBe(true);
    expect(chunks[1]!.startsWith('<pre><code class="language-typescript">')).toBe(true);
    expect(chunks[chunks.length - 1]!.endsWith("</code></pre>")).toBe(true);
  });

  it("handles void tags without inserting closing tags", () => {
    const text = "Hello<br>World<hr>";
    const balanced = balanceHtmlTags(text);
    expect(balanced).toBe("Hello<br>World<hr>");
  });
});
