import { atom, read } from 'claude-code'
import type {
  AgentInfo, AgentStatus, CoreEngineInterface, ElementTable, Register, SessionContextUsage,
  SessionRateLimit, Timer, ToolCallInput,
} from 'claude-code'
import type { AgentRow, BackgroundKind, BackgroundTask, CodexData, CodexLaunch, CodexRun, CodexSummary, CodexWindow, FeedItem, MonitorState } from '../types'
import { FULL_VIEW, OFFICE_ACTIONS, buildScene, moveView, officeFrame, remaining, renderAvatarSvg, renderOfficeSvg, sanitizeOfficeSize, sanitizeView, viewPercent } from './office'
import type { OfficeAction } from './office'

export { remaining } from './office'

const PANE = 'agent-monitor'
const MAIN = '@main'
const CODEX = '@codex'
const SHAPE = 'monitor-7'
const REF = { plugin: 'agent-monitor', key: 'monitor' } as const
const INITIAL: MonitorState = {
  agents: [], limits: [], contextRemaining: null, feed: [], codex: null,
}
const monitor = atom(REF, INITIAL, { shape: SHAPE })
const VIEW_KEY = 'officeView'
const SIZE_KEY = 'officeSize'
const NO_CODEX_RUNS = 'Chưa có lần gọi Codex trong phiên này'
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
  if (state.background) state.background = [
    ...state.background.filter(task => task.status === 'running').slice(-MAX_BACKGROUND_RUNNING),
    ...state.background.filter(task => task.status !== 'running').slice(-MAX_BACKGROUND_DONE),
  ]
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
  if (id === BACKGROUND) return 'Task ngầm'
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
  // Head/tail có thể cắt giữa dòng JSON; parser bỏ dòng dở và chỉ giữ allow-list.
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
        summary.cwd = normalizePath(payload.cwd)
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

/** Một rollout đã quét; cwd đầy đủ chỉ nằm ở đây, không vào atom. */
export type ScannedRun = CodexRun & { cwd?: string; startedAt?: number }
type CodexScan = { limits: CodexData['limits']; runs: ScannedRun[] }
const MAX_LAUNCHES = 32
const MAX_SESSION_RUNS = 16
const CLAIM_BEFORE_MS = 5000
const CLAIM_AFTER_MS = 90000

/** Giờ bắt đầu ghi trong tên file (giờ địa phương), dùng khi không đọc được log. */
function rolloutStart(path: string): number | undefined {
  const match = /rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/.exec(path)
  if (!match) return undefined
  const [, year, month, day, hour, minute, second] = match.map(Number)
  return new Date(year, month - 1, day, hour, minute, second).getTime()
}

type CodexCacheEntry = { size: number; mtime: number; summary: CodexSummary | null }
const CODEX_READ_LIMIT = 4 * 1024 * 1024 - 64 * 1024
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

