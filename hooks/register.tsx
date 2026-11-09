import { atom, read } from 'claude-code'
import type {
  AgentInfo, AgentStatus, CoreEngineInterface, Register, SessionContextUsage,
  SessionRateLimit, Timer, ToolCallInput,
} from 'claude-code'
import type { AgentRow, CodexData, CodexRun, CodexSummary, CodexWindow, FeedItem, MonitorState, OtherSession } from '../types'
import { buildScene, remaining, renderAvatarSvg, renderOfficeSvg } from './office'

export { remaining } from './office'

const PANE = 'agent-monitor'
const MAIN = '@main'
const CODEX = '@codex'
const SHAPE = 'monitor-4'
const REF = { plugin: 'agent-monitor', key: 'monitor' } as const
const INITIAL: MonitorState = {
  agents: [], limits: [], contextRemaining: null, feed: [], sessions: null, codex: null,
}
const monitor = atom(REF, INITIAL, { shape: SHAPE })
const EMPTY_LIMITS = 'Chưa có dữ liệu limit (cần gói subscription và ít nhất một lượt gọi API)'
const MAX_HISTORY = 200
const STATUS: Record<AgentStatus, string> = {
  pending: '◌ Chờ chạy', running: '● Đang chạy', waiting: '◷ Đang chờ',
  idle: '○ Rảnh', completed: '✓ Hoàn tất', failed: '✗ Thất bại', killed: '■ Đã dừng',
}

