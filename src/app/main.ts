import { App, applyDocumentTheme, applyHostFonts, applyHostStyleVariables, type McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { OpenAIExtensions } from "@openai/mcp-extensions/app";
import type { AgentGroup, AgentView, FileNode, ModelOption, ProjectDetail, ProjectIcon, ProjectColor, ProjectSummary, Snapshot, TranscriptItem } from "../shared/types.ts";
import { PROJECT_COLORS, PROJECT_ICONS } from "../shared/types.ts";
import { icon } from "./icons.ts";
import { escapeHtml, inline, markdown } from "./markdown.ts";

type Mode = "home" | "panel";
type Page = { kind: "project" } | { kind: "agent"; id: string } | { kind: "file"; scope: "project" | "user"; path: string; text: string } | { kind: "settings" } | { kind: "pick" };

interface Host {
  call(name: string, args?: Record<string, unknown>): Promise<Record<string, any>>;
  openLink(url: string): Promise<boolean>;
  message(text: string, target: "new" | "active"): Promise<boolean>;
  fullscreen(): Promise<boolean>;
}

interface CreateDraft {
  name: string;
  icon: ProjectIcon;
  color: ProjectColor;
  workspace: string;
  otherPath: string;
  model: string;
  effort: string;
  picker: boolean;
  saving: boolean;
}

interface State {
  snapshot?: Snapshot;
  mode: Mode;
  threadId?: string;
  page: Page;
  create?: CreateDraft;
  options?: { models: ModelOption[]; workspaces: string[] };
  transcript?: { agentId: string; items: TranscriptItem[] };
  menu: boolean;
  expandedDirs: Set<string>;
  collapsed: Set<string>;
  steer: boolean;
  drafts: Record<string, string>;
  openDetails: Set<string>;
  toast?: { text: string; kind: "ok" | "error" };
  pending: boolean;
}

const state: State = {
  mode: "panel",
  page: { kind: "project" },
  menu: false,
  expandedDirs: new Set(["project:memory"]),
  collapsed: new Set(["files", "resolved"]),
  steer: false,
  drafts: {},
  openDetails: new Set(),
  pending: false,
};

const GROUPS: { id: AgentGroup; label: string }[] = [
  { id: "needs_you", label: "Needs you" },
  { id: "review", label: "Ready for review" },
  { id: "working", label: "Working" },
  { id: "idle", label: "Idle" },
  { id: "resolved", label: "Resolved" },
];

const root = document.getElementById("root")!;
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

function notesBlock(detail: ProjectDetail): string {
  const { tldr, sections } = detail.notes;
  const hasItems = sections.some((section) => section.items.length);
  if (!tldr.length && !hasItems) return "";
  const tl = tldr.length ? `<div class="tldr">${tldr.map((line) => `<div class="tldr-line"><span>${inline(line)}</span></div>`).join("")}</div>` : "";
  const body = sections
    .filter((section) => section.items.length || section.title)
    .map(
      (section) => `<div class="notes-section">${section.title ? `<div class="notes-title">${inline(section.title)}</div>` : ""}${section.items
        .map((item) => `<div class="note ${item.checked ? "done" : ""}">${item.checked ? icon("checkCircle", 15, "note-icon") : icon("circle", 15, "note-icon")}<span>${inline(item.text)}</span></div>`)
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

function fileTree(nodes: FileNode[], scope: "project" | "user", depth: number): string {
  return nodes
    .map((node) => {
      const key = `${scope}:${node.path}`;
      if (node.kind === "dir") {
        const open = state.expandedDirs.has(key);
        return `<button class="tree-row" style="--depth:${depth}" data-action="toggle-dir" data-key="${escapeHtml(key)}">${icon(open ? "folderOpen" : "folder", 15, "row-icon")}<span class="tree-name">${escapeHtml(node.name)}</span><span class="tree-date">${when(node.updatedAt)}</span></button>${open ? fileTree(node.children ?? [], scope, depth + 1) : ""}`;
      }
      return `<button class="tree-row" style="--depth:${depth}" data-action="open-file" data-scope="${scope}" data-path="${escapeHtml(node.path)}">${icon("file", 15, "row-icon")}<span class="tree-name">${escapeHtml(node.name)}</span><span class="tree-date">${when(node.updatedAt)}</span></button>`;
    })
    .join("");
}

function filesBlock(detail: ProjectDetail): string {
  const collapsed = state.collapsed.has("files");
  const projectOpen = state.expandedDirs.has("root:project");
  const userOpen = state.expandedDirs.has("root:user");
  const tree = `<div class="tree">
    <button class="tree-row" style="--depth:0" data-action="toggle-dir" data-key="root:project">${icon(projectOpen ? "folderOpen" : "folder", 15, "row-icon")}<span class="tree-name">Project</span></button>${projectOpen ? fileTree(detail.files.project, "project", 1) : ""}
    <button class="tree-row" style="--depth:0" data-action="toggle-dir" data-key="root:user">${icon(userOpen ? "folderOpen" : "folder", 15, "row-icon")}<span class="tree-name">User</span></button>${userOpen ? fileTree(detail.files.user, "user", 1) : ""}
  </div>`;
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

function filePage(page: Extract<Page, { kind: "file" }>): string {
  const name = page.path.split("/").pop() ?? page.path;
  return `${subHeader(`<span class="muted">${page.scope === "user" ? "User" : "Project"} /</span> ${escapeHtml(name)}`)}<div class="md file-body">${page.path.endsWith(".md") ? markdown(page.text) : `<pre><code>${escapeHtml(page.text)}</code></pre>`}</div>`;
}

function settingsPage(detail: ProjectDetail): string {
  const project = detail.project;
  return `${subHeader("Project settings")}
  <form class="form" data-form="settings">
    <div class="identity">
      <button type="button" class="icon-tile c-${project.color}" data-action="toggle-picker" data-target="settings">${icon(project.icon, 26)}</button>
      <input class="title-input" name="name" value="${escapeHtml(project.name)}" placeholder="New Project">
    </div>
    ${state.create?.picker && !state.create.saving && state.page.kind === "settings" ? iconPicker(project.icon, project.color) : `<input type="hidden" name="icon" value="${project.icon}"><input type="hidden" name="color" value="${project.color}">`}
    <div class="field-rows">
      ${fieldRow("Workspace", workspaceSelect(project.repos[0] ?? "", "workspace"))}
      ${fieldRow("Model", modelSelects(project.model ?? "", project.effort ?? ""))}
    </div>
    <label class="field"><span>Instructions</span><textarea name="instructions" rows="8" maxlength="16000" placeholder="What every agent should know: conventions, which folder is which, rules no task can break.">${escapeHtml(detail.instructions.trim())}</textarea><span class="hint">Sent to every agent, like an AGENTS.md for the whole project.</span></label>
    <label class="check"><input type="checkbox" name="prFollowUp" ${project.prFollowUp !== false ? "checked" : ""}><span><strong>Follow up on pull requests</strong><em>Send failing checks and requested changes back to the agent that opened the PR.</em></span></label>
    <div class="form-actions"><button class="btn primary" type="submit">Save</button><button class="btn ghost" type="button" data-action="archive">${icon("archive", 13)}Archive project</button></div>
  </form>`;
}

function fieldRow(label: string, control: string): string {
  return `<div class="field-row"><span class="field-label">${label}</span><div class="field-control">${control}</div></div>`;
}

function workspaceSelect(selected: string, name: string): string {
  const workspaces = state.options?.workspaces ?? [];
  const list = selected && !workspaces.includes(selected) ? [selected, ...workspaces] : workspaces;
  const loading = !state.options;
  const other = state.create?.workspace === "__other" && state.page.kind !== "settings";
  const options = [
    `<option value="" ${!selected ? "selected" : ""}>${loading ? "Loading repositories…" : "No repository"}</option>`,
    ...list.map((dir) => `<option value="${escapeHtml(dir)}" ${dir === selected ? "selected" : ""} title="${escapeHtml(dir)}">${escapeHtml(base(dir))}</option>`),
    `<option value="__other" ${other ? "selected" : ""}>Other folder…</option>`,
  ];
  return `<select class="inline-select" name="${name}" data-bind="${name}">${options.join("")}</select>`;
}

function modelSelects(model: string, effort: string): string {
  const models = state.options?.models ?? [];
  const chosen = models.find((option) => option.id === model) ?? models.find((option) => option.isDefault);
  const efforts = chosen?.efforts.length ? chosen.efforts : ["low", "medium", "high"];
  const modelOptions = [`<option value="" ${!model ? "selected" : ""}>${chosen && !model ? `${escapeHtml(chosen.label)} (default)` : "Default"}</option>`, ...models.map((option) => `<option value="${escapeHtml(option.id)}" ${option.id === model ? "selected" : ""}>${escapeHtml(option.label)}</option>`)];
  const effortOptions = [`<option value="" ${!effort ? "selected" : ""}>${chosen ? capital(chosen.defaultEffort) : "Default"}</option>`, ...efforts.map((value) => `<option value="${value}" ${value === effort ? "selected" : ""}>${capital(value)}</option>`)];
  return `<select class="inline-select strong" name="model" data-bind="model">${modelOptions.join("")}</select><select class="inline-select" name="effort" data-bind="effort">${effortOptions.join("")}</select>`;
}

function capital(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

function iconPicker(selectedIcon: string, selectedColor: string): string {
  return `<div class="icon-picker">
    <div class="picker-grid">${PROJECT_ICONS.map((name) => `<label class="pick ${selectedIcon === name ? "on" : ""}"><input type="radio" name="icon" value="${name}" ${selectedIcon === name ? "checked" : ""}>${icon(name, 17)}</label>`).join("")}</div>
    <div class="picker-colors">${PROJECT_COLORS.map((color) => `<label class="swatch c-${color} ${selectedColor === color ? "on" : ""}"><input type="radio" name="color" value="${color}" ${selectedColor === color ? "checked" : ""}></label>`).join("")}</div>
  </div>`;
}

function createDialog(): string {
  const draft = state.create!;
  return `<div class="modal-scrim" data-action="close-create"></div>
  <form class="modal" data-form="create" role="dialog" aria-label="Create Project">
    <div class="modal-head"><div><h2>Create Project</h2><p>Create a focused chat where agents coordinate work</p></div><button type="button" class="icon-btn" data-action="close-create" title="Close">${icon("x", 15)}</button></div>
    <div class="modal-body">
      <button type="button" class="icon-tile big c-${draft.color}" data-action="toggle-picker" data-target="create" title="Choose an icon">${icon(draft.icon, 30)}</button>
      ${draft.picker ? iconPicker(draft.icon, draft.color) : ""}
      <input class="title-input center" name="name" data-bind="name" value="${escapeHtml(draft.name)}" placeholder="New Project" autocomplete="off" autofocus>
      <div class="field-rows">
        ${fieldRow("Workspace", workspaceSelect(draft.workspace === "__other" ? "" : draft.workspace, "workspace"))}
        ${draft.workspace === "__other" ? `<div class="field-row"><input class="path-input" name="otherPath" data-bind="otherPath" value="${escapeHtml(draft.otherPath)}" placeholder="/Users/you/code/api"></div>` : ""}
        ${fieldRow("Model", modelSelects(draft.model, draft.effort))}
      </div>
    </div>
    <div class="modal-foot"><button class="btn accent" type="submit" ${draft.saving ? "disabled" : ""}>${draft.saving ? `<span class="spinner light"></span>Creating…` : "Create Project"}</button></div>
  </form>`;
}

function projectMenu(): string {
  const snapshot = state.snapshot!;
  const detail = current();
  const items = snapshot.projects
    .map((project: ProjectSummary) => `<button class="menu-item ${project.slug === detail?.project.slug ? "on" : ""}" data-action="select" data-slug="${project.slug}">${projectIcon(project, 15)}<span class="name">${escapeHtml(project.name)}</span>${project.needsYou ? `<span class="badge-soft warning">${project.needsYou}</span>` : ""}</button>`)
    .join("");
  return `<div class="menu">${items}<div class="menu-sep"></div>
    <button class="menu-item" data-action="new-project">${icon("plus", 15)}<span class="name">New Project</span></button>
    ${detail ? `<button class="menu-item" data-action="settings">${icon("settings", 15)}<span class="name">Project settings</span></button>
    <button class="menu-item" data-action="open-coordinator">${icon("chat", 15)}<span class="name">Open coordinator chat</span></button>` : ""}
  </div>`;
}

function panelView(): string {
  const detail = current();
  if (!detail) {
    return `<div class="panel"><div class="panel-body">${`<div class="empty"><div class="empty-icon">${icon("layers", 17)}</div><div class="empty-title">No projects yet</div><div class="empty-sub">Create a focused chat where agents coordinate work</div><button class="btn primary" data-action="new-project">${icon("plus", 14)}New Project</button></div>`}</div></div>`;
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
          <div class="ph-actions"><button class="icon-btn" data-action="open-coordinator" title="Open coordinator chat">${icon("chat", 15)}</button><button class="icon-btn" data-action="menu" title="More">${icon("more", 15)}</button></div>
          ${state.menu ? projectMenu() : ""}
        </header>`
      : "";
  return `<div class="panel">${head}<div class="panel-body">${body}</div></div>`;
}

function homeView(): string {
  const snapshot = state.snapshot!;
  const rows = snapshot.projects
    .map((project) => {
      const badges = [
        project.needsYou ? `<span class="badge-soft warning">${project.needsYou} need${project.needsYou === 1 ? "s" : ""} you</span>` : "",
        project.review ? `<span class="badge-soft success">${project.review} to review</span>` : "",
        project.working ? `<span class="badge-soft info"><span class="spinner tiny"></span>${project.working} working</span>` : "",
      ].join("");
      return `<div class="project-row">
        <button class="project-main" data-action="open-project" data-slug="${project.slug}">${projectIcon(project, 18)}<span class="row-main"><span class="row-title">${escapeHtml(project.name)}</span><span class="row-sub">${project.workspace ? escapeHtml(base(project.workspace)) : "No repository"}</span></span><span class="badges">${badges}</span><span class="age">${ago(project.updatedAt)}</span></button>
        <button class="icon-btn row-menu" data-action="project-settings" data-slug="${project.slug}" title="Project settings">${icon("settings", 14)}</button>
      </div>`;
    })
    .join("");
  const list = snapshot.projects.length
    ? `<div class="project-list">${rows}</div>`
    : `<div class="empty"><div class="empty-icon">${icon("layers", 17)}</div><div class="empty-title">No projects yet</div><div class="empty-sub">A project is a focused chat where agents coordinate work. It keeps notes and memory that every agent reads.</div><button class="btn primary" data-action="new-project">${icon("plus", 14)}New Project</button></div>`;
  const detail = current();
  const settings = state.page.kind === "settings" && detail ? `<div class="modal-scrim" data-action="back"></div><div class="sheet">${settingsPage(detail)}</div>` : "";
  return `<div class="home"><div class="home-inner">
    <div class="home-head"><div><h1>Projects</h1><p class="muted">Each project is a coordinator chat that runs agents for you. Open one to continue.</p></div>${snapshot.projects.length ? `<button class="btn primary" data-action="new-project">${icon("plus", 14)}New Project</button>` : ""}</div>
    ${list}
  </div>${settings}</div>`;
}

const SCROLLERS = [".panel-body", ".home", ".sheet", ".transcript", ".modal-body"];

function render(): void {
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
  state.menu = false;
  render();
  void loadOptions();
}

async function openCoordinator(slug: string): Promise<void> {
  const info = await host.call("ui_coordinator", { project: slug });
  if (info.threadId && (await host.openLink(`codex://threads/${info.threadId}`))) return;
  if (!(await host.message(info.kickoff, "new"))) toast("Could not open the chat. Type $projects in a new chat instead.", "error");
}

async function onAction(target: HTMLElement): Promise<void> {
  const action = target.dataset.action!;
  const detail = current();
  switch (action) {
    case "select":
      state.menu = false;
      state.page = { kind: "project" };
      return run(async () => {
        const data = await host.call("ui_state", { project: target.dataset.slug });
        state.snapshot = data.snapshot as Snapshot;
      });
    case "menu":
      state.menu = !state.menu;
      return render();
    case "new-project":
      return openCreate();
    case "close-create":
      state.create = undefined;
      return render();
    case "toggle-picker":
      if (target.dataset.target === "settings") {
        state.create = state.create ?? { name: "", icon: detail!.project.icon, color: detail!.project.color, workspace: "", otherPath: "", model: "", effort: "", picker: false, saving: false };
        state.create.picker = !state.create.picker;
        if (!state.create.picker) state.create = undefined;
        return render();
      }
      if (state.create) state.create.picker = !state.create.picker;
      return render();
    case "settings":
      state.menu = false;
      state.page = { kind: "settings" };
      render();
      return loadOptions();
    case "project-settings":
      return run(async () => {
        const data = await host.call("ui_state", { project: target.dataset.slug });
        state.snapshot = data.snapshot as Snapshot;
        state.page = { kind: "settings" };
        void loadOptions();
      });
    case "back":
      state.page = { kind: "project" };
      state.transcript = undefined;
      if (state.create && !state.create.name && state.create.picker) state.create = undefined;
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
      const scope = (target.dataset.scope as "project" | "user") ?? "project";
      const path = target.dataset.path!;
      return run(async () => {
        const result = await host.call("ui_file", { project: detail.project.slug, scope, path });
        state.page = { kind: "file", scope, path, text: result.file.text };
      });
    }
    case "open-project":
      return run(() => openCoordinator(target.dataset.slug!));
    case "open-coordinator":
      state.menu = false;
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
      }, "Project archived");
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
        name: draft.name.trim() || "New Project",
        icon: data.icon ?? draft.icon,
        color: data.color ?? draft.color,
        repos: workspace ? [workspace] : [],
        model: draft.model,
        effort: draft.effort,
      });
      state.snapshot = result.snapshot;
      state.create = undefined;
      state.page = { kind: "project" };
      render();
      const slug = result.saved as string;
      const info = await host.call("ui_coordinator", { project: slug });
      if (!(await host.message(info.kickoff, "new"))) toast("Project created. Type $projects in a new chat to start it.", "error");
    } catch (error) {
      draft.saving = false;
      toast(error instanceof Error ? error.message : String(error), "error");
    }
    return;
  }
  if (form.dataset.form === "settings" && detail) {
    const workspace = data.workspace === "__other" ? (prompt("Absolute path of the repository") ?? "").trim() : data.workspace;
    return run(async () => {
      const result = await host.call("ui_project_save", {
        project: detail.project.slug,
        name: data.name,
        icon: data.icon,
        color: data.color,
        repos: workspace ? [workspace] : [],
        model: data.model,
        effort: data.effort,
        instructions: data.instructions,
        prFollowUp: data.prFollowUp === "on",
      });
      state.snapshot = result.snapshot;
      state.create = undefined;
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
  if (state.menu && !element.closest(".menu, [data-action='menu']")) {
    state.menu = false;
    render();
    return;
  }
  const anchor = element.closest<HTMLAnchorElement>("a[data-link], a[data-file]");
  if (anchor) {
    event.preventDefault();
    if (anchor.dataset.link) void host.openLink(anchor.dataset.link);
    else if (anchor.dataset.file) {
      const fake = document.createElement("button");
      fake.dataset.action = "open-file";
      fake.dataset.scope = "project";
      fake.dataset.path = anchor.dataset.file.replace(/^\.\//, "");
      void onAction(fake);
    }
    return;
  }
  const target = element.closest<HTMLElement>("[data-action]");
  if (!target || target.tagName === "FORM") return;
  void onAction(target);
});

root.addEventListener("submit", (event) => {
  event.preventDefault();
  void onSubmit(event.target as HTMLFormElement);
});

root.addEventListener("input", (event) => {
  const field = event.target as HTMLInputElement;
  if (field.dataset.draft) state.drafts[field.dataset.draft] = field.value;
  const bind = field.dataset.bind as keyof CreateDraft | undefined;
  if (bind && state.create && field.closest("[data-form='create']") && (bind === "name" || bind === "otherPath")) state.create[bind] = field.value as never;
});

root.addEventListener("change", (event) => {
  const input = event.target as HTMLInputElement;
  if (input.name === "steer") state.steer = input.checked;
  const inCreate = Boolean(input.closest("[data-form='create']"));
  if (inCreate && state.create) {
    if (input.name === "icon" || input.name === "color") {
      state.create[input.name] = input.value as never;
      if (input.name === "icon") state.create.picker = false;
      return render();
    }
    if (input.name === "workspace" || input.name === "model" || input.name === "effort") {
      state.create[input.name] = input.value;
      if (input.name === "model") state.create.effort = "";
      return render();
    }
  }
  if (input.type === "radio") {
    input.closest(".picker-grid, .picker-colors")?.querySelectorAll("label").forEach((label) => label.classList.toggle("on", label.contains(input)));
    const tile = input.closest("form")?.querySelector<HTMLElement>(".icon-tile");
    if (tile && input.name === "color") tile.className = tile.className.replace(/c-\w+/, `c-${input.value}`);
    if (tile && input.name === "icon") tile.innerHTML = icon(input.value, 26);
  }
});

root.addEventListener("toggle", (event) => {
  const details = event.target as HTMLDetailsElement;
  const key = details.dataset?.key;
  if (!key) return;
  if (details.open) state.openDetails.add(key);
  else state.openDetails.delete(key);
}, true);

root.addEventListener("keydown", (event) => {
  const target = event.target as HTMLElement;
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && target.tagName === "TEXTAREA") {
    event.preventDefault();
    target.closest("form")?.requestSubmit();
  }
  if (event.key === "Escape") {
    if (state.create) state.create = undefined;
    else if (state.menu) state.menu = false;
    else if (state.page.kind !== "project") state.page = { kind: "project" };
    render();
  }
});

function applyContext(context: McpUiHostContext | undefined): void {
  if (!context) return;
  if (context.theme) applyDocumentTheme(context.theme);
  if (context.styles?.variables) applyHostStyleVariables(context.styles.variables);
  if (context.styles?.css?.fonts) applyHostFonts(context.styles.css.fonts);
  document.body.classList.toggle("fullscreen", context.displayMode === "fullscreen");
}

function handleContent(content: Record<string, any>): void {
  if (content.mode === "panel" || content.mode === "home") state.mode = content.mode;
  apply(content.snapshot as Snapshot);
  if (content.create) openCreate();
}

function connectMcpHost(): Host {
  const app = new App({ name: "projects", version: "0.2.0" }, {}, { autoResize: true });
  const extensions = new OpenAIExtensions(app);
  app.ontoolresult = (result) => handleContent((result.structuredContent ?? {}) as Record<string, any>);
  app.addEventListener("hostcontextchanged", (context) => applyContext({ ...app.getHostContext(), ...context }));
  const connected = app.connect().then(() => {
    const context = app.getHostContext();
    const tool = context?.toolInfo?.tool?.name;
    if (tool === "projects_home" || tool === "project_new") state.mode = "home";
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
  void call(state.mode === "home" ? "projects_home" : "project_panel").then(handleContent);
  return { call, openLink: (url) => note("open", url), message: (text, target) => note(`message (${target})`, text), fullscreen: async () => false };
}

host = window.parent !== window ? connectMcpHost() : connectPreviewHost();
render();

setInterval(() => {
  if (document.visibilityState === "visible" && state.snapshot && !state.pending && !state.create) void refresh().catch(() => undefined);
}, 3000);
