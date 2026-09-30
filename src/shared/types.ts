export type Harness = "codex";

export type Isolation = "worktree" | "checkout" | "folder";

export type AgentStatus = "starting" | "working" | "idle" | "waiting" | "failed" | "stopped";

export type AgentGroup = "needs_you" | "review" | "working" | "idle" | "resolved";

export const PROJECT_COLORS = ["gray", "green", "cyan", "blue", "purple", "magenta", "orange", "yellow", "red"] as const;

export type ProjectColor = (typeof PROJECT_COLORS)[number];

export const PROJECT_ICONS = ["layers", "rocket", "bolt", "leaf", "flask", "compass", "cube", "star", "bug", "book"] as const;

export type ProjectIcon = (typeof PROJECT_ICONS)[number];

export interface ProjectRecord {
  slug: string;
  name: string;
  goal: string;
  icon: ProjectIcon;
  color: ProjectColor;
  repos: string[];
  model?: string;
  effort?: string;
  coordinatorThreadId?: string;
  prFollowUp?: boolean;
  createdAt: string;
  updatedAt: string;
  archived?: boolean;
}

export interface PullRequestStatus {
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED" | "UNKNOWN";
  draft: boolean;
  checks: "passing" | "failing" | "pending" | "none";
  failing: string[];
  review: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | "NONE";
  checkedAt: string;
}

export interface AgentReport {
  text: string;
  summary: string;
  next: string[];
  remember: string[];
  needsYou: string;
  pr?: string;
}

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
}

export interface AgentFollowUp {
  at: string;
  text: string;
  from: "coordinator" | "user";
}

export interface AgentRecord {
  id: string;
  slug: string;
  title: string;
  task: string;
  harness: Harness;
  model?: string;
  effort?: string;
  isolation: Isolation;
  repo?: string;
  cwd: string;
  branch?: string;
  writableRoots?: string[];
  status: AgentStatus;
  sessionId?: string;
  turnId?: string;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  activity?: string;
  lastMessage?: string;
  report?: AgentReport;
  reviewed: boolean;
  resolved: boolean;
  error?: string;
  turns: number;
  usage?: AgentUsage;
  followUps: AgentFollowUp[];
  pr?: PullRequestStatus;
}

export type InboxKind = "agent_done" | "agent_failed" | "agent_waiting" | "agent_stopped" | "pr_checks_failed" | "pr_changes_requested" | "pr_merged" | "pr_closed";

export interface InboxItem {
  id: string;
  at: string;
  kind: InboxKind;
  agentId: string;
  title: string;
  summary: string;
}

export interface MemoryEntry {
  file: string;
  name: string;
  description: string;
  type: "user" | "feedback" | "project" | "reference";
  updatedAt: string;
}

export interface NotesItem {
  checked: boolean;
  text: string;
}

export interface NotesSection {
  title: string;
  items: NotesItem[];
}

export interface ParsedNotes {
  tldr: string[];
  sections: NotesSection[];
}

export interface FileNode {
  name: string;
  path: string;
  kind: "file" | "dir";
  updatedAt: string;
  children?: FileNode[];
}

export interface AgentView extends AgentRecord {
  group: AgentGroup;
}

export interface ProjectSummary {
  slug: string;
  name: string;
  icon: ProjectIcon;
  color: ProjectColor;
  workspace?: string;
  coordinatorThreadId?: string;
  updatedAt: string;
  needsYou: number;
  working: number;
  review: number;
}

export interface ProjectDetail {
  project: ProjectRecord;
  instructions: string;
  notes: ParsedNotes;
  notesRaw: string;
  agents: AgentView[];
  memory: MemoryEntry[];
  inbox: InboxItem[];
  files: { project: FileNode[]; user: FileNode[] };
}

export interface ModelOption {
  id: string;
  label: string;
  efforts: string[];
  defaultEffort: string;
  isDefault: boolean;
}

export interface Snapshot {
  version: string;
  root: string;
  service: { running: boolean; pid?: number; error?: string };
  codex: boolean;
  projects: ProjectSummary[];
  current?: ProjectDetail;
  threadId?: string;
}

export interface TranscriptItem {
  role: "user" | "assistant" | "tool";
  text: string;
  at?: string;
}
