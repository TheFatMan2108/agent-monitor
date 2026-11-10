import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { AgentInfo, AgentSpawnInput, CoreEngineInterface, EngineEventOf, On, SessionRateLimit, SessionUsage, FsEntry, ToolCallResult, ToolCallInput, Register } from 'claude-code'
import type { CodexLaunch, MonitorState } from '../types'
import { remaining, resetText, register, parseTaskNotification, reconcileBackground, parseCodexCommand, claimCodexRuns, normalizePath, parseCodexRollout, codexWindowText, codexStatus, readCodex, buildCodexReadArgv } from './register'
import { FULL_VIEW, buildScene, officeFrame, officeHitboxes, renderOfficeSvg } from './office'

const NOW = Date.parse('2026-11-09T03:00:00Z')
const PANE = {
  plugin: 'agent-monitor', component: 'Pane', requestId: 'agent-monitor',
  viewport: { columns: 100, rows: 100 },
  props: {
    title: 'Agent Monitor', isFocused: false, bodyColumns: 80, placement: 'dock',
    scroll: { offset: 0, bodyRows: 96 }, view: {},
  },
} as const

function setup(on: On, options: {
  limits?: SessionRateLimit[]; env?: Record<string, string>; agents?: AgentInfo[]
  onUsage?: () => void; onAgents?: () => void; onWrite?: () => void
  usageDelay?: number; agentDelay?: number; launches?: CodexLaunch[]
} = {}) {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, options.env ?? {})
  on('command.register', () => ({ value: { command: 'agent-monitor' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'own' }))
  on('agent.list', async () => {
    options.onAgents?.()
    if (options.agentDelay) await clock.sleep(options.agentDelay)
    return { value: options.agents ?? [] }
  })
  const usage: SessionUsage = { startedAt: NOW, context: { window: 200000, percent: 30 }, rateLimits: options.limits ?? [] }
  on('session.usage', async () => {
    options.onUsage?.()
    if (options.usageDelay) await clock.sleep(options.usageDelay)
    return { value: usage }
  })
  let held: MonitorState | undefined
  let seeded: MonitorState | undefined
  on('state.get', async (_, e, next) => {
    const result = await next(e)
    if (seeded) return { ...result, value: { ...result.value, value: { shape: 'monitor-7', value: seeded } } }
    if (options.launches && !held) return { ...result, value: { ...result.value, value: { shape: 'monitor-7', value: {
      agents: [], limits: [], contextRemaining: null, feed: [], codex: null, codexLaunches: options.launches } } } }
    return result
  })
  on('state.set', async (_, e, next) => {
    const result = await next(e)
    if (result.value.isSet) {
      held = (e.value as { shape: string; value: MonitorState }).value
      options.onWrite?.()
    }
    return result
  })
  return { clock, usage, snapshot: () => held!, seed: (value: MonitorState) => { seeded = value } }
}

async function start($: Engine): Promise<void> {
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
}

function spawn(name = 'scout', parentAgentId?: string): AgentSpawnInput {
  return {
    tool_use_id: `spawn-${name}`, prompt: 'Đọc mã nguồn', description: 'Khảo sát mã nguồn',
    subagentType: 'Explore', name, provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'test-model', background: true, fork: false, parentAgentId,
  }
}

test('phần trăm còn lại và thời gian reset được tính chính xác', () => {
  expect(remaining(23.5)).toBe(76.5)
  expect(remaining(0)).toBe(100)
  expect(remaining(100)).toBe(0)
  expect(remaining(140)).toBe(0)
  expect(remaining(-10)).toBe(100)
  expect(remaining(NaN)).toBe(0)
  expect(resetText('2026-11-09T06:47:00Z', NOW)).toBe('còn 3h 47m')
  expect(resetText('2026-11-09T02:00:00Z', NOW)).toBe('còn 0h 0m')
  expect(resetText('2026-11-09T03:00:01Z', NOW)).toBe('còn 0h 1m')
  expect(resetText(undefined, NOW)).toBe('Chưa rõ giờ reset')
  expect(resetText('không hợp lệ', NOW)).toBe('Chưa rõ giờ reset')
})

test('hiển thị thông báo limit trống trên mọi surface', async ($, on) => {
  setup(on)
  await start($)
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /Chưa có dữ liệu limit/ }))?.text)
      .toBe('Chưa có dữ liệu limit (cần gói subscription và ít nhất một lượt gọi API)')
    expect((await ui.find({ type: 'Text', text: /Context phiên này/ }))?.text).toBe('Context phiên này: 70% còn lại')
    await ui.unmount()
  }
})

test('terminal giữ layout chữ; desktop/vscode/mobile có văn phòng, avatar và bar chỉ khi đang chạy', async ($, on) => {
  const { clock, usage, snapshot } = setup(on, { agents: [
    { id: 'running', name: 'Người làm', type: 'Explore', description: 'Khảo sát mã', status: 'running' },
    { id: 'waiting', name: 'Người chờ', type: 'Explore', description: 'Chờ duyệt', status: 'waiting' },
    { id: 'idle', name: 'Người nghỉ', type: 'Explore', description: 'Đã khảo sát', status: 'idle' },
  ] })
  usage.cost = { usd: 0.012 }
  await start($)
  await clock.settle()
  expect(snapshot().claudeCost).toBe(0.012)
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const svgs = await ui.findAll({ type: 'Svg' })
    if (surface === 'terminal') {
      expect(svgs.length).toBe(0)
      expect((await ui.find({ type: 'Text', text: /^Các agent$/ }))?.text).toBe('Các agent')
      expect(await ui.find({ type: 'Text', text: 'Văn phòng Agent' })).toBe(undefined)
    } else {
      expect((await ui.find({ type: 'Text', text: 'Văn phòng Agent' }))?.text).toBe('Văn phòng Agent')
      expect(svgs.length).toBe(6) // Văn phòng, 4 avatar, 1 bar.
      expect(svgs[0]?.props.isInteractive).toBe(true)
      expect(svgs[0]?.props.alt).toBe('Văn phòng: 3 agent đang làm, 1 agent đang nghỉ')
      const avatars = svgs.filter(svg => String(svg.props.alt).startsWith('Chân dung'))
      expect(avatars.length).toBe(4)
      expect(avatars.every(svg => svg.props.isInteractive === undefined)).toBe(true)
      const bars = svgs.filter(svg => String(svg.props.alt).startsWith('Đang xử lý'))
      expect(bars.length).toBe(1)
      expect(bars[0]?.props.width).toBe(240)
      expect(bars[0]?.props.height).toBe(4)
      expect((await ui.findAll({ type: 'Box' })).filter(box => box.props.marginTop === 1).length).toBe(1)
      expect(String(bars[0]?.props.source).includes('<animate ')).toBe(true)
      expect(svgs.every(svg => !String(svg.props.source).includes('%'))).toBe(true)
      expect((await ui.find({ type: 'Text', text: '≈$0.01' }))?.text).toBe('≈$0.01')
      expect(await ui.find({ key: 'view:running' })).toBeDefined()
      expect(await ui.find({ key: 'view:idle' })).toBeDefined()
    }
    await ui.unmount()
  }
})

test('lưu model spawn và chi phí đo thực tế, card không suy đoán phần trăm tiến độ', async ($, on) => {
  const { clock, snapshot } = setup(on)
  on('agent.spawn', () => ({ model: 'claude-sonnet-test', agentId: 'child' }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  await start($)
  await clock.settle()
  await $.agent.spawn(spawn('Người khảo sát'))
  await $.session.measure({ context: { window: 100, percent: 20 }, rateLimits: [], cost: { usd: 1.234 }, changed: ['cost'] })
  expect(snapshot().agents.find(agent => agent.id === 'child')?.model).toBe('claude-sonnet-test')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Agent con Claude.*claude-sonnet-test/ }))?.text)
    .toBe('Agent con Claude · Người khảo sát · claude-sonnet-test · ● Đang chạy')
  expect((await ui.find({ type: 'Text', text: '≈$1.23' }))?.text).toBe('≈$1.23')
  const card = await ui.find({ key: 'card:child' })
  expect(card?.text.includes('%')).toBe(false)
  expect(card?.text.includes('Khảo sát mã nguồn')).toBe(true)
  await ui.unmount()
})

test('poll chỉ đổi SVG tại ranh giới tương tác, tick và rời sân khấu', async ($, on) => {
  const agents: AgentInfo[] = [{ id: 'child', name: 'Người làm', type: 'Explore', description: 'Kiểm tra', status: 'running' }]
  const { clock, snapshot } = setup(on, { agents })
  on('session.send', () => ({ isDelivered: true }))
  await start($)
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await $.session.send({ to: 'child', text: 'Kiểm tra tiếp', origin: { kind: 'model' } })
  const active = (await ui.find({ type: 'Svg' }))?.props.source
  await clock.advance(3000)
  expect((await ui.find({ type: 'Svg' }))?.props.source).toBe(active)
  await clock.advance(9000)
  const expired = (await ui.find({ type: 'Svg' }))?.props.source
  expect(expired === active).toBe(false)
  expect(String(expired).includes('<animateMotion')).toBe(false)
  agents[0]!.status = 'completed'
  await clock.advance(3000)
  const done = (await ui.find({ type: 'Svg' }))?.props.source
  expect(String(done).includes('>✓</text>')).toBe(true)
  const seat = snapshot().officeSeats?.child
  await clock.advance(4000)
  const settledDone = (await ui.find({ type: 'Svg' }))?.props.source
  await clock.advance(53000)
  expect((await ui.find({ type: 'Svg' }))?.props.source).toBe(settledDone)
  expect(snapshot().officeSeats?.child).toEqual(seat)
  await clock.advance(3000)
  expect(String((await ui.find({ type: 'Svg' }))?.props.source).includes('>✓</text>')).toBe(false)
  await clock.advance(240000)
  expect(snapshot().officeSeats?.child).toBe(undefined)
  expect((await ui.find({ type: 'Svg' }))?.props.source).toBe(renderOfficeSvg(buildScene(snapshot(), NOW + 315000), FULL_VIEW, officeFrame(FULL_VIEW)))
  await ui.unmount()
})

test('session.measure cập nhật phần trăm còn lại và cảnh báo theo limit còn lại', async ($, on) => {
  const { clock } = setup(on)
  on('session.measure', (_, e) => ({ changed: e.changed }))
  await start($)
  await clock.settle()
  const result = await $.session.measure({
    context: { window: 100, percent: 85 }, changed: ['rateLimits', 'context'],
    rateLimits: [
      { kind: 'five_hour', percentUsed: 81, resetsAt: '2026-11-09T06:47:00Z' },
      { kind: 'seven_day', percentUsed: 96 },
      { kind: 'seven_day_sonnet', percentUsed: 30 },
    ],
  })
  expect(result).toEqual({ changed: ['rateLimits', 'context'] })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /5 giờ/ }))?.text)
      .toBe('5 giờ [██░░░░░░░░] 19% còn lại · còn 3h 47m')
    expect((await ui.find({ type: 'Text', text: /^Tuần \[/ }))?.text)
      .toBe('Tuần [░░░░░░░░░░] 4% còn lại · Chưa rõ giờ reset')
    expect((await ui.find({ type: 'Text', text: /Tuần · sonnet/ }))?.text)
      .toBe('Tuần · sonnet [███████░░░] 70% còn lại · Chưa rõ giờ reset')
    await ui.unmount()
  }
})

test('observer giữ nguyên input và kết quả tool, turn, spawn, send', async ($, on) => {
  setup(on)
  const toolResult = { result: {}, text: 'Giữ nguyên', isError: true }
  const turnResult = { text: 'Nguyên văn câu trả lời' }
  const spawnResult = { model: 'test-model', agentId: 'a1' }
  const sendResult = { isDelivered: false as const, reason: 'Chưa nhận được' }
  const spawnInput = spawn()
  const message = 'Thông điệp nguyên văn'
  on('tool.call', (_, e) => {
    expect(e.tool).toBe('Edit')
    if (e.tool === 'Edit') {
      expect(e.file_path).toBe('/foo.ts')
      expect(e.old_string).toBe('a')
      expect(e.new_string).toBe('b')
    }
    expect(e.agentId).toBe('a1')
    return toolResult
  })
  on('turn.complete', (_, e) => {
    expect(e.answer).toBe('Câu trả lời')
    expect(e.agentId).toBe('a1')
    return turnResult
  })
  on('agent.spawn', (_, e) => { expect(e).toEqual(spawnInput); return spawnResult })
  on('session.send', (_, e) => { expect(e.text).toBe(message); expect(e.to).toBe('a1'); return sendResult })
  await start($)
  expect(await $.agent.spawn(spawnInput)).toEqual(spawnResult)
  expect(await $.tool.call({ tool: 'Edit', file_path: '/foo.ts', old_string: 'a', new_string: 'b', agentId: 'a1' })).toEqual(toolResult)
  expect(await $.turn.complete({ answer: 'Câu trả lời', durationMs: 5, isAborted: false, turnId: 't1', agentId: 'a1', reason: 'answer' })).toEqual(turnResult)
  expect(await $.session.send({ to: 'a1', text: message, origin: { kind: 'model' } })).toEqual(sendResult)
})

