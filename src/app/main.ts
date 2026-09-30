import { App, applyDocumentTheme, applyHostFonts, applyHostStyleVariables, type McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { OpenAIExtensions } from "@openai/mcp-extensions/app";
import type { AgentGroup, AgentView, FileNode, FileScope, ModelOption, ProjectDetail, ProjectIcon, ProjectColor, ProjectSummary, Snapshot, TranscriptItem } from "../shared/types.ts";
import { PROJECT_COLORS, PROJECT_ICONS } from "../shared/types.ts";
import { icon } from "./icons.ts";
import { escapeHtml, inline, markdown } from "./markdown.ts";

type Mode = "home" | "panel";
interface FilePage {
  kind: "file";
  scope: FileScope;
  path: string;
  text: string;
  updatedAt: string;
  view: "preview" | "source";
  draft?: string;
  tooLarge?: boolean;
}

type Page = { kind: "project" } | { kind: "agent"; id: string } | FilePage | { kind: "settings" } | { kind: "pick" };

interface Host {
  call(name: string, args?: Record<string, unknown>): Promise<Record<string, any>>;
  openLink(url: string): Promise<boolean>;
  message(text: string, target: "new" | "active"): Promise<boolean>;
  openFile(path: string): Promise<boolean>;
  pageNote(text: string): Promise<boolean>;
  fullscreen(): Promise<boolean>;
}

type DropdownKey = "workspace" | "model" | "effort";

interface Draft {
  icon: ProjectIcon;
  color: ProjectColor;
  workspace: string;
  otherPath: string;
  model: string;
  effort: string;
  picker: boolean;
}

interface CreateDraft extends Draft {
  name: string;
  saving: boolean;
}

interface State {
  snapshot?: Snapshot;
  mode: Mode;
  threadId?: string;
  page: Page;
  create?: CreateDraft;
  settings?: Draft;
  dropdown?: DropdownKey;
  options?: { models: ModelOption[]; workspaces: string[] };
  transcript?: { agentId: string; items: TranscriptItem[] };
  filter: string;
  selected: boolean;
  expandedDirs: Set<string>;
  collapsed: Set<string>;
  steer: boolean;
  drafts: Record<string, string>;
  openDetails: Set<string>;
  toast?: { text: string; kind: "ok" | "error" };
  pending: boolean;
  listWidth: number;
}

const LIST_WIDTH_KEY = "coordinator.listWidth";
const LIST_WIDTH_MIN = 200;
const LIST_WIDTH_MAX = 420;

function clampListWidth(value: number): number {
  return Math.round(Math.min(LIST_WIDTH_MAX, Math.max(LIST_WIDTH_MIN, value)));
}

function storedListWidth(): number {
  try {
    const value = Number(localStorage.getItem(LIST_WIDTH_KEY));
    return value ? clampListWidth(value) : 260;
  } catch {
    return 260;
  }
}

const state: State = {
  mode: "panel",
  page: { kind: "project" },
  filter: "",
  selected: true,
  expandedDirs: new Set(["root:project", "root:user"]),
  collapsed: new Set(["resolved"]),
  steer: false,
  drafts: {},
  openDetails: new Set(),
  pending: false,
  listWidth: storedListWidth(),
};

const GROUPS: { id: AgentGroup; label: string }[] = [
  { id: "needs_you", label: "Needs you" },
  { id: "review", label: "Ready for review" },
  { id: "working", label: "Working" },
  { id: "idle", label: "Idle" },
  { id: "resolved", label: "Resolved" },
];

const root = document.getElementById("root")!;
let pageNoteSent = false;

const PAGE_CHAT_NOTE = [
  "This chat sits on the Project Coordinator page. It is not the coordinator of any project.",
  "Each project has its own coordinator chat that the user opens by clicking the project in the list on this page.",
  "Do not call Project Coordinator tools here. If the user asks about a project or asks for project work, tell them to open that project from the list.",
].join(" ");

function syncPageNote(): void {
  if (state.mode !== "home" || !host || pageNoteSent) return;
  pageNoteSent = true;
  void host.pageNote(PAGE_CHAT_NOTE);
}
let host: Host;

const current = (): ProjectDetail | undefined => state.snapshot?.current;
const agentById = (id?: string): AgentView | undefined => current()?.agents.find((agent) => agent.id === id);
const base = (dir?: string): string => (dir ? dir.split("/").filter(Boolean).pop() ?? dir : "");

function ago(iso?: string): string {
  if (!iso) return "";
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 45) return "now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

function when(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (date.toDateString() === today.toDateString()) return `Today at ${time}`;
  return `${date.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })} at ${time}`;
}

function projectIcon(project: { icon: string; color: string }, size = 16): string {
  return `<span class="picon c-${project.color}">${icon(project.icon, size)}</span>`;
}

function toast(text: string, kind: "ok" | "error" = "ok"): void {
  state.toast = { text, kind };
  render();
  setTimeout(() => {
    if (state.toast?.text === text) {
      state.toast = undefined;
      render();
    }
  }, 3200);
}

async function refresh(): Promise<void> {
  const data = await host.call("ui_state", { project: current()?.project.slug, threadId: state.threadId });
  apply(data.snapshot as Snapshot);
}

function apply(snapshot: Snapshot | undefined): void {
  if (!snapshot) return;
  state.snapshot = snapshot;
  if (snapshot.threadId) state.threadId = snapshot.threadId;
  if (snapshot.threadProject && !state.selected) state.selected = true;
  const focused = document.activeElement;
  if (focused && ["INPUT", "TEXTAREA", "SELECT"].includes(focused.tagName) && root.contains(focused)) return;
  render();
}

async function run(task: () => Promise<void>, success?: string): Promise<void> {
  if (state.pending) return;
  state.pending = true;
  render();
  try {
    await task();
    if (success) toast(success);
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), "error");
  } finally {
    state.pending = false;
    render();
  }
}

function statusLine(agent: AgentView): string {
  if (agent.group === "needs_you") return agent.error ?? agent.report?.needsYou ?? agent.activity ?? "Needs your input";
  if (agent.group === "working") return agent.activity ?? "Working";
  if (agent.report?.summary) return agent.report.summary;
  return agent.lastMessage?.split("\n")[0] ?? agent.task.split("\n")[0];
}

