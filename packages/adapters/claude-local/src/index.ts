import type { AdapterModelProfileDefinition } from "@paperclipai/adapter-utils";

export const type = "claude_local";
export const label = "Claude Code (local)";

export const SANDBOX_INSTALL_COMMAND = "npm install -g @anthropic-ai/claude-code";

export const models = [
  { id: "claude-opus-4-8", label: "Claude Opus 4.8" },
  { id: "claude-fable-5", label: "Claude Fable 5" },
  { id: "claude-mythos-5", label: "Claude Mythos 5" },
  { id: "claude-opus-4-7", label: "Claude Opus 4.7" },
  { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { id: "claude-haiku-4-6", label: "Claude Haiku 4.6" },
  { id: "claude-sonnet-4-5-20250929", label: "Claude Sonnet 4.5" },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
];

export const modelProfiles: AdapterModelProfileDefinition[] = [
  {
    key: "cheap",
    label: "Cheap",
    description: "Use Claude Sonnet as the lower-cost Claude Code lane while preserving the agent's primary model.",
    adapterConfig: {
      model: "claude-sonnet-4-6",
      effort: "low",
    },
    source: "adapter_default",
  },
];

export const agentConfigurationDoc = `# claude_local agent configuration

Adapter: claude_local

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file injected at runtime
- model (string, optional): Claude model id
- effort (string, optional): reasoning effort passed via --effort (low|medium|high)
- chrome (boolean, optional): pass --chrome when running Claude
- promptTemplate (string, optional): run prompt template
- maxTurnsPerRun (number, optional): max turns for one run
- dangerouslySkipPermissions (boolean, optional, default true): pass --dangerously-skip-permissions to claude; defaults to true because Paperclip runs Claude in headless --print mode where interactive permission prompts cannot be answered
- excludeDynamicSystemPromptSections (boolean, optional, default false): pass --exclude-dynamic-system-prompt-sections to claude, moving per-machine sections (cwd, env info incl. date, memory paths, git status) out of the default system prompt into the first user message. Widens run-crossing/cross-agent server-side prompt-cache reuse of the static Claude Code base by keeping the cached system-prompt prefix byte-identical across heartbeats, agents, and day boundaries. Ignored under --system-prompt; we use --append-system-prompt-file so the default prompt is still in effect. Default off so enabling is an explicit, reversible fleet decision (ENGA-621 / ENGA-616 lever #1).
- command (string, optional): defaults to "claude"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables
- workspaceStrategy (object, optional): execution workspace strategy; currently supports { type: "git_worktree", baseRef?, branchTemplate?, worktreeParentDir? }
- workspaceRuntime (object, optional): reserved for workspace runtime metadata; workspace runtime services are manually controlled from the workspace UI and are not auto-started by heartbeats

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds
- outputInactivityTimeoutMs (number | null, optional): output-inactivity monitor around the claude child. Resets on every line of stdout that parses as JSON (claude runs with --output-format stream-json, so every system/assistant/user/result event — including the assistant turns that carry thinking output — counts). Defaults to 15 * 60_000 ms when unset or non-positive. Set to \`null\` to disable the monitor entirely (only do this for known-slow tasks; the platform-level silent-run safety net still applies). On fire, the adapter sends SIGTERM to the process group, waits 5s, then SIGKILL, and surfaces the run as failed with errorMessage "monitor: no claude output for {N}m {S}s" (errorCode claude_output_inactivity_monitor) so the run is retried, not left holding its slot.
- runWallClockTimeoutSec (number | null, optional): run-level wall-clock cap backstop for the streaming inference process. Only applies when timeoutSec is unset/0 (the historical "disabled for local" case); an explicit timeoutSec or a sandbox default takes precedence. Defaults to 4 * 60 * 60 s (aligns with the platform-level 4h critical silent-run monitor) when unset or non-positive. Set to \`null\` to disable the cap (a hung run is then only reaped by the platform-level safety net).

Notes:
- When Paperclip realizes a workspace/runtime for a run, it injects PAPERCLIP_WORKSPACE_* and PAPERCLIP_RUNTIME_* env vars for agent-side tooling.
`;