test('spawn và send xuất hiện mới nhất trước, message lưu tối đa 120 ký tự', async ($, on) => {
  const { snapshot } = setup(on)
  on('agent.spawn', () => ({ model: 'test-model', agentId: 'a1' }))
  on('session.send', () => ({ isDelivered: true }))
  await start($)
  await $.agent.spawn(spawn())
  const message = 'x'.repeat(180)
  await $.session.send({ to: 'a1', text: message, origin: { kind: 'model' } })
  const held = snapshot()
  expect(held.feed.map(item => item.kind)).toEqual(['send', 'spawn'])
  expect(held.feed[0]?.text).toBe('x'.repeat(120))
  expect(held.feed[1]?.from).toBe('@main')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /Claude Code → scout: giao việc/ }))?.text)
      .toBe(`${new Date(NOW).getHours().toString().padStart(2, '0')}:00:00 Claude Code → scout: giao việc Khảo sát mã nguồn`)
    expect((await ui.find({ type: 'Text', text: /Claude Code → scout: x/ }))?.text?.endsWith('x'.repeat(120))).toBe(true)
    await ui.unmount()
  }
  for (let i = 0; i < 55; i++) await $.session.send({ to: 'a1', text: `Tin ${i}`, origin: { kind: 'model' }, agentId: 'a1' })
  expect(snapshot().feed.length).toBe(50)
  expect(snapshot().feed[0]?.text).toBe('Tin 54')
})

test('token và công cụ được gán theo agentId; công cụ lỗi được dọn sạch', async ($, on) => {
  const { snapshot } = setup(on)
  let during: MonitorState | undefined
  on('tool.call', async () => {
    during = snapshot()
    return { result: {}, isError: true, text: 'Công cụ gặp lỗi' }
  })
  on('turn.complete', (_, e) => ({ text: e.answer, usage: e.usage }))
  await start($)
  await $.tool.call({ tool: 'Edit', file_path: '/foo.ts', old_string: 'a', new_string: 'b', agentId: 'a1' })
  expect(during?.agents.find(row => row.id === 'a1')?.active.map(call => call.text)).toEqual(['Sửa /foo.ts'])
  expect(snapshot().agents.find(row => row.id === 'a1')?.active).toEqual([])
  const usage = { model: 'test-model', input_tokens: 10000, output_tokens: 300, cache_creation_input_tokens: 2000, cache_read_input_tokens: 90000 }
  const turn = { answer: 'Xong', durationMs: 5, isAborted: false, turnId: 't1', agentId: 'a1', reason: 'answer' as const, usage }
  await $.turn.complete(turn)
  await $.turn.complete(turn)
  const held = snapshot()
  expect(held.agents.find(row => row.id === 'a1')?.tokens).toBe(12300)
  expect(held.agents.find(row => row.id === 'a1')?.tools).toBe(1)
  expect(held.agents.find(row => row.id === '@main')?.tokens).toBe(0)
  await $.tool.call({ tool: 'Bash', command: 'echo ok' })
  expect(snapshot().agents.find(row => row.id === '@main')?.tools).toBe(1)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /12.3k token/ }))?.text?.includes('Không có công cụ đang chạy')).toBe(true)
  await ui.unmount()
})

test('poll phát hiện hoàn tất và lồng agent theo parent; nút xem xử lý deny', async ($, on) => {
  const agents: AgentInfo[] = [
    { id: 'a1', name: 'scout', type: 'Explore', description: 'Khảo sát', status: 'running' },
    { id: 'a2', parentId: 'a1', name: 'helper', type: 'Explore', description: 'Hỗ trợ', status: 'running' },
  ]
  const { clock, snapshot } = setup(on, { agents })
  let viewed: string | undefined
  let toast = ''
  on('ui.view', (_, e) => { viewed = e.agentId; return { value: { deny: 'Không xem được' } } })
  on('ui.toast', (_, e) => { toast = e.text; return { value: undefined } })
  await start($)
  await clock.settle()
  expect(snapshot().agents.find(row => row.id === 'a2')?.parentId).toBe('a1')
  agents[0]!.status = 'completed'
  agents[1]!.status = 'failed'
  await clock.advance(3000)
  expect(snapshot().feed.map(item => item.kind)).toEqual(['finish', 'finish'])
  await clock.advance(3000)
  expect(snapshot().feed.length).toBe(2)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, view: { agentId: 'a1' } } })
  await ui.press({ key: 'view:a2' })
  expect(viewed).toBe('a2')
  expect(toast).toBe('Không thể chuyển góc xem: Không xem được')
  await ui.press({ key: 'main' })
  expect(viewed).toBe(undefined)
  await ui.unmount()
})

test('poll rảnh không ghi atom và dữ liệu usage có cadence 15 giây', async ($, on) => {
  let writes = 0
  let usageCalls = 0
  let agentCalls = 0
  const { clock } = setup(on, {
    onUsage: () => { usageCalls++ }, onAgents: () => { agentCalls++ }, onWrite: () => { writes++ },
  })
  await start($)
  await clock.settle()
  await clock.advance(4000) // Bong bóng chào hết hạn; từ đây poll rảnh không ghi atom.
  const initialWrites = writes
  await clock.advance(15000)
  expect(writes).toBe(initialWrites)
  expect(usageCalls).toBe(2)
  expect(agentCalls).toBe(7)
})

test('usage poll cũ không ghi đè session.measure mới hơn', async ($, on) => {
  const { clock, snapshot } = setup(on, { usageDelay: 1000 })
  on('session.measure', (_, e) => ({ changed: e.changed }))
  await start($)
  await clock.settle()
  await $.session.measure({
    context: { window: 100, percent: 90 }, changed: ['rateLimits', 'context'],
    rateLimits: [{ kind: 'five_hour', percentUsed: 95 }],
  })
  await clock.advance(1000)
  expect(snapshot().contextRemaining).toBe(10)
  expect(snapshot().limits[0]?.percentUsed).toBe(95)
})

test('agent poll cũ không dọn công cụ vừa bắt đầu', async ($, on) => {
  const { clock, snapshot } = setup(on, {
    agentDelay: 1000,
    agents: [{ id: 'a1', type: 'Explore', description: 'Khảo sát', status: 'idle' }],
  })
  on('tool.call', async () => {
    await clock.sleep(2000)
    return { result: {}, isError: true, text: 'Lỗi công cụ' }
  })
  await start($)
  await clock.settle()
  const call = $.tool.call({ tool: 'Bash', command: 'echo ok', agentId: 'a1' })
  await clock.settle()
  await clock.advance(1000)
  expect(snapshot().agents.find(row => row.id === 'a1')?.active.length).toBe(1)
  await clock.advance(1000)
  await call
  expect(snapshot().agents.find(row => row.id === 'a1')?.active.length).toBe(0)
})

function codexLine(type: string, payload: unknown, at = NOW): string {
  return JSON.stringify({ timestamp: new Date(at).toISOString(), type, payload })
}

function codexLimits(used = 14, at = NOW) {
  return {
    limit_id: 'codex', primary: { used_percent: used, window_minutes: 300, resets_at: at / 1000 + 3600 },
    secondary: { used_percent: 61, window_minutes: 10080, resets_at: at / 1000 + 86400 },
    plan_type: 'plus', rate_limit_reached_type: null,
  }
}

type RolloutFile = { name: string; text: string; mtime: number; day?: string; size?: number }

function codexFixture(home: string, files: RolloutFile[]) {
  const lists: string[] = []
  const reads: string[] = []
  const stats: string[] = []
  const processes: { argv: readonly string[]; timeoutMs?: number }[] = []
  const directories = new Map<string, FsEntry[]>()
  const byPath = new Map<string, RolloutFile>()
  const sessions = `${home}/sessions`
  directories.set(sessions, [])
  const directoryEntry = (name: string): FsEntry => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })
  for (const file of files) {
    let path = sessions
    for (const name of (file.day ?? '2026/11/09').split('/')) {
      if (!directories.get(path)!.some(entry => entry.name === name)) directories.get(path)!.push(directoryEntry(name))
      path += `/${name}`
      if (!directories.has(path)) directories.set(path, [])
    }
    directories.get(path)!.push({ name: file.name, kind: 'file', size: file.size ?? file.text.length, mtimeMs: file.mtime, isLink: false })
    byPath.set(`${path}/${file.name}`, file)
  }
  // Mọi tầng đều chứa mồi ngoài allow-list; không được list/read chúng.
  for (const entries of directories.values()) {
    for (const name of ['auth.json', 'config.toml', 'notes.txt', 'private.jsonl', 'rollout-other.txt', 'rollout-../../auth.jsonl']) {
      entries.push({ name, kind: 'file', size: 1, mtimeMs: NOW + 1, isLink: false })
    }
    entries.push({ name: 'rollout-link.jsonl', kind: 'file', size: 1, mtimeMs: NOW + 1, isLink: true })
    entries.push({ name: '2024', kind: 'dir', size: 0, mtimeMs: 0, isLink: true })
  }
  const api = {
    env: { get: async () => undefined },
    process: {
      run: async (argv: readonly string[], init?: { timeoutMs?: number }) => {
        processes.push({ argv: [...argv], timeoutMs: init?.timeoutMs })
        const entry = [...byPath].find(([path]) => argv[argv.length - 1] === path
          || (argv[0] === 'powershell.exe' && argv[4].includes(`::Open('${path.replace(/'/g, "''")}',`)))
        expect(entry !== undefined).toBe(true)
        expect(stats.includes(entry![0])).toBe(true)
        const chunks = entry![1].text.split('\nCUT\n')
        const stdout = argv[0] === 'head' ? chunks[0] : argv[0] === 'tail' ? chunks[1] ?? '' : chunks.join('\n')
        return { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
      },
    },
    fs: {
      list: async (path?: string) => {
        lists.push(path ?? '')
        expect(path === sessions || path?.startsWith(`${sessions}/`)).toBe(true)
        expect(directories.has(path!)).toBe(true)
        return directories.get(path!)!
      },
      stat: async (path: string, options?: { resolve: boolean }) => {
        stats.push(path)
        expect(options?.resolve).toBe(true)
        const file = byPath.get(path)
        return {
          kind: file ? 'file' as const : 'dir' as const, size: file ? file.size ?? file.text.length : 0,
          mtimeMs: file?.mtime ?? 0, isLink: false, realPath: path,
        }
      },
      read: async (path: string) => {
        reads.push(path)
        expect(/^rollout-[^\\/:]+\.jsonl$/.test(path.split('/').pop()!)).toBe(true)
        expect(byPath.has(path)).toBe(true)
        return byPath.get(path)!.text
      },
    },
  } as unknown as CoreEngineInterface
  return { api, lists, reads, stats, processes, directories, byPath }
}

test('rollout bỏ dòng rác và shape lạ, chỉ giữ trường allow-list', () => {
  const secret = 'PRIVATE_MESSAGE_REASONING_ARGUMENT_OUTPUT'
  const text = [
    'garbage', 'null', '[]', '{}', '{"payload":', JSON.stringify({ timestamp: 'bad', type: 'session_meta', payload: { cwd: secret } }),
    codexLine('session_meta', { cwd: 'C:\\work\\game\\', instructions: secret }, NOW - 180000),
    codexLine('event_msg', { type: 'task_started', message: secret }, NOW - 120000),
    codexLine('response_item', { type: 'custom_tool_call', name: 'apply_patch', input: secret }, NOW - 90000),
    codexLine('response_item', { type: 'function_call', name: 'exec_command', arguments: secret }, NOW - 60000),
    codexLine('response_item', { type: 'message', content: secret }),
    codexLine('response_item', { type: 'reasoning', text: secret }),
    codexLine('response_item', { type: 'function_call_output', output: secret }),
    codexLine('event_msg', {
      type: 'token_count', rate_limits: { ...codexLimits(), unknown: secret },
      info: { total_token_usage: { total_tokens: 12345 }, messages: secret },
    }, NOW - 1000),
    codexLine('event_msg', { type: 'token_count', rate_limits: codexLimits(99), info: { total_token_usage: { total_tokens: 1 } } }, NOW - 2000),
    codexLine('event_msg', { type: 'item_completed', text: secret }),
    codexLine('event_msg', { type: 'task_complete', message: secret }), '{',
  ].join('\n')
  const summary = parseCodexRollout(text + '\n' + codexLine('event_msg', { type: 'token_count', rate_limits: { limit_id: 'codex', primary: 'shape lạ' } }))
  expect(summary.folder).toBe('game')
  expect(summary.firstAt).toBe(NOW - 180000)
  expect(summary.lastAt).toBe(NOW)
  expect(summary.task).toBe('complete')
  expect(summary.lastTool).toBe('exec_command')
  expect(summary.tools).toBe(2)
  expect(summary.tokens).toBe(12345)
  expect(summary.limits?.primary?.usedPercent).toBe(14)
  expect(summary.limits?.plan).toBe('plus')
  expect(JSON.stringify(summary).includes(secret)).toBe(false)
  expect(JSON.stringify(summary).includes('arguments')).toBe(false)
  expect(parseCodexRollout(codexLine('event_msg', { type: 'token_count', rate_limits: [] })).limits).toBe(null)
  expect(parseCodexRollout(codexLine('event_msg', { type: 'token_count' })).tokens).toBe(null)
})

