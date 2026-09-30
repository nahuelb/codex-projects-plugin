import type { AgentRecord, AgentUsage, Harness, TranscriptItem } from "../../shared/types.ts";

export function agentKey(agent: Pick<AgentRecord, "slug" | "id">): string {
  return `${agent.slug}/${agent.id}`;
}

export interface TurnEnd {
  outcome: "completed" | "failed" | "interrupted";
  message: string;
  error?: string;
}

export interface AdapterHooks {
  onSession(agentId: string, sessionId: string): void;
  onWorking(agentId: string, turnId?: string): void;
  onActivity(agentId: string, activity: string): void;
  onMessage(agentId: string, text: string): void;
  onUsage(agentId: string, usage: AgentUsage): void;
  onWaiting(agentId: string, reason: string): void;
  onTurnEnd(agentId: string, end: TurnEnd): void;
}

export type SendResult = "started" | "steered" | "queued";

export interface HarnessAdapter {
  readonly harness: Harness;
  available(): Promise<boolean>;
  start(agent: AgentRecord, brief: string, instructions: string): Promise<{ sessionId: string }>;
  send(agent: AgentRecord, text: string, mode: "queue" | "steer", instructions: string): Promise<SendResult>;
  stop(agent: AgentRecord): Promise<void>;
  isRunning(key: string): boolean;
  transcript(agent: AgentRecord): Promise<TranscriptItem[]>;
  dispose(): Promise<void>;
}