function prBadge(agent: AgentView): string {
  const pr = agent.pr;
  if (!pr && !agent.report?.pr) return "";
  if (!pr) return `<span class="chip">${icon("pr", 11)}PR</span>`;
  if (pr.state === "MERGED") return `<span class="chip pr-merged">${icon("pr", 11)}Merged</span>`;
  if (pr.state === "CLOSED") return `<span class="chip">${icon("pr", 11)}Closed</span>`;
  if (pr.checks === "failing") return `<span class="chip pr-failing">${icon("pr", 11)}Checks failing</span>`;
  if (pr.review === "CHANGES_REQUESTED") return `<span class="chip pr-failing">${icon("pr", 11)}Changes requested</span>`;
  if (pr.review === "APPROVED") return `<span class="chip pr-ok">${icon("pr", 11)}Approved</span>`;
  return `<span class="chip">${icon("pr", 11)}${pr.draft ? "Draft" : pr.checks === "pending" ? "Checks running" : "Open"}</span>`;
}

function agentRow(agent: AgentView): string {
  return `<button class="row agent-row g-${agent.group}" data-action="open-agent" data-id="${agent.id}">
    <span class="status-dot"></span>
    <span class="row-main"><span class="row-title"><span class="t">${escapeHtml(agent.title)}</span>${prBadge(agent)}</span><span class="row-sub">${escapeHtml(statusLine(agent))}</span></span>
    <span class="age">${ago(agent.updatedAt)}</span>
  </button>`;
}

function sectionHead(key: string, label: string, count?: number, extra = ""): string {
  const collapsed = state.collapsed.has(key);
  return `<button class="section-head" data-action="toggle-section" data-key="${key}">${icon(collapsed ? "chevronRight" : "chevronDown", 12, "chev")}<span>${label}</span>${count != null ? `<span class="count">${count}</span>` : ""}${extra}</button>`;
}

function withAgentLinks(html: string, detail: ProjectDetail): string {
  return html.replace(/\(?\b(a-\d{3})\b\)?/g, (match, id: string) => {
    const agent = detail.agents.find((item) => item.id === id);
    return agent ? `<a class="agent-link" data-agent="${id}">${icon("agent", 13)}<strong>${escapeHtml(agent.title)}</strong></a>` : match;
  });
}

function notesBlock(detail: ProjectDetail): string {
  const { tldr, sections } = detail.notes;
  const hasItems = sections.some((section) => section.items.length);
  if (!tldr.length && !hasItems) return "";
  const tl = tldr.length ? `<div class="tldr">${tldr.map((line) => `<div class="tldr-line"><span>${withAgentLinks(inline(line), detail)}</span></div>`).join("")}</div>` : "";
  const body = sections
    .filter((section) => section.items.length || section.title)
    .map(
      (section) => `<div class="notes-section">${section.title ? `<div class="notes-title">${inline(section.title)}</div>` : ""}${section.items
        .map((item) => `<div class="note ${item.checked ? "done" : ""}">${item.checked ? icon("checkCircle", 15, "note-icon") : icon("circle", 15, "note-icon")}<span>${withAgentLinks(inline(item.text), detail)}</span></div>`)
        .join("")}</div>`,
    )
    .join("");
  return `<section class="block">${tl}${body}</section>`;
}

function agentsBlock(detail: ProjectDetail): string {
  const out: string[] = [];
  for (const group of GROUPS) {
    const members = detail.agents.filter((agent) => agent.group === group.id);
    if (!members.length) continue;
    const key = `group-${group.id}`;
    const collapsed = group.id === "resolved" ? !state.collapsed.has("resolved-open") : state.collapsed.has(key);
    const head = `<button class="section-head" data-action="toggle-section" data-key="${group.id === "resolved" ? "resolved-open" : key}" data-invert="${group.id === "resolved"}">${icon(collapsed ? "chevronRight" : "chevronDown", 12, "chev")}<span>${group.label}</span><span class="count">${members.length}</span></button>`;
    out.push(`<section class="block">${head}${collapsed ? "" : `<div class="rows">${members.map(agentRow).join("")}</div>`}</section>`);
  }
  return out.join("");
}

function memoryBlock(detail: ProjectDetail): string {
  if (!detail.memory.length) return "";
  const collapsed = state.collapsed.has("memory");
  const rows = detail.memory
    .map((entry) => `<button class="row" data-action="open-file" data-scope="project" data-path="memory/${escapeHtml(entry.file)}">${icon("memory", 15, "row-icon")}<span class="row-main"><span class="row-title">${escapeHtml(entry.name)}</span><span class="row-sub">${escapeHtml(entry.description || entry.type)}</span></span></button>`)
    .join("");
  return `<section class="block">${sectionHead("memory", "Memory", detail.memory.length)}${collapsed ? "" : `<div class="rows">${rows}</div>`}</section>`;
}

function fileTree(nodes: FileNode[], scope: FileScope, depth: number): string {
  return nodes
    .map((node) => {
      const key = `${scope}:${node.path}`;
      if (node.kind === "dir") {
        const open = state.expandedDirs.has(key);
        return `<button class="tree-row" style="--depth:${depth}" data-action="toggle-dir" data-key="${escapeHtml(key)}">${icon(open ? "folderOpen" : "folder", 15, "row-icon")}<span class="tree-name">${escapeHtml(node.name)}</span><span class="tree-date">${when(node.updatedAt)}</span></button>${open ? fileTree(node.children ?? [], scope, depth + 1) : ""}`;
      }
      return `<button class="tree-row" style="--depth:${depth}" data-action="open-file" data-scope="${scope}" data-path="${escapeHtml(node.path)}" title="${escapeHtml(node.path)}">${icon("file", 15, "row-icon")}<span class="tree-name">${escapeHtml(node.name)}</span><span class="tree-date">${when(node.updatedAt)}</span></button>`;
    })
    .join("");
}

function treeRoot(scope: FileScope, label: string, nodes: FileNode[]): string {
  const key = `root:${scope}`;
  const open = state.expandedDirs.has(key);
  const children = nodes.length ? fileTree(nodes, scope, 1) : `<div class="tree-empty" style="--depth:1">No files yet</div>`;
  return `<button class="tree-row" style="--depth:0" data-action="toggle-dir" data-key="${key}">${icon(open ? "folderOpen" : "folder", 15, "row-icon")}<span class="tree-name">${label}</span></button>${open ? children : ""}`;
}

function filesBlock(detail: ProjectDetail): string {
  const collapsed = state.collapsed.has("files");
  const tree = `<div class="tree">${treeRoot("project", "Coordinator", detail.files.project)}${treeRoot("user", "User", detail.files.user)}</div>`;
  return `<section class="block">${sectionHead("files", "All Files")}${collapsed ? "" : tree}</section>`;
}

function emptyTrack(): string {
  return `<div class="empty">
    <div class="empty-icon">${icon("layers", 17)}</div>
    <div class="empty-title">Nothing to Track Yet</div>
    <div class="empty-sub">Give your project an assignment and track its progress here</div>
  </div>`;
}