test('limit Codex tính phần trăm còn lại, nhãn cửa sổ và ẩn phần trăm sau reset', () => {
  const window = { usedPercent: 14, windowMinutes: 300, resetsAt: NOW / 1000 + 60 }
  expect(codexWindowText(window, NOW)).toBe('5 giờ [█████████░] 86% còn lại · còn 0h 1m')
  expect(codexWindowText({ ...window, windowMinutes: 10080, usedPercent: 61 }, NOW))
    .toBe('Tuần [████░░░░░░] 39% còn lại · còn 0h 1m')
  expect(codexWindowText({ ...window, windowMinutes: 120 }, NOW).startsWith('2 giờ')).toBe(true)
  expect(codexWindowText({ ...window, resetsAt: NOW / 1000 }, NOW))
    .toBe('5 giờ · đã reset, chờ lần gọi Codex tiếp theo')
  expect(codexWindowText({ ...window, resetsAt: NOW / 1000 - 1 }, NOW).includes('%')).toBe(false)
})

test('Codex phân biệt đang chạy, dừng và hoàn tất bằng task cuối cùng và mtime', () => {
  const started = parseCodexRollout(codexLine('event_msg', { type: 'task_started' }))
  expect(codexStatus(started, NOW - 120000, NOW)).toBe('running')
  expect(codexStatus(started, NOW - 120001, NOW)).toBe('stopped')
  const finished = parseCodexRollout([
    codexLine('event_msg', { type: 'task_started' }, NOW - 1000),
    codexLine('event_msg', { type: 'task_complete' }),
  ].join('\n'))
  expect(codexStatus(finished, NOW - 999999, NOW)).toBe('completed')
  expect(codexStatus(parseCodexRollout(''), NOW, NOW)).toBe('stopped')
  const resumed = parseCodexRollout([
    codexLine('event_msg', { type: 'task_complete' }, NOW - 1000),
    codexLine('event_msg', { type: 'task_started' }),
  ].join('\n'))
  expect(codexStatus(resumed, NOW, NOW)).toBe('running')
})

test('Codex chỉ list sessions và đọc rollout, cache theo size/mtime, không giữ dữ liệu nhạy cảm', async () => {
  const secret = 'CODEX_SECRET_MUST_NOT_ENTER_STATE'
  const file: RolloutFile = {
    name: 'rollout-cache.jsonl', mtime: NOW,
    text: [
      codexLine('session_meta', { cwd: '/work/secure-game', message: secret }),
      codexLine('event_msg', { type: 'task_started', text: secret }),
      codexLine('response_item', { type: 'function_call', name: 'exec_command', arguments: secret }),
      codexLine('response_item', { type: 'message', content: secret.repeat(25000) }),
      codexLine('event_msg', { type: 'token_count', rate_limits: codexLimits() }),
    ].join('\n'),
  }
  const fixture = codexFixture('/codex-cache-test', [file])
  const first = await readCodex(fixture.api, '/codex-cache-test', NOW)
  expect(first?.runs[0]?.folder).toBe('secure-game')
  expect(first?.runs[0]?.status).toBe('running')
  expect(JSON.stringify(first).includes(secret)).toBe(false)
  expect(fixture.reads).toEqual(['/codex-cache-test/sessions/2026/11/09/rollout-cache.jsonl'])
  expect(await readCodex(fixture.api, '/codex-cache-test', NOW + 15000)).toEqual(first)
  expect(fixture.reads.length).toBe(1)
  expect((await readCodex(fixture.api, '/codex-cache-test', NOW + 120001))?.runs[0]?.status).toBe('stopped')
  expect(fixture.reads.length).toBe(1)
  file.mtime++
  await readCodex(fixture.api, '/codex-cache-test', NOW)
  expect(fixture.reads.length).toBe(2)
  file.text += '\n' + codexLine('event_msg', { type: 'task_complete' })
  expect((await readCodex(fixture.api, '/codex-cache-test', NOW))?.runs[0]?.status).toBe('completed')
  expect(fixture.reads.length).toBe(3)
  expect(fixture.lists).toEqual(Array.from({ length: 5 }, () => [
    '/codex-cache-test/sessions', '/codex-cache-test/sessions/2026',
    '/codex-cache-test/sessions/2026/11', '/codex-cache-test/sessions/2026/11/09',
  ]).flat())
})

test('Codex giới hạn 4 ngày và 8 rollout mới nhất', async () => {
  const files: RolloutFile[] = []
  for (let index = 0; index < 12; index++) {
    files.push({
      name: `rollout-${String(index).padStart(2, '0')}.jsonl`, mtime: NOW - index * 1000,
      text: [
        codexLine('session_meta', { cwd: `/work/game-${index}` }, NOW - 100000),
        codexLine('event_msg', { type: index === 0 || index === 1 ? 'task_started' : 'task_complete' }, NOW - index * 1000),
        codexLine('event_msg', { type: 'token_count', rate_limits: codexLimits(index) }, NOW - (12 - index) * 1000),
      ].join('\n'),
    })
  }
  for (const day of ['08', '07', '06', '05', '04']) files.push({
    name: `rollout-old-${day}.jsonl`, day: `2026/11/${day}`, mtime: NOW - 86400000 * 2,
    text: codexLine('event_msg', { type: 'task_complete' }, NOW - 86400000 * 2),
  })
  const fixture = codexFixture('/codex-bounds-test', files)
  const result = await readCodex(fixture.api, '/codex-bounds-test', NOW)
  expect(fixture.reads.length).toBe(8)
  expect(fixture.stats.filter(path => path.endsWith('.jsonl')).length).toBe(8)
  expect(fixture.lists.filter(path => /\/\d{4}\/\d{2}\/\d{2}$/.test(path)).length).toBe(4)
  expect(fixture.lists.some(path => /\/(?:05|04)$/.test(path))).toBe(false)
  expect(result?.runs.filter(run => run.status === 'running').length).toBe(2)
  expect(result?.runs.filter(run => run.status === 'completed').length).toBe(6)
  // token_count mới nhất thắng, không dùng mtime để chọn limit.
  expect(result?.limits?.primary?.usedPercent).toBe(7)
})

test('lỗi listing ẩn Codex; lỗi đọc, parse hoặc link từng file không che phiên và limit khác', async () => {
  const file = { name: 'rollout-fail.jsonl', text: codexLine('event_msg', { type: 'task_started' }), mtime: NOW }
  const listing = codexFixture('/codex-fail-list', [file])
  listing.api.fs.list = async () => { throw new Error('list lỗi') }
  expect(await readCodex(listing.api, '/codex-fail-list', NOW)).toBe(null)
  const reading = codexFixture('/codex-fail-read', [file, {
    name: 'rollout-good.jsonl', mtime: NOW - 1,
    text: [codexLine('event_msg', { type: 'task_started' }),
      codexLine('event_msg', { type: 'token_count', rate_limits: codexLimits(23) })].join('\n'),
  }, { name: 'rollout-broken.jsonl', mtime: NOW - 2, text: '{broken' }])
  const read = reading.api.fs.read
  reading.api.fs.read = (async (path: string) => {
    if (path.endsWith(file.name)) throw new Error('read lỗi')
    return read(path)
  }) as CoreEngineInterface['fs']['read']
  const result = await readCodex(reading.api, '/codex-fail-read', NOW)
  expect(result?.runs.map(run => run.id.split('/').pop())).toEqual(['rollout-good.jsonl'])
  expect(result?.limits?.primary?.usedPercent).toBe(23)
  expect(reading.processes).toEqual([])
  const alias = codexFixture('/codex-alias-test', [file])
  const stat = alias.api.fs.stat
  alias.api.fs.stat = async (path, options) => ({
    ...await stat(path, options), ...(path.endsWith('.jsonl') ? { realPath: '/private/auth.json' } : {}),
  })
  expect(await readCodex(alias.api, '/codex-alias-test', NOW)).toEqual({ limits: null, runs: [] })
  expect(alias.reads).toEqual([])
  expect(await readCodex(alias.api, '//server/share', NOW)).toBe(null)
  expect(await readCodex(alias.api, '/codex/../private', NOW)).toBe(null)
})

function mockCodexFiles(on: On, fixture: ReturnType<typeof codexFixture>, withProcess = false): void {
  on('fs.list', async (_, e) => ({ value: await fixture.api.fs.list(e.path?.replace(/\\/g, '/')) }))
  on('fs.stat', async (_, e) => ({ value: await fixture.api.fs.stat(e.path.replace(/\\/g, '/'), { resolve: e.resolve ?? false }) }))
  on('fs.read', async (_, e) => ({ value: await fixture.api.fs.read(e.path.replace(/\\/g, '/')) }))
  if (withProcess) on('process.run', async (_, e) => ({ value: await fixture.api.process.run(e.argv, e.init) }))
}

test('argv Windows giữ UTF-8, shared read, đúng head/tail và escape dấu nháy đơn trong path', () => {
  const path = "C:/người dùng/O'Brien/sessions/2026/11/09/rollout-run.jsonl"
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)',
    "$stream = [IO.File]::Open('C:/người dùng/O''Brien/sessions/2026/11/09/rollout-run.jsonl', 'Open', 'Read', 'ReadWrite,Delete')",
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
  expect(buildCodexReadArgv(path, true)).toEqual([
    ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script],
  ])
  expect(buildCodexReadArgv("/home/O'Brien/rollout-run.jsonl", false)).toEqual([
    ['head', '-c', '524288', '--', "/home/O'Brien/rollout-run.jsonl"],
    ['tail', '-c', '2097152', '--', "/home/O'Brien/rollout-run.jsonl"],
  ])
})

test('rollout lớn dùng process sau stat, parse head/tail, cache size/mtime và chỉ lưu allow-list', async () => {
  const secret = 'TAIL_MESSAGE_ARGUMENT_SECRET'
  const home = "C:/người dùng/O'Brien/codex-large-test"
  const file = {
    name: "rollout-O'Brien.jsonl", mtime: NOW, size: 9942134,
    text: [
      codexLine('session_meta', { cwd: 'C:/work/Trò chơi', instructions: secret }, NOW - 180000),
      codexLine('event_msg', { type: 'task_started' }, NOW - 120000),
      '{"cut_head":', 'CUT', 'broken_tail"}',
      codexLine('response_item', { type: 'message', content: secret }),
      codexLine('response_item', { type: 'function_call', name: 'exec_command', arguments: secret }),
      codexLine('event_msg', { type: 'token_count', rate_limits: codexLimits(33),
        info: { total_token_usage: { total_tokens: 12345 } }, message: secret }),
      codexLine('event_msg', { type: 'task_complete', message: secret }),
    ].join('\n'),
  }
  const fixture = codexFixture(home, [file, {
    name: 'rollout-small.jsonl', mtime: NOW - 1,
    text: codexLine('event_msg', { type: 'token_count', rate_limits: codexLimits(99) }, NOW - 1000),
  }])
  const result = await readCodex(fixture.api, home, NOW)
  const path = `${home}/sessions/2026/11/09/${file.name}`
  expect(fixture.processes).toEqual([{ argv: buildCodexReadArgv(path, true)[0], timeoutMs: 5000 }])
  expect(fixture.reads).toEqual([`${home}/sessions/2026/11/09/rollout-small.jsonl`])
  expect(result?.runs[0]).toEqual({ id: path, folder: 'Trò chơi', status: 'completed',
    lastTool: 'exec_command', tools: 1, partial: true, tokens: 12345, elapsed: '0h 3m', lastAt: NOW,
    startedAt: NOW - 180000, cwd: 'c:/work/trò chơi' })
  expect(result?.limits?.primary?.usedPercent).toBe(33)
  expect(JSON.stringify(result).includes(secret)).toBe(false)
  expect(JSON.stringify(result).includes('arguments')).toBe(false)
  expect(fixture.stats.some(path => /auth\.json|config\.toml/.test(path))).toBe(false)
  expect(await readCodex(fixture.api, home, NOW + 15000)).toEqual(result)
  expect(fixture.processes.length).toBe(1)
  file.size++
  await readCodex(fixture.api, home, NOW)
  expect(fixture.processes.length).toBe(2)
  file.mtime++
  await readCodex(fixture.api, home, NOW)
  expect(fixture.processes.length).toBe(3)
})

test('Unix đọc head/tail bằng argv, margin tránh fs.read gần giới hạn 4 MiB', async () => {
  const home = '/codex-large-unix-test'
  const fixture = codexFixture(home, [{
    name: 'rollout-large.jsonl', mtime: NOW, size: 4 * 1024 * 1024 - 1,
    text: [codexLine('session_meta', { cwd: '/work/日本語' }, NOW - 120000),
      'CUT', 'broken tail', codexLine('event_msg', { type: 'task_started' }),
      codexLine('event_msg', { type: 'token_count', rate_limits: codexLimits(19),
        info: { total_token_usage: { total_tokens: 42 } } }),
    ].join('\n'),
  }])
  const result = await readCodex(fixture.api, home, NOW)
  const path = `${home}/sessions/2026/11/09/rollout-large.jsonl`
  expect(fixture.reads).toEqual([])
  expect(fixture.processes).toEqual([
    { argv: ['head', '-c', '524288', '--', path], timeoutMs: 5000 },
    { argv: ['tail', '-c', '2097152', '--', path], timeoutMs: 5000 },
  ])
  expect(result?.runs[0]?.folder).toBe('日本語')
  expect(result?.runs[0]?.status).toBe('running')
  expect(result?.runs[0]?.tokens).toBe(42)
  expect(result?.runs[0]?.partial).toBe(true)
  expect(result?.runs[0]?.elapsed).toBe('0h 2m')
  expect(result?.limits?.primary?.usedPercent).toBe(19)
})

