import type { AgentReport, ParsedNotes, NotesSection } from "../shared/types.ts";

export interface Frontmatter {
  data: Record<string, string>;
  body: string;
}

export function parseFrontmatter(text: string): Frontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { data: {}, body: text };
  const data: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^\s*([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
    if (pair) data[pair[1]] = pair[2].trim().replace(/^["']|["']$/g, "");
  }
  return { data, body: text.slice(match[0].length) };
}

export function renderFrontmatter(data: Record<string, string>, body: string): string {
  const lines = Object.entries(data).map(([key, value]) => `${key}: ${value.replace(/\r?\n/g, " ")}`);
  return `---\n${lines.join("\n")}\n---\n\n${body.trim()}\n`;
}

function sections(text: string): Map<string, string> {
  const result = new Map<string, string>();
  let current = "";
  let buffer: string[] = [];
  const flush = () => {
    const body = buffer.join("\n").trim();
    if (current || body) result.set(current, body);
  };
  for (const line of text.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      current = heading[1].toLowerCase();
      buffer = [];
    } else {
      buffer.push(line);
    }
  }
  flush();
  return result;
}

function listItems(body: string | undefined): string[] {
  if (!body) return [];
  return body
    .split(/\r?\n/)
    .map((line) => /^\s*(?:[-*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.+)$/.exec(line)?.[1]?.trim())
    .filter((item): item is string => Boolean(item) && !/^none\.?$/i.test(item as string));
}

function withoutFences(text: string): string {
  let fence: string | undefined;
  return text
    .split(/\r?\n/)
    .map((line) => {
      const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
      if (marker && (!fence || marker[0] === fence[0])) {
        fence = fence ? undefined : marker;
        return "";
      }
      return fence ? "" : line;
    })
    .join("\n");
}

export function parseReport(text: string): AgentReport {
  const clean = text.trim();
  const live = withoutFences(clean);
  const pr = /(?:^|\n)PR:\s*(https:\/\/\S+)/.exec(live)?.[1] ?? /https:\/\/github\.com\/[^\s)]+\/pull\/\d+/.exec(live)?.[0];
  const parts = sections(live);
  const reportBody = parts.get("report") ?? parts.get("") ?? live;
  const needsYou = (parts.get("needs you") ?? "").trim();
  const candidates = reportBody
    .split(/\r?\n/)
    .map((line) => line.replace(/^PR:\s*\S+/, "").replace(/^[-*]\s+/, "").trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  const summary = candidates[0]?.endsWith(":") && candidates[1] ? `${candidates[0]} ${candidates[1]}` : (candidates[0] ?? "");
  return {
    text: clean,
    summary: summary.length > 220 ? `${summary.slice(0, 217)}...` : summary,
    next: listItems(parts.get("next")).slice(0, 9),
    remember: listItems(parts.get("remember")),
    needsYou: /^none\.?$/i.test(needsYou) ? "" : needsYou,
    pr,
  };
}

export function parseNotes(text: string): ParsedNotes {
  const tldr: string[] = [];
  const tldrMatch = /<tldr>([\s\S]*?)<\/tldr>/i.exec(text);
  if (tldrMatch) {
    for (const line of tldrMatch[1].split(/\r?\n/)) {
      const item = line.replace(/^\s*[-*]\s+/, "").trim();
      if (item) tldr.push(item);
    }
  }
  const rest = text.replace(/<tldr>[\s\S]*?<\/tldr>/i, "");
  const result: NotesSection[] = [];
  let current: NotesSection = { title: "", items: [] };
  for (const line of rest.split(/\r?\n/)) {
    const header = /^\s*(?:#{1,6}\s+(.+?)|\*\*(.+?)\*\*:?)\s*$/.exec(line);
    if (header) {
      if (current.title || current.items.length) result.push(current);
      current = { title: (header[1] ?? header[2]).trim(), items: [] };
      continue;
    }
    const item = /^\s*[-*]\s+\[([ xX])\]\s+(.+)$/.exec(line);
    if (item) current.items.push({ checked: item[1].toLowerCase() === "x", text: item[2].trim() });
  }
  if (current.title || current.items.length) result.push(current);
  return { tldr, sections: result };
}