/** Dựng argv đọc 512 KiB đầu và 2 MiB cuối; chỉ gọi sau checkedStat, không qua shell ngoài Windows. */
export function buildCodexReadArgv(path: string, windows: boolean): string[][] {
  if (!windows) return [
    ['head', '-c', '524288', '--', path],
    ['tail', '-c', '2097152', '--', path],
  ]
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)',
    `$stream = [IO.File]::Open('${path.replace(/'/g, "''")}', 'Open', 'Read', 'ReadWrite,Delete')`,
    'try {',
    '  $length = $stream.Length',
    '  $buffer = [byte[]]::new(524288)',
    '  $count = 0',
    '  while ($count -lt $buffer.Length) {',
    '    $read = $stream.Read($buffer, $count, $buffer.Length - $count)',
    '    if ($read -eq 0) { break }',
    '    $count += $read',
    '  }',
    '  [Console]::Write([Text.Encoding]::UTF8.GetString($buffer, 0, $count))',
    '  [Console]::Write("`n")',
    '  [void]$stream.Seek([Math]::Max(0, $length - 2097152), [IO.SeekOrigin]::Begin)',
    '  $buffer = [byte[]]::new(2097152)',
    '  $count = 0',
    '  while ($count -lt $buffer.Length) {',
    '    $read = $stream.Read($buffer, $count, $buffer.Length - $count)',
    '    if ($read -eq 0) { break }',
    '    $count += $read',
    '  }',
    '  [Console]::Write([Text.Encoding]::UTF8.GetString($buffer, 0, $count))',
    '} finally { $stream.Dispose() }',
  ].join('\n')
  return [['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script]]
}

async function readCodexEdges($: CoreEngineInterface, path: string): Promise<CodexSummary | null> {
  try {
    const windows = /^[A-Za-z]:\//.test(path) || (await $.env.get('OS')) === 'Windows_NT'
    const chunks: string[] = []
    for (const argv of buildCodexReadArgv(path, windows)) {
      const result = await $.process.run(argv, { timeoutMs: 5000 })
      if (result.exitCode !== 0 || result.isStdoutTruncated) return null
      chunks.push(result.stdout)
    }
    const summary = parseCodexRollout(chunks.join('\n'))
    summary.partial = true
    return summary.firstAt === null || summary.lastAt === null ? null : summary
  } catch { return null }
}

/** Chỉ list sessions/YYYY/MM/DD và đọc tối đa 8 rollout thường, không theo symlink. */
export async function readCodex(
  $: CoreEngineInterface, home: string, now: number, keep: ReadonlySet<string> = new Set(),
): Promise<CodexScan | null> {
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
    candidates.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path))
    // Phiên khác chạy nhiều cũng không đẩy được lần chạy đã ghép của phiên này ra ngoài.
    const newest = [...candidates.slice(0, 8), ...candidates.slice(8).filter(file => keep.has(file.path))]
    const reading = new Set(newest.map(file => file.path))
    for (const path of codexCache.keys()) if (!reading.has(path)) codexCache.delete(path)
    const runs: ScannedRun[] = []
    let limits: CodexData['limits'] = null
    for (const file of newest) {
      try {
        const stat = await checkedStat($, file.path, 'file')
        if (!finite(stat.size) || !finite(stat.mtimeMs)) throw new Error('Thiếu metadata Codex')
        let cached = codexCache.get(file.path)
        if (!cached || cached.size !== stat.size || cached.mtime !== stat.mtimeMs) {
          const summary = stat.size > CODEX_READ_LIMIT
            ? await readCodexEdges($, file.path) : parseCodexRollout(await $.fs.read(file.path))
          cached = { size: stat.size, mtime: stat.mtimeMs, summary }
          codexCache.set(file.path, cached)
        }
        const summary = cached.summary
        if (!summary) {
          runs.push({
            id: file.path, folder: '—', status: now - stat.mtimeMs <= 120000 ? 'running' : 'stopped',
            lastTool: 'Chưa đọc được log', tools: 0, partial: true, tokens: null,
            elapsed: '<1m', lastAt: stat.mtimeMs,
            ...(rolloutStart(file.path) === undefined ? {} : { startedAt: rolloutStart(file.path) }),
          })
          continue
        }
        if (summary.limits && summary.limits.updatedAt >= (limits?.updatedAt ?? -Infinity)) limits = summary.limits
        if (summary.firstAt === null || summary.lastAt === null) continue
        runs.push({
          id: file.path, folder: summary.folder, status: codexStatus(summary, stat.mtimeMs, now),
          lastTool: summary.lastTool, tools: summary.tools, tokens: summary.tokens,
          ...(summary.partial ? { partial: true } : {}),
          elapsed: elapsed(summary.firstAt, summary.lastAt), lastAt: summary.lastAt,
          startedAt: summary.firstAt, ...(summary.cwd ? { cwd: summary.cwd } : {}),
        })
      } catch { /* Một rollout lỗi không được che các phiên và limit còn đọc được. */ }
    }
    if (limits) {
      // Chỉ đổi atom khi cửa sổ thực sự qua giờ reset, kể cả rollout không đổi.
      limits = structuredClone(limits)
      for (const window of [limits.primary, limits.secondary]) {
        if (window?.resetsAt !== undefined && window.resetsAt * 1000 <= now) window.expired = true
      }
    }
    runs.sort((a, b) => b.lastAt - a.lastAt)
    return { limits, runs }
  } catch { return null }
}

const CODEX_TOOLS = new Set([
  'mcp__codex-cli__ask-codex', 'mcp__codex-cli__batch-codex', 'mcp__codex-cli__brainstorm',
])