test('process lỗi, timeout, stdout bị cắt hoặc không parse được vẫn hiện metadata, cache không chạy lại', async () => {
  for (const failure of ['exit', 'throw', 'truncated', 'invalid']) {
    const home = `/codex-process-fail-${failure}`
    const fixture = codexFixture(home, [{ name: 'rollout-large.jsonl', mtime: NOW - 120000, size: 5000000, text: '' }])
    let calls = 0
    fixture.api.process.run = async () => {
      calls++
      if (failure === 'throw') throw new Error('timeout')
      return { exitCode: failure === 'exit' ? 1 : 0, stdout: '{broken', stderr: 'PRIVATE_ERROR',
        isStdoutTruncated: failure === 'truncated', isStderrTruncated: false }
    }
    const result = await readCodex(fixture.api, home, NOW)
    expect(result).toEqual({ limits: null, runs: [{
      id: `${home}/sessions/2026/11/09/rollout-large.jsonl`, folder: '—', status: 'running',
      lastTool: 'Chưa đọc được log', tools: 0, partial: true, tokens: null, elapsed: '<1m', lastAt: NOW - 120000,
    }] })
    const initialCalls = calls
    expect((await readCodex(fixture.api, home, NOW + 1))?.runs[0]?.status).toBe('stopped')
    expect(calls).toBe(initialCalls)
    expect(fixture.reads).toEqual([])
  }
})

test('rollout lớn không chạy process khi checkedStat phát hiện link hoặc realPath khác', async () => {
  const home = 'C:/codex-large-link-test'
  const fixture = codexFixture(home, [{ name: 'rollout-large.jsonl', mtime: NOW, size: 5000000, text: '' }])
  const stat = fixture.api.fs.stat
  fixture.api.fs.stat = async (path, options) => ({
    ...await stat(path, options), ...(path.endsWith('.jsonl') ? { realPath: 'C:/private/auth.json', isLink: true } : {}),
  })
  expect(await readCodex(fixture.api, home, NOW)).toEqual({ limits: null, runs: [] })
  expect(fixture.processes).toEqual([])
  expect(fixture.reads).toEqual([])
})

test('card, title nhân vật và terminal hiển thị số lần gọi partial, không lưu nội dung tail vào atom', async ($, on) => {
  const home = 'C:/codex-partial-ui-test'
  const { clock, snapshot } = setup(on, { env: { CODEX_HOME: home }, launches: [{ id: 'l', at: NOW - 120000 }] })
  const fixture = codexFixture(home, [{
    name: 'rollout-large.jsonl', mtime: NOW, size: 9942134,
    text: [codexLine('session_meta', { cwd: '/work/game' }, NOW - 120000),
      'CUT', codexLine('event_msg', { type: 'task_started', message: 'PRIVATE_TAIL' }),
      codexLine('response_item', { type: 'function_call', name: 'apply_patch', arguments: 'PRIVATE_TAIL' }),
    ].join('\n'),
  }])
  mockCodexFiles(on, fixture, true)
  await start($)
  await clock.settle()
  expect(snapshot().codex?.runs[0]?.partial).toBe(true)
  expect(JSON.stringify(snapshot()).includes('PRIVATE_TAIL')).toBe(false)
  const desktop = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await desktop.find({ type: 'Text', text: /^apply_patch · 1\+ lần gọi/ }))?.text)
    .toBe('apply_patch · 1+ lần gọi · 0h 2m · Chưa rõ token')
  expect(renderOfficeSvg(buildScene(snapshot(), NOW)).includes('1+ lần gọi')).toBe(true)
  await desktop.unmount()
  const terminal = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await terminal.find({ type: 'Text', text: /game · apply_patch · 1\+ lần gọi/ }))?.text?.includes('1+ lần gọi')).toBe(true)
  await terminal.unmount()
  await clock.advance(15000)
  expect(fixture.processes.length).toBe(1)
  expect(fixture.reads).toEqual([])
})

test('poll Codex mỗi 15 giây, ghi atom khi đổi, UI hai tài khoản và reset không hiển thị phần trăm cũ', async ($, on) => {
  let writes = 0
  const home = 'C:/codex-ui-test'
  const { clock, snapshot } = setup(on, { env: { CODEX_HOME: home }, onWrite: () => { writes++ }, launches: [{ id: 'l', at: NOW - 120000 }] })
  const limits = { ...codexLimits(), rate_limit_reached_type: 'primary' }
  limits.primary.resets_at = NOW / 1000 + 20
  const file = {
    name: 'rollout-ui.jsonl', mtime: NOW, text: [
      codexLine('session_meta', { cwd: '/work/game', message: 'PRIVATE_UI_MESSAGE' }, NOW - 120000),
      codexLine('event_msg', { type: 'task_started' }, NOW - 60000),
      codexLine('response_item', { type: 'custom_tool_call', name: 'apply_patch', input: 'PRIVATE_UI_ARGUMENT' }),
      codexLine('event_msg', {
        type: 'token_count', rate_limits: limits, info: { total_token_usage: { total_tokens: 12345 } },
      }),
    ].join('\n'),
  }
  const fixture = codexFixture(home, [file])
  mockCodexFiles(on, fixture)
  await start($)
  await clock.settle()
  await clock.advance(4000) // Bong bóng chào hết hạn; từ đây poll rảnh không ghi atom.
  const initialWrites = writes
  expect(snapshot().codex?.runs[0]?.status).toBe('running')
  expect(JSON.stringify(snapshot()).includes('PRIVATE_UI')).toBe(false)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: 'Codex CLI · plus' }))?.text).toBe('Codex CLI · plus')
  expect((await ui.find({ type: 'Text', text: /86% còn lại/ }))?.text?.startsWith('5 giờ')).toBe(true)
  expect((await ui.find({ type: 'Text', text: 'Đã chạm limit' }))?.text).toBe('Đã chạm limit')
  expect((await ui.find({ type: 'Text', text: /Cập nhật lúc/ }))?.text)
    .toBe(`Cập nhật lúc ${new Date(NOW).getHours().toString().padStart(2, '0')}:00:00 (theo lần gọi Codex gần nhất)`)
  expect((await ui.find({ type: 'Text', text: /^apply_patch · 1 lần gọi/ }))?.text)
    .toBe('apply_patch · 1 lần gọi · 0h 2m · 12.3k token')
  expect((await ui.find({ type: 'Text', text: /Mỗi nhóm là limit riêng/ }))?.text)
    .toBe('Mỗi nhóm là limit riêng của tài khoản đó; các agent con của Claude dùng chung limit Claude.')
  await clock.advance(8000)
  expect(fixture.lists.length).toBe(4)
  await clock.advance(3000)
  expect(fixture.lists.length).toBe(8)
  expect(fixture.reads.length).toBe(1)
  expect(writes).toBe(initialWrites)
  await clock.advance(15000)
  expect(fixture.reads.length).toBe(1)
  expect((await ui.find({ type: 'Text', text: /đã reset, chờ lần gọi Codex tiếp theo/ }))?.text)
    .toBe('5 giờ · đã reset, chờ lần gọi Codex tiếp theo')
  expect(await ui.find({ type: 'Text', text: /86% còn lại/ })).toBe(undefined)
  await ui.unmount()
  fixture.api.fs.list = async () => { throw new Error('Không đọc được') }
  await clock.advance(15000)
  expect(snapshot().codex).toBe(null)
  const empty = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await empty.find({ type: 'Text', text: 'Chưa có dữ liệu limit Codex' }))?.text)
    .toBe('Chưa có dữ liệu limit Codex')
  await empty.unmount()
})

test('fallback chỉ đọc USERPROFILE/.codex/sessions', async ($, on) => {
  const { clock, snapshot } = setup(on, { env: { USERPROFILE: 'C:/profile', OS: 'Windows_NT' }, launches: [{ id: 'l', at: NOW }] })
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  const fixture = codexFixture('C:/profile/.codex', [{
    name: 'rollout-fallback.jsonl', mtime: NOW,
    text: codexLine('event_msg', { type: 'task_complete' }),
  }])
  mockCodexFiles(on, fixture)
  await start($)
  await clock.settle()
  expect(snapshot().codex?.runs[0]?.status).toBe('completed')
  expect(fixture.reads).toEqual(['C:/profile/.codex/sessions/2026/11/09/rollout-fallback.jsonl'])
})

test('feed MCP Codex ghi trước/sau next, giữ nguyên input/result cho cả ba tool', async ($, on) => {
  const { snapshot } = setup(on)
  const prompt = 'p'.repeat(180)
  const reply = { result: { content: [{ type: 'text', text: 'PRIVATE_TOOL_OUTPUT' }], isError: false }, text: 'PRIVATE_TOOL_OUTPUT', context: ['Giữ nguyên'] }
  let before: MonitorState | undefined
  on('tool.call', (_, e) => {
    before = snapshot()
    expect('prompt' in e ? e.prompt : '').toBe(prompt)
    expect('extra' in e ? e.extra : '').toEqual({ retained: true })
    expect(e.agentId).toBe('child')
    expect(before.feed[0]?.from).toBe('@main')
    expect(before.feed[0]?.to).toBe('@codex')
    expect(before.feed[0]?.text).toBe('p'.repeat(120))
    return reply
  })
  await start($)
  for (const tool of ['mcp__codex-cli__ask-codex', 'mcp__codex-cli__batch-codex', 'mcp__codex-cli__brainstorm'] as const) {
    expect(await $.tool.call({ tool, prompt, extra: { retained: true }, agentId: 'child', tool_use_id: tool })).toEqual(reply)
    expect(snapshot().feed[0]?.text).toBe('xong sau <1m')
    expect(snapshot().feed[0]?.from).toBe('@codex')
    expect(snapshot().feed[0]?.to).toBe('@main')
  }
  expect(snapshot().feed.length).toBe(6)
  expect(JSON.stringify(snapshot()).includes('PRIVATE_TOOL_OUTPUT')).toBe(false)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Claude Code → Codex CLI: p/ }))?.text?.endsWith('p'.repeat(120))).toBe(true)
  expect((await ui.find({ type: 'Text', text: /Codex CLI → Claude Code: xong sau/ }))?.text?.endsWith('xong sau <1m')).toBe(true)
  await ui.unmount()
})

test('feed Codex ghi lỗi, timeout MCP và giữ nguyên kết quả', async ($, on) => {
  const { snapshot } = setup(on)
  let response: ToolCallResult = { result: {}, text: 'PRIVATE_FAILURE', isError: true }
  on('tool.call', () => {
    return response
  })
  await start($)
  const input = { tool: 'mcp__codex-cli__ask-codex' as const, prompt: 'Kiểm tra' }
  expect(await $.tool.call(input)).toEqual(response)
  expect(snapshot().feed[0]?.text).toBe('lỗi')
  response = { result: { isError: true, content: [{ type: 'text', text: 'MCP timed out PRIVATE_TIMEOUT' }] }, text: 'Lỗi MCP' }
  expect(await $.tool.call(input)).toEqual(response)
  expect(snapshot().feed[0]?.text).toBe('hết thời gian chờ MCP, Codex có thể vẫn đang chạy')
  response = { result: {}, isError: true, text: 'Timed out' }
  expect(await $.tool.call(input)).toEqual(response)
  expect(snapshot().feed[0]?.text).toBe('hết thời gian chờ MCP, Codex có thể vẫn đang chạy')
  response = { deny: 'PRIVATE_DENY' }
  expect(await $.tool.call(input)).toEqual(response)
  expect(snapshot().feed[0]?.text).toBe('lỗi')
  expect(JSON.stringify(snapshot()).includes('PRIVATE_')).toBe(false)
})


test('observer Codex ghi lỗi và rethrow cùng object khi next reject', async () => {
  type Observer = ($: CoreEngineInterface, e: ToolCallInput, next: (e: ToolCallInput) => Promise<ToolCallResult>) => Promise<ToolCallResult>
  let observer: Observer | undefined
  const capture = ((event: string, handler: unknown) => {
    if (event === 'tool.call') observer = handler as Observer
  }) as unknown as On
  register(capture, {} as Parameters<Register>[1])
  let held: { shape: string; value: MonitorState } | undefined
  let version = 0
  const api = {
    clock: { now: async () => NOW },
    state: {
      get: async () => ({ value: held, version }),
      set: async (_: unknown, value: typeof held, options: { ifVersion: number }) => {
        expect(options.ifVersion).toBe(version)
        held = value
        version++
        return { isSet: true }
      },
    },
  } as unknown as CoreEngineInterface
  const input: ToolCallInput = {
    tool: 'mcp__codex-cli__ask-codex', tool_use_id: 'rejection', prompt: 'Kiểm tra',
  }
  const result: ToolCallResult = { result: { retained: true }, text: 'Giữ nguyên', context: ['ngữ cảnh'] }
  expect(await observer!(api, input, async received => {
    expect(received).toBe(input)
    return result
  })).toBe(result)
  for (const failure of [new Error('PRIVATE_REJECTION'), new Error('MCP timed out PRIVATE_REJECTION')]) {
    let caught: unknown
    try {
      await observer!(api, input, async received => {
        expect(received).toBe(input)
        expect(held?.value.feed[0]?.to).toBe('@codex')
        throw failure
      })
    } catch (error) { caught = error }
    expect(caught).toBe(failure)
    expect(held?.value.feed[0]?.text).toBe(failure.message.includes('timed out')
      ? 'hết thời gian chờ MCP, Codex có thể vẫn đang chạy' : 'lỗi')
    expect(held?.value.agents[0]?.active).toEqual([])
    expect(JSON.stringify(held).includes('PRIVATE_REJECTION')).toBe(false)
  }
})

