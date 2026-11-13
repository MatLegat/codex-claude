export type ClaudeContext = {
  model?: string
  tokens?: number
  window: number
  percent?: number
}

export type CodexContext =
  | {
      thread?: string
      source?: string
      model?: string
      effort?: string
      tokens: number
      window: number
      percent: number
      updatedAt: number
    }
  | { error: string }

// One rate-limit window: `5h`, `Weekly`, ...; resetsAt in epoch milliseconds.
export type UsageWindow = { name: string; percent: number; resetsAt?: number }

declare module 'claude-code' {
  interface PluginState {
    'codex-claude': {
      claude: Shaped<ClaudeContext | null>
      codex: Shaped<CodexContext | null>
      isClaudeOpen: boolean
      isCodexOpen: boolean
      claudeUsage: Shaped<UsageWindow[] | null>
      codexUsage: Shaped<UsageWindow[] | null>
      isClaudeUsageOpen: boolean
      isCodexUsageOpen: boolean
      claudeUsageSeenAt: number | null
      tzOffset: number | null
      claudeBusy: boolean
      codexBusy: boolean
      frame: number
      imageEpoch: number
      minuteTick: number
    }
  }
}