/** So sánh đường dẫn giữa Windows, Git Bash và log Codex. */
export function normalizePath(path: string): string {
  const slashed = path.replace(/\\/g, '/').replace(/\/+$/, '')
  const drive = /^\/([A-Za-z])(\/.*)?$/.exec(slashed)
  return (drive ? `${drive[1]}:${drive[2] ?? ''}` : slashed).toLowerCase()
}

type ShellToken = { text: string; dynamic: boolean }

/** Tách lệnh theo dấu ngăn lệnh, tôn trọng dấu nháy; biến shell đánh dấu là chưa biết giá trị. */
function shellSegments(command: string): ShellToken[][] {
  const segments: ShellToken[][] = [[]]
  let token: ShellToken | null = null
  let quote = ''
  const flush = (): void => { if (token) segments[segments.length - 1].push(token); token = null }
  for (const char of command) {
    if (quote) {
      if (char === quote) { quote = ''; continue }
      token ??= { text: '', dynamic: false }
      token.text += char
      if (quote === '"' && (char === '$' || char === '`' || char === '%')) token.dynamic = true
      continue
    }
    if (char === "'" || char === '"') { quote = char; token ??= { text: '', dynamic: false }; continue }
    if (/\s/.test(char) && char !== '\n') { flush(); continue }
    if (';&|()\n'.includes(char)) { flush(); segments.push([]); continue }
    token ??= { text: '', dynamic: false }
    token.text += char
    if (char === '$' || char === '`' || char === '%') token.dynamic = true
  }
  flush()
  return segments
}

const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path
const isCodexBinary = (text: string): boolean => /^codex(?:\.cmd|\.ps1|\.js|\.exe)?$/i.test(baseName(text))
const absolutePath = (token: ShellToken | undefined): string | undefined =>
  token && !token.dynamic && /^(?:[A-Za-z]:[\\/]|\/)/.test(token.text) ? normalizePath(token.text) : undefined
const CODEX_VALUE_FLAGS = new Set(['-c', '--config', '-i', '--image', '-m', '--model', '-p', '--profile',
  '-s', '--sandbox', '-a', '--ask-for-approval', '--add-dir', '--color', '-o', '--output-last-message', '--output-schema'])

/** Nhận diện lệnh shell thật sự chạy `codex exec`; null nếu lệnh chỉ nhắc tới codex. */
export function parseCodexCommand(command: string): { cwd?: string } | null {
  let shellCwd: string | undefined
  for (const tokens of shellSegments(command)) {
    let index = 0
    while (/^[A-Za-z_]\w*=/.test(tokens[index]?.text ?? '')) index++
    const head = tokens[index]
    if (!head) continue
    if (/^(?:cd|pushd|Set-Location)$/i.test(head.text)) { shellCwd = absolutePath(tokens[index + 1]); continue }
    if (/^(?:npx|node)(?:\.cmd|\.exe)?$/i.test(baseName(head.text))) {
      index++
      while (tokens[index]?.text.startsWith('-')) index++
    }
    if (!tokens[index] || !isCodexBinary(tokens[index].text)) continue
    let subcommand: string | undefined
    let cwd: string | undefined
    for (let at = index + 1; at < tokens.length; at++) {
      const text = tokens[at].text
      if (text === '-C' || text === '--cd') cwd = absolutePath(tokens[++at])
      else if (text.startsWith('--cd=')) cwd = absolutePath({ ...tokens[at], text: text.slice(5) })
      else if (CODEX_VALUE_FLAGS.has(text)) at++
      else if (!text.startsWith('-')) subcommand ??= text
      if (subcommand !== undefined && subcommand !== 'exec' && subcommand !== 'e') break
    }
    if (subcommand !== 'exec' && subcommand !== 'e') continue
    const dir = cwd ?? shellCwd
    return dir ? { cwd: dir } : {}
  }
  return null
}

function codexLaunch(e: ToolCallInput): { cwd?: string } | null {
  const tool: string = e.tool
  if (CODEX_TOOLS.has(tool)) {
    const dir = 'cd' in e && typeof e.cd === 'string' ? e.cd
      : 'workingDir' in e && typeof e.workingDir === 'string' ? e.workingDir : ''
    return dir ? { cwd: normalizePath(dir) } : {}
  }
  if ((tool === 'Bash' || tool === 'PowerShell') && 'command' in e && typeof e.command === 'string') {
    return parseCodexCommand(e.command)
  }
  return null
}