function projectPage(detail: ProjectDetail): string {
  const notes = notesBlock(detail);
  const agents = agentsBlock(detail);
  const top = notes || agents ? `${notes}${agents}` : emptyTrack();
  return `${top}${memoryBlock(detail)}${filesBlock(detail)}`;
}

function subHeader(title: string, extra = ""): string {
  return `<div class="subhead"><button class="icon-btn" data-action="back" title="Back">${icon("chevronLeft", 15)}</button><span class="subhead-title">${title}</span>${extra}</div>`;
}

function agentPage(agent: AgentView): string {
  const detail = current()!;
  const report = agent.report;
  const meta = [
    `<span>${icon("terminal", 12)}Codex${agent.model ? ` · ${escapeHtml(agent.model)}` : ""}</span>`,
    agent.branch ? `<span>${icon("branch", 12)}${escapeHtml(agent.branch)}</span>` : "",
    `<span title="${escapeHtml(agent.cwd)}">${icon("folder", 12)}${escapeHtml(base(agent.cwd))}</span>`,
    agent.usage ? `<span>${Math.round((agent.usage.inputTokens + agent.usage.outputTokens) / 1000)}k tokens</span>` : "",
  ].join("");
  const needs = agent.group === "needs_you" ? `<div class="callout">${icon("inbox", 14)}<div>${escapeHtml(agent.error ?? report?.needsYou ?? agent.activity ?? "This agent needs your input.")}</div></div>` : "";
  const working = agent.group === "working" ? `<div class="activity"><span class="spinner"></span>${escapeHtml(agent.activity ?? "Working")}</div>` : "";
  const next = report?.next.length
    ? `<section class="block"><div class="label">Next</div><div class="rows">${report.next.map((line, index) => `<button class="row next-row" data-action="send-next" data-index="${index}"><span class="kbd">${index + 1}</span><span class="row-main">${inline(line)}</span>${icon("send", 13, "send-icon")}</button>`).join("")}</div></section>`
    : "";
  const body = report ? markdown(report.text) : agent.lastMessage ? markdown(agent.lastMessage) : `<span class="muted">No report yet.</span>`;
  const transcript =
    state.transcript?.agentId === agent.id
      ? `<section class="block"><div class="label">Transcript</div><div class="transcript">${state.transcript.items.map((item) => `<div class="t-item t-${item.role}"><span class="t-role">${item.role}</span><div class="md">${item.role === "tool" ? `<code>${escapeHtml(item.text)}</code>` : markdown(item.text.length > 4000 ? `${item.text.slice(0, 4000)}…` : item.text)}</div></div>`).join("") || `<div class="muted">Empty.</div>`}</div></section>`
      : "";
  const actions = [
    agent.sessionId ? `<button class="btn small" data-action="open-thread" data-thread="${agent.sessionId}">${icon("external", 12)}Open chat</button>` : "",
    agent.group === "working" ? `<button class="btn small" data-action="agent" data-op="stop">${icon("stop", 12)}Stop</button>` : "",
    agent.group === "review" ? `<button class="btn small" data-action="agent" data-op="review">${icon("check", 12)}Mark reviewed</button>` : "",
    `<button class="btn small ghost" data-action="transcript">${state.transcript?.agentId === agent.id ? "Hide transcript" : "Transcript"}</button>`,
    agent.resolved ? `<button class="btn small ghost" data-action="agent" data-op="reopen">Reopen</button>` : `<button class="btn small ghost" data-action="agent" data-op="resolve">${icon("archive", 12)}Resolve</button>`,
  ].join("");
  return `${subHeader(escapeHtml(detail.project.name))}
    <div class="agent-head"><div class="dt-row"><span class="status-dot g-${agent.group}"></span><h3>${escapeHtml(agent.title)}</h3></div><div class="dt-sub">${escapeHtml(GROUPS.find((g) => g.id === agent.group)!.label)} · started ${ago(agent.createdAt)} ago</div></div>
    <div class="meta">${meta}</div>
    ${needs}${working}
    ${report?.pr ? `<div class="pr-line"><button class="pr-link" data-action="link" data-url="${escapeHtml(report.pr)}">${icon("pr", 14)}${escapeHtml(report.pr.replace("https://github.com/", ""))}</button>${prBadge(agent)}</div>` : ""}
    <div class="md report">${body}</div>
    ${next}
    <div class="actions">${actions}</div>
    ${transcript}
    <details class="task" data-key="task-${agent.id}" ${state.openDetails.has(`task-${agent.id}`) ? "open" : ""}><summary>Task</summary><div class="md">${markdown(agent.task)}</div></details>
    ${agent.resolved ? "" : `<form class="composer" data-form="reply">
      <textarea name="text" rows="2" data-draft="${agent.id}" placeholder="${agent.group === "working" ? "Send follow-up" : `Reply to ${escapeHtml(agent.title)}`}">${escapeHtml(state.drafts[agent.id] ?? "")}</textarea>
      <div class="composer-bar">${agent.group === "working" ? `<label class="toggle"><input type="checkbox" name="steer" ${state.steer ? "checked" : ""}>Steer now</label>` : `<span></span>`}<button class="send" type="submit" title="Send">${icon("arrowUp", 14)}</button></div>
    </form>`}`;
}

function fileCrumbs(page: FilePage): string {
  const parts = page.path.split("/").filter(Boolean);
  const name = parts.pop() ?? page.path;
  const trail = [page.scope === "user" ? "User" : "Coordinator", ...parts].map((part) => `<span class="crumb">${escapeHtml(part)}</span><span class="crumb-sep">/</span>`).join("");
  return `<span class="crumbs">${trail}<span class="crumb current">${escapeHtml(name)}</span></span>`;
}

function isDirty(page: FilePage): boolean {
  return page.draft !== undefined && page.draft !== page.text;
}

function filePage(page: FilePage): string {
  const dirty = isDirty(page);
  const segment = (view: FilePage["view"], label: string) => `<button class="seg ${page.view === view ? "on" : ""}" data-action="file-view" data-view="${view}">${label}</button>`;
  const markdownFile = /\.(md|markdown|mdx)$/i.test(page.path);
  const bar = `<div class="file-bar">
    <button class="icon-btn" data-action="back" title="Back">${icon("chevronLeft", 15)}</button>
    ${fileCrumbs(page)}${dirty ? `<span class="dirty-dot" title="Unsaved changes"></span>` : ""}
    <span class="file-tools">
      ${markdownFile && !page.tooLarge ? `<span class="segmented">${segment("preview", "Preview")}${segment("source", "Source")}</span>` : ""}
      ${dirty ? `<button class="btn small ghost" data-action="file-discard">Discard</button><button class="btn small primary" data-action="file-save">Save</button>` : ""}
    </span>
  </div>`;
  if (page.tooLarge) return `${bar}<div class="empty"><div class="empty-title">This file is too large to show here</div></div>`;
  const text = page.draft ?? page.text;
  const body =
    markdownFile && page.view === "preview"
      ? `<article class="md doc">${text.trim() ? markdown(text, { frontmatter: true }) : `<p class="muted">Empty file. Switch to Source to write it.</p>`}</article>`
      : `<textarea class="source" data-bind="file-draft" spellcheck="false">${escapeHtml(text)}</textarea>`;
  return `${bar}<div class="file-body">${body}</div>`;
}