test('card desktop hiển thị limit đúng tài khoản, share token riêng và dòng giải thích dùng chung', async ($, on) => {
  const { clock, snapshot, seed } = setup(on, { agents: [
    { id: 'child', name: 'Agent con', type: 'Explore', description: 'Đọc mã', status: 'running' },
    { id: 'idle', name: 'Agent nghỉ', type: 'Explore', description: 'Đã đọc', status: 'idle' },
  ], limits: [{ kind: 'five_hour', percentUsed: 24 }, { kind: 'seven_day', percentUsed: 4 }] })
  await start($)
  await clock.settle()
  const data = structuredClone(snapshot())
  data.agents.find(agent => agent.id === '@main')!.tokens = 66
  data.agents.find(agent => agent.id === 'child')!.tokens = 34
  data.codex = { limits: { updatedAt: NOW, plan: '', reached: false,
    primary: { windowMinutes: 10080, usedPercent: 94 },
    secondary: { windowMinutes: 300, usedPercent: 60 } },
    runs: [250, 750].map((tokens, i) => ({ id: String(i), folder: 'game',
      status: i ? 'completed' : 'running', lastTool: 'apply_patch', tools: 1, tokens, elapsed: '<1m', lastAt: NOW })) }
  seed(data)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const claudeLine = 'Limit Claude · 5 giờ [████████░░] 76% · Tuần [██████████] 96%'
  const cardTexts = await ui.findAll({ type: 'Text' })
  expect(cardTexts.some(text => text.text.includes('Claude Code · Claude Code'))).toBe(false)
  expect(cardTexts.some(text => text.text.includes('Codex CLI · Codex CLI'))).toBe(false)
  for (const id of ['@main', 'child']) {
    const card = await ui.find({ key: `card:${id}` })
    expect(card?.text.includes(claudeLine)).toBe(true)
    expect(card?.text.includes('Limit Codex')).toBe(false)
  }
  expect((await ui.find({ key: 'card:child' }))?.text.includes('Agent này chiếm 34% token của tài khoản trong các agent đang theo dõi')).toBe(true)
  const line = await ui.find({ type: 'Text', text: /^Limit Codex ·/ })
  expect(line?.text).toBe('Limit Codex · 5 giờ [████░░░░░░] 40% · Tuần [█░░░░░░░░░] 6%')
  expect(line?.props.color).toBe('warning')
  expect((await ui.find({ key: 'card:codex' }))?.text.includes('Agent này chiếm 100% token của tài khoản trong các agent đang theo dõi')).toBe(true)
  expect((await ui.findAll({ type: 'Box' })).filter(box => box.key === 'card:codex').length).toBe(1)
  expect((await ui.find({ key: 'card:codex' }))?.text.includes('apply_patch · 2 lần chạy')).toBe(true)
  expect((await ui.find({ key: 'card:idle' }))?.text.includes(' · 5 giờ 76% · Tuần 96%')).toBe(true)
  const note = await ui.find({ type: 'Text', text: /^Limit tính theo tài khoản:/ })
  expect(note?.text).toBe('Limit tính theo tài khoản: các agent cùng tài khoản dùng chung một hạn mức.')
  expect(note?.props.dimColor).toBe(true)
  const texts = await ui.findAll({ type: 'Text' })
  const heading = texts.findIndex(text => text.text.startsWith('Đang làm ·'))
  expect(texts[heading + 1]?.text).toBe(note?.text)
  expect((await ui.find({ type: 'Text', text: /^5 giờ \[/ }))?.text)
    .toBe('5 giờ [████████░░] 76% còn lại · Chưa rõ giờ reset')
  await ui.unmount()
  for (const run of data.codex.runs) run.status = 'completed'
  seed(data)
  const resting = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await resting.findAll({ type: 'Box' })).filter(box => box.key === 'card:codex').length).toBe(1)
  expect((await resting.find({ key: 'card:codex' }))?.text.includes(' · 5 giờ 40% · Tuần 6%')).toBe(true)
  await resting.unmount()
})

test('card màu đúng ngưỡng 20/5 và ẩn phần trăm Codex hết hạn, không rõ không bịa quota', async ($, on) => {
  const { clock, snapshot, seed } = setup(on)
  await start($)
  await clock.settle()
  const data = structuredClone(snapshot())
  data.codex = { limits: { updatedAt: NOW, plan: '', reached: false,
    primary: { windowMinutes: 300, usedPercent: 80, resetsAt: NOW / 1000 + 60 }, secondary: null },
    runs: ['running', 'stopped'].map((status, i) => ({ id: String(i), folder: 'game',
      status: status as 'running' | 'stopped', lastTool: '', tools: 0, tokens: null, elapsed: '<1m', lastAt: NOW })) }
  for (const [left, color] of [[20, undefined], [19, 'warning'], [5, 'warning'], [4, 'error']] as const) {
    data.codex.limits!.primary!.usedPercent = 100 - left
    seed(structuredClone(data))
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const line = await ui.find({ type: 'Text', text: /^Limit Codex ·/ })
    expect(line?.props.color).toBe(color)
    expect(line?.text).toBe(`Limit Codex · 5 giờ [${'█'.repeat(Math.round(left / 10))}${'░'.repeat(10 - Math.round(left / 10))}] ${left}% · Tuần chưa rõ`)
    await ui.unmount()
    for (const run of data.codex.runs) run.status = 'stopped'
    seed(structuredClone(data))
    const resting = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const compact = (await resting.findAll({ type: 'Text' })).find(item => item.text === ` · 5 giờ ${left}% · Tuần chưa rõ`)
    expect(compact?.text).toBe(` · 5 giờ ${left}% · Tuần chưa rõ`)
    expect(compact?.props.color).toBe(color)
    await resting.unmount()
    data.codex.runs[0]!.status = 'running'
  }
  for (const expired of [false, true]) {
    data.codex.limits!.primary = { windowMinutes: 300, usedPercent: 14, expired,
      resetsAt: NOW / 1000 + (expired ? 3600 : 0) }
    seed(structuredClone(data))
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const card = await ui.find({ key: 'card:codex' })
    expect(card?.text.includes('Limit Codex · 5 giờ chưa rõ · Tuần chưa rõ')).toBe(true)
    expect(card?.text.includes('86%')).toBe(false)
    expect(card?.text.includes('Agent này chiếm')).toBe(false)
    expect((await ui.find({ type: 'Text', text: /^Limit Codex ·/ }))?.props.color).toBe(undefined)
    expect((await ui.find({ key: 'card:@main' }))?.text.includes('Limit Claude · 5 giờ chưa rõ · Tuần chưa rõ')).toBe(true)
    await ui.unmount()
    for (const run of data.codex.runs) run.status = 'stopped'
    seed(structuredClone(data))
    const resting = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect((await resting.find({ key: 'card:codex' }))?.text.includes(' · 5 giờ chưa rõ · Tuần chưa rõ')).toBe(true)
    await resting.unmount()
    data.codex.runs[0]!.status = 'running'
  }
})

test('terminal giữ nguyên toàn bộ các dòng chữ, không thêm limit/share của card', async ($, on) => {
  const { clock } = setup(on, { limits: [
    { kind: 'five_hour', percentUsed: 24 }, { kind: 'seven_day', percentUsed: 4 },
  ] })
  await start($)
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.findAll({ type: 'Text' })).map(item => item.text)).toEqual([
    'Limit còn lại', 'Claude Code',
    '5 giờ [████████░░] 76% còn lại · Chưa rõ giờ reset',
    'Tuần [██████████] 96% còn lại · Chưa rõ giờ reset',
    'Context phiên này: 70% còn lại', 'Codex CLI', 'Chưa có dữ liệu limit Codex',
    'Mỗi nhóm là limit riêng của tài khoản đó; các agent con của Claude dùng chung limit Claude.',
    'Các agent', '○ Rảnh · Claude Code · ',
    'Không có công cụ đang chạy · 0 lần gọi · <1m · 0 token',
    'Codex CLI', 'Chưa có lần gọi Codex trong phiên này', 'Task ngầm · 0', 'Không có task ngầm', 'Tương tác', 'Chưa có tương tác.',
  ])
  expect((await ui.findAll({ type: 'Svg' })).length).toBe(0)
  await ui.unmount()
})


test('nhận diện đúng lệnh thật chạy codex exec và thư mục làm việc', () => {
  expect(parseCodexCommand("codex exec -i 'C:\\a\\1.png' --sandbox workspace-write -C 'F:\\AI_Agent\\agent-monitor' - < \"$S/task.md\" > \"$S/task.log\" 2>&1; echo \"codex exit: $?\""))
    .toEqual({ cwd: 'f:/ai_agent/agent-monitor' })
  expect(parseCodexCommand("S='/c/x;y'; codex exec --sandbox workspace-write -C \"F:\\Work\\Game\" -")).toEqual({ cwd: 'f:/work/game' })
  expect(parseCodexCommand('codex exec --cd=/work/game hi')).toEqual({ cwd: '/work/game' })
  expect(parseCodexCommand('npx -y codex e hi')).toEqual({})
  expect(parseCodexCommand('& "C:\\tools\\codex.cmd" exec hi')).toEqual({})
  expect(parseCodexCommand('cd /f/Work/Game && codex exec hi')).toEqual({ cwd: 'f:/work/game' })
  expect(parseCodexCommand('codex exec -C "$R" -')).toEqual({})
  expect(parseCodexCommand('FOO=1 codex -m gpt exec hi')).toEqual({})
  for (const text of ['grep codex exec', 'echo "codex exec"', 'cat codex-task.md', 'Get-Process codex',
    'ls C:/tools/codex/exec', 'codex login', 'codex --version', 'rg "codex exec" -n', 'mycodex exec']) {
    expect(parseCodexCommand(text)).toBe(null)
  }
  expect(normalizePath('F:\\AI_Agent\\Game\\')).toBe('f:/ai_agent/game')
  expect(normalizePath('/f/AI_Agent/Game')).toBe('f:/ai_agent/game')
})

function scanned(id: string, startedAt: number | undefined, cwd?: string) {
  return { id, folder: 'x', status: 'running' as const, lastTool: '', tools: 0, tokens: null, elapsed: '<1m', lastAt: NOW, startedAt, cwd }
}

test('ghép lần gọi với rollout theo thời gian và thư mục, không ghép trùng', () => {
  const launch = { id: 'l1', at: NOW, cwd: 'f:/game' }
  expect(claimCodexRuns([scanned('in', NOW + 90000, 'f:/game')], [launch], {})).toEqual({ l1: 'in' })
  expect(claimCodexRuns([scanned('early', NOW - 5000, 'f:/game')], [launch], {})).toEqual({ l1: 'early' })
  expect(claimCodexRuns([scanned('late', NOW + 90001, 'f:/game')], [launch], {})).toEqual({})
  expect(claimCodexRuns([scanned('before', NOW - 5001, 'f:/game')], [launch], {})).toEqual({})
  expect(claimCodexRuns([scanned('other', NOW + 1000, 'f:/other')], [launch], {})).toEqual({})
  expect(claimCodexRuns([scanned('nocwd', NOW + 1000)], [launch], {})).toEqual({ l1: 'nocwd' })
  expect(claimCodexRuns([scanned('free', NOW + 1000, 'f:/any')], [{ id: 'l1', at: NOW }], {})).toEqual({ l1: 'free' })
  expect(claimCodexRuns([scanned('none', undefined, 'f:/game')], [launch], {})).toEqual({})
  expect(claimCodexRuns([scanned('far', NOW + 40000, 'f:/game'), scanned('near', NOW + 2000, 'f:/game')], [launch], {})).toEqual({ l1: 'near' })
  expect(claimCodexRuns([scanned('only', NOW + 1000, 'f:/game')],
    [launch, { id: 'l2', at: NOW + 500, cwd: 'f:/game' }], {})).toEqual({ l1: 'only' })
  expect(claimCodexRuns([scanned('a', NOW + 1000, 'f:/game'), scanned('b', NOW + 1500, 'f:/game')],
    [launch, { id: 'l2', at: NOW + 500, cwd: 'f:/game' }], {})).toEqual({ l1: 'a', l2: 'b' })
  expect(claimCodexRuns([scanned('new', NOW + 1000, 'f:/game')], [launch], { l1: 'kept' })).toEqual({ l1: 'kept' })
  expect(claimCodexRuns([], [launch], { gone: 'x', l1: 'kept' })).toEqual({ l1: 'kept' })
})

