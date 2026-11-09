import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { AgentInfo, AgentSpawnInput, CoreEngineInterface, On, SessionRateLimit, SessionUsage, FsEntry, ToolCallResult, ToolCallInput, Register } from 'claude-code'
import type { MonitorState } from '../types'
import { otherSessions, remaining, resetText, taskPids, register, parseCodexRollout, codexWindowText, codexStatus, readCodex } from './register'
import { buildScene, renderOfficeSvg } from './office'

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
  usageDelay?: number; agentDelay?: number
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
    return seeded ? { ...result, value: { ...result.value, value: { shape: 'monitor-4', value: seeded } } } : result
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
  expect(taskPids('"claude.exe","1234","Console","1","10 K"\r\n"a,b.exe","56","Console"')).toEqual([1234, 56])
  expect(taskPids('không có dữ liệu')).toBe(null)
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
  await clock.advance(57000)
  expect((await ui.find({ type: 'Svg' }))?.props.source).toBe(done)
  expect(snapshot().officeSeats?.child).toEqual(seat)
  await clock.advance(3000)
  expect(String((await ui.find({ type: 'Svg' }))?.props.source).includes('>✓</text>')).toBe(false)
  await clock.advance(240000)
  expect(snapshot().officeSeats?.child).toBe(undefined)
  expect((await ui.find({ type: 'Svg' }))?.props.source).toBe(renderOfficeSvg(buildScene(snapshot(), NOW + 315000)))
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

test('không đọc key, link và phiên hiện tại; không lưu trường bí mật', async ($, on) => {
  const { clock, snapshot } = setup(on, { env: { CLAUDE_CONFIG_DIR: 'C:/config', OS: 'Windows_NT' } })
  const reads: string[] = []
  let taskCalls = 0
  on('process.run', (_, e) => {
    expect(e.argv).toEqual(['tasklist', '/FO', 'CSV', '/NH'])
    taskCalls++
    return { value: { exitCode: 0, stdout: '"claude.exe","42","Console"', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.list', (_, e) => {
    expect(e.path?.replace(/\\/g, '/')).toBe('C:/config/sessions')
    return { value: ['secret.key', 'own.json', 'other.json', 'dead.json', 'alias.json', 'notes.txt'].map(name => ({
      name, kind: 'file' as const, size: 20, mtimeMs: NOW, isLink: name === 'alias.json',
    })) }
  })
  on('fs.read', (_, e) => {
    reads.push(e.path.replace(/\\/g, '/'))
    expect(e.path.endsWith('.key')).toBe(false)
    return { value: JSON.stringify({
      sessionId: e.path.endsWith('dead.json') ? 'dead' : 'other',
      name: 'Phiên kiểm tra', cwd: 'C:\\work\\game', status: 'waiting', waitingFor: 'permission',
      pid: e.path.endsWith('dead.json') ? 99 : 42, statusUpdatedAt: NOW - 120000,
      peerToken: 'SECRET_MUST_NEVER_ENTER_STATE',
    }) }
  })
  await start($)
  await clock.settle()
  expect(reads).toEqual(['C:/config/sessions/other.json', 'C:/config/sessions/dead.json'])
  const held = snapshot()
  expect(held.sessions?.map(session => session.id)).toEqual(['other'])
  expect(held.sessions?.[0]?.folder).toBe('game')
  expect(JSON.stringify(held).includes('SECRET_MUST_NEVER_ENTER_STATE')).toBe(false)
  expect(JSON.stringify(held).includes('.key')).toBe(false)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Phiên kiểm tra/ }))?.text)
    .toBe('Phiên kiểm tra · game · ◷ Đang chờ · chờ: cấp quyền · 0h 2m')
  await ui.unmount()
  await clock.advance(12000)
  expect(taskCalls).toBe(1)
  await clock.advance(3000)
  expect(taskCalls).toBe(2)
})

test('filesystem hoặc process thất bại sẽ ẩn phần phiên khác và không ảnh hưởng session', async ($, on) => {
  const { clock, snapshot } = setup(on, { env: { CLAUDE_CONFIG_DIR: 'C:/config', OS: 'Windows_NT' } })
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: 'Không chạy được', isStdoutTruncated: false, isStderrTruncated: false } }))
  let reads = 0
  on('fs.list', () => { reads++; return { value: [] } })
  await start($)
  await clock.settle()
  expect(snapshot().sessions).toBe(null)
  expect(reads).toBe(0)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: 'Phiên khác trên máy' })).toBe(undefined)
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
  const initialWrites = writes
  await clock.advance(15000)
  expect(writes).toBe(initialWrites)
  expect(usageCalls).toBe(2)
  expect(agentCalls).toBe(6)
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

