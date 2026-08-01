/**
 * Screen 4 copy contract — Knowledge bases /paseo-vfs tip for managed agents.
 * Injected via daemonAppendSystemPrompt and cursor-print ~/AGENTS.md.
 * Keep CLI dogfood (`paseo kb --root`) out of this default tip.
 */
export const KNOWLEDGE_BASES_AGENT_GUIDANCE = `Knowledge bases (read-only)
  Mounted trees appear under /paseo-vfs/<mountSlug>/…
  Use ls / paseo kb ls, cat / paseo kb cat, grep / paseo kb grep.
  Writes are denied. Empty /paseo-vfs means this workspace has no
  Knowledge base mounts — ask the host to Mount knowledge bases.`;