function rolloutOf(name: string, cwd: string, at: number, tokens: number, mtime = NOW) {
  return { name, mtime, text: [
    codexLine('session_meta', { cwd, instructions: 'PRIVATE_TEXT' }, at),
    codexLine('event_msg', { type: 'task_started' }, at + 1000),
    codexLine('response_item', { type: 'function_call', name: 'exec', arguments: 'PRIVATE_TEXT' }, at + 2000),
    codexLine('event_msg', { type: 'token_count', rate_limits: codexLimits(14, at + 3000), info: { total_token_usage: { total_tokens: tokens } } }, at + 3000),
  ].join('\n') }
}

test('chỉ hiện Codex do phiên này gọi; phiên khác và limit tài khoản xử lý đúng', async ($, on) => {
  const home = 'C:/codex-scope-test'
  const { clock, snapshot } = setup(on, { env: { CODEX_HOME: home } })
  const fixture = codexFixture(home, [
    rolloutOf('rollout-mine.jsonl', 'F:\\Work\\Game', NOW + 1000, 700),
    rolloutOf('rollout-other.jsonl', 'F:\\Work\\Other', NOW + 1200, 9000),
    rolloutOf('rollout-old.jsonl', 'F:\\Work\\Game', NOW - 600000, 5000),
  ])
  mockCodexFiles(on, fixture)
  on('tool.call', () => ({ result: {}, text: 'ok' }))
  await start($)
  await clock.settle()
  expect(snapshot().codex?.runs).toEqual([])
  expect(snapshot().codex?.limits?.plan).toBe('plus')
  const empty = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await empty.find({ type: 'Text', text: 'Chưa có lần gọi Codex trong phiên này' }))?.text).toBe('Chưa có lần gọi Codex trong phiên này')
  expect((await empty.find({ type: 'Text', text: 'Codex CLI · plus' }))?.text).toBe('Codex CLI · plus')
  expect(await empty.find({ key: 'card:codex' })).toBe(undefined)
  await empty.unmount()
  await $.tool.call({ tool: 'Bash', command: "codex exec -C 'F:\\Work\\Game' hi", agentId: 'child', tool_use_id: 'launch-1' })
  await clock.advance(15000)
  const held = snapshot()
  expect(held.codexLaunches).toEqual([{ id: 'launch-1', at: NOW, cwd: 'f:/work/game' }])
  expect(held.codex?.runs.map(run => run.id)).toEqual(['C:/codex-scope-test/sessions/2026/11/09/rollout-mine.jsonl'])
  expect(held.codex?.runs[0]?.folder).toBe('Game')
  expect(JSON.stringify(held).includes('f:/work/other')).toBe(false)
  expect(JSON.stringify(held.codex).includes('f:/work/game')).toBe(false)
  expect(JSON.stringify(held).includes('PRIVATE_TEXT')).toBe(false)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const tile = await ui.findAll({ type: 'Text' })
  expect(tile[tile.findIndex(text => text.text === 'Token') + 1]?.text).toBe('700')
  expect(await ui.find({ type: 'Text', text: 'Chưa có lần gọi Codex trong phiên này' })).toBe(undefined)
  await ui.unmount()
})

test('launch Bash/PowerShell nền được đánh dấu, MCP và CLI tiền cảnh thì không', async ($, on) => {
  const { snapshot } = setup(on)
  on('tool.call', () => ({ result: {}, text: 'ok' }))
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'codex exec hi', run_in_background: true, tool_use_id: 'bash-bg' })
  await $.tool.call({ tool: 'PowerShell', command: 'codex exec hi', run_in_background: true, tool_use_id: 'ps-bg' })
  await $.tool.call({ tool: 'Bash', command: 'codex exec hi', run_in_background: false, tool_use_id: 'foreground' })
  await $.tool.call({ tool: 'mcp__codex-cli__ask-codex', prompt: 'hi', tool_use_id: 'mcp' })
  expect(snapshot().codexLaunches).toEqual([
    { id: 'bash-bg', at: NOW, background: true }, { id: 'ps-bg', at: NOW, background: true },
    { id: 'foreground', at: NOW }, { id: 'mcp', at: NOW },
  ])
})

test('claim truyền background từ đúng launch sang run và giữ cờ qua poll', async ($, on) => {
  const home = 'C:/codex-background-test'
  const { clock, snapshot } = setup(on, { env: { CODEX_HOME: home } })
  mockCodexFiles(on, codexFixture(home, [
    rolloutOf('rollout-bg.jsonl', '/work/bg', NOW + 1000, 10),
    rolloutOf('rollout-mcp.jsonl', '/work/mcp', NOW + 1200, 20),
  ]))
  on('tool.call', () => ({ result: {}, text: 'ok' }))
  await start($)
  await clock.settle()
  await $.tool.call({ tool: 'Bash', command: 'codex exec -C /work/bg hi', run_in_background: true, tool_use_id: 'bg' })
  await $.tool.call({ tool: 'mcp__codex-cli__ask-codex', prompt: 'hi', cd: '/work/mcp', tool_use_id: 'mcp' })
  await clock.advance(15000)
  const bgId = snapshot().codexClaims!.bg
  const mcpId = snapshot().codexClaims!.mcp
  expect(bgId.endsWith('rollout-bg.jsonl')).toBe(true)
  expect(mcpId.endsWith('rollout-mcp.jsonl')).toBe(true)
  expect(snapshot().codex!.runs.find(run => run.id === bgId)?.background).toBe(true)
  expect(snapshot().codex!.runs.find(run => run.id === mcpId)?.background).toBe(undefined)
  await clock.advance(15000)
  expect(snapshot().codex!.runs.find(run => run.id === bgId)?.background).toBe(true)
  expect(snapshot().codex!.runs.find(run => run.id === mcpId)?.background).toBe(undefined)
})

test('lần gọi MCP được ghi với thư mục; lệnh không phải Codex thì không', async ($, on) => {
  const { snapshot } = setup(on)
  on('tool.call', () => ({ result: {}, text: 'ok' }))
  await start($)
  await $.tool.call({ tool: 'mcp__codex-cli__ask-codex', prompt: 'a', cd: 'F:\\Game', tool_use_id: 'a' })
  await $.tool.call({ tool: 'mcp__codex-cli__batch-codex', prompt: 'b', workingDir: '/f/Game2', tool_use_id: 'b' })
  await $.tool.call({ tool: 'mcp__codex-cli__brainstorm', prompt: 'c', tool_use_id: 'c' })
  await $.tool.call({ tool: 'Bash', command: 'grep codex exec', tool_use_id: 'd' })
  expect(snapshot().codexLaunches?.map(({ id, cwd }) => [id, cwd])).toEqual([['a', 'f:/game'], ['b', 'f:/game2'], ['c', undefined]])
})

test('rollout đã ghép vẫn được đọc khi rơi khỏi 8 file mới nhất và không tạo dữ liệu phiên khác', async () => {
  const home = '/codex-keep-test'
  const files: RolloutFile[] = [rolloutOf('rollout-kept.jsonl', '/work/game', NOW - 900000, 1, NOW - 900000)]
  for (let i = 0; i < 10; i++) files.push(rolloutOf('rollout-n' + i + '.jsonl', '/work/x', NOW - i * 1000, 1, NOW - i * 1000))
  const fixture = codexFixture(home, files)
  const kept = home + '/sessions/2026/11/09/rollout-kept.jsonl'
  const without = await readCodex(fixture.api, home, NOW)
  expect(without?.runs.some(run => run.id === kept)).toBe(false)
  const withKeep = await readCodex(fixture.api, home, NOW, new Set([kept]))
  expect(withKeep?.runs.some(run => run.id === kept)).toBe(true)
  expect(fixture.reads.filter(path => path === kept).length).toBe(1)
})

test('không còn đọc phiên Claude khác hay gọi tasklist', async ($, on) => {
  const { clock } = setup(on, { env: { CLAUDE_CONFIG_DIR: 'C:/config', OS: 'Windows_NT', USERPROFILE: 'C:/p' } })
  const lists: string[] = []
  const processes: string[][] = []
  on('fs.list', (_, e) => { lists.push(String(e.path)); throw new Error('không có') })
  on('fs.stat', () => { throw new Error('không có') })
  on('process.run', (_, e) => { processes.push(e.argv); return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } })
  await start($)
  await clock.settle()
  expect(lists.some(path => path.includes('config'))).toBe(false)
  expect(processes).toEqual([])
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: 'Phiên khác trên máy' })).toBe(undefined)
  await ui.unmount()
})


function bashResult(id: string) { return { result: { stdout: '', stderr: '', backgroundTaskId: id }, text: 'ok' } }

test('lệnh nền, monitor, workflow được theo dõi từ lúc tạo; lệnh thường thì không', async ($, on) => {
  const { snapshot } = setup(on)
  let reply: ToolCallResult = bashResult('b1')
  on('tool.call', () => reply)
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'npm test', description: 'Chạy test', run_in_background: true, tool_use_id: 'u1' })
  reply = { result: { taskId: 'm1', timeoutMs: 0 }, text: 'ok' }
  await $.tool.call({ tool: 'Monitor', command: 'tail -f log', description: 'Theo dõi log', tool_use_id: 'u2' } as unknown as ToolCallInput)
  reply = { result: { status: 'async_launched', taskId: 'w1', workflowName: 'Dựng video' }, text: 'ok' }
  await $.tool.call({ tool: 'Workflow', tool_use_id: 'u3' } as unknown as ToolCallInput)
  reply = { result: { stdout: 'x', stderr: '' }, text: 'ok' }
  await $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: 'u4' })
  reply = { result: { backgroundTaskId: 'bad' }, text: 'lỗi', isError: true }
  await $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: 'u5' })
  const list = snapshot().background!
  expect(list.map(task => [task.taskId, task.kind, task.label, task.status])).toEqual([
    ['b1', 'shell', 'Chạy test', 'running'], ['m1', 'monitor', 'Theo dõi log', 'running'], ['w1', 'workflow', 'Dựng video', 'running'],
  ])
  expect(snapshot().feed[0]?.kind).toBe('background')
  expect(snapshot().feed[0]?.text).toBe('bắt đầu: Dựng video')
})

test('observer task ngầm giữ nguyên input, kết quả và không làm hỏng khi dữ liệu lạ', async ($, on) => {
  setup(on)
  const reply = bashResult('b1')
  on('tool.call', (_, e) => { expect('command' in e ? e.command : '').toBe('npm test'); return reply })
  on('prompt.submit', (_, e) => { expect(e.text).toBe('<task-notification>'); return { text: e.text } })
  await start($)
  expect(await $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: 'u1' })).toEqual(reply)
  await $.prompt.submit({ text: '<task-notification>', origin: { kind: 'task-notification' } } as never)
})

test('thông báo hoàn tất cập nhật đúng task, kể cả tìm theo tool-use-id', async ($, on) => {
  const { snapshot } = setup(on)
  on('tool.call', (_, e) => bashResult(e.tool_use_id === 'u1' ? 'b1' : 'b2'))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'a', tool_use_id: 'u1' })
  await $.tool.call({ tool: 'Bash', command: 'b', tool_use_id: 'u2' })
  const notice = (id: string, use: string, status: string) => '<task-notification>\n<task-id>' + id + '</task-id>\n<tool-use-id>' + use + '</tool-use-id>\n<status>' + status + '</status>\n<summary>PRIVATE_SUMMARY</summary>\n</task-notification>'
  await $.prompt.submit({ text: notice('b1', 'x', 'failed'), origin: { kind: 'task-notification' } } as never)
  await $.prompt.submit({ text: notice('zzz', 'u2', 'killed'), origin: { kind: 'task-notification' } } as never)
  const list = snapshot().background!
  expect(list.find(task => task.taskId === 'b1')?.status).toBe('failed')
  expect(list.find(task => task.taskId === 'b2')?.status).toBe('killed')
  expect(JSON.stringify(snapshot()).includes('PRIVATE_SUMMARY')).toBe(false)
  await $.prompt.submit({ text: notice('b1', 'x', 'completed'), origin: { kind: 'composer' } } as never)
  expect(snapshot().background!.find(task => task.taskId === 'b1')?.status).toBe('failed')
  expect(parseTaskNotification('xin chào')).toBe(null)
})

