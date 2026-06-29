/**
 * Lightweight markdown renderer — no dependencies, covers the subset used by
 * Sonnet responses and AI council output: headings, paragraphs, bullet/ordered
 * lists, blockquotes, and inline bold / italic / code.
 *
 * All text is HTML-escaped before inline transforms so user-supplied or
 * AI-supplied content cannot inject markup.
 */

function esc(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Render **bold**, *italic*, and `code` spans within a single line of text. */
export function renderInline(s: string): string {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

/**
 * Render a block of markdown text to an HTML string.
 * Handles paragraphs, headings (# ## ###), bullet lists, ordered lists,
 * blockquotes, horizontal rules, and inline formatting.
 */
export function renderMarkdown(text: string): string {
  const blocks = text.split(/\n{2,}/);
  const html: string[] = [];

  for (const block of blocks) {
    const lines = block.split("\n");
    const nonEmpty = lines.filter((l) => l.trim() !== "");
    if (!nonEmpty.length) continue;

    // Heading (# / ## / ###)
    const headingMatch = nonEmpty[0].match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch && nonEmpty.length === 1) {
      const level = headingMatch[1].length;
      const tag = level === 1 ? "h2" : level === 2 ? "h3" : "h4";
      html.push(`<${tag}>${renderInline(headingMatch[2])}</${tag}>`);
      continue;
    }

    // Horizontal rule
    if (/^[-*_]{3,}$/.test(nonEmpty[0].trim()) && nonEmpty.length === 1) {
      html.push("<hr>");
      continue;
    }

    // Bullet list
    if (nonEmpty.every((l) => /^[-*]\s/.test(l.trim()))) {
      const items = nonEmpty.map((l) => `<li>${renderInline(l.trim().replace(/^[-*]\s/, ""))}</li>`);
      html.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    // Ordered list
    if (nonEmpty.every((l) => /^\d+[.)]\s/.test(l.trim()))) {
      const items = nonEmpty.map((l) => `<li>${renderInline(l.trim().replace(/^\d+[.)]\s/, ""))}</li>`);
      html.push(`<ol>${items.join("")}</ol>`);
      continue;
    }

    // Blockquote
    if (nonEmpty.every((l) => /^>\s?/.test(l.trim()))) {
      const inner = nonEmpty.map((l) => renderInline(l.trim().replace(/^>\s?/, ""))).join("<br>");
      html.push(`<blockquote>${inner}</blockquote>`);
      continue;
    }

    // Mixed block — treat each non-empty line as a paragraph if it starts
    // with a heading marker; otherwise join as one paragraph.
    const paragraphLines: string[] = [];
    for (const line of nonEmpty) {
      const hm = line.trim().match(/^(#{1,3})\s+(.+)$/);
      if (hm) {
        if (paragraphLines.length) {
          html.push(`<p>${renderInline(paragraphLines.join(" "))}</p>`);
          paragraphLines.length = 0;
        }
        const tag = hm[1].length === 1 ? "h2" : hm[1].length === 2 ? "h3" : "h4";
        html.push(`<${tag}>${renderInline(hm[2])}</${tag}>`);
      } else {
        paragraphLines.push(line);
      }
    }
    if (paragraphLines.length) {
      html.push(`<p>${renderInline(paragraphLines.join(" "))}</p>`);
    }
  }

  return html.join("\n");
}