test('lỗi đọc hoặc liệt kê filesystem trả về null', async () => {
  const unavailable = { fs: { list: async () => { throw new Error('Không đọc được') } } } as unknown as CoreEngineInterface
  expect(await otherSessions(unavailable, '/sessions', 'own', NOW, null)).toBe(null)
  const unreadable = { fs: {
    list: async () => [{ name: 'other.json', kind: 'file', size: 1, mtimeMs: NOW, isLink: false }],
    read: async () => { throw new Error('Không đọc được') },
  } } as unknown as CoreEngineInterface
  expect(await otherSessions(unreadable, '/sessions', 'own', NOW, null)).toBe(null)
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
  return { api, lists, reads, stats, directories, byPath }
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

test('Codex giới hạn 4 ngày, 8 rollout mới nhất và 3 phiên đã kết thúc trong 24 giờ', async () => {
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
  expect(result?.runs.filter(run => run.status === 'completed').length).toBe(3)
  // token_count mới nhất thắng, không dùng mtime để chọn limit.
  expect(result?.limits?.primary?.usedPercent).toBe(7)
  const old = codexFixture('/codex-old-test', [{
    name: 'rollout-old.jsonl', mtime: NOW - 86400001,
    text: codexLine('event_msg', { type: 'task_complete' }, NOW - 86400001),
  }])
  expect((await readCodex(old.api, '/codex-old-test', NOW))?.runs).toEqual([])
})

test('lỗi filesystem hoặc đường dẫn link Codex ẩn dữ liệu, không đọc file khác', async () => {
  const file = { name: 'rollout-fail.jsonl', text: codexLine('event_msg', { type: 'task_started' }), mtime: NOW }
  const listing = codexFixture('/codex-fail-list', [file])
  listing.api.fs.list = async () => { throw new Error('list lỗi') }
  expect(await readCodex(listing.api, '/codex-fail-list', NOW)).toBe(null)
  const reading = codexFixture('/codex-fail-read', [file])
  reading.api.fs.read = (async () => { throw new Error('read lỗi') }) as CoreEngineInterface['fs']['read']
  expect(await readCodex(reading.api, '/codex-fail-read', NOW)).toBe(null)
  const alias = codexFixture('/codex-alias-test', [file])
  const stat = alias.api.fs.stat
  alias.api.fs.stat = async (path, options) => ({
    ...await stat(path, options), ...(path.endsWith('.jsonl') ? { realPath: '/private/auth.json' } : {}),
  })
  expect(await readCodex(alias.api, '/codex-alias-test', NOW)).toBe(null)
  expect(alias.reads).toEqual([])
  expect(await readCodex(alias.api, '//server/share', NOW)).toBe(null)
  expect(await readCodex(alias.api, '/codex/../private', NOW)).toBe(null)
})

function mockCodexFiles(on: On, fixture: ReturnType<typeof codexFixture>): void {
  on('fs.list', async (_, e) => ({ value: await fixture.api.fs.list(e.path?.replace(/\\/g, '/')) }))
  on('fs.stat', async (_, e) => ({ value: await fixture.api.fs.stat(e.path.replace(/\\/g, '/'), { resolve: e.resolve ?? false }) }))
  on('fs.read', async (_, e) => ({ value: await fixture.api.fs.read(e.path.replace(/\\/g, '/')) }))
}

test('poll Codex mỗi 15 giây, ghi atom khi đổi, UI hai tài khoản và reset không hiển thị phần trăm cũ', async ($, on) => {
  let writes = 0
  const home = 'C:/codex-ui-test'
  const { clock, snapshot } = setup(on, { env: { CODEX_HOME: home }, onWrite: () => { writes++ } })
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
  await clock.advance(12000)
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
  const { clock, snapshot } = setup(on, { env: { USERPROFILE: 'C:/profile', OS: 'Windows_NT' } })
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
  data.sessions = [{ id: 'other', name: 'Phiên khác', folder: 'game', status: 'running',
    waitingFor: '', statusUpdatedAt: NOW, age: '<1m' }]
  data.codex = { limits: { updatedAt: NOW, plan: '', reached: false,
    primary: { windowMinutes: 10080, usedPercent: 94 },
    secondary: { windowMinutes: 300, usedPercent: 60 } },
    runs: [250, 750].map((tokens, i) => ({ id: String(i), folder: 'game',
      status: i ? 'completed' : 'running', lastTool: 'apply_patch', tools: 1, tokens, elapsed: '<1m', lastAt: NOW })) }
  seed(data)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const claudeLine = 'Limit Claude · 5 giờ [████████░░] 76% · Tuần [██████████] 96%'
  for (const id of ['@main', 'child', 'session:other']) {
    const card = await ui.find({ key: `card:${id}` })
    expect(card?.text.includes(claudeLine)).toBe(true)
    expect(card?.text.includes('Limit Codex')).toBe(false)
  }
  expect((await ui.find({ key: 'card:child' }))?.text.includes('Agent này chiếm 34% token của tài khoản trong các agent đang theo dõi')).toBe(true)
  expect((await ui.find({ key: 'card:session:other' }))?.text.includes('Agent này chiếm')).toBe(false)
  const line = await ui.find({ type: 'Text', text: /^Limit Codex ·/ })
  expect(line?.text).toBe('Limit Codex · 5 giờ [████░░░░░░] 40% · Tuần [█░░░░░░░░░] 6%')
  expect(line?.props.color).toBe('warning')
  expect((await ui.find({ key: 'card:codex:0' }))?.text.includes('Agent này chiếm 25% token của tài khoản trong các agent đang theo dõi')).toBe(true)
  expect((await ui.find({ key: 'card:idle' }))?.text.includes(' · 5 giờ 76% · Tuần 96%')).toBe(true)
  expect((await ui.find({ key: 'card:codex:1' }))?.text.endsWith(' · 5 giờ 40% · Tuần 6%')).toBe(true)
  const note = await ui.find({ type: 'Text', text: /^Limit tính theo tài khoản:/ })
  expect(note?.text).toBe('Limit tính theo tài khoản: các agent cùng tài khoản dùng chung một hạn mức.')
  expect(note?.props.dimColor).toBe(true)
  const texts = await ui.findAll({ type: 'Text' })
  const heading = texts.findIndex(text => text.text.startsWith('Đang làm ·'))
  expect(texts[heading + 1]?.text).toBe(note?.text)
  expect((await ui.find({ type: 'Text', text: /^5 giờ \[/ }))?.text)
    .toBe('5 giờ [████████░░] 76% còn lại · Chưa rõ giờ reset')
  await ui.unmount()
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
    const compact = (await ui.findAll({ type: 'Text' })).find(item => item.text === ` · 5 giờ ${left}% · Tuần chưa rõ`)
    expect(compact?.props.color).toBe(color)
    await ui.unmount()
  }
  for (const expired of [false, true]) {
    data.codex.limits!.primary = { windowMinutes: 300, usedPercent: 14, expired,
      resetsAt: NOW / 1000 + (expired ? 3600 : 0) }
    seed(structuredClone(data))
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const card = await ui.find({ key: 'card:codex:0' })
    expect(card?.text.includes('Limit Codex · 5 giờ chưa rõ · Tuần chưa rõ')).toBe(true)
    expect(card?.text.includes('86%')).toBe(false)
    expect(card?.text.includes('Agent này chiếm')).toBe(false)
    expect((await ui.find({ type: 'Text', text: /^Limit Codex ·/ }))?.props.color).toBe(undefined)
    expect((await ui.find({ key: 'card:codex:1' }))?.text.endsWith(' · 5 giờ chưa rõ · Tuần chưa rõ')).toBe(true)
    expect((await ui.find({ key: 'card:@main' }))?.text.includes('Limit Claude · 5 giờ chưa rõ · Tuần chưa rõ')).toBe(true)
    await ui.unmount()
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
    'Codex CLI', 'Chưa có hoạt động Codex', 'Tương tác', 'Chưa có tương tác.',
  ])
  expect((await ui.findAll({ type: 'Svg' })).length).toBe(0)
  await ui.unmount()
})
