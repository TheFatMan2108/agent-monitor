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
  kind: 'spawn' | 'send' | 'finish' | 'codex'
  from: string
  to: string
  text: string
}
export type LimitRow = { kind: string; percentUsed: number; resetsAt?: string; reset: string }
export type OtherSession = {
  id: string
  name: string
  folder: string
  status: string
  waitingFor: string
  statusUpdatedAt: number
  age: string
}
export type CodexWindow = { usedPercent: number; windowMinutes: number; resetsAt?: number; expired?: boolean }
export type CodexLimits = {
  updatedAt: number
  plan: string
  reached: boolean
  primary: CodexWindow | null
  secondary: CodexWindow | null
}
export type CodexSummary = {
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
  id: string
  folder: string
  status: 'running' | 'stopped' | 'completed'
  lastTool: string
  tools: number
  tokens: number | null
  elapsed: string
  lastAt: number
}
export type CodexData = { limits: CodexLimits | null; runs: CodexRun[] }
export type MonitorState = {
  agents: AgentRow[]
  limits: LimitRow[]
  contextRemaining: number | null
  feed: FeedItem[]
  sessions: OtherSession[] | null
  codex: CodexData | null
  claudeCost?: number | null
  officeSeats?: Record<string, OfficeSeat>
  officePhase?: string
}

export type OfficeZone = 'work' | 'lounge'
export type OfficeKind = 'main' | 'subagent' | 'codex' | 'session'
export type OfficeStatus = AgentRow['status'] | 'stopped'
export type OfficeSeat = { zone: OfficeZone; seat: number; firstSeen: number }
export type OfficeAgent = OfficeSeat & {
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
}
export type OfficeScene = {
  agents: OfficeAgent[]
  interactions: { from: string; to: string; kind: 'spawn' | 'send' | 'codex' }[]
  overflow: { work: number; lounge: number }
}

declare module 'claude-code' {
  interface PluginState {
    'agent-monitor': { monitor: Shaped<MonitorState> }
  }
}
