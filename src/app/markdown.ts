import MarkdownIt, { type Token } from "markdown-it";

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

const md = new MarkdownIt({ html: false, linkify: true, breaks: false, typographer: false });

const EXTERNAL = /^(https?:|mailto:)/i;

function safeDecode(text: string): string {
  try {
    return decodeURI(text);
  } catch {
    return text;
  }
}

md.renderer.rules.link_open = (tokens, index) => {
  const href = String(tokens[index].attrGet("href") ?? "");
  if (EXTERNAL.test(href)) return `<a href="${escapeHtml(href)}" data-link="${escapeHtml(href)}">`;
  if (href.startsWith("#")) return `<a>`;
  const target = safeDecode(href.replace(/^file:\/\//, ""));
  return `<a class="file-link" data-file="${escapeHtml(target)}">`;
};

md.renderer.rules.fence = (tokens, index) => {
  const token = tokens[index];
  const lang = token.info.trim().split(/\s+/)[0];
  return `<pre${lang ? ` data-lang="${escapeHtml(lang)}"` : ""}><code>${escapeHtml(token.content.replace(/\n$/, ""))}</code></pre>`;
};

md.renderer.rules.table_open = () => `<div class="table-wrap"><table>`;
md.renderer.rules.table_close = () => `</table></div>`;

function markTasks(tokens: Token[]): void {
  for (let index = 2; index < tokens.length; index += 1) {
    const inlineToken = tokens[index];
    if (inlineToken.type !== "inline" || tokens[index - 1].type !== "paragraph_open" || tokens[index - 2].type !== "list_item_open") continue;
    const match = /^\[([ xX])\]\s+/.exec(inlineToken.content);
    if (!match) continue;
    const done = match[1] !== " ";
    const item = tokens[index - 2];
    item.attrJoin("class", `task${done ? " done" : ""}`);
    const first = inlineToken.children?.[0];
    if (first?.type === "text") first.content = first.content.replace(/^\[([ xX])\]\s+/, "");
    const box = new (inlineToken.constructor as typeof Token)("html_inline", "", 0);
    box.content = `<span class="box" aria-hidden="true"></span>`;
    inlineToken.children?.unshift(box);
  }
}

md.core.ruler.push("task_items", (state) => markTasks(state.tokens));

export interface Frontmatter {
  fields: [string, string][];
  body: string;
}

export function splitFrontmatter(source: string): Frontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  if (!match) return { fields: [], body: source };
  const fields: [string, string][] = [];
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([\w.-]+):\s*(.*)$/.exec(line);
    if (pair) fields.push([pair[1], pair[2].replace(/^["']|["']$/g, "")]);
  }
  return { fields, body: source.slice(match[0].length) };
}

function frontmatterTable(fields: [string, string][]): string {
  if (!fields.length) return "";
  return `<div class="props">${fields.map(([key, value]) => `<div class="prop"><span class="prop-key">${escapeHtml(key)}</span><span class="prop-value">${escapeHtml(value)}</span></div>`).join("")}</div>`;
}

export function inline(text: string): string {
  return md.renderInline(text);
}

export function markdown(source: string, options: { frontmatter?: boolean } = {}): string {
  const normalized = source.replace(/\r\n/g, "\n").replace(/<\/?tldr>\n?/gi, "");
  if (!options.frontmatter) return md.render(normalized);
  const { fields, body } = splitFrontmatter(normalized);
  return frontmatterTable(fields) + md.render(body);
}