test('đối chiếu cuối lượt: thêm task chưa biết, bỏ subagent, task biến mất là đã xong, lưu lịch', () => {
  const state: MonitorState = { agents: [], limits: [], contextRemaining: null, feed: [], codex: null, background: [
    { id: 'old', taskId: 'old', kind: 'shell', label: 'Cũ', status: 'running', startedAt: NOW - 120000, elapsed: '0h 2m' },
    { id: 'keep', taskId: 'keep', kind: 'shell', label: 'Giữ', status: 'running', startedAt: NOW - 60000, elapsed: '0h 1m' },
  ] }
  reconcileBackground(state, [
    { id: 'keep', type: 'shell', status: 'running', description: 'Giữ' },
    { id: 'mcp1', type: 'MCP task', status: 'running', description: '', tool: 'ask', server: 's' },
    { id: 'wf', type: 'workflow', status: 'pending', description: '', name: 'Dựng' },
    { id: 'agent', type: 'subagent', status: 'running', description: 'Không được hiện', agent_type: 'Explore' } as never,
  ], [{ id: 'c1', schedule: '0 9 * * *', recurring: true, prompt: 'p'.repeat(200) }], NOW)
  expect(state.background!.find(task => task.taskId === 'old')?.status).toBe('done')
  expect(state.background!.find(task => task.taskId === 'old')?.elapsed).toBe('0h 2m')
  expect(state.background!.find(task => task.taskId === 'keep')?.status).toBe('running')
  expect(state.background!.find(task => task.taskId === 'mcp1')?.kind).toBe('mcp')
  expect(state.background!.find(task => task.taskId === 'mcp1')?.label).toBe('ask')
  expect(state.background!.find(task => task.taskId === 'wf')?.label).toBe('Dựng')
  expect(state.background!.some(task => task.taskId === 'agent')).toBe(false)
  expect(state.scheduled).toEqual([{ id: 'c1', schedule: '0 9 * * *', recurring: true, prompt: 'p'.repeat(80) }])
  const untouched = state.background!.map(task => task.status)
  reconcileBackground(state, undefined, undefined, NOW + 1000)
  expect(state.background!.map(task => task.status)).toEqual(untouched)
  reconcileBackground(state, [], [], NOW + 1000)
  expect(state.background!.every(task => task.status !== 'running')).toBe(true)
  expect(state.scheduled).toEqual([])
})

test('classic.Stop cập nhật pane; desktop và terminal đều hiện task ngầm, lịch và trạng thái', async ($, on) => {
  const { clock, snapshot } = setup(on)
  on('classic.Stop', () => ({}))
  on('tool.call', () => bashResult('b1'))
  await start($)
  await clock.settle()
  await $.tool.call({ tool: 'Bash', command: 'npm test', description: 'Chạy test', tool_use_id: 'u1' })
  await clock.advance(120000)
  expect(snapshot().background![0]?.elapsed).toBe('0h 2m')
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [
    { id: 'b1', type: 'shell', status: 'running', description: 'Chạy test' }],
    session_crons: [{ id: 'c1', schedule: '*/5 * * * *', recurring: true, prompt: 'Kiểm tra build' }] })
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: 'Task ngầm · 1' }))?.text).toBe('Task ngầm · 1')
    expect((await ui.find({ type: 'Text', text: /Lệnh nền/ }))?.text).toBe('● Đang chạy · Lệnh nền · Chạy test · 0h 2m')
    expect((await ui.find({ type: 'Text', text: 'Đã lên lịch · 1' }))?.text).toBe('Đã lên lịch · 1')
    expect((await ui.find({ type: 'Text', text: /Lặp lại/ }))?.text).toBe('Lặp lại · */5 * * * * · Kiểm tra build')
    await ui.unmount()
  }
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [], session_crons: [] })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: 'Task ngầm · 0' }))?.text).toBe('Task ngầm · 0')
  const row = await ui.find({ type: 'Text', text: /Lệnh nền/ })
  expect(row?.text).toBe('✓ Đã xong · Lệnh nền · Chạy test · 0h 2m')
  expect(row?.props.dimColor).toBe(true)
  expect(await ui.find({ type: 'Text', text: /^Đã lên lịch/ })).toBe(undefined)
  await ui.unmount()
})

test('giới hạn lịch sử task ngầm và task đã xong quá 10 phút không còn hiện', async ($, on) => {
  const { clock, snapshot } = setup(on)
  let count = 0
  on('classic.Stop', () => ({}))
  on('tool.call', () => bashResult('b' + (++count)))
  await start($)
  await clock.settle()
  for (let i = 0; i < 40; i++) await $.tool.call({ tool: 'Bash', command: 'x', tool_use_id: 'u' + i })
  expect(snapshot().background!.length).toBe(32)
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
  expect(snapshot().background!.length).toBe(8)
  await clock.advance(600000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Lệnh nền/ })).toBe(undefined)
  expect((await ui.find({ type: 'Text', text: 'Không có task ngầm' }))?.text).toBe('Không có task ngầm')
  await ui.unmount()
})


test('nút zoom đổi hình, hiện phần trăm, lưu lại và nút mũi tên chỉ hiện khi phóng to', async ($, on) => {
  const { clock, snapshot } = setup(on)
  const saved: unknown[] = []
  on('store.get', () => ({ value: undefined }))
  on('store.set', (_, e) => { saved.push(e.value); return { value: undefined } })
  await start($)
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: '100%' }))?.text).toBe('100%')
  expect(await ui.find({ key: 'office:left' })).toBe(undefined)
  await ui.press({ key: 'office:in' })
  expect(snapshot().officeView).toEqual({ x: 40, y: 26, w: 240, h: 158 })
  expect(saved).toEqual([{ x: 40, y: 26, w: 240, h: 158 }])
  expect((await ui.find({ type: 'Text', text: '133%' }))?.text).toBe('133%')
  expect((await ui.find({ type: 'Svg', key: undefined as never }))?.props.source.includes('viewBox="40 26 240 158"')).toBe(true)
  await ui.press({ key: 'office:left' })
  expect(snapshot().officeView?.x).toBe(0)
  await ui.press({ key: 'office:lounge' })
  expect(snapshot().officeView).toEqual({ x: 213, y: 40, w: 104, h: 167 })
  await ui.press({ key: 'office:all' })
  expect(snapshot().officeView).toEqual({ x: 0, y: 0, w: 320, h: 210 })
  expect(await ui.find({ key: 'office:right' })).toBe(undefined)
  await ui.unmount()
  const terminal = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await terminal.find({ key: 'office:in' })).toBe(undefined)
  await terminal.unmount()
})

test('kéo desktop snap hai trục, flush 100ms, lưu khi thả và nhận props mới ở lần kéo sau', async ($, on) => {
  const { clock, snapshot } = setup(on)
  const saved: unknown[] = []
  on('store.get', () => ({ value: undefined }))
  on('store.set', (_, e) => { saved.push({ key: e.key, value: e.value }); return { value: undefined } })
  await start($)
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'office-resize', type: 'Client' })).toBeDefined()
  expect(await ui.find({ key: 'office:wider' })).toBe(undefined)
  expect((await ui.find({ type: 'Svg' }))?.props.width).toBe(480)
  expect((await ui.find({ type: 'Svg' }))?.props.height).toBe(315)
  const initialOrder = await ui.findAll({})
  const handleIndex = initialOrder.findIndex(element => element.key === 'office-resize')
  expect(initialOrder[handleIndex + 1]?.type).toBe('Box')
  expect(initialOrder[handleIndex + 2]?.type).toBe('Svg')
  await ui.pointer({ in: 'office-resize', type: 'down', x: 10, y: 1, fine: { x: 10.25, y: 1.25 }, button: 'right' })
  await ui.pointer({ in: 'office-resize', type: 'move', x: 18, y: 3, button: 'right' })
  await ui.advance(100)
  expect(snapshot().officeSize).toBe(undefined)
  await ui.pointer({ in: 'office-resize', type: 'down', x: 10, y: 1, fine: { x: 10.25, y: 1.25 }, button: 'left' })
  await ui.pointer({ in: 'office-resize', type: 'move', x: 18, y: 3, fine: { x: 18.25, y: 3.25 }, button: 'left' })
  expect((await ui.find({ type: 'Text', text: /ngang đổi rộng/, in: 'office-resize' }))?.text.endsWith('544×352')).toBe(true)
  await ui.advance(99)
  expect(snapshot().officeSize).toBe(undefined)
  await ui.advance(1)
  expect(snapshot().officeSize).toEqual({ w: 544, h: 352 })
  expect(saved).toEqual([])
  expect((await ui.find({ type: 'Svg' }))?.props.width).toBe(544)
  expect((await ui.find({ type: 'Svg' }))?.props.height).toBe(352)
  const resizedOrder = await ui.findAll({})
  expect(resizedOrder.findIndex(element => element.key === 'office-resize')).toBe(handleIndex)
  expect(resizedOrder[handleIndex + 2]?.type).toBe('Svg')
  await ui.pointer({ in: 'office-resize', type: 'move', x: 26, y: 5, fine: { x: 26.25, y: 5.25 }, button: 'left' })
  await ui.pointer({ in: 'office-resize', type: 'up', x: 26, y: 5, button: 'left' })
  expect(snapshot().officeSize).toEqual({ w: 608, h: 384 })
  expect(saved).toEqual([{ key: 'officeSize', value: { w: 608, h: 384 } }])
  expect((await ui.find({ type: 'Svg' }))?.props.source.includes('width="608" height="384"')).toBe(true)
  await ui.advance(100)
  expect(saved.length).toBe(1)
  await ui.pointer({ in: 'office-resize', type: 'down', x: 0, y: 0, button: 'left' })
  await ui.pointer({ in: 'office-resize', type: 'move', x: 1, y: 0, button: 'left' })
  await ui.pointer({ in: 'office-resize', type: 'move', x: 2, y: 0 }) // Nhả ngoài vùng, không áp dụng tọa độ hover.
  expect(snapshot().officeSize).toEqual({ w: 616, h: 384 })
  expect(saved.length).toBe(2)
  await ui.pointer({ in: 'office-resize', type: 'move', x: 20, y: 20, button: 'left' })
  await ui.advance(200)
  expect(snapshot().officeSize).toEqual({ w: 616, h: 384 })
  await ui.unmount()
})

test('message không tin cậy không đổi state; chỉ done true mới lưu cỡ đã sanitize', async ($, on) => {
  const { clock, snapshot } = setup(on)
  const saved: unknown[] = []
  on('store.get', () => ({ value: undefined }))
  on('store.set', (_, e) => { saved.push(e.value); return { value: undefined } })
  await start($)
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const before = structuredClone(snapshot())
  for (const data of [null, false, [], 'resize', {}, { type: 'other', w: 640, h: 320 },
    { type: 'resize', w: '640', h: 320 }, { type: 'resize', w: 640 }]) await ui.post(data, { in: 'office-resize' })
  expect(snapshot()).toEqual(before)
  expect(saved).toEqual([])
  await ui.post({ type: 'resize', w: 641, h: 319, done: 'true' }, { in: 'office-resize' })
  expect(snapshot().officeSize).toEqual({ w: 640, h: 320 })
  expect(saved).toEqual([])
  await ui.post({ type: 'resize', w: 5000, h: 0, done: true }, { in: 'office-resize' })
  expect(snapshot().officeSize).toEqual({ w: 1280, h: 105 })
  expect(saved).toEqual([{ w: 1280, h: 105 }])
  await ui.unmount()
})