function settingsPage(detail: ProjectDetail): string {
  const draft = state.settings!;
  return `${subHeader("Coordinator settings")}
  <form class="form" data-form="settings">
    <div class="identity">
      <button type="button" class="icon-tile c-${draft.color}" data-action="toggle-picker" title="Choose an icon">${icon(draft.icon, 26)}</button>
      <input class="title-input" name="name" value="${escapeHtml(detail.project.name)}" placeholder="New Coordinator">
    </div>
    ${draft.picker ? iconPicker(draft) : ""}
    <div class="field-rows">
      ${workspaceField(draft)}
      ${fieldRow("Model", modelField(draft))}
    </div>
    <label class="field"><span>Instructions</span><textarea name="instructions" rows="8" maxlength="16000" placeholder="What every agent should know: conventions, which folder is which, rules no task can break.">${escapeHtml(detail.instructions.trim())}</textarea><span class="hint">Sent to every agent, like an AGENTS.md for the whole project.</span></label>
    <label class="check"><input type="checkbox" name="prFollowUp" ${detail.project.prFollowUp !== false ? "checked" : ""}><span><strong>Follow up on pull requests</strong><em>Send failing checks and requested changes back to the agent that opened the PR.</em></span></label>
    <div class="form-actions"><button class="btn primary" type="submit">Save</button><button class="btn ghost" type="button" data-action="archive">${icon("archive", 13)}Archive coordinator</button></div>
  </form>`;
}

function fieldRow(label: string, control: string): string {
  return `<div class="field-row"><span class="field-label">${label}</span><div class="field-control">${control}</div></div>`;
}

interface Choice {
  value: string;
  label: string;
  sub?: string;
}

function dropdown(key: DropdownKey, placeholder: string, choices: Choice[], selected: string, strong = false): string {
  const open = state.dropdown === key;
  const current = choices.find((choice) => choice.value === selected)?.label ?? placeholder;
  const menu = open
    ? `<div class="dd-menu">${choices
        .map(
          (choice) => `<button type="button" class="dd-item ${choice.value === selected ? "on" : ""}" data-action="pick" data-key="${key}" data-value="${escapeHtml(choice.value)}"><span class="dd-text"><span class="dd-label">${escapeHtml(choice.label)}</span>${choice.sub ? `<span class="dd-sub">${escapeHtml(choice.sub)}</span>` : ""}</span>${choice.value === selected ? icon("check", 14, "dd-check") : ""}</button>`,
        )
        .join("")}</div>`
    : "";
  return `<div class="dd ${open ? "open" : ""}"><button type="button" class="dd-btn ${strong ? "strong" : ""}" data-action="dropdown" data-key="${key}">${escapeHtml(current)}${icon("chevronDown", 12, "chev")}</button>${menu}</div>`;
}

function homeDir(): string {
  const root = state.snapshot?.root ?? "";
  return root.replace(/\/[^/]+\/?$/, "");
}

function tilde(dir: string): string {
  const home = homeDir();
  return home && dir.startsWith(home + "/") ? `~${dir.slice(home.length)}` : dir;
}

function workspaceField(draft: Draft): string {
  const workspaces = state.options?.workspaces ?? [];
  const chosen = draft.workspace !== "__other" ? draft.workspace : "";
  const list = chosen && !workspaces.includes(chosen) ? [chosen, ...workspaces] : workspaces;
  const choices: Choice[] = [...list.map((dir) => ({ value: dir, label: base(dir), sub: tilde(dir) })), { value: "__other", label: "Other folder…" }, { value: "", label: "No repository" }];
  const row = fieldRow("Workspace", dropdown("workspace", state.options ? "No repository" : "Loading repositories…", choices, draft.workspace));
  const other = draft.workspace === "__other" ? `<div class="field-row"><input class="path-input" data-bind="otherPath" value="${escapeHtml(draft.otherPath)}" placeholder="/Users/you/code/api" autocomplete="off"></div>` : "";
  return row + other;
}

function modelField(draft: Draft): string {
  const models = state.options?.models ?? [];
  const fallback = models.find((option) => option.isDefault);
  const chosen = models.find((option) => option.id === draft.model) ?? fallback;
  const efforts = chosen?.efforts.length ? chosen.efforts : ["low", "medium", "high"];
  const modelChoices: Choice[] = [{ value: "", label: fallback ? `${fallback.label}` : "Default", sub: "Codex default" }, ...models.filter((option) => option !== fallback).map((option) => ({ value: option.id, label: option.label }))];
  const effortChoices: Choice[] = [{ value: "", label: chosen ? capital(chosen.defaultEffort) : "Default", sub: "Model default" }, ...efforts.map((value) => ({ value, label: capital(value) }))];
  return `${dropdown("model", state.options ? "Default" : "Loading…", modelChoices, draft.model, true)}${dropdown("effort", "Default", effortChoices, draft.effort)}`;
}