/** Định dạng thời gian reset từ timestamp ISO, không suy đoán khi thiếu dữ liệu. */
export function resetText(resetsAt: string | undefined, now: number): string {
  if (!resetsAt) return 'Chưa rõ giờ reset'
  const at = Date.parse(resetsAt)
  if (!Number.isFinite(at)) return 'Chưa rõ giờ reset'
  const minutes = Math.max(0, Math.ceil((at - now) / 60000))
  return `còn ${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function clean(value: unknown, max = 120): string {
  return typeof value === 'string'
    ? value.slice(0, max).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    : ''
}

function elapsed(start: number, end: number): string {
  const minutes = Math.max(0, Math.floor((end - start) / 60000))
  return minutes === 0 ? '<1m' : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function terminal(status: AgentStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'killed'
}

function ensureAgent(state: MonitorState, id: string, now: number): AgentRow {
  let row = state.agents.find(agent => agent.id === id)
  if (!row) {
    row = {
      id, name: id === MAIN ? 'Claude Code' : clean(id), description: '', status: 'idle',
      startedAt: now, stoppedAt: now, elapsed: '<1m', tools: 0, tokens: 0, active: [], turns: [],
    }
    state.agents.push(row)
  }
  return row
}

function cap(state: MonitorState): void {
  // Giữ mọi agent đang sống; chỉ giới hạn lịch sử đã kết thúc.
  const finished = state.agents.filter(row => row.id !== MAIN && terminal(row.status))
  const remove = new Set(finished.slice(0, Math.max(0, finished.length - MAX_HISTORY)).map(row => row.id))
  state.agents = state.agents.filter(row => !remove.has(row.id))
  state.feed = state.feed.slice(0, 50)
}

// CAS bảo vệ các tool chạy đồng thời. So sánh JSON trước khi ghi để phiên rảnh
// không redraw; shape từ phiên bản cũ được xử lý giống atom của ví dụ pane.
async function change($: CoreEngineInterface, edit: (state: MonitorState) => void): Promise<void> {
  const now = await $.clock.now()
  for (let attempt = 0; attempt < 8; attempt++) {
    const held = await $.state.get(REF)
    const before = held.value?.shape === SHAPE ? held.value.value : INITIAL
    const after = structuredClone(before)
    edit(after)
    cap(after)
    const scene = buildScene(after, now)
    after.officeSeats = Object.fromEntries(scene.agents.map(agent => [agent.id,
      { zone: agent.zone, seat: agent.seat, firstSeen: agent.firstSeen }]))
    after.officePhase = JSON.stringify([scene.interactions, scene.agents.filter(agent => agent.tick).map(agent => agent.id)])
    if (JSON.stringify(before) === JSON.stringify(after)) return
    const written = await $.state.set(REF, { shape: SHAPE, value: after }, { ifVersion: held.version })
    if (written.isSet) return
  }
}

async function safely(work: () => Promise<unknown>): Promise<void> {
  try { await work() } catch { /* Telemetry không được làm hỏng tác vụ chính. */ }
}

function addFeed(state: MonitorState, item: FeedItem): void {
  state.feed.unshift({ ...item, text: clean(item.text) })
}

function agentName(state: MonitorState, id: string): string {
  if (id === MAIN) return 'Claude Code'
  if (id === CODEX) return 'Codex CLI'
  return state.agents.find(row => row.id === id || row.name === id)?.name ?? clean(id)
}

function setUsage(state: MonitorState, limits: SessionRateLimit[], context: SessionContextUsage, now: number): void {
  state.limits = limits.map(limit => ({
    kind: clean(limit.kind), percentUsed: limit.percentUsed,
    ...(limit.resetsAt ? { resetsAt: limit.resetsAt } : {}),
    reset: resetText(limit.resetsAt, now),
  }))
  const used = context.percent ?? (context.tokens !== undefined && context.window > 0
    ? context.tokens / context.window * 100 : undefined)
  state.contextRemaining = used === undefined ? null : remaining(used)
}

function toolActivity(e: ToolCallInput): string {
  const path = 'file_path' in e ? clean(e.file_path) : 'path' in e ? clean(e.path) : ''
  const name = ({ Edit: 'Sửa', Write: 'Ghi', Read: 'Đọc', Bash: 'Lệnh', Agent: 'Giao việc',
    Grep: 'Tìm nội dung', Glob: 'Tìm file' } as Record<string, string>)[e.tool] ?? clean(e.tool)
  const detail = path || ('command' in e ? clean(e.command, 60) : '')
  return clean(`${name}${detail ? ` ${detail}` : ''}`)
}

function clockText(at: number): string {
  const date = new Date(at)
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map(n => String(n).padStart(2, '0')).join(':')
}

function compact(tokens: number): string {
  return tokens >= 1000000 ? `${(tokens / 1000000).toFixed(1)}M`
    : tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens)
}

function limitLabel(kind: string): string {
  if (kind === 'five_hour') return '5 giờ'
  if (kind === 'seven_day') return 'Tuần'
  if (kind === 'spend_limit') return 'Ngân sách'
  if (kind.startsWith('seven_day_')) return `Tuần · ${kind.slice(10)}`
  if (kind.startsWith('five_hour_')) return `5 giờ · ${kind.slice(10)}`
  return `Theo mô hình · ${kind}`
}

function sessionStatus(value: unknown): string {
  const statuses: Record<string, string> = {
    ...STATUS, active: '● Đang chạy', busy: '● Đang chạy',
    thinking: 'Đang suy nghĩ', working: 'Đang làm việc',
    stopped: 'Đã dừng', closed: 'Đã đóng', ended: 'Đã kết thúc',
  }
  return typeof value === 'string' ? statuses[value] ?? 'Chưa rõ' : 'Chưa rõ'
}

function waitingLabel(value: unknown): string {
  const labels: Record<string, string> = {
    user: 'người dùng', input: 'nhập liệu', prompt: 'nhập liệu',
    permission: 'cấp quyền', approval: 'phê duyệt', tool: 'công cụ',
    model: 'mô hình', response: 'phản hồi', agent: 'agent',
  }
  return typeof value === 'string' && value ? labels[value] ?? 'phản hồi' : '—'
}

/** Đọc PID từ CSV của tasklist; null nghĩa là không có kết quả đáng tin cậy. */
export function taskPids(csv: string): number[] | null {
  const pids: number[] = []
  for (const line of csv.split(/\r?\n/)) {
    const match = /^"(?:[^"]|"")*","(\d+)"/.exec(line.trim())
    if (match) pids.push(Number(match[1]))
  }
  return pids.length ? pids : null
}

/** Chỉ đọc file JSON thông thường, chiếu vào allow-list; không giữ object gốc. */
export async function otherSessions(
  $: CoreEngineInterface, directory: string, ownId: string, now: number,
  alive: readonly number[] | null,
): Promise<OtherSession[] | null> {
  try {
    const entries = await $.fs.list(directory)
    const result: OtherSession[] = []
    for (const entry of entries) {
      if (entry.kind !== 'file' || entry.isLink || !/\.json$/i.test(entry.name)
        || /[\\/:]/.test(entry.name) || entry.name === `${ownId}.json`) continue
      const raw: unknown = JSON.parse(await $.fs.read(`${directory}/${entry.name}`))
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
      // Không spread/serialize raw: chỉ các trường dưới đây được phép vào state.
      const data = raw as Record<string, unknown>
      const id = clean(data.sessionId) || clean(data.id) || entry.name.slice(0, -5)
      if (id === ownId) continue
      const pid = typeof data.pid === 'number' ? data.pid : Number(data.pid)
      if (alive !== null && (!Number.isInteger(pid) || !alive.includes(pid))) continue
      const stamp = typeof data.statusUpdatedAt === 'number' ? data.statusUpdatedAt
        : typeof data.statusUpdatedAt === 'string' ? Date.parse(data.statusUpdatedAt) : NaN
      const updatedAt = Number.isFinite(stamp) ? stamp : entry.mtimeMs
      const cwd = clean(data.cwd, 1024).replace(/[\\/]+$/, '')
      result.push({
        id, name: clean(data.name) || 'Phiên chưa đặt tên',
        folder: cwd.split(/[\\/]/).pop() || '—', status: sessionStatus(data.status),
        waitingFor: waitingLabel(data.waitingFor), statusUpdatedAt: updatedAt,
        age: elapsed(updatedAt, now),
      })
    }
    return result.sort((a, b) => b.statusUpdatedAt - a.statusUpdatedAt).slice(0, 200)
  } catch { return null }
}


function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function codexWindow(value: unknown): CodexWindow | null {
  const data = object(value)
  if (!data || !finite(data.used_percent) || !finite(data.window_minutes) || data.window_minutes <= 0) return null
  return {
    usedPercent: Math.max(0, Math.min(100, data.used_percent)), windowMinutes: data.window_minutes,
    ...(finite(data.resets_at) && data.resets_at > 0 && data.resets_at < 8640000000000
      ? { resetsAt: data.resets_at } : {}),
  }
}

/** Chiếu từng dòng rollout vào allow-list; không giữ nội dung, arguments hay output. */
export function parseCodexRollout(text: string): CodexSummary {
  const summary: CodexSummary = {
    folder: '—', firstAt: null, lastAt: null, task: null, taskAt: null,
    lastTool: '', tools: 0, tokens: null, limits: null,
  }
  let tokensAt = -Infinity
  let toolAt = -Infinity
  // $.fs.read không có range/tail; chỉ parse toàn file khi size/mtime thay đổi.
  let offset = 0
  while (offset < text.length) {
    const newline = text.indexOf('\n', offset)
    const end = newline < 0 ? text.length : newline
    const line = text.slice(offset, end)
    offset = end + 1
    try {
      const entry = object(JSON.parse(line))
      const payload = object(entry?.payload)
      const at = typeof entry?.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN
      if (!entry || !payload || !Number.isFinite(at)) continue
      const event = entry.type === 'event_msg' && (
        payload.type === 'task_started' || payload.type === 'task_complete'
        || payload.type === 'item_completed' || payload.type === 'token_count')
      const tool = entry.type === 'response_item'
        && (payload.type === 'custom_tool_call' || payload.type === 'function_call')
      if (entry.type !== 'session_meta' && !event && !tool) continue
      summary.firstAt = Math.min(summary.firstAt ?? at, at)
      summary.lastAt = Math.max(summary.lastAt ?? at, at)
      if (entry.type === 'session_meta' && typeof payload.cwd === 'string') {
        summary.folder = clean(payload.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop()) || '—'
      }
      if (tool && typeof payload.name === 'string') {
        summary.tools++
        if (at >= toolAt) { summary.lastTool = clean(payload.name); toolAt = at }
      }
      if (!event) continue
      if ((payload.type === 'task_started' || payload.type === 'task_complete') && at >= (summary.taskAt ?? -Infinity)) {
        summary.task = payload.type === 'task_started' ? 'started' : 'complete'
        summary.taskAt = at
      }
      if (payload.type !== 'token_count') continue
      const total = object(object(payload.info)?.total_token_usage)?.total_tokens
      if (finite(total) && total >= 0 && at >= tokensAt) {
        summary.tokens = total
        tokensAt = at
      }
      const limits = object(payload.rate_limits)
      if (!limits || limits.limit_id !== 'codex' || at < (summary.limits?.updatedAt ?? -Infinity)) continue
      const primary = codexWindow(limits.primary)
      const secondary = codexWindow(limits.secondary)
      if (!primary && !secondary) continue
      summary.limits = {
        updatedAt: at, plan: clean(limits.plan_type, 32),
        reached: limits.rate_limit_reached_type !== undefined && limits.rate_limit_reached_type !== null,
        primary, secondary,
      }
    } catch { /* Dòng JSON lỗi hoặc ghi dở không ảnh hưởng dòng tiếp theo. */ }
  }
  return summary
}

/** Trạng thái dựa trên task cuối và mtime, không suy đoán từ nội dung hội thoại. */
export function codexStatus(summary: CodexSummary, mtime: number, now: number): CodexRun['status'] {
  return summary.task === 'complete' ? 'completed'
    : summary.task === 'started' && now - mtime <= 120000 ? 'running' : 'stopped'
}

/** Không hiển thị phần trăm cũ sau reset; resetsAt của Codex tính bằng giây. */
export function codexWindowText(window: CodexWindow, now: number): string {
  const label = window.windowMinutes === 10080 ? 'Tuần' : `${window.windowMinutes / 60} giờ`
  if (window.resetsAt !== undefined && window.resetsAt * 1000 <= now) {
    return `${label} · đã reset, chờ lần gọi Codex tiếp theo`
  }
  const left = remaining(window.usedPercent)
  const filled = Math.round(left / 10)
  const reset = resetText(window.resetsAt === undefined ? undefined : new Date(window.resetsAt * 1000).toISOString(), now)
  return `${label} [${'█'.repeat(filled) + '░'.repeat(10 - filled)}] ${left}% còn lại · ${reset}`
}

type CodexCacheEntry = { size: number; mtime: number; summary: CodexSummary }
// Chỉ summary đã lọc nằm trong bộ nhớ module; không đưa cache hay JSON gốc vào atom.
const codexCache = new Map<string, CodexCacheEntry>()
const CODEX_STATUS: Record<CodexRun['status'], string> = {
  running: '● Đang chạy', stopped: '■ Đã dừng / không rõ', completed: '✓ Hoàn tất',
}

function localPath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized
}

async function checkedStat($: CoreEngineInterface, path: string, kind: 'dir' | 'file') {
  const stat = await $.fs.stat(path, { resolve: true })
  if (stat.kind !== kind || stat.isLink || !stat.realPath || localPath(stat.realPath) !== localPath(path)) {
    throw new Error('Đường dẫn Codex không hợp lệ')
  }
  return stat
}

async function codexDirectories($: CoreEngineInterface, path: string, pattern: RegExp): Promise<string[]> {
  await checkedStat($, path, 'dir')
  return (await $.fs.list(path))
    .filter(entry => entry.kind === 'dir' && !entry.isLink && pattern.test(entry.name))
    .map(entry => entry.name).sort().reverse()
}

/** Chỉ list sessions/YYYY/MM/DD và đọc tối đa 8 rollout thường, không theo symlink. */
export async function readCodex($: CoreEngineInterface, home: string, now: number): Promise<CodexData | null> {
  try {
    const root = home.replace(/\\/g, '/').replace(/\/+$/, '')
    if (!root || /^\/\//.test(root) || !/^(?:[A-Za-z]:\/|\/)/.test(root)
      || root.split('/').some(part => part === '.' || part === '..')) return null
    const sessions = `${root}/sessions`
    const today = new Date(now)
    const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    const days: string[] = []
    const years = (await codexDirectories($, sessions, /^\d{4}$/))
      .filter(year => year <= date.slice(0, 4)).slice(0, 2)
    for (const year of years) {
      const months = (await codexDirectories($, `${sessions}/${year}`, /^(?:0[1-9]|1[0-2])$/))
        .filter(month => `${year}-${month}` <= date.slice(0, 7)).slice(0, 2)
      for (const month of months) {
        const parent = `${sessions}/${year}/${month}`
        for (const day of await codexDirectories($, parent, /^(?:0[1-9]|[12]\d|3[01])$/)) {
          const stamp = `${year}-${month}-${day}`
          if (stamp > date || new Date(`${stamp}T00:00:00Z`).toISOString().slice(0, 10) !== stamp) continue
          days.push(`${parent}/${day}`)
          if (days.length === 4) break
        }
        if (days.length === 4) break
      }
      if (days.length === 4) break
    }
    const candidates: { path: string; mtime: number }[] = []
    for (const day of days) {
      await checkedStat($, day, 'dir')
      for (const entry of await $.fs.list(day)) {
        if (entry.kind === 'file' && !entry.isLink && /^rollout-[^\\/:]+\.jsonl$/.test(entry.name)) {
          candidates.push({ path: `${day}/${entry.name}`, mtime: entry.mtimeMs })
        }
      }
    }
    const newest = candidates.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path)).slice(0, 8)
    const keep = new Set(newest.map(file => file.path))
    for (const path of codexCache.keys()) if (!keep.has(path)) codexCache.delete(path)
    const runs: CodexRun[] = []
    let limits: CodexData['limits'] = null
    for (const file of newest) {
      const stat = await checkedStat($, file.path, 'file')
      if (!finite(stat.size) || !finite(stat.mtimeMs)) throw new Error('Thiếu metadata Codex')
      let cached = codexCache.get(file.path)
      if (!cached || cached.size !== stat.size || cached.mtime !== stat.mtimeMs) {
        cached = { size: stat.size, mtime: stat.mtimeMs, summary: parseCodexRollout(await $.fs.read(file.path)) }
        codexCache.set(file.path, cached)
      }
      const summary = cached.summary
      if (summary.limits && summary.limits.updatedAt >= (limits?.updatedAt ?? -Infinity)) limits = summary.limits
      if (summary.firstAt === null || summary.lastAt === null) continue
      runs.push({
        id: file.path, folder: summary.folder, status: codexStatus(summary, stat.mtimeMs, now),
        lastTool: summary.lastTool, tools: summary.tools, tokens: summary.tokens,
        elapsed: elapsed(summary.firstAt, summary.lastAt), lastAt: summary.lastAt,
      })
    }
    if (limits) {
      // Chỉ đổi atom khi cửa sổ thực sự qua giờ reset, kể cả rollout không đổi.
      limits = structuredClone(limits)
      for (const window of [limits.primary, limits.secondary]) {
        if (window?.resetsAt !== undefined && window.resetsAt * 1000 <= now) window.expired = true
      }
    }
    runs.sort((a, b) => b.lastAt - a.lastAt)
    const recent = runs.filter(run => run.status !== 'running' && now - run.lastAt <= 86400000).slice(0, 3)
    return { limits, runs: [...runs.filter(run => run.status === 'running'), ...recent] }
  } catch { return null }
}

const CODEX_TOOLS = new Set([
  'mcp__codex-cli__ask-codex', 'mcp__codex-cli__batch-codex', 'mcp__codex-cli__brainstorm',
])

function codexOutcome(value: unknown, rejected: boolean): 'success' | 'error' | 'timeout' {
  const envelope = object(value)
  const result = object(envelope?.result)
  const failed = rejected || envelope?.isError === true || typeof envelope?.deny === 'string' || result?.isError === true
  if (!failed) return 'success'
  // Chỉ kiểm tra lỗi, không lưu output của công cụ vào state.
  let text = value instanceof Error ? value.message : typeof value === 'string' ? value : ''
  for (const data of [envelope, result]) {
    if (typeof data?.text === 'string') text += data.text
    if (typeof data?.deny === 'string') text += data.deny
    if (Array.isArray(data?.content)) {
      for (const block of data.content) {
        const content = object(block)
        if (typeof content?.text === 'string') text += content.text
      }
    }
  }
  return /timed out/i.test(text) ? 'timeout' : 'error'
}

function orderedAgents(agents: AgentRow[]): { row: AgentRow; depth: number }[] {
  const ordered: { row: AgentRow; depth: number }[] = []
  const seen = new Set<string>()
  const byId = new Map(agents.map(row => [row.id, row]))
  const visit = (row: AgentRow, depth: number): void => {
    if (seen.has(row.id)) return
    seen.add(row.id)
    ordered.push({ row, depth })
    for (const child of agents) if (child.parentId === row.id) visit(child, depth + 1)
  }
  const main = byId.get(MAIN)
  if (main) visit(main, 0)
  for (const row of agents) if (!seen.has(row.id) && (!row.parentId || !byId.has(row.parentId))) visit(row, 1)
  for (const row of agents) if (!seen.has(row.id)) visit(row, 1)
  return ordered
}

type PollRuntime = {
  refreshing: boolean
  lastUsage: number
  lastSessions: number
  lastCodex: number
  lastPidCheck: number
  alivePids: number[] | null
  pidCheckFailed: boolean
  agentsRevision: number
  usageRevision: number
}

async function refresh($: CoreEngineInterface, runtime: PollRuntime): Promise<void> {
    if (runtime.refreshing) return
    runtime.refreshing = true
    try {
      const now = await $.clock.now()
      await safely(async () => {
        const revision = runtime.agentsRevision
        const agents = await $.agent.list()
        await change($, state => {
          ensureAgent(state, MAIN, now)
          // Một tool/turn/spawn mới hơn poll luôn có quyền ưu tiên.
          for (const info of runtime.agentsRevision === revision ? agents : []) {
            const row = ensureAgent(state, info.id, now)
            if (row.status !== info.status && terminal(info.status)) {
              addFeed(state, { at: now, kind: 'finish', from: info.id,
                to: row.parentId ?? info.parentId ?? MAIN, text: STATUS[info.status] })
            }
            applyInfo(row, info, now)
          }
          for (const row of state.agents) row.elapsed = elapsed(row.startedAt, row.stoppedAt ?? now)
          for (const limit of state.limits) limit.reset = resetText(limit.resetsAt, now)
        })
      })
      if (now - runtime.lastUsage >= 15000) {
        runtime.lastUsage = now
        await safely(async () => {
          const revision = runtime.usageRevision
          const usage = await $.session.usage()
          await change($, state => {
            if (runtime.usageRevision === revision) {
              setUsage(state, usage.rateLimits, usage.context, now)
              state.claudeCost = finite(usage.cost?.usd) && usage.cost.usd >= 0 ? usage.cost.usd : null
            }
            const main = ensureAgent(state, MAIN, usage.startedAt)
            main.startedAt = usage.startedAt
            main.elapsed = elapsed(main.startedAt, main.stoppedAt ?? now)
          })
        })
      }
      if (now - runtime.lastSessions >= 15000) {
        runtime.lastSessions = now
        await safely(async () => {
          let sessions: OtherSession[] | null = null
          try {
            const config = await $.env.get('CLAUDE_CONFIG_DIR')
            const profile = await $.env.get('USERPROFILE')
            const home = profile || await $.env.get('HOME')
            const directory = config || (home ? `${home}/.claude` : '')
            const windows = (await $.env.get('OS')) === 'Windows_NT' || /^[A-Za-z]:[\\/]/.test(home ?? directory)
            if (windows && now - runtime.lastPidCheck >= 15000) {
              runtime.lastPidCheck = now
              // Thất bại => không kết luận PID chết; ẩn phần này đến lần kiểm tra sau.
              runtime.alivePids = null
              runtime.pidCheckFailed = true
              try {
                const result = await $.process.run(['tasklist', '/FO', 'CSV', '/NH'], { timeoutMs: 2500 })
                runtime.alivePids = result.exitCode === 0 && !result.isStdoutTruncated ? taskPids(result.stdout) : null
                runtime.pidCheckFailed = runtime.alivePids === null
              } catch { /* Giữ alivePids = null: không đánh dấu PID chết. */ }
            }
            if (directory && !(windows && runtime.pidCheckFailed)) {
              sessions = await otherSessions($, `${directory}/sessions`, await $.session.id(), now, windows ? runtime.alivePids : null)
            }
          } catch { sessions = null }
          await change($, state => { state.sessions = sessions })
        })
      }

      if (now - runtime.lastCodex >= 15000) {
        runtime.lastCodex = now
        await safely(async () => {
          let codex: CodexData | null = null
          try {
            const configured = await $.env.get('CODEX_HOME')
            const profile = configured ? undefined : await $.env.get('USERPROFILE')
            const home = configured || (profile ? `${profile}/.codex` : '')
            if (home) codex = await readCodex($, home, now)
          } catch { /* Mọi lỗi chỉ ẩn telemetry Codex. */ }
          await change($, state => { state.codex = codex })
        })
      }
    } finally { runtime.refreshing = false }
}

/** Đăng ký pane và observer; mọi dữ liệu hiển thị nằm trong state của phiên. */
export const register: Register = (on, options) => {
  void options
  let tick: Timer | undefined
  const runtime: PollRuntime = {
    refreshing: false, lastUsage: -Infinity, lastSessions: -Infinity, lastCodex: -Infinity,
    lastPidCheck: -Infinity, alivePids: null, pidCheckFailed: false,
    agentsRevision: 0, usageRevision: 0,
  }

  on('session.start', async ($, e, next) => {
    await safely(async () => {
      await $.command.register({ name: PANE, description: 'Mở bảng theo dõi hạn mức và agent' })
    })
    void $.ui.open({ id: PANE, title: 'Theo dõi agent' }).catch(() => {})
    tick?.cancel()
    runtime.lastUsage = runtime.lastSessions = runtime.lastCodex = runtime.lastPidCheck = -Infinity
    tick = $.clock.every(3000, () => { void refresh($, runtime).catch(() => {}) })
    void refresh($, runtime).catch(() => {})
    return await next(e)
  })

  on('session.end', async ($, e, next) => {
    // /clear và resume giữ process sống và không phát lại session.start.
    if (e.reason !== 'clear' && e.reason !== 'resume') tick?.cancel()
    return await next(e)
  })

  on('command.run', { command: PANE }, async $ => {
    await $.ui.open({ id: PANE, title: 'Theo dõi agent' })
    return { text: 'Đã mở bảng theo dõi agent.' }
  })

  on('tool.call', async ($, e, next) => {
    runtime.agentsRevision++
    const id = e.agentId ?? MAIN
    const isCodex = CODEX_TOOLS.has(e.tool)
    let startedAt: number | undefined
    await safely(async () => {
      const now = await $.clock.now()
      startedAt = now
      await change($, state => {
        const row = ensureAgent(state, id, now)
        row.tools++
        row.status = 'running'
        delete row.stoppedAt
        row.active = [...row.active.filter(call => call.id !== e.tool_use_id),
          { id: e.tool_use_id, text: toolActivity(e) }].slice(-32)
        if (isCodex) addFeed(state, {
          at: now, kind: 'codex', from: MAIN, to: CODEX,
          text: clean('prompt' in e ? e.prompt : ''),
        })
      })
    })
    const recordCodex = async (value: unknown, rejected: boolean): Promise<void> => {
      if (!isCodex) return
      await safely(async () => {
        const now = await $.clock.now()
        const outcome = codexOutcome(value, rejected)
        const text = outcome === 'timeout' ? 'hết thời gian chờ MCP, Codex có thể vẫn đang chạy'
          : outcome === 'error' ? 'lỗi' : `xong sau ${elapsed(startedAt ?? now, now)}`
        await change($, state => addFeed(state, { at: now, kind: 'codex', from: CODEX, to: MAIN, text }))
      })
    }
    try {
      const result = await next(e)
      await recordCodex(result, false)
      return result
    } catch (error) {
      await recordCodex(error, true)
      throw error
    } finally {
      runtime.agentsRevision++
      await safely(() => change($, state => {
        const row = state.agents.find(agent => agent.id === id)
        if (row) row.active = row.active.filter(call => call.id !== e.tool_use_id)
      }))
    }
  })

  on('turn.start', async ($, e, next) => {
    runtime.agentsRevision++
    await safely(async () => {
      const now = await $.clock.now()
      await change($, state => {
        const row = ensureAgent(state, e.agentId ?? MAIN, now)
        row.status = 'running'
        delete row.stoppedAt
      })
    })
    return await next(e)
  })

  on('turn.complete', async ($, e, next) => {
    runtime.agentsRevision++
    await safely(async () => {
      const now = await $.clock.now()
      await change($, state => {
        const row = ensureAgent(state, e.agentId ?? MAIN, now)
        const isNewTurn = !row.turns.includes(e.turnId)
        if (isNewTurn) {
          const usage = e.usage
          if (usage) row.tokens += usage.input_tokens + usage.output_tokens + usage.cache_creation_input_tokens
          if (usage?.model) row.model = clean(usage.model)
          row.turns = [...row.turns, e.turnId].slice(-64)
        }
        // turn.complete kết thúc một lượt, chưa khẳng định teammate đã kết thúc.
        row.status = e.reason === 'error' ? 'failed' : e.isAborted ? 'waiting' : 'idle'
        if (isNewTurn && e.agentId && e.reason === 'error') addFeed(state, {
          at: now, kind: 'finish', from: e.agentId, to: row.parentId ?? MAIN, text: STATUS.failed,
        })
        row.stoppedAt = now
        row.elapsed = elapsed(row.startedAt, now)
        row.active = []
      })
    })
    return await next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    runtime.agentsRevision++
    await safely(async () => {
      if ('deny' in result || !result.agentId) return
      const now = await $.clock.now()
      await change($, state => {
        const row = ensureAgent(state, result.agentId!, now)
        row.parentId = e.parentAgentId ?? MAIN
        row.name = clean(e.name) || clean(e.subagentType)
        row.description = clean(e.description)
        row.model = clean(result.model)
        if (!row.turns.length) row.status = 'running'
        addFeed(state, { at: now, kind: 'spawn', from: row.parentId,
          to: row.id, text: clean(e.description) })
      })
    })
    return result
  })

  on('session.send', async ($, e, next) => {
    await safely(async () => {
      const now = await $.clock.now()
      await change($, state => addFeed(state, {
        at: now, kind: 'send', from: e.agentId ?? MAIN, to: clean(e.to), text: e.text.slice(0, 120),
      }))
    })
    return await next(e)
  })

  on('session.measure', async ($, e, next) => {
    runtime.usageRevision++
    await safely(async () => {
      const now = await $.clock.now()
      await change($, state => {
        setUsage(state, e.rateLimits, e.context, now)
        if (e.cost) state.claudeCost = finite(e.cost.usd) && e.cost.usd >= 0 ? e.cost.usd : null
      })
    })
    return await next(e)
  })

  on('ui.press', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.plugin === PANE && (e.element === 'main' || e.element.startsWith('view:'))) {
      await safely(async () => {
        const result = await $.ui.view(e.element === 'main' ? {} : { agentId: e.element.slice(5) })
        if ('deny' in result) $.ui.toast(`Không thể chuyển góc xem: ${result.deny}`)
      })
    }
    return await next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    // Engine bổ sung constructor Fragment cho phần tử surface không hỗ trợ.
    const Svg = 'Svg' in elements && elements.Svg({ source: '<svg/>', alt: '' }).type === 'Svg'
      ? elements.Svg : undefined
    const state = await read($, monitor)
    const now = await $.clock.now()
    const agents = orderedAgents(state.agents)
    const codexRows = state.codex?.limits
      ? 2 + Number(!!state.codex.limits.primary) + Number(!!state.codex.limits.secondary) + Number(state.codex.limits.reached) : 2
    const baseRows = 10 + codexRows + Math.max(1, state.codex?.runs.length ?? 0) + Math.max(1, state.limits.length) + agents.length * 2
      + (e.props.view.agentId ? 1 : 0) + (state.sessions === null ? 0 : 1 + Math.max(1, state.sessions.length))
    const feedRoom = Math.max(0, (e.viewport?.rows ?? 24) - baseRows)
    const scene = Svg ? buildScene(state, now) : undefined
    const working = scene?.agents.filter(agent => agent.zone === 'work') ?? []
    const resting = scene?.agents.filter(agent => agent.zone === 'lounge') ?? []
    const main = state.agents.find(agent => agent.id === MAIN)
    const totalTokens = state.agents.reduce((sum, row) => sum + row.tokens, 0)
      + (state.codex?.runs.reduce((sum, run) => sum + (run.tokens ?? 0), 0) ?? 0)
    const activityBar = '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="4" viewBox="0 0 240 4"><rect width="240" height="4" fill="#e7ddc6"/><rect width="48" height="4" fill="#79a49b"><animate attributeName="x" values="-48;240" dur="2s" repeatCount="indefinite"/></rect></svg>'
    const cards = (rows: NonNullable<typeof scene>['agents'], small: boolean) => rows.map(agent => {
      const type = agent.kind === 'main' ? 'Claude Code' : agent.kind === 'codex' ? 'Codex CLI'
        : agent.kind === 'subagent' ? 'Agent con Claude' : 'Phiên Claude khác'
      const status = agent.status === 'stopped' ? CODEX_STATUS.stopped : STATUS[agent.status]
      const detail = `${agent.tool} · ${agent.tools} lần gọi · ${agent.elapsed} · ${agent.tokens === null ? 'Chưa rõ token' : `${compact(agent.tokens)} token`}`
      const { fiveHourLeft, weekLeft, binding, share, account } = agent.limit
      const limitColor = binding === null ? undefined : binding < 5 ? 'error' : binding < 20 ? 'warning' : undefined
      const percent = (left: number | null, bar: boolean): string => {
        if (left === null) return 'chưa rõ'
        const filled = Math.round(left / 10)
        return `${bar ? `[${'█'.repeat(filled)}${'░'.repeat(10 - filled)}] ` : ''}${left}%`
      }
      const limitDetail = `5 giờ ${percent(fiveHourLeft, !small)} · Tuần ${percent(weekLeft, !small)}`
      return <Box key={`card:${agent.id}`} flexDirection="row" gap={1} padding={1} borderStyle="round" borderColor="subtle">
        {Svg && <Svg source={renderAvatarSvg(agent.lookSeed, agent.kind)} alt={`Chân dung ${agent.name}`} width={36} height={36} />}
        <Box flexDirection="column" flexGrow={1}>
          {small ? <Text><Text color={agent.kind === 'codex' ? 'success' : 'suggestion'}>{type}{agent.model ? ` · ${agent.model}` : ''}</Text> · {agent.name} · {agent.task} · {status} · {detail}<Text color={limitColor}> · {limitDetail}</Text></Text>
            : <>
              <Text bold>{agent.task}</Text>
              <Text color={agent.kind === 'codex' ? 'success' : agent.kind === 'main' ? 'claude' : 'suggestion'}>{type} · {agent.name}{agent.model ? ` · ${agent.model}` : ''} · {status}</Text>
              <Text dimColor>{detail}</Text>
              <Text color={limitColor}>Limit {account === 'codex' ? 'Codex' : 'Claude'} · {limitDetail}</Text>
              {share !== null && <Text dimColor>Agent này chiếm {share}% token của tài khoản trong các agent đang theo dõi</Text>}
              {Svg && agent.status === 'running' && <Svg source={activityBar} alt="Đang xử lý, chưa có số liệu tiến độ" height={4} />}
            </>}
        </Box>
        {agent.kind === 'subagent' && <Button key={`view:${agent.id}`} label="Xem" onPress={() => {}} />}
      </Box>
    })
    return (
      <Box flexDirection="column">
        {Svg && scene && <>
          <Text bold size="heading">Văn phòng Agent</Text>
          <Svg source={renderOfficeSvg(scene)} alt={`Văn phòng: ${working.length} agent đang làm, ${resting.length} agent đang nghỉ`} isInteractive />
          <Box flexDirection="row" gap={1}>
            <Box flexDirection="column" padding={1} borderStyle="round" borderColor="subtle" flexGrow={1}>
              <Text dimColor>Chi phí Claude</Text>
              <Text bold>{state.claudeCost == null ? 'Chưa rõ' : `≈$${state.claudeCost.toFixed(2)}`}</Text>
            </Box>
            <Box flexDirection="column" padding={1} borderStyle="round" borderColor="subtle" flexGrow={1}>
              <Text dimColor>Token</Text><Text bold>{compact(totalTokens)}</Text>
            </Box>
            <Box flexDirection="column" padding={1} borderStyle="round" borderColor="subtle" flexGrow={1}>
              <Text dimColor>Thời gian</Text><Text bold>{main ? elapsed(main.startedAt, now) : '<1m'}</Text>
            </Box>
          </Box>
        </>}
        <Text bold>Limit còn lại</Text>
        <Text bold>Claude Code</Text>
        {state.limits.length === 0 && <Text dimColor>{EMPTY_LIMITS}</Text>}
        {state.limits.map(limit => {
          const left = remaining(limit.percentUsed)
          const filled = Math.round(left / 10)
          return <Text color={left < 5 ? 'error' : left < 20 ? 'warning' : undefined}>
            {limitLabel(limit.kind)} [{ '█'.repeat(filled) + '░'.repeat(10 - filled) }] {left}% còn lại · {limit.reset}
          </Text>
        })}
        <Text>Context phiên này: {state.contextRemaining === null ? 'Chưa có dữ liệu' : `${state.contextRemaining}% còn lại`}</Text>
        <Text bold>Codex CLI{state.codex?.limits?.plan ? ` · ${state.codex.limits.plan}` : ''}</Text>
        {!state.codex?.limits && <Text dimColor>Chưa có dữ liệu limit Codex</Text>}
        {state.codex?.limits && <Box flexDirection="column">
          {[state.codex.limits.primary, state.codex.limits.secondary].map(window => {
            if (!window) return null
            const left = remaining(window.usedPercent)
            const expired = window.resetsAt !== undefined && window.resetsAt * 1000 <= now
            return <Text dimColor={expired} color={expired ? undefined : left < 5 ? 'error' : left < 20 ? 'warning' : undefined}>
              {codexWindowText(window, now)}
            </Text>
          })}
          {state.codex.limits.reached && <Text color="warning">Đã chạm limit</Text>}
          <Text dimColor>Cập nhật lúc {clockText(state.codex.limits.updatedAt)} (theo lần gọi Codex gần nhất)</Text>
        </Box>}
        <Text dimColor>Mỗi nhóm là limit riêng của tài khoản đó; các agent con của Claude dùng chung limit Claude.</Text>

        {Svg ? <>
          <Text bold>Đang làm · {working.length}</Text>
          <Text dimColor>Limit tính theo tài khoản: các agent cùng tài khoản dùng chung một hạn mức.</Text>
          {cards(working, false)}
          <Text bold>Đang nghỉ · {resting.length}</Text>
          {cards(resting, true)}
        </> : <>
        <Text bold>Các agent</Text>
        {agents.length === 0 && <Text dimColor>Claude Code · ○ Rảnh · Chưa có hoạt động</Text>}
        {agents.map(({ row, depth }) => (
          <Box flexDirection="column">
            <Box>
              <Text>{'  '.repeat(Math.min(depth, 12))}{STATUS[row.status]} · {row.name} · {row.description}</Text>
              {row.id !== MAIN && <Button key={`view:${row.id}`} label="Xem" onPress={() => {}} />}
            </Box>
            <Text dimColor>{'  '.repeat(Math.min(depth, 12))}{row.active.length ? row.active.map(call => call.text).join(' | ') : 'Không có công cụ đang chạy'} · {row.tools} lần gọi · {row.elapsed} · {compact(row.tokens)} token</Text>
          </Box>
        ))}
        <Text bold>Codex CLI</Text>
        {!state.codex?.runs.length && <Text dimColor>Chưa có hoạt động Codex</Text>}
        {state.codex?.runs.map(run => <Text>
          {CODEX_STATUS[run.status]} · {run.folder} · {run.lastTool || 'Chưa gọi công cụ'} · {run.tools} lần gọi · {run.elapsed} · {run.tokens === null ? 'Chưa rõ token' : `${compact(run.tokens)} token`}
        </Text>)}
        </>}
        {e.props.view.agentId && <Button key="main" label="Về Claude Code" onPress={() => {}} />}
        <Text bold>Tương tác</Text>
        {state.feed.length === 0 && <Text dimColor>Chưa có tương tác.</Text>}
        {state.feed.slice(0, feedRoom).map(item => (
          <Text>{clockText(item.at)} {agentName(state, item.from)} → {agentName(state, item.to)}: {item.kind === 'spawn' ? 'giao việc ' : ''}{item.text}</Text>
        ))}
        {state.sessions !== null && <Box flexDirection="column">
          <Text bold>Phiên khác trên máy</Text>
          {state.sessions.length === 0 && <Text dimColor>Không có phiên khác đang chạy.</Text>}
          {state.sessions.map(session => <Text>{session.name} · {session.folder} · {session.status} · chờ: {session.waitingFor} · {session.age}</Text>)}
        </Box>}
      </Box>
    )
  })
}

function applyInfo(row: AgentRow, info: AgentInfo, now: number): void {
  row.parentId = info.parentId ?? MAIN
  row.name = clean(info.name) || clean(info.type)
  row.description = clean(info.description)
  row.status = info.status
  if (terminal(info.status) || info.status === 'idle') {
    row.stoppedAt ??= now
    row.active = []
  } else delete row.stoppedAt
}