test('vscode/mobile có nút đổi cỡ, lưu store và Cỡ gốc xóa cỡ đã lưu', async ($, on) => {
  const { clock, snapshot } = setup(on)
  const saved: unknown[] = []
  const deleted: string[] = []
  on('store.get', () => ({ value: undefined }))
  on('store.set', (_, e) => { saved.push({ key: e.key, value: e.value }); return { value: undefined } })
  on('store.delete', (_, e) => { deleted.push(e.key); return { value: undefined } })
  await start($)
  await clock.settle()
  for (const surface of ['vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.findAll({ type: 'Client' })).length).toBe(0)
    expect(await ui.find({ key: 'office:size-reset' })).toBe(undefined)
    for (const [key, label] of [['narrower', 'Hẹp'], ['wider', 'Rộng'], ['shorter', 'Thấp'], ['taller', 'Cao']]) {
      expect((await ui.find({ key: `office:${key}` }))?.props.label).toBe(label)
    }
    await ui.press({ key: 'office:wider' })
    expect(snapshot().officeSize).toEqual({ w: 544, h: 312 })
    await ui.press({ key: 'office:narrower' })
    expect(snapshot().officeSize).toEqual({ w: 480, h: 312 })
    await ui.press({ key: 'office:shorter' })
    expect(snapshot().officeSize).toEqual({ w: 480, h: 272 })
    await ui.press({ key: 'office:taller' })
    expect(snapshot().officeSize).toEqual({ w: 480, h: 312 })
    expect((await ui.find({ type: 'Svg' }))?.props.height).toBe(312)
    await ui.press({ key: 'office:size-reset' })
    expect(snapshot().officeSize).toBe(undefined)
    expect((await ui.find({ type: 'Svg' }))?.props.height).toBe(315)
    expect(await ui.find({ key: 'office:size-reset' })).toBe(undefined)
    await ui.unmount()
  }
  expect(saved.length).toBe(8)
  expect(saved[0]).toEqual({ key: 'officeSize', value: { w: 544, h: 312 } })
  expect(deleted).toEqual(['officeSize', 'officeSize'])
})

test('ui.fault đúng Client chuyển desktop sang nút dự phòng', async ($, on) => {
  const { clock, snapshot, seed } = setup(on)
  // Kit không cung cấp $.ui.fault; gọi hook đã đăng ký với state CAS giả rồi redraw pane.
  type Fault = EngineEventOf['ui.fault']
  type FaultHook = ($: CoreEngineInterface, e: Fault, next: (e: Fault) => Promise<{}>) => Promise<unknown>
  let faultHook: FaultHook | undefined
  register(((event: string, matcher: unknown, handler: unknown) => {
    if (event !== 'ui.fault') return
    expect(matcher).toEqual({ component: 'Pane', requestId: 'agent-monitor' })
    faultHook = handler as FaultHook
  }) as unknown as On, {} as Parameters<Register>[1])
  await start($)
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  let faultState = structuredClone(snapshot())
  let version = 0
  const api = {
    clock: { now: async () => NOW },
    state: {
      get: async () => ({ value: { shape: 'monitor-7', value: faultState }, version }),
      set: async (_: unknown, value: { value: MonitorState }, options: { ifVersion: number }) => {
        expect(options.ifVersion).toBe(version)
        faultState = value.value
        version++
        seed(faultState)
        return { isSet: true }
      },
    },
  } as unknown as CoreEngineInterface
  const dispatchFault = async (element: string) => {
    const fault: Fault = { surface: 'desktop', component: 'Pane', requestId: 'agent-monitor',
      module: 'hooks/office-resize.tsx', phase: 'run', reason: 'module failed', element }
    let continued = false
    expect(await faultHook!(api, fault, async received => {
      expect(received).toBe(fault)
      continued = true
      return {}
    })).toEqual({})
    expect(continued).toBe(true)
    await ui.redraw()
  }
  await dispatchFault('other')
  expect(faultState.officeDragFailed).toBe(undefined)
  expect(await ui.find({ key: 'office-resize' })).toBeDefined()
  expect(await ui.find({ key: 'office-play' })).toBeDefined()
  await dispatchFault('office-play')
  expect(faultState.officePlayFailed).toBe(true)
  expect(await ui.find({ key: 'office-play' })).toBe(undefined)
  expect(await ui.find({ key: 'office-resize' })).toBeDefined()
  expect(await ui.find({ key: 'fun:whip:@main' })).toBeDefined()
  await dispatchFault('office-resize')
  expect(faultState.officeDragFailed).toBe(true)
  expect(await ui.find({ key: 'office-resize' })).toBe(undefined)
  for (const key of ['narrower', 'wider', 'shorter', 'taller']) expect(await ui.find({ key: `office:${key}` })).toBeDefined()
  await ui.unmount()
})

test('cỡ đã lưu được tải ở session.start; dữ liệu hỏng không ghi đè', async ($, on) => {
  const { clock, snapshot } = setup(on)
  let stored: unknown = { w: 701, h: 399 }
  on('store.get', (_, e) => ({ value: e.key === 'officeSize' ? stored : undefined }))
  on('store.delete', () => { stored = undefined; return { value: undefined } })
  await start($)
  await clock.settle()
  expect(snapshot().officeSize).toEqual({ w: 704, h: 400 })
  stored = { w: 'bad', h: 320 }
  await start($)
  await clock.settle()
  expect(snapshot().officeSize).toEqual({ w: 704, h: 400 })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'office:size-reset' })
  expect(snapshot().officeSize).toBe(undefined)
  await start($)
  await clock.settle()
  expect(snapshot().officeSize).toBe(undefined)
  await ui.unmount()
})

test('mức zoom đã lưu được dùng lại ở phiên sau, giá trị hỏng thì bỏ qua', async ($, on) => {
  const { clock, snapshot } = setup(on)
  let stored: unknown = { x: 40, y: 30, w: 160, h: 105 }
  on('store.get', (_, e) => ({ value: e.key === 'officeView' ? stored : undefined }))
  await start($)
  await clock.settle()
  expect(snapshot().officeView).toEqual({ x: 40, y: 30, w: 160, h: 105 })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: '200%' }))?.text).toBe('200%')
  await ui.unmount()
  stored = { x: 'hỏng' }
  await start($)
  await clock.settle()
  expect(snapshot().officeView).toEqual({ x: 40, y: 30, w: 160, h: 105 })
})

test('desktop click và kéo theo hiệu chuẩn, zoom/cỡ mới; chỉ đổi state vui và về sau 15s+4s', async ($, on) => {
  let agentCalls = 0
  const { clock, snapshot } = setup(on, { agents: [
    { id: 'rest', name: 'Người nghỉ', type: 'Explore', description: '', status: 'idle' },
  ], onAgents: () => { agentCalls++ } })
  await start($)
  await clock.settle()
  await clock.advance(4000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.resize({ in: 'office-play', columns: 80, rows: 42 })
  const before = structuredClone(snapshot())
  const count = agentCalls
  const box = officeHitboxes(buildScene(snapshot(), NOW + 4000)).find(item => item.id === 'rest')!
  const col = (box.x + box.w / 2) / 4
  const row = (box.y + box.h / 2) / 5
  await ui.pointer({ in: 'office-play', type: 'down', x: Math.floor(col), y: Math.floor(row), fine: { x: col, y: row }, button: 'left' })
  await ui.pointer({ in: 'office-play', type: 'up', x: Math.floor(col), y: Math.floor(row), fine: { x: col, y: row }, button: 'left' })
  expect(snapshot().fun?.reactions.rest.count).toBe(1)
  expect(snapshot().fun?.awakeUntil.rest).toBe(NOW + 64000)
  expect(snapshot().agents).toEqual(before.agents)
  expect(snapshot().codex).toEqual(before.codex)
  expect(agentCalls).toBe(count)
  expect(String((await ui.find({ type: 'Svg' }))?.props.source).includes('data-layer="whip"')).toBe(true)
  await ui.press({ key: 'office:in' })
  await ui.post({ type: 'resize', w: 640, h: 256 }, { in: 'office-resize' })
  const view = snapshot().officeView!
  const x = (box.x + box.w / 2 - view.x) / view.w * 80
  const y = (box.y + box.h / 2 - view.y) / view.h * 42
  const dropX = (100 - view.x) / view.w * 80
  const dropY = (100 - view.y) / view.h * 42
  const seats = structuredClone(snapshot().officeSeats)
  await ui.pointer({ in: 'office-play', type: 'down', x: Math.floor(x), y: Math.floor(y), fine: { x, y }, button: 'left' })
  await ui.pointer({ in: 'office-play', type: 'move', x: Math.floor(dropX), y: Math.floor(dropY), fine: { x: dropX, y: dropY }, button: 'left' })
  expect(await ui.find({ type: 'Text', text: '✋', in: 'office-play' })).toBeDefined()
  await ui.pointer({ in: 'office-play', type: 'up', x: Math.floor(dropX), y: Math.floor(dropY), fine: { x: dropX, y: dropY }, button: 'left' })
  expect(snapshot().fun?.fakeWork.rest).toEqual({ from: NOW + 4000, workUntil: NOW + 19000, bubbleUntil: NOW + 23000 })
  expect(snapshot().officeSeats).toEqual(seats)
  expect(snapshot().agents).toEqual(before.agents)
  expect(snapshot().codex).toEqual(before.codex)
  await clock.advance(14999)
  expect(buildScene(snapshot(), NOW + 18999).agents.find(agent => agent.id === 'rest')?.typing).toBe(true)
  await clock.advance(1)
  expect(snapshot().fun?.bubbles.rest.until).toBe(NOW + 23000)
  expect(buildScene(snapshot(), NOW + 19000).agents.find(agent => agent.id === 'rest')?.typing).toBe(false)
  await clock.advance(3999)
  expect(buildScene(snapshot(), NOW + 22999).agents.find(agent => agent.id === 'rest')?.fake).toBe(true)
  await clock.advance(1)
  expect(snapshot().fun?.fakeWork.rest).toBe(undefined)
  expect(officeHitboxes(buildScene(snapshot(), NOW + 23000)).find(item => item.id === 'rest')).toEqual(box)
  await ui.unmount()
})

test('nút vui desktop/vscode cho main, subagent và Codex; không gọi agent/send/model', async ($, on) => {
  let agentCalls = 0
  let sends = 0
  let models = 0
  on('model.complete', () => { models++; throw new Error('Fun must never call a model') })
  on('model.classify', () => { models++; throw new Error('Fun must never classify') })
  on('model.fork', () => { models++; throw new Error('Fun must never fork') })
  const home = 'C:/fun-codex'
  const { clock, snapshot } = setup(on, { env: { CODEX_HOME: home }, launches: [{ id: 'l', at: NOW - 120000 }],
    agents: [{ id: 'rest', name: 'Người nghỉ', type: 'Explore', description: '', status: 'idle' }],
    onAgents: () => { agentCalls++ } })
  const fixture = codexFixture(home, [{ name: 'rollout-fun.jsonl', mtime: NOW, text: [
    codexLine('session_meta', { cwd: '/work/game' }, NOW - 120000),
    codexLine('event_msg', { type: 'task_started' }, NOW - 60000),
  ].join('\n') }])
  mockCodexFiles(on, fixture)
  on('session.send', () => { sends++; return { isDelivered: true } })

  await start($)
  await clock.settle()
  expect(snapshot().codex?.runs.length).toBe(1)
  let actionAt = NOW
  for (const surface of ['desktop', 'vscode'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const before = structuredClone(snapshot())
    const calls = agentCalls
    for (const id of ['@main', 'rest', 'codex']) {
      expect((await ui.find({ key: `fun:whip:${id}` }))?.props.label).toBe('Quất roi')
      await ui.press({ key: `fun:whip:${id}` })
      expect(snapshot().fun?.reactions[id].count).toBe(1)
    }
    expect((await ui.find({ key: 'fun:work:rest' }))?.props.label).toBe('Bắt làm')
    await ui.press({ key: 'fun:work:rest' })
    expect(snapshot().fun?.fakeWork.rest.workUntil).toBe(actionAt + 15000)
    expect(await ui.find({ key: 'fun:work:rest' })).toBe(undefined)
    expect(snapshot().agents).toEqual(before.agents)
    expect(snapshot().codex).toEqual(before.codex)
    expect(snapshot().officeSeats).toEqual(before.officeSeats)
    expect(agentCalls).toBe(calls)
    expect(sends).toBe(0)
    expect(models).toBe(0)
    await ui.unmount()
    await clock.advance(19000)
    actionAt += 19000
  }
  const terminal = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await terminal.find({ key: 'fun:whip:@main' })).toBe(undefined)
  expect(await terminal.find({ key: 'office-play' })).toBe(undefined)
  await terminal.unmount()
})

test('message rác, id lạ, thả sai vùng/đang chạy bị bỏ; mất button hủy kéo', async ($, on) => {
  const { clock, snapshot } = setup(on, { agents: [
    { id: 'rest', name: 'Nghỉ', type: 'Explore', description: '', status: 'idle' },
  ] })
  await start($)
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const before = structuredClone(snapshot())
  for (const data of [null, [], {}, 'whip', { type: 'whip', id: 12 }, { type: 'whip', id: 'unknown' },
    { type: 'drop', id: 'rest', x: '1', y: 100 }, { type: 'drop', id: 'rest', x: 210, y: 100 },
    { type: 'drop', id: 'rest', x: -1, y: 100 }, { type: 'drop', id: 'rest', x: 100, y: 210 },
    { type: 'drop', id: 'rest', x: 100, y: -1 }, { type: 'drop', id: '@main', x: 100, y: 100 }]) {
    await ui.post(data, { in: 'office-play' })
  }
  expect(snapshot()).toEqual(before)
  await ui.resize({ in: 'office-play', columns: 320, rows: 210 })
  await ui.pointer({ in: 'office-play', type: 'down', x: 238, y: 80, button: 'left' })
  await ui.pointer({ in: 'office-play', type: 'move', x: 100, y: 100, button: 'left' })
  await ui.pointer({ in: 'office-play', type: 'move', x: 100, y: 100 })
  expect(await ui.find({ text: '✋', in: 'office-play' })).toBe(undefined)
  await ui.pointer({ in: 'office-play', type: 'up', x: 100, y: 100, button: 'left' })
  expect(snapshot()).toEqual(before)
  await ui.unmount()
})

test('đổi trạng thái thật sinh một bong bóng 4s; redraw không sinh lại và phản ứng hết đúng 3s', async ($, on) => {
  const agents: AgentInfo[] = [{ id: 'rest', name: 'Nghỉ', type: 'Explore', description: '', status: 'idle' }]
  const { clock, snapshot } = setup(on, { agents })
  await start($)
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const hello = structuredClone(snapshot().fun?.bubbles.rest)
  await ui.redraw()
  expect(snapshot().fun?.bubbles.rest).toEqual(hello)
  await clock.advance(4000)
  expect(snapshot().fun?.bubbles.rest).toBe(undefined)
  agents[0]!.status = 'running'
  await clock.advance(2000)
  expect(snapshot().fun?.lastStatus.rest).toBe('running')
  expect(snapshot().fun?.bubbles.rest.until).toBe(NOW + 10000)
  await clock.advance(3999)
  expect(!!snapshot().fun?.bubbles.rest).toBe(true)
  await clock.advance(1)
  expect(snapshot().fun?.bubbles.rest).toBe(undefined)
  await ui.press({ key: 'fun:whip:rest' })
  await clock.advance(2999)
  expect(String((await ui.find({ type: 'Svg' }))?.props.source).includes('data-expression=')).toBe(true)
  await clock.advance(1)
  expect(String((await ui.find({ type: 'Svg' }))?.props.source).includes('data-expression=')).toBe(false)
  await ui.unmount()
})