/** Mỗi lần gọi nhận tối đa một rollout gần giờ gọi nhất; rollout đã ghép giữ nguyên suốt phiên. */
export function claimCodexRuns(
  runs: readonly ScannedRun[], launches: readonly CodexLaunch[], claims: Readonly<Record<string, string>>,
): Record<string, string> {
  const ids = new Set(launches.map(launch => launch.id))
  const result = Object.fromEntries(Object.entries(claims).filter(([id]) => ids.has(id)))
  const taken = new Set(Object.values(result))
  for (const launch of [...launches].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))) {
    if (result[launch.id]) continue
    let best: ScannedRun | undefined
    let bestGap = Infinity
    for (const run of runs) {
      if (taken.has(run.id) || run.startedAt === undefined) continue
      const delta = run.startedAt - launch.at
      if (delta < -CLAIM_BEFORE_MS || delta > CLAIM_AFTER_MS) continue
      if (launch.cwd && run.cwd && launch.cwd !== run.cwd) continue
      if (Math.abs(delta) < bestGap || (Math.abs(delta) === bestGap && best && run.id < best.id)) {
        best = run
        bestGap = Math.abs(delta)
      }
    }
    if (best) { result[launch.id] = best.id; taken.add(best.id) }
  }
  return result
}

/** Chỉ đưa vào state các lần chạy của phiên này và bỏ đường dẫn đầy đủ. */
function sessionRuns(runs: readonly ScannedRun[], claims: Readonly<Record<string, string>>): CodexRun[] {
  const owned = new Set(Object.values(claims))
  return runs.filter(run => owned.has(run.id)).slice(0, MAX_SESSION_RUNS).map(({ cwd, startedAt, ...run }) => {
    void cwd; void startedAt
    return run
  })
}

const BACKGROUND = '@background'
const MAX_BACKGROUND_RUNNING = 32
const MAX_BACKGROUND_DONE = 8
const BACKGROUND_DONE_SHOWN = 5
const BACKGROUND_DONE_WINDOW_MS = 600000
const BACKGROUND_KINDS: Record<BackgroundKind, string> = {
  shell: 'Lệnh nền', monitor: 'Monitor', workflow: 'Workflow', mcp: 'MCP task', other: 'Task nền',
}
const BACKGROUND_STATUS: Record<BackgroundTask['status'], string> = {
  running: '● Đang chạy', completed: '✓ Hoàn tất', failed: '✗ Thất bại', killed: '■ Đã dừng', done: '✓ Đã xong',
}

function backgroundKind(type: string): BackgroundKind {
  return /shell|bash/i.test(type) ? 'shell' : /monitor/i.test(type) ? 'monitor'
    : /workflow/i.test(type) ? 'workflow' : /mcp/i.test(type) ? 'mcp' : 'other'
}

function startBackground(state: MonitorState, task: { taskId: string; kind: BackgroundKind; label: string; toolUseId?: string }, now: number): void {
  const list = state.background ??= []
  const known = list.find(item => item.taskId === task.taskId)
  if (known) {
    if (task.toolUseId) known.toolUseId = task.toolUseId
    return
  }
  list.push({ ...task, id: task.taskId, status: 'running', startedAt: now, elapsed: '<1m' })
  addFeed(state, { at: now, kind: 'background', from: BACKGROUND, to: MAIN, text: 'bắt đầu: ' + task.label })
}

function finishBackground(state: MonitorState, task: BackgroundTask, status: BackgroundTask['status'], now: number): void {
  if (task.status !== 'running') return
  task.status = status
  task.endedAt = now
  task.elapsed = elapsed(task.startedAt, now)
  addFeed(state, { at: now, kind: 'background', from: BACKGROUND, to: MAIN, text: BACKGROUND_STATUS[status] + ': ' + task.label })
}

