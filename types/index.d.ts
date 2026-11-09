export type Activity = { id: string; text: string }
export type AgentRow = {
  id: string
  parentId?: string
  name: string
  description: string
  model?: string
  status: 'pending' | 'running' | 'waiting' | 'idle' | 'completed' | 'failed' | 'killed'
  startedAt: number
  stoppedAt?: number
  elapsed: string
  tools: number
  tokens: number
  active: Activity[]
  turns: string[]
}
export type FeedItem = {
  at: number
  kind: 'spawn' | 'send' | 'finish' | 'codex' | 'background'
  from: string
  to: string
  text: string
}
export type LimitRow = { kind: string; percentUsed: number; resetsAt?: string; reset: string }
export type CodexWindow = { usedPercent: number; windowMinutes: number; resetsAt?: number; expired?: boolean }
export type CodexLimits = {
  updatedAt: number
  plan: string
  reached: boolean
  primary: CodexWindow | null
  secondary: CodexWindow | null
}
export type CodexSummary = {
  partial?: boolean
  cwd?: string
  folder: string
  firstAt: number | null
  lastAt: number | null
  task: 'started' | 'complete' | null
  taskAt: number | null
  lastTool: string
  tools: number
  tokens: number | null
  limits: CodexLimits | null
}
export type CodexRun = {
  partial?: boolean
  id: string
  folder: string
  status: 'running' | 'stopped' | 'completed'
  lastTool: string
  tools: number
  tokens: number | null
  elapsed: string
  lastAt: number
}
export type BackgroundKind = 'shell' | 'monitor' | 'workflow' | 'mcp' | 'other'
export type BackgroundTask = {
  id: string
  taskId: string
  toolUseId?: string
  kind: BackgroundKind
  label: string
  status: 'running' | 'completed' | 'failed' | 'killed' | 'done'
  startedAt: number
  endedAt?: number
  elapsed: string
}
export type ScheduledTask = { id: string; schedule: string; recurring: boolean; prompt: string }
export type CodexLaunch = { id: string; at: number; cwd?: string }
export type CodexData = { limits: CodexLimits | null; runs: CodexRun[] }
export type MonitorState = {
  agents: AgentRow[]
  limits: LimitRow[]
  contextRemaining: number | null
  feed: FeedItem[]
  codex: CodexData | null
  codexLaunches?: CodexLaunch[]
  background?: BackgroundTask[]
  scheduled?: ScheduledTask[]
  codexClaims?: Record<string, string>
  claudeCost?: number | null
  officeSeats?: Record<string, OfficeSeat>
  officeView?: OfficeView
  officePhase?: string
}

export type OfficeView = { x: number; y: number; w: number; h: number }
export type OfficeZone = 'work' | 'lounge'
export type OfficeKind = 'main' | 'subagent' | 'codex'
export type OfficeStatus = AgentRow['status'] | 'stopped'
export type OfficeSeat = { zone: OfficeZone; seat: number; firstSeen: number }
export type OfficeAgent = OfficeSeat & {
  partial?: boolean
  id: string
  name: string
  task: string
  kind: OfficeKind
  status: OfficeStatus
  lookSeed: string
  parentSeed?: string
  model?: string
  tool: string
  tools: number
  elapsed: string
  tokens: number | null
  tick: boolean
  limit: {
    account: 'claude' | 'codex'
    fiveHourLeft: number | null
    weekLeft: number | null
    binding: number | null
    share: number | null
  }
}
export type OfficeScene = {
  agents: OfficeAgent[]
  interactions: { from: string; to: string; kind: 'spawn' | 'send' | 'codex' }[]
  overflow: { work: number; lounge: number }
  background?: { id: string; kind: BackgroundKind; label: string }[]
  backgroundOverflow?: number
}

declare module 'claude-code' {
  interface PluginState {
    'agent-monitor': { monitor: Shaped<MonitorState> }
  }
}