function capital(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

function iconPicker(draft: Draft): string {
  return `<div class="icon-picker">
    <div class="picker-grid">${PROJECT_ICONS.map((name) => `<button type="button" class="pick ${draft.icon === name ? "on" : ""}" data-action="pick-icon" data-value="${name}">${icon(name, 17)}</button>`).join("")}</div>
    <div class="picker-colors">${PROJECT_COLORS.map((color) => `<button type="button" class="swatch c-${color} ${draft.color === color ? "on" : ""}" data-action="pick-color" data-value="${color}" title="${color}"></button>`).join("")}</div>
  </div>`;
}

function createDialog(): string {
  const draft = state.create!;
  return `<div class="modal-scrim" data-action="close-create"></div>
  <form class="modal" data-form="create" role="dialog" aria-label="Create Coordinator">
    <div class="modal-head"><div><h2>Create Coordinator</h2><p>Create a focused chat where agents coordinate work</p></div><button type="button" class="icon-btn" data-action="close-create" title="Close">${icon("x", 15)}</button></div>
    <div class="modal-body">
      <button type="button" class="icon-bare c-${draft.color}" data-action="toggle-picker" title="Choose an icon">${icon(draft.icon, 32)}</button>
      ${draft.picker ? iconPicker(draft) : ""}
      <input class="title-input center" data-bind="name" value="${escapeHtml(draft.name)}" placeholder="New Coordinator" autocomplete="off" autofocus>
      <div class="field-rows">
        ${workspaceField(draft)}
        ${fieldRow("Model", modelField(draft))}
      </div>
    </div>
    <div class="modal-foot"><button class="btn accent" type="submit" ${draft.saving ? "disabled" : ""}>${draft.saving ? `<span class="spinner light"></span>Creating…` : "Create Coordinator"}</button></div>
  </form>`;
}

function panelView(): string {
  const detail = current();
  if (!detail) {
    return `<div class="panel"><div class="panel-body">${`<div class="empty"><div class="empty-icon">${icon("layers", 17)}</div><div class="empty-title">No coordinators yet</div><div class="empty-sub">Create a focused chat where agents coordinate work</div><button class="btn primary" data-action="new-project">${icon("plus", 14)}New Coordinator</button></div>`}</div></div>`;
  }
  const page = state.page;
  let body = "";
  if (page.kind === "agent") {
    const agent = agentById(page.id);
    body = agent ? agentPage(agent) : projectPage(detail);
  } else if (page.kind === "file") body = filePage(page);
  else if (page.kind === "settings") body = settingsPage(detail);
  else body = projectPage(detail);
  const head =
    page.kind === "project"
      ? `<header class="panel-head">
          <div class="ph-title">${projectIcon(detail.project, 20)}<h1>${escapeHtml(detail.project.name)}</h1></div>
          <div class="ph-actions"><button class="icon-btn" data-action="settings" title="Coordinator settings">${icon("settings", 15)}</button></div>
        </header>`
      : "";
  return `<div class="panel">${head}<div class="panel-body">${body}</div></div>`;
}

function projectMeta(project: ProjectSummary): string {
  const parts: string[] = [];
  if (project.needsYou) parts.push(`${project.needsYou} need${project.needsYou === 1 ? "s" : ""} you`);
  if (project.working) parts.push(`${project.working} working`);
  if (project.review) parts.push(`${project.review} to review`);
  if (!parts.length) parts.push(project.workspace ? base(project.workspace) : "No repository");
  parts.push(ago(project.updatedAt));
  return parts.join(" · ");
}

function projectRow(project: ProjectSummary, active: boolean): string {
  return `<button class="prow ${active ? "on" : ""}" data-action="select" data-slug="${project.slug}">
    <span class="prow-title">${escapeHtml(project.name)}</span>
    <span class="prow-meta">${projectIcon(project, 14)}<span>${escapeHtml(projectMeta(project))}</span></span>
  </button>`;
}

function homeView(): string {
  const snapshot = state.snapshot!;
  const detail = current();
  const needle = state.filter.trim().toLowerCase();
  const projects = snapshot.projects.filter((project) => !needle || project.name.toLowerCase().includes(needle));
  const groups: [string, ProjectSummary[]][] = [
    ["Needs you", projects.filter((project) => project.needsYou > 0)],
    ["In progress", projects.filter((project) => !project.needsYou && (project.working > 0 || project.review > 0))],
    ["Recent", projects.filter((project) => !project.needsYou && !project.working && !project.review)],
  ];
  const sections = groups
    .filter(([, members]) => members.length)
    .map(([label, members]) => `<div class="plabel">${label}</div>${members.map((project) => projectRow(project, project.slug === detail?.project.slug && state.selected)).join("")}`)
    .join("");
  const list = `<aside class="plist"><div class="plist-resize" data-drag="plist" title="Drag to resize"></div>
    <div class="plist-top"><label class="search-pill">${icon("search", 15)}<input data-bind="filter" value="${escapeHtml(state.filter)}" placeholder="Search coordinators" autocomplete="off"></label><button class="icon-btn" data-action="new-project" title="New Coordinator">${icon("plus", 16)}</button></div>
    <div class="plist-rows">${sections || `<div class="plabel">${snapshot.projects.length ? "No matches" : "No coordinators yet"}</div>`}</div>
  </aside>`;
  let main: string;
  if (!snapshot.projects.length) {
    main = `<div class="empty center"><div class="empty-glyph">${icon("layers", 30)}</div><div class="empty-title">Create your first coordinator</div><div class="empty-sub">A focused chat where agents coordinate work</div><button class="btn primary" data-action="new-project">${icon("plus", 14)}New Coordinator</button></div>`;
  } else if (!detail || !state.selected) {
    main = `<div class="empty center"><div class="empty-glyph">${icon("layers", 30)}</div><div class="empty-title">Select a coordinator</div><div class="empty-sub">Choose one from the sidebar to see its agents, notes, and memory</div></div>`;
  } else {
    const page = state.page;
    let body = "";
    if (page.kind === "agent") {
      const agent = agentById(page.id);
      body = agent ? agentPage(agent) : projectPage(detail);
    } else if (page.kind === "file") body = filePage(page);
    else if (page.kind === "settings" && state.settings) body = settingsPage(detail);
    else body = projectPage(detail);
    const chat = detail.project.coordinatorThreadId
      ? `<button class="btn small" data-action="open-coordinator">${icon("chat", 13)}Open chat</button>`
      : `<button class="btn small primary" data-action="open-coordinator">${icon("chat", 13)}Start coordinator</button>`;
    const head =
      page.kind === "project"
        ? `<header class="pdetail-head"><div class="ph-title">${projectIcon(detail.project, 20)}<h1>${escapeHtml(detail.project.name)}</h1></div><div class="ph-actions">${chat}<button class="icon-btn" data-action="settings" title="Coordinator settings">${icon("settings", 15)}</button></div></header>`
        : "";
    main = `${head}<div class="pdetail-body">${body}</div>`;
  }
  return `<div class="home" style="--plist-w:${state.listWidth}px">${list}<main class="pdetail">${main}</main></div>`;
}

const SCROLLERS = [".panel-body", ".pdetail-body", ".plist-rows", ".transcript", ".source"];

function render(): void {
  if (root.querySelector(".home.resizing")) return;
  if (!state.snapshot) {
    root.innerHTML = `<div class="loading"><span class="spinner"></span></div>`;
    return;
  }
  const scroll = SCROLLERS.map((selector) => root.querySelector(selector)?.scrollTop ?? 0);
  document.body.classList.toggle("is-panel", state.mode === "panel");
  const view = state.mode === "panel" ? panelView() : homeView();
  root.innerHTML = view + (state.create ? createDialog() : "") + (state.toast ? `<div class="toast ${state.toast.kind}">${escapeHtml(state.toast.text)}</div>` : "") + (state.pending ? `<div class="busy"></div>` : "");
  SCROLLERS.forEach((selector, index) => {
    const element = root.querySelector(selector);
    if (element && scroll[index]) element.scrollTop = scroll[index];
  });
  syncPageNote();
  const autofocus = root.querySelector<HTMLInputElement>("[autofocus]");
  if (autofocus && document.activeElement === document.body) autofocus.focus();
}

function formData(form: HTMLFormElement): Record<string, string> {
  const data: Record<string, string> = {};
  new FormData(form).forEach((value, key) => {
    data[key] = String(value);
  });
  return data;
}

async function loadOptions(): Promise<void> {
  if (state.options) return;
  try {
    const result = await host.call("ui_create_options");
    state.options = { models: result.models ?? [], workspaces: result.workspaces ?? [] };
  } catch {
    state.options = { models: [], workspaces: [] };
  }
  render();
}

function openCreate(): void {
  const pick = PROJECT_ICONS[Math.floor(Math.random() * PROJECT_ICONS.length)];
  state.create = { name: "", icon: pick, color: "gray", workspace: "", otherPath: "", model: "", effort: "", picker: false, saving: false };
  state.dropdown = undefined;
  render();
  void loadOptions();
}

function activeDraft(): Draft | undefined {
  return state.create ?? (state.page.kind === "settings" ? state.settings : undefined);
}

function openSettings(detail: ProjectDetail): void {
  const project = detail.project;
  state.settings = { icon: project.icon, color: project.color, workspace: project.repos[0] ?? "", otherPath: "", model: project.model ?? "", effort: project.effort ?? "", picker: false };
  state.page = { kind: "settings" };
  state.dropdown = undefined;
  render();
  void loadOptions();
}

function absolutePath(detail: ProjectDetail, scope: FileScope, relative: string): string {
  return `${detail.files.roots[scope]}/${relative.replace(/^\.?\//, "")}`;
}

function scopeOf(detail: ProjectDetail, target: string): { scope: FileScope; path: string } | undefined {
  for (const scope of ["project", "user"] as FileScope[]) {
    const root = detail.files.roots[scope] + "/";
    if (target.startsWith(root)) return { scope, path: target.slice(root.length) };
  }
  if (!target.startsWith("/")) return { scope: "project", path: target.replace(/^\.?\//, "") };
  return undefined;
}

async function openFile(detail: ProjectDetail, scope: FileScope, relative: string): Promise<void> {
  if (state.page.kind === "file" && isDirty(state.page) && !confirm("Discard unsaved changes?")) return;
  if (await host.openFile(absolutePath(detail, scope, relative))) return;
  return run(async () => {
    const result = await host.call("ui_file", { project: detail.project.slug, scope, path: relative });
    const file = result.file;
    state.page = { kind: "file", scope, path: relative, text: file.text, updatedAt: file.updatedAt, view: "preview", tooLarge: file.tooLarge };
  });
}

async function openLinkedFile(target: string): Promise<void> {
  const detail = current();
  if (!detail) return;
  const scoped = scopeOf(detail, target);
  if (scoped) return openFile(detail, scoped.scope, scoped.path);
  if (!(await host.openFile(target))) toast("Could not open that file here.", "error");
}

async function saveFile(): Promise<void> {
  const detail = current();
  const page = state.page;
  if (!detail || page.kind !== "file" || page.draft === undefined) return;
  const text = page.draft;
  return run(async () => {
    const result = await host.call("ui_file_write", { project: detail.project.slug, scope: page.scope, path: page.path, text, expectedUpdatedAt: page.updatedAt });
    state.snapshot = result.snapshot;
    if (state.page === page) {
      page.text = result.file.text;
      page.updatedAt = result.file.updatedAt;
      page.draft = undefined;
    }
  }, "Saved");
}

async function openCoordinator(slug: string): Promise<void> {
  const info = await host.call("ui_coordinator", { project: slug });
  if (info.threadId && (await host.openLink(`codex://threads/${info.threadId}`))) return;
  if (info.newThreadUrl && (await host.openLink(info.newThreadUrl))) return;
  if (!(await host.message(info.kickoff, "new"))) toast("Could not open the chat. Type $coordinator in a new chat instead.", "error");
}

async function onAction(target: HTMLElement): Promise<void> {
  const action = target.dataset.action!;
  const detail = current();
  switch (action) {
    case "select":
      state.selected = true;
      state.page = { kind: "project" };
      return run(async () => {
        const data = await host.call("ui_state", { project: target.dataset.slug });
        state.snapshot = data.snapshot as Snapshot;
        if (state.mode === "home" && target.dataset.slug) await openCoordinator(target.dataset.slug);
      });
    case "new-project":
      return openCreate();
    case "close-create":
      state.create = undefined;
      state.dropdown = undefined;
      return render();
    case "toggle-picker": {
      const draft = activeDraft();
      if (draft) draft.picker = !draft.picker;
      state.dropdown = undefined;
      return render();
    }
    case "pick-icon":
    case "pick-color": {
      const draft = activeDraft();
      if (!draft) return;
      if (action === "pick-icon") {
        draft.icon = target.dataset.value as ProjectIcon;
        draft.picker = false;
      } else draft.color = target.dataset.value as ProjectColor;
      return render();
    }
    case "dropdown": {
      const key = target.dataset.key as DropdownKey;
      state.dropdown = state.dropdown === key ? undefined : key;
      return render();
    }
    case "pick": {
      const draft = activeDraft();
      const key = target.dataset.key as DropdownKey;
      if (!draft) return;
      draft[key] = target.dataset.value ?? "";
      if (key === "model") draft.effort = "";
      state.dropdown = undefined;
      render();
      if (key === "workspace" && draft.workspace === "__other") root.querySelector<HTMLInputElement>(".path-input")?.focus();
      return;
    }
    case "settings":
      if (!detail) return;
      openSettings(detail);
      return;
    case "project-settings":
      return run(async () => {
        const data = await host.call("ui_state", { project: target.dataset.slug });
        state.snapshot = data.snapshot as Snapshot;
        if (state.snapshot.current) openSettings(state.snapshot.current);
      });
    case "back":
      if (state.page.kind === "file" && isDirty(state.page) && !confirm("Discard unsaved changes?")) return;
      state.page = { kind: "project" };
      state.transcript = undefined;
      state.settings = undefined;
      state.dropdown = undefined;
      return render();
    case "toggle-section": {
      const key = target.dataset.key!;
      if (state.collapsed.has(key)) state.collapsed.delete(key);
      else state.collapsed.add(key);
      return render();
    }
    case "toggle-dir": {
      const key = target.dataset.key!;
      if (state.expandedDirs.has(key)) state.expandedDirs.delete(key);
      else state.expandedDirs.add(key);
      return render();
    }
    case "open-agent":
      state.page = { kind: "agent", id: target.dataset.id! };
      state.transcript = undefined;
      state.steer = false;
      return render();
    case "open-file": {
      if (!detail) return;
      const scope = (target.dataset.scope as FileScope) ?? "project";
      return openFile(detail, scope, target.dataset.path!);
    }
    case "file-view": {
      if (state.page.kind !== "file") return;
      state.page.view = target.dataset.view as FilePage["view"];
      return render();
    }
    case "file-discard": {
      if (state.page.kind !== "file") return;
      state.page.draft = undefined;
      return render();
    }
    case "file-save":
      return saveFile();
    case "open-coordinator":
      if (!detail) return;
      return run(() => openCoordinator(detail.project.slug));
    case "open-thread":
      if (!(await host.openLink(`codex://threads/${target.dataset.thread}`))) toast("Could not open the chat.", "error");
      return;
    case "link":
      await host.openLink(target.dataset.url!);
      return;
    case "transcript": {
      const agent = state.page.kind === "agent" ? agentById(state.page.id) : undefined;
      if (!detail || !agent) return;
      if (state.transcript?.agentId === agent.id) {
        state.transcript = undefined;
        return render();
      }
      return run(async () => {
        const result = await host.call("ui_transcript", { project: detail.project.slug, agent: agent.id });
        state.transcript = { agentId: agent.id, items: result.items ?? [] };
      });
    }
    case "send-next": {
      const agent = state.page.kind === "agent" ? agentById(state.page.id) : undefined;
      const line = agent?.report?.next[Number(target.dataset.index)];
      if (!detail || !agent || !line) return;
      return run(async () => {
        const result = await host.call("ui_agent", { project: detail.project.slug, agent: agent.id, action: "send", text: line });
        state.snapshot = result.snapshot;
      }, `Sent to ${agent.title}`);
    }
    case "agent": {
      const agent = state.page.kind === "agent" ? agentById(state.page.id) : undefined;
      const op = target.dataset.op!;
      if (!detail || !agent) return;
      if (op === "resolve" && !confirm(`Resolve "${agent.title}"? Its branch and files stay.`)) return;
      return run(async () => {
        const result = await host.call("ui_agent", { project: detail.project.slug, agent: agent.id, action: op });
        state.snapshot = result.snapshot;
        if (op === "resolve") state.page = { kind: "project" };
      });
    }
    case "archive":
      if (!detail || !confirm(`Archive ${detail.project.name}? Its files stay on disk.`)) return;
      return run(async () => {
        const result = await host.call("ui_project_save", { project: detail.project.slug, archived: true });
        state.snapshot = result.snapshot;
        state.page = { kind: "project" };
      }, "Coordinator archived");
  }
}

async function onSubmit(form: HTMLFormElement): Promise<void> {
  const data = formData(form);
  const detail = current();
  if (form.dataset.form === "create" && state.create) {
    const draft = state.create;
    const workspace = draft.workspace === "__other" ? draft.otherPath.trim() : draft.workspace;
    draft.saving = true;
    render();
    try {
      const result = await host.call("ui_project_save", {
        name: draft.name.trim() || "New Coordinator",
        icon: draft.icon,
        color: draft.color,
        repos: workspace ? [workspace] : [],
        model: draft.model,
        effort: draft.effort,
      });
      state.snapshot = result.snapshot;
      state.create = undefined;
      state.page = { kind: "project" };
      render();
      state.selected = true;
      await openCoordinator(result.saved as string);
    } catch (error) {
      draft.saving = false;
      toast(error instanceof Error ? error.message : String(error), "error");
    }
    return;
  }
  if (form.dataset.form === "settings" && detail && state.settings) {
    const draft = state.settings;
    const workspace = draft.workspace === "__other" ? draft.otherPath.trim() : draft.workspace;
    return run(async () => {
      const result = await host.call("ui_project_save", {
        project: detail.project.slug,
        name: data.name,
        icon: draft.icon,
        color: draft.color,
        repos: workspace ? [workspace] : [],
        model: draft.model,
        effort: draft.effort,
        instructions: data.instructions,
        prFollowUp: data.prFollowUp === "on",
      });
      state.snapshot = result.snapshot;
      state.settings = undefined;
      state.page = { kind: "project" };
    }, "Saved");
  }
  if (form.dataset.form === "reply" && detail && state.page.kind === "agent") {
    const agent = agentById(state.page.id);
    const text = data.text?.trim();
    if (!agent || !text) return;
    return run(async () => {
      const result = await host.call("ui_agent", { project: detail.project.slug, agent: agent.id, action: "send", text, mode: data.steer ? "steer" : "queue" });
      state.snapshot = result.snapshot;
      delete state.drafts[agent.id];
    }, "Sent");
  }
}

root.addEventListener("click", (event) => {
  const element = event.target as HTMLElement;
  if (state.dropdown && !element.closest(".dd")) {
    state.dropdown = undefined;
    render();
    if (!element.closest("[data-action]")) return;
  }
  const agentLink = element.closest<HTMLAnchorElement>("a[data-agent]");
  if (agentLink) {
    event.preventDefault();
    state.page = { kind: "agent", id: agentLink.dataset.agent! };
    state.transcript = undefined;
    render();
    return;
  }
  const anchor = element.closest<HTMLAnchorElement>("a[data-link], a[data-file]");
  if (anchor) {
    event.preventDefault();
    if (anchor.dataset.link) void host.openLink(anchor.dataset.link);
    else if (anchor.dataset.file) void openLinkedFile(anchor.dataset.file);
    return;
  }
  const target = element.closest<HTMLElement>("[data-action]");
  if (!target || target.tagName === "FORM") return;
  void onAction(target);
});

root.addEventListener("pointerdown", (event) => {
  const handle = (event.target as HTMLElement).closest<HTMLElement>("[data-drag='plist']");
  const home = root.querySelector<HTMLElement>(".home");
  if (!handle || !home) return;
  event.preventDefault();
  handle.setPointerCapture(event.pointerId);
  const startX = event.clientX;
  const startWidth = state.listWidth;
  home.classList.add("resizing");
  const move = (next: PointerEvent) => {
    state.listWidth = clampListWidth(startWidth + next.clientX - startX);
    home.style.setProperty("--plist-w", `${state.listWidth}px`);
  };
  const stop = () => {
    home.classList.remove("resizing");
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", stop);
    handle.removeEventListener("pointercancel", stop);
    try {
      localStorage.setItem(LIST_WIDTH_KEY, String(state.listWidth));
    } catch {}
  };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", stop);
  handle.addEventListener("pointercancel", stop);
});

root.addEventListener("dblclick", (event) => {
  if (!(event.target as HTMLElement).closest("[data-drag='plist']")) return;
  state.listWidth = 260;
  try {
    localStorage.removeItem(LIST_WIDTH_KEY);
  } catch {}
  render();
});

root.addEventListener("submit", (event) => {
  event.preventDefault();
  void onSubmit(event.target as HTMLFormElement);
});

root.addEventListener("input", (event) => {
  const field = event.target as HTMLInputElement;
  if (field.dataset.draft) state.drafts[field.dataset.draft] = field.value;
  const bind = field.dataset.bind;
  if (bind === "filter") {
    state.filter = field.value;
    const position = field.selectionStart;
    render();
    const input = root.querySelector<HTMLInputElement>("[data-bind='filter']");
    input?.focus();
    if (position != null) input?.setSelectionRange(position, position);
    return;
  }
  if (bind === "file-draft" && state.page.kind === "file") {
    const wasDirty = isDirty(state.page);
    state.page.draft = field.value;
    if (wasDirty !== isDirty(state.page)) refreshFileBar();
    return;
  }
  if (bind === "name" && state.create) state.create.name = field.value;
  if (bind === "otherPath") {
    const draft = activeDraft();
    if (draft) draft.otherPath = field.value;
  }
});

root.addEventListener("change", (event) => {
  const input = event.target as HTMLInputElement;
  if (input.name === "steer") state.steer = input.checked;
});

root.addEventListener("toggle", (event) => {
  const details = event.target as HTMLDetailsElement;
  const key = details.dataset?.key;
  if (!key) return;
  if (details.open) state.openDetails.add(key);
  else state.openDetails.delete(key);
}, true);

function refreshFileBar(): void {
  if (state.page.kind !== "file") return;
  const bar = root.querySelector(".file-bar");
  const holder = document.createElement("div");
  holder.innerHTML = filePage(state.page);
  const next = holder.querySelector(".file-bar");
  if (bar && next) bar.replaceWith(next);
}

root.addEventListener("keydown", (event) => {
  const target = event.target as HTMLElement;
  if (event.key === "s" && (event.metaKey || event.ctrlKey) && state.page.kind === "file") {
    event.preventDefault();
    void saveFile();
    return;
  }
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && target.tagName === "TEXTAREA") {
    event.preventDefault();
    target.closest("form")?.requestSubmit();
  }
  if (event.key === "Escape") {
    if (state.dropdown) state.dropdown = undefined;
    else if (state.create) state.create = undefined;
    else if (state.page.kind === "file" && isDirty(state.page)) return;
    else if (state.page.kind !== "project") {
      state.page = { kind: "project" };
      state.settings = undefined;
    }
    render();
  }
});

function applyContext(context: McpUiHostContext | undefined): void {
  if (!context) return;
  if (context.theme) applyDocumentTheme(context.theme);
  if (context.styles?.variables) applyHostStyleVariables(context.styles.variables);
  if (context.styles?.css?.fonts) applyHostFonts(context.styles.css.fonts);
  document.body.classList.toggle("fullscreen", context.displayMode === "fullscreen");
  const inset = context.safeAreaInsets?.right ?? 0;
  document.documentElement.style.setProperty("--chat-inset", inset > 0 ? `${inset}px` : "");
}

function handleContent(content: Record<string, any>): void {
  if (content.mode === "panel" || content.mode === "home") state.mode = content.mode;
  apply(content.snapshot as Snapshot);
  if (content.create) openCreate();
}

function connectMcpHost(): Host {
  const app = new App({ name: "coordinator", version: "0.2.0" }, {}, { autoResize: true });
  const extensions = new OpenAIExtensions(app);
  app.ontoolresult = (result) => handleContent((result.structuredContent ?? {}) as Record<string, any>);
  app.addEventListener("hostcontextchanged", (context) => {
    applyContext({ ...app.getHostContext(), ...context });
    if ((context as Record<string, unknown>)["openai/modelContext"] === null) {
      pageNoteSent = false;
      syncPageNote();
    }
  });
  const connected = app.connect().then(() => {
    const context = app.getHostContext();
    const tool = context?.toolInfo?.tool?.name;
    if (tool === "coordinator_home" || tool === "project_new") state.mode = "home";
    applyContext(context);
    if (!state.snapshot) void refresh().catch((error) => toast(String(error.message ?? error), "error"));
  });
  return {
    async call(name, args = {}) {
      await connected;
      const result = await app.callServerTool({ name, arguments: args });
      if (result.isError) throw new Error(result.content?.map((part: any) => part.text).join("\n") || `${name} failed`);
      return (result.structuredContent ?? {}) as Record<string, any>;
    },
    async openLink(url) {
      await connected;
      try {
        const result = await app.openLink({ url });
        return !(result as { isError?: boolean })?.isError;
      } catch {
        return false;
      }
    },
    async message(text, target) {
      await connected;
      try {
        if (extensions.message) await extensions.message.send({ role: "user", content: [{ type: "text", text }], _meta: { "openai/message": { target } } } as any);
        else await app.sendMessage({ role: "user", content: [{ type: "text", text }] });
        return true;
      } catch {
        return false;
      }
    },
    async openFile(path) {
      await connected;
      if (!extensions.files) return false;
      try {
        await extensions.files.open(path);
        return true;
      } catch {
        return false;
      }
    },
    async pageNote(text) {
      await connected;
      if (!app.getHostCapabilities()?.updateModelContext) return false;
      try {
        await app.updateModelContext({ content: [{ type: "text", text, annotations: { audience: ["assistant"] } }] });
        return true;
      } catch {
        return false;
      }
    },
    async fullscreen() {
      await connected;
      try {
        return (await app.requestDisplayMode({ mode: "fullscreen" })).mode === "fullscreen";
      } catch {
        return false;
      }
    },
  };
}

function connectPreviewHost(): Host {
  const params = new URLSearchParams(location.search);
  state.mode = params.get("mode") === "home" ? "home" : "panel";
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await fetch("/call", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, arguments: args }) });
    const result = await response.json();
    if (result.isError) throw new Error(result.content?.map((part: any) => part.text).join("\n") || `${name} failed`);
    return (result.structuredContent ?? {}) as Record<string, any>;
  };
  const note = (label: string, text: string) => {
    toast(`${label}: ${text.slice(0, 120)}`);
    return Promise.resolve(true);
  };
  void call(state.mode === "home" ? "coordinator_home" : "project_panel").then(handleContent);
  return { call, openLink: (url) => note("open", url), message: (text, target) => note(`message (${target})`, text), openFile: async () => false, pageNote: async () => false, fullscreen: async () => false };
}

host = window.parent !== window ? connectMcpHost() : connectPreviewHost();
render();

setInterval(() => {
  if (document.visibilityState === "visible" && state.snapshot && !state.pending && !state.create && !state.settings) void refresh().catch(() => undefined);
}, 3000);