/** Lấy task ngầm vừa được tạo từ kết quả tool; null nếu lời gọi không tạo task. */
function launchedBackground(e: ToolCallInput, value: unknown): { taskId: string; kind: BackgroundKind; label: string } | null {
  const envelope = object(value)
  const output = object(envelope?.result)
  if (!envelope || !output || envelope.isError === true) return null
  const tool: string = e.tool
  const description = 'description' in e ? clean(e.description, 100) : ''
  const command = 'command' in e ? clean(e.command, 60) : ''
  if (tool === 'Bash' || tool === 'PowerShell') {
    return typeof output.backgroundTaskId === 'string' && output.backgroundTaskId
      ? { taskId: clean(output.backgroundTaskId), kind: 'shell', label: description || command || BACKGROUND_KINDS.shell } : null
  }
  if ((tool === 'Monitor' || tool === 'Workflow') && typeof output.taskId === 'string' && output.taskId) {
    const kind: BackgroundKind = tool === 'Monitor' ? 'monitor' : 'workflow'
    const name = tool === 'Workflow' ? clean(output.workflowName, 100) : ''
    return { taskId: clean(output.taskId), kind, label: name || description || command || BACKGROUND_KINDS[kind] }
  }
  return null
}

type InFlightTask = { id: string; type: string; status: string; description?: string; command?: string; name?: string; server?: string; tool?: string }
type CronSummary = { id: string; schedule: string; recurring: boolean; prompt: string }

/** Đối chiếu với danh sách đầy đủ engine gửi khi hết lượt; task biến mất nghĩa là đã xong. */
export function reconcileBackground(
  state: MonitorState, tasks: readonly InFlightTask[] | undefined, crons: readonly CronSummary[] | undefined, now: number,
): void {
  if (crons) state.scheduled = crons.slice(0, 16).map(cron => ({
    id: clean(cron.id), schedule: clean(cron.schedule, 40), recurring: cron.recurring === true, prompt: clean(cron.prompt, 80),
  }))
  if (!tasks) return
  // Subagent và teammate đã có nhân vật và thẻ riêng ở mục agent.
  const live = tasks.filter(task => !/^(?:subagent|teammate)$/i.test(task.type))
  const ids = new Set(live.map(task => clean(task.id)))
  for (const task of live) {
    const kind = backgroundKind(task.type)
    const label = clean(task.description, 100) || clean(task.name, 100) || clean(task.command, 60) || clean(task.tool, 60) || BACKGROUND_KINDS[kind]
    startBackground(state, { taskId: clean(task.id), kind, label }, now)
  }
  for (const task of state.background ?? []) {
    if (task.status === 'running' && !ids.has(task.taskId)) finishBackground(state, task, 'done', now)
  }
}

/** Đọc thẻ định danh và trạng thái trong thông báo; không giữ phần tóm tắt. */
export function parseTaskNotification(text: string): { taskId?: string; toolUseId?: string; status?: string } | null {
  if (!text.includes('<task-notification>')) return null
  const tag = (name: string): string | undefined => new RegExp('<' + name + '>([^<]*)</' + name + '>').exec(text)?.[1]?.trim() || undefined
  return { taskId: tag('task-id'), toolUseId: tag('tool-use-id'), status: tag('status') }
}

function notifiedStatus(status: string | undefined): BackgroundTask['status'] {
  return status === 'completed' ? 'completed' : status === 'failed' ? 'failed'
    : status === 'killed' || status === 'stopped' ? 'killed' : 'done'
}

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
  lastCodex: number
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
          for (const task of state.background ?? []) task.elapsed = elapsed(task.startedAt, task.endedAt ?? now)
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
      if (now - runtime.lastCodex >= 15000) {
        runtime.lastCodex = now
        await safely(async () => {
          let scan: CodexScan | null = null
          try {
            const configured = await $.env.get('CODEX_HOME')
            const profile = configured ? undefined : await $.env.get('USERPROFILE')
            const home = configured || (profile ? `${profile}/.codex` : '')
            const held = await $.state.get(REF)
            const claims = held.value?.shape === SHAPE ? held.value.value.codexClaims : undefined
            if (home) scan = await readCodex($, home, now, new Set(Object.values(claims ?? {})))
          } catch { /* Mọi lỗi chỉ ẩn telemetry Codex. */ }
          await change($, state => {
            if (!scan) { state.codex = null; return }
            const claims = claimCodexRuns(scan.runs, state.codexLaunches ?? [], state.codexClaims ?? {})
            if (Object.keys(claims).length) state.codexClaims = claims
            else delete state.codexClaims
            state.codex = { limits: scan.limits, runs: sessionRuns(scan.runs, claims) }
          })
        })
      }
    } finally { runtime.refreshing = false }
}

