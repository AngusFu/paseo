import equal from "fast-deep-equal";
import type { AgentUsage } from "@getpaseo/protocol/agent-types";

interface AgentUpdateValue {
  updatedAt: Date | string;
  lastUsage?: AgentUsage;
}

interface LiveAgentDirectoryUpdateValue extends AgentUpdateValue {
  status?: string;
  archivedAt?: Date | string | null;
}

function timestamp(value: Date | string): number {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

export function acceptAgentDirectoryUpdate<T extends AgentUpdateValue>(
  current: T | undefined,
  incoming: T,
): T {
  if (!current || timestamp(incoming.updatedAt) >= timestamp(current.updatedAt)) return incoming;
  if (incoming.lastUsage === undefined) return current;
  if (equal(incoming.lastUsage, current.lastUsage)) return current;
  return { ...current, lastUsage: incoming.lastUsage };
}

/** Live agent_update can carry idle from persistence resume with an older stored updatedAt. */
export function prepareLiveAgentDirectoryUpdate<T extends LiveAgentDirectoryUpdateValue>(
  current: T | undefined,
  incoming: T,
): T {
  if (
    current?.status === "running" &&
    incoming.status !== undefined &&
    incoming.status !== "running" &&
    incoming.archivedAt == null &&
    timestamp(incoming.updatedAt) < timestamp(current.updatedAt)
  ) {
    return { ...incoming, updatedAt: current.updatedAt };
  }
  return incoming;
}
