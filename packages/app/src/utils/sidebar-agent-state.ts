import {
  deriveAgentStateBucket,
  type AgentAttentionReason,
  type AgentStateBucketInput,
} from "@getpaseo/protocol/agent-state-bucket";

export type SidebarStateBucket = "needs_input" | "failed" | "running" | "attention" | "done";
export type SidebarAttentionReason = AgentAttentionReason;

export function deriveSidebarStateBucket(input: AgentStateBucketInput): SidebarStateBucket {
  return deriveAgentStateBucket(input);
}

export function isSidebarActiveAgent(input: AgentStateBucketInput): boolean {
  return deriveSidebarStateBucket(input) !== "done";
}

/** Workspace may still have agents using /paseo-vfs when not fully idle. */
export function isSidebarActiveWorkspaceBucket(bucket: SidebarStateBucket): boolean {
  return bucket !== "done";
}