/** Đăng ký pane và observer; mọi dữ liệu hiển thị nằm trong state của phiên. */
export const register: Register = (on, options) => {
  void options
  let tick: Timer | undefined
  const runtime: PollRuntime = {
    refreshing: false, lastUsage: -Infinity, lastCodex: -Infinity,
    agentsRevision: 0, usageRevision: 0,
  }

  on('session.start', async ($, e, next) => {
    await safely(async () => {
      await $.command.register({ name: PANE, description: 'Mở bảng theo dõi hạn mức và agent' })
    })
    await safely(async () => {
      const saved = sanitizeView(await $.store.get(VIEW_KEY))
      if (saved) await change($, state => { state.officeView = saved })
    })
    await safely(async () => {
      const saved = sanitizeOfficeSize(await $.store.get(SIZE_KEY))
      if (saved) await change($, state => { state.officeSize = saved })
    })
    void $.ui.open({ id: PANE, title: 'Theo dõi agent' }).catch(() => {})
    tick?.cancel()
    runtime.lastUsage = runtime.lastCodex = -Infinity
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
    const launch = codexLaunch(e)
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
        if (launch) state.codexLaunches = [...(state.codexLaunches ?? []).filter(item => item.id !== e.tool_use_id),
          { id: e.tool_use_id, at: now, ...launch }].slice(-MAX_LAUNCHES)
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
      await safely(async () => {
        const launched = launchedBackground(e, result)
        if (!launched) return
        const now = await $.clock.now()
        await change($, state => startBackground(state, { ...launched, toolUseId: e.tool_use_id }, now))
      })
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

  on('prompt.submit', async ($, e, next) => {
    if (e.origin?.kind === 'task-notification') {
      await safely(async () => {
        const notice = parseTaskNotification(e.text)
        if (!notice) return
        const now = await $.clock.now()
        await change($, state => {
          const task = state.background?.find(item => (notice.taskId && item.taskId === notice.taskId)
            || (notice.toolUseId && item.toolUseId === notice.toolUseId))
          if (task) finishBackground(state, task, notifiedStatus(notice.status), now)
        })
      })
    }
    return await next(e)
  })

  on('classic.Stop', async ($, e, next) => {
    await safely(async () => {
      const now = await $.clock.now()
      await change($, state => reconcileBackground(state, e.background_tasks, e.session_crons, now))
    })
    return await next(e)
  })

  on('classic.SubagentStop', async ($, e, next) => {
    await safely(async () => {
      const now = await $.clock.now()
      await change($, state => reconcileBackground(state, e.background_tasks, e.session_crons, now))
    })
    return await next(e)
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

  on('ui.message', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    await safely(async () => {
      if (e.element !== 'office-resize' || e.data === null || typeof e.data !== 'object') return
      const data = e.data as Record<string, unknown>
      if (data.type !== 'resize') return
      const size = sanitizeOfficeSize(data)
      if (!size) return
      await change($, state => { state.officeSize = size })
      if (data.done === true) await $.store.set(SIZE_KEY, size)
    })
    return await next(e)
  })

  on('ui.fault', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.element === 'office-resize') await safely(() => change($, state => { state.officeDragFailed = true }))
    return await next(e)
  })

  on('ui.press', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const action = e.plugin === PANE && e.element.startsWith('office:') ? e.element.slice(7) : ''
    if ((OFFICE_ACTIONS as readonly string[]).includes(action)) {
      await safely(async () => {
        let view: ReturnType<typeof moveView> | undefined
        await change($, state => {
          view = moveView(state.officeView ?? FULL_VIEW, action as OfficeAction)
          state.officeView = view
        })
        if (view) await $.store.set(VIEW_KEY, view)
      })
    }
    if (action === 'size-reset') {
      await safely(async () => {
        await change($, state => { delete state.officeSize })
        await $.store.delete(SIZE_KEY)
      })
    } else if (['narrower', 'wider', 'shorter', 'taller'].includes(action)) {
      await safely(async () => {
        let size: ReturnType<typeof sanitizeOfficeSize> = null
        await change($, state => {
          const frame = officeFrame(state.officeView ?? FULL_VIEW, state.officeSize)
          size = sanitizeOfficeSize({
            w: frame.w + (action === 'narrower' ? -64 : action === 'wider' ? 64 : 0),
            h: frame.h + (action === 'shorter' ? -40 : action === 'taller' ? 40 : 0),
          })
          if (size) state.officeSize = size
        })
        if (size) await $.store.set(SIZE_KEY, size)
      })
    }
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
    const Client = e.surface === 'desktop' && !state.officeDragFailed ? (elements as ElementTable<'desktop'>).Client : undefined
    const now = await $.clock.now()
    const agents = orderedAgents(state.agents)
    const backgroundRunning = (state.background ?? []).filter(task => task.status === 'running')
    const backgroundShown = [...backgroundRunning, ...(state.background ?? [])
      .filter(task => task.status !== 'running' && now - (task.endedAt ?? 0) < BACKGROUND_DONE_WINDOW_MS)
      .slice(-BACKGROUND_DONE_SHOWN).reverse()]
    const scheduled = state.scheduled ?? []
    const codexRows = state.codex?.limits
      ? 2 + Number(!!state.codex.limits.primary) + Number(!!state.codex.limits.secondary) + Number(state.codex.limits.reached) : 2
    const baseRows = 10 + codexRows + Math.max(1, state.codex?.runs.length ?? 0) + Math.max(1, state.limits.length) + agents.length * 2
      + (e.props.view.agentId ? 1 : 0) + 1 + Math.max(1, backgroundShown.length) + (scheduled.length ? 1 + scheduled.length : 0)
    const feedRoom = Math.max(0, (e.viewport?.rows ?? 24) - baseRows)
    const scene = Svg ? buildScene(state, now) : undefined
    const view = state.officeView ?? FULL_VIEW
    const frame = officeFrame(view, state.officeSize)
    const working = scene?.agents.filter(agent => agent.zone === 'work') ?? []
    const resting = scene?.agents.filter(agent => agent.zone === 'lounge') ?? []
    const main = state.agents.find(agent => agent.id === MAIN)
    const totalTokens = state.agents.reduce((sum, row) => sum + row.tokens, 0)
      + (state.codex?.runs.reduce((sum, run) => sum + (run.tokens ?? 0), 0) ?? 0)
    const activityBar = '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="4" viewBox="0 0 240 4"><rect width="240" height="4" fill="#e7ddc6"/><rect width="48" height="4" fill="#79a49b"><animate attributeName="x" values="-48;240" dur="2s" repeatCount="indefinite"/></rect></svg>'
    const cards = (rows: NonNullable<typeof scene>['agents'], small: boolean) => rows.map(agent => {
      const type = agent.kind === 'main' ? 'Claude Code' : agent.kind === 'codex' ? 'Codex CLI'
        : 'Agent con Claude'
      const name = agent.name === type ? '' : ` · ${agent.name}`
      const status = agent.status === 'stopped' ? CODEX_STATUS.stopped : STATUS[agent.status]
      const detail = `${agent.tool} · ${agent.tools}${agent.partial ? '+' : ''} lần gọi · ${agent.elapsed} · ${agent.tokens === null ? 'Chưa rõ token' : `${compact(agent.tokens)} token`}`
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
          {small ? <Text><Text color={agent.kind === 'codex' ? 'success' : 'suggestion'}>{type}{agent.model ? ` · ${agent.model}` : ''}</Text>{name} · {agent.task} · {status} · {detail}<Text color={limitColor}> · {limitDetail}</Text></Text>
            : <>
              <Text bold>{agent.task}</Text>
              <Text color={agent.kind === 'codex' ? 'success' : agent.kind === 'main' ? 'claude' : 'suggestion'}>{type}{name}{agent.model ? ` · ${agent.model}` : ''} · {status}</Text>
              <Text dimColor>{detail}</Text>
              <Text color={limitColor}>Limit {account === 'codex' ? 'Codex' : 'Claude'} · {limitDetail}</Text>
              {share !== null && <Text dimColor>Agent này chiếm {share}% token của tài khoản trong các agent đang theo dõi</Text>}
              {Svg && agent.status === 'running' && <Box marginTop={1}><Svg source={activityBar} alt="Đang xử lý, chưa có số liệu tiến độ" width={240} height={4} /></Box>}
            </>}
        </Box>
        {agent.kind === 'subagent' && <Button key={`view:${agent.id}`} label="Xem" onPress={() => {}} />}
      </Box>
    })
    return (
      <Box flexDirection="column">
        {Svg && scene && <>
          <Text bold size="heading">Văn phòng Agent</Text>
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            <Button key="office:out" label="−" onPress={() => {}} />
            <Text>{viewPercent(view)}%</Text>
            <Button key="office:in" label="+" onPress={() => {}} />
            <Button key="office:all" label="Toàn cảnh" onPress={() => {}} />
            <Button key="office:work" label="Làm việc" onPress={() => {}} />
            <Button key="office:lounge" label="Nghỉ" onPress={() => {}} />
            {!Client && <>
              <Button key="office:narrower" label="Hẹp" onPress={() => {}} />
              <Button key="office:wider" label="Rộng" onPress={() => {}} />
              <Button key="office:shorter" label="Thấp" onPress={() => {}} />
              <Button key="office:taller" label="Cao" onPress={() => {}} />
            </>}
          </Box>
          {view.w < 320 || view.h < 210 ? <Box flexDirection="row" gap={1} flexWrap="wrap">
            <Button key="office:left" label="◀" onPress={() => {}} />
            <Button key="office:up" label="▲" onPress={() => {}} />
            <Button key="office:down" label="▼" onPress={() => {}} />
            <Button key="office:right" label="▶" onPress={() => {}} />
          </Box> : null}
          {Client && <Client key="office-resize" module="./office-resize.tsx" props={{ width: frame.w, height: frame.h }} width="100%" />}
          <Svg source={renderOfficeSvg(scene, view, frame)} alt={`Văn phòng: ${working.length} agent đang làm, ${resting.length} agent đang nghỉ`} width={frame.w} height={frame.h} isInteractive />
          {state.officeSize && <Box flexDirection="row"><Button key="office:size-reset" label="Cỡ gốc" onPress={() => {}} /></Box>}
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
          {!state.codex?.runs.length && <Text dimColor>{NO_CODEX_RUNS}</Text>}
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
        {!state.codex?.runs.length && <Text dimColor>{NO_CODEX_RUNS}</Text>}
        {state.codex?.runs.map(run => <Text>
          {CODEX_STATUS[run.status]} · {run.folder} · {run.lastTool || 'Chưa gọi công cụ'} · {run.tools}{run.partial ? '+' : ''} lần gọi · {run.elapsed} · {run.tokens === null ? 'Chưa rõ token' : `${compact(run.tokens)} token`}
        </Text>)}
        </>}
        {e.props.view.agentId && <Button key="main" label="Về Claude Code" onPress={() => {}} />}
        <Text bold>Task ngầm · {backgroundRunning.length}</Text>
        {backgroundShown.length === 0 && <Text dimColor>Không có task ngầm</Text>}
        {backgroundShown.map(task => <Text dimColor={task.status !== 'running'} color={task.status === 'failed' ? 'error' : undefined}>
          {BACKGROUND_STATUS[task.status]} · {BACKGROUND_KINDS[task.kind]} · {task.label} · {task.elapsed}
        </Text>)}
        {scheduled.length > 0 && <Box flexDirection="column">
          <Text bold>Đã lên lịch · {scheduled.length}</Text>
          {scheduled.map(cron => <Text dimColor>{cron.recurring ? 'Lặp lại' : 'Một lần'} · {cron.schedule} · {cron.prompt}</Text>)}
        </Box>}
        <Text bold>Tương tác</Text>
        {state.feed.length === 0 && <Text dimColor>Chưa có tương tác.</Text>}
        {state.feed.slice(0, feedRoom).map(item => (
          <Text>{clockText(item.at)} {agentName(state, item.from)} → {agentName(state, item.to)}: {item.kind === 'spawn' ? 'giao việc ' : ''}{item.text}</Text>
        ))}
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
