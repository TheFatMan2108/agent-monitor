import { expect, test } from 'claude-code/testing'
import type { AgentRow, MonitorState, OfficeKind, OfficeScene } from '../types'
import { FULL_VIEW, buildScene, moveView, renderAvatarSvg, renderOfficeSvg, sanitizeView, viewPercent } from './office'

const NOW = 1804734000000

function row(id: string, status: AgentRow['status'] = 'running', startedAt = NOW - 10000): AgentRow {
  return { id, name: id, description: 'Kiểm tra mã', status, startedAt,
    stoppedAt: status === 'running' || status === 'pending' || status === 'waiting' ? undefined : NOW,
    elapsed: '<1m', tools: 0, tokens: 0, active: [], turns: [] }
}

function state(agents: AgentRow[] = []): MonitorState {
  return { agents, limits: [], contextRemaining: null, feed: [], codex: null }
}

function remember(data: MonitorState, scene: OfficeScene): void {
  data.officeSeats = Object.fromEntries(scene.agents.map(agent => [agent.id,
    { zone: agent.zone, seat: agent.seat, firstSeen: agent.firstSeen }]))
}

test('ngoại hình cố định theo id, khác nhau theo id và không phụ thuộc thứ tự/trạng thái', () => {
  const data = state([row('a'), row('b')])
  const scene = buildScene(data, NOW)
  const a = scene.agents.find(agent => agent.id === 'a')!
  const avatar = renderAvatarSvg(a.lookSeed, a.kind)
  remember(data, scene)
  data.agents.reverse()
  data.agents.find(agent => agent.id === 'a')!.status = 'idle'
  const later = buildScene(data, NOW + 1000).agents.find(agent => agent.id === 'a')!
  expect(renderAvatarSvg(later.lookSeed, later.kind)).toBe(avatar)
  expect(renderAvatarSvg('b', 'subagent') === avatar).toBe(false)
  expect(new Set(Array.from({ length: 100 }, (_, i) => renderAvatarSvg(`agent-${i}`, 'subagent'))).size).toBeGreaterThan(50)
  expect(avatar.includes('viewBox="0 0 24 24"')).toBe(true)
})

test('mọi nhân vật và avatar có hai mắt tối với pixel highlight, kể cả khi lỗi hoặc đang ngồi', () => {
  const template = buildScene(state(), NOW).agents[0]!
  for (const kind of ['main', 'codex', 'subagent'] as const) {
    for (let seed = 0; seed < 32; seed++) {
      const lookSeed = `face-${seed}`
      const avatar = renderAvatarSvg(lookSeed, kind)
      expect((avatar.match(/data-feature="eye"/g) ?? []).length).toBe(2)
      for (const status of ['running', 'waiting', 'failed', 'completed', 'stopped'] as const) {
        const scene: OfficeScene = { agents: [{ ...template, kind, status, lookSeed,
          zone: status === 'completed' || status === 'stopped' ? 'lounge' : 'work', tick: status === 'completed' }],
          interactions: [], overflow: { work: 0, lounge: 0 } }
        const svg = renderOfficeSvg(scene)
        const character = svg.match(/<g data-layer="character">([\s\S]*?)<\/g>/)![1]
        const eyes = [...character.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="2" height="3" fill="#252735" data-feature="eye"\/>/g)]
        expect(eyes.length).toBe(2)
        for (const eye of eyes) expect(character.includes(
          `<rect x="${eye[1]}" y="${eye[2]}" width="1" height="1" fill="#fff6df"/>`)).toBe(true)
      }
    }
  }
})

test('avatar giữ mọi rect trong 0..24 sau transform, đầu có lề ở cả bốn phía', () => {
  for (const kind of ['main', 'codex', 'subagent'] as OfficeKind[]) {
    for (let seed = 0; seed < 64; seed++) {
      const svg = renderAvatarSvg(`bounds-${seed}`, kind)
      const transforms = [{ x: 0, y: 0, scale: 1 }]
      for (const tag of svg.matchAll(/<g\b[^>]*>|<\/g>|<rect\b[^>]*\/>/g)) {
        if (tag[0] === '</g>') { transforms.pop(); continue }
        const parent = transforms[transforms.length - 1]!
        if (tag[0].startsWith('<g')) {
          const translate = tag[0].match(/translate\(([\d.]+) ([\d.]+)\)/)
          const scale = tag[0].match(/scale\(([\d.]+)\)/)
          transforms.push({ x: parent.x + Number(translate?.[1] ?? 0) * parent.scale,
            y: parent.y + Number(translate?.[2] ?? 0) * parent.scale,
            scale: parent.scale * Number(scale?.[1] ?? 1) })
          continue
        }
        const attr = (name: string): number => Number(tag[0].match(new RegExp(`\\b${name}="([\\d.]+)"`))![1])
        const x = parent.x + attr('x') * parent.scale, y = parent.y + attr('y') * parent.scale
        const right = x + attr('width') * parent.scale, bottom = y + attr('height') * parent.scale
        expect(x).toBeGreaterThanOrEqual(0)
        expect(y).toBeGreaterThanOrEqual(0)
        expect(right).toBeLessThanOrEqual(24)
        expect(bottom).toBeLessThanOrEqual(24)
        if (transforms.length > 1) {
          expect(x).toBeGreaterThan(0)
          expect(y).toBeGreaterThan(0)
          expect(right).toBeLessThan(24)
          expect(bottom).toBeLessThan(24)
        }
      }
      expect(transforms.length).toBe(1)
    }
  }
})

test('6 bàn rộng theo 2 cột × 3 hàng, mép bàn sau nhân vật và chỉ che phần chân', () => {
  const scene = buildScene(state(Array.from({ length: 5 }, (_, i) => row(`worker-${i}`))), NOW)
  const svg = renderOfficeSvg(scene)
  expect(scene.agents.filter(agent => agent.zone === 'work' && agent.seat >= 0).length).toBe(6)
  expect((svg.match(/data-layer="desk-front"/g) ?? []).length).toBe(6)
  const workers = scene.agents.slice().sort((a, b) => a.seat - b.seat)
  for (let i = 0; i < workers.length; i++) {
    const title = svg.indexOf(`<title>${workers[i]!.name} ·`)
    const character = svg.indexOf('<g data-layer="character">', title)
    const characterEnd = svg.indexOf('</g>', character)
    const desk = svg.indexOf('<g data-layer="desk-front">', character)
    const nextTitle = svg.indexOf('<title>', title + 1)
    expect(title).toBeGreaterThanOrEqual(0)
    expect(character).toBeGreaterThan(title)
    expect(desk).toBeGreaterThan(characterEnd)
    if (nextTitle >= 0) expect(desk).toBeLessThan(nextTitle)
    const front = svg.slice(desk).match(/<rect x="([\d.]+)" y="([\d.]+)" width="82" height="6"/)
    expect(Number(front![1])).toBe(15 + i % 2 * 98)
    const headTop = 55 + Math.floor(i / 2) * 48
    expect(Number(front![2])).toBe(headTop + 29)
    expect(headTop + 13 * 1.5).toBeLessThan(Number(front![2]))
    expect(headTop + 19 * 1.5).toBeLessThan(Number(front![2]))
  }
})

test('mọi trạng thái Claude được ánh xạ đúng khu, main luôn bàn đầu tiên kể cả khi rảnh', () => {
  for (const status of ['pending', 'running', 'waiting', 'failed', 'idle', 'completed', 'killed'] as const) {
    const scene = buildScene(state([row('child', status), row('@main', status)]), NOW)
    const expected = ['pending', 'running', 'waiting', 'failed'].includes(status) ? 'work' : 'lounge'
    expect(scene.agents.find(agent => agent.id === 'child')?.zone).toBe(expected)
    expect(scene.agents.find(agent => agent.id === '@main')?.seat).toBe(0)
    expect(scene.agents.find(agent => agent.id === '@main')?.zone).toBe('work')
  }
  const fallback = buildScene(state(), NOW).agents[0]!
  expect(fallback.id).toBe('@main')
  expect(fallback.seat).toBe(0)
})

test('mọi trạng thái Codex được ánh xạ đúng khu và loại', () => {
  for (const status of ['running', 'stopped', 'completed'] as const) {
    const data = state()
    data.codex = { limits: null, runs: [{ id: 'run', folder: 'game', status, lastTool: '', tools: 2,
      tokens: 10, elapsed: '<1m', lastAt: NOW }] }
    const agent = buildScene(data, NOW).agents.find(agent => agent.kind === 'codex')!
    expect(agent.zone).toBe(status === 'running' ? 'work' : 'lounge')
    expect(agent.status).toBe(status)
  }
})

test('ghế theo firstSeen/id, không đổi khi đảo danh sách, thêm/xóa người hoặc đổi ưu tiên cùng khu', () => {
  const data = state([row('b'), row('a'), row('c', 'idle')])
  const first = buildScene(data, NOW)
  expect(first.agents.find(agent => agent.id === 'a')?.seat).toBe(1)
  expect(first.agents.find(agent => agent.id === 'b')?.seat).toBe(2)
  remember(data, first)
  data.agents = [row('new', 'running', NOW), ...data.agents.reverse()]
  data.agents.find(agent => agent.id === 'a')!.status = 'waiting'
  let next = buildScene(data, NOW + 1)
  expect(next.agents.find(agent => agent.id === 'a')?.seat).toBe(1)
  expect(next.agents.find(agent => agent.id === 'b')?.seat).toBe(2)
  expect(next.agents.find(agent => agent.id === 'c')?.seat).toBe(0)
  remember(data, next)
  data.agents = data.agents.filter(agent => agent.id !== 'a')
  next = buildScene(data, NOW + 2)
  expect(next.agents.find(agent => agent.id === 'b')?.seat).toBe(2)
  expect(next.agents.find(agent => agent.id === 'new')?.seat).toBe(3)
  remember(data, next)
  data.agents.find(agent => agent.id === 'b')!.status = 'idle'
  next = buildScene(data, NOW + 3)
  expect(next.agents.find(agent => agent.id === 'b')?.zone).toBe('lounge')
  expect(next.agents.find(agent => agent.id === 'c')?.seat).toBe(0)
})

test('đủ ghế ưu tiên main, chạy, chờ, lỗi rồi mới nhất; hiện +N riêng từng khu', () => {
  const data = state([
    ...Array.from({ length: 4 }, (_, i) => row(`run-${i}`)), row('wait', 'waiting'),
    row('failed', 'failed'), row('pending', 'pending'),
    ...Array.from({ length: 9 }, (_, i) => row(`idle-${i}`, 'idle', NOW + i)),
  ])
  const scene = buildScene(data, NOW)
  expect(scene.overflow).toEqual({ work: 2, lounge: 3 })
  expect(scene.agents.find(agent => agent.id === 'wait')!.seat).toBeGreaterThanOrEqual(0)
  expect(scene.agents.find(agent => agent.id === 'failed')!.seat).toBe(-1)
  expect(scene.agents.find(agent => agent.id === 'pending')!.seat).toBe(-1)
  expect(scene.agents.find(agent => agent.id === 'idle-0')!.seat).toBe(-1)
  expect(scene.agents.find(agent => agent.id === 'idle-8')!.seat).toBeGreaterThanOrEqual(0)
  const svg = renderOfficeSvg(scene)
  expect(svg.includes('>+2</text>')).toBe(true)
  expect(svg.includes('>+3</text>')).toBe(true)
  expect((svg.match(/<title>/g) ?? []).length).toBe(12)
})

test('tương tác dưới 12 giây, đúng người trên sân khấu, tối đa 6; hỗ trợ tên và alias Codex', () => {
  const data = state([row('a'), row('b')])
  data.agents[0]!.name = 'Bạn A'
  data.codex = { limits: null, runs: [{ id: 'run', folder: 'game', status: 'running', lastTool: '',
    tools: 0, tokens: null, elapsed: '<1m', lastAt: NOW }] }
  data.feed = [
    { at: NOW - 12000, kind: 'send', from: '@main', to: 'a', text: '' },
    { at: NOW + 1, kind: 'send', from: '@main', to: 'a', text: '' },
    { at: NOW, kind: 'finish', from: '@main', to: 'a', text: '' },
    { at: NOW, kind: 'send', from: '@main', to: 'absent', text: '' },
    { at: NOW, kind: 'send', from: '@main', to: '@main', text: '' },
    { at: NOW, kind: 'codex', from: '@main', to: '@codex', text: '' },
    { at: NOW - 11999, kind: 'spawn', from: '@main', to: 'Bạn A', text: '' },
    ...Array.from({ length: 9 }, () => ({ at: NOW, kind: 'send' as const, from: 'a', to: 'b', text: '' })),
  ]
  const scene = buildScene(data, NOW)
  expect(scene.interactions.length).toBe(6)
  expect(scene.interactions[0]).toEqual({ from: '@main', to: 'codex:run', kind: 'codex' })
  expect(scene.interactions[1]).toEqual({ from: '@main', to: 'a', kind: 'spawn' })
  expect((renderOfficeSvg(scene).match(/<animateMotion /g) ?? []).length).toBe(6)
  data.feed = [{ at: NOW, kind: 'send', from: '@main', to: 'a', text: '' }]
  expect(buildScene(data, NOW + 11999).interactions.length).toBe(1)
  expect(buildScene(data, NOW + 12000).interactions.length).toBe(0)
  data.officeSeats = { a: { zone: 'work', seat: -1, firstSeen: NOW } }
  data.agents = Array.from({ length: 12 }, (_, i) => row(`run-${i}`))
  data.agents.push(row('a', 'waiting'))
  expect(buildScene(data, NOW).interactions.length).toBe(0)
})

test('tick chỉ 60 giây, agent đã kết thúc rời sân khấu sau 5 phút, agent sống luôn ở lại', () => {
  const data = state([row('done', 'completed'), row('stop', 'killed'), row('bad', 'failed'), row('idle', 'idle')])
  const first = buildScene(data, NOW)
  remember(data, first)
  expect(buildScene(data, NOW + 59999).agents.find(agent => agent.id === 'done')?.tick).toBe(true)
  expect(buildScene(data, NOW + 60000).agents.find(agent => agent.id === 'done')?.tick).toBe(false)
  expect(buildScene(data, NOW + 299999).agents.length).toBe(5)
  expect(buildScene(data, NOW + 300000).agents.map(agent => agent.id)).toEqual(['@main', 'idle'])
})

test('SVG escape XML mọi chuỗi không tin cậy, chỉ chứa element/attribute an toàn', () => {
  const data = state([row('a', 'waiting')])
  data.agents[0]!.name = '<script>&"' + "'"
  data.agents[0]!.description = '</title><image href="https://evil" onload="bad()">\u0000\ud800'
  const svg = renderOfficeSvg(buildScene(data, NOW))
  expect(svg.includes('&lt;script&gt;&amp;&quot;&apos;')).toBe(true)
  expect(svg.includes('&lt;/title&gt;&lt;image href=&quot;https://evil&quot; onload=&quot;bad()&quot;&gt;')).toBe(true)
  expect(svg.includes('\u0000')).toBe(false)
  expect(svg.includes('\ud800')).toBe(false)
  const allowed = new Set(['svg', 'g', 'rect', 'text', 'title', 'animate', 'animateTransform', 'animateMotion', 'mpath'])
  for (const match of svg.matchAll(/<\/?([A-Za-z]+)\b[^>]*>/g)) {
    expect(allowed.has(match[1])).toBe(true)
    expect(/\s(?:on\w+|href|xlink:href|style)\s*=/i.test(match[0])).toBe(false)
  }
  expect(/<(?:script|style|image|foreignObject|use)\b/i.test(svg)).toBe(false)
  expect(svg.includes('url(')).toBe(false)
})

test('SVG giữ nguyên khi poll không đổi, không có timestamp, elapsed hay phần trăm tiến độ', () => {
  const data = state([row('a'), row('rest', 'idle')])
  const scene = buildScene(data, NOW)
  remember(data, scene)
  const svg = renderOfficeSvg(scene)
  data.agents[0]!.elapsed = '0h 59m'
  data.agents[0]!.tokens = 99999
  const next = buildScene(data, NOW + 3000)
  expect(renderOfficeSvg(next)).toBe(svg)
  expect(renderOfficeSvg(scene)).toBe(svg)
  expect(svg.includes(String(NOW))).toBe(false)
  expect(svg.includes('59m')).toBe(false)
  expect(svg.includes('%')).toBe(false)
  expect(svg.includes('<animateTransform')).toBe(true)
})

test('40 agent với tên và task rất dài vẫn dưới 131072 ký tự, cảnh đủ 12 người', () => {
  const data = state(Array.from({ length: 40 }, (_, i) => ({
    ...row(`agent-${i}`, i % 2 ? 'completed' : 'running'),
    name: '<script>&"'.repeat(30000), description: '<image>&"'.repeat(30000),
  })))
  data.feed = Array.from({ length: 40 }, () => ({ at: NOW, kind: 'send', from: '@main', to: 'agent-0', text: '' }))
  const svg = renderOfficeSvg(buildScene(data, NOW))
  expect(svg.length).toBeLessThanOrEqual(131072)
  expect(svg.endsWith('</svg>')).toBe(true)
  expect((svg.match(/<title>/g) ?? []).length).toBe(12)
  expect(svg.includes('<script>')).toBe(false)
  expect(svg.includes('%')).toBe(false)
})

function accountState(): MonitorState {
  const data = state([
    { ...row('@main'), tokens: 66 }, { ...row('child'), tokens: 34 }, row('idle', 'idle'),
  ])
  data.limits = [
    { kind: 'five_hour', percentUsed: 24.2, reset: '' },
    { kind: 'seven_day', percentUsed: 4.1, reset: '' },
    { kind: 'seven_day_sonnet', percentUsed: 99, reset: '' },
  ]
  data.codex = {
    limits: { updatedAt: NOW, plan: '', reached: false,
      primary: { windowMinutes: 10080, usedPercent: 61.2, resetsAt: NOW / 1000 + 3600 },
      secondary: { windowMinutes: 300, usedPercent: 14.1, resetsAt: NOW / 1000 + 60 } },
    runs: [250, 750, null].map((tokens, index) => ({ id: String(index), folder: 'game',
      status: 'running', lastTool: '', tools: 0, tokens, elapsed: '<1m', lastAt: NOW })),
  }
  return data
}

test('limit theo tài khoản, không chia quota theo agent; token share chỉ tính trong tài khoản của scene', () => {
  const scene = buildScene(accountState(), NOW)
  for (const [id, share] of [['@main', 66], ['child', 34], ['idle', 0]] as const) {
    expect(scene.agents.find(agent => agent.id === id)?.limit)
      .toEqual({ account: 'claude', fiveHourLeft: 76, weekLeft: 96, binding: 76, share })
  }
  for (const [id, share] of [['codex:0', 25], ['codex:1', 75], ['codex:2', null]] as const) {
    expect(scene.agents.find(agent => agent.id === id)?.limit)
      .toEqual({ account: 'codex', fiveHourLeft: 86, weekLeft: 39, binding: 39, share })
  }
  // Agent tràn ghế vẫn có card, được tính trong mẫu số; agent rời scene thì không.
  const data = accountState()
  data.agents.push({ ...row('old', 'completed'), stoppedAt: NOW - 300000, tokens: 900 })
  expect(buildScene(data, NOW).agents.find(agent => agent.id === 'child')?.limit.share).toBe(34)
  for (const agent of data.agents) agent.tokens = 0
  for (const run of data.codex!.runs) run.tokens = run.tokens === null ? null : 0
  expect(buildScene(data, NOW).agents.every(agent => agent.limit.share === null)).toBe(true)
})

test('cửa sổ Codex khớp theo windowMinutes dù đổi vị trí, binding chọn số nhỏ hơn còn biết', () => {
  const data = accountState()
  const before = buildScene(data, NOW).agents.find(agent => agent.kind === 'codex')!.limit
  const limits = data.codex!.limits!
  const primary = limits.primary
  limits.primary = limits.secondary
  limits.secondary = primary
  expect(buildScene(data, NOW).agents.find(agent => agent.kind === 'codex')!.limit).toEqual(before)
  limits.primary!.usedPercent = 98
  expect(buildScene(data, NOW).agents.find(agent => agent.kind === 'codex')!.limit.binding).toBe(2)
  limits.secondary!.windowMinutes = 120
  expect(buildScene(data, NOW).agents.find(agent => agent.kind === 'codex')!.limit.weekLeft).toBe(null)
  expect(buildScene(data, NOW).agents.find(agent => agent.kind === 'codex')!.limit.binding).toBe(2)
  data.limits = [data.limits[1]!]
  expect(buildScene(data, NOW).agents.find(agent => agent.id === 'child')!.limit)
    .toEqual({ account: 'claude', fiveHourLeft: null, weekLeft: 96, binding: 96, share: 34 })
})

test('cửa sổ Codex hết hạn tại reset hoặc có expired trả null, SVG không lộ phần trăm cũ', () => {
  for (const expired of [false, true]) {
    const data = accountState()
    data.codex!.limits!.secondary = { windowMinutes: 300, usedPercent: 14,
      resetsAt: NOW / 1000 + (expired ? 3600 : 0), expired }
    let scene = buildScene(data, NOW)
    expect(scene.agents.find(agent => agent.kind === 'codex')!.limit)
      .toEqual({ account: 'codex', fiveHourLeft: null, weekLeft: 39, binding: 39, share: 25 })
    expect(renderOfficeSvg(scene).includes('Limit Codex: 5 giờ chưa rõ · Tuần 39%')).toBe(true)
    expect(renderOfficeSvg(scene).includes('86%')).toBe(false)
    data.codex!.limits!.primary!.expired = true
    scene = buildScene(data, NOW)
    expect(scene.agents.find(agent => agent.kind === 'codex')!.limit.binding).toBe(null)
    expect(renderOfficeSvg(scene).includes('Limit Codex: 5 giờ chưa rõ · Tuần chưa rõ')).toBe(true)
  }
})

test('bar 18×4, pixel nguyên, ngưỡng màu tại 20 và 5; không rõ là bar xám rỗng', () => {
  for (const [left, width, color] of [
    [100, 16, '#79b77d'], [76, 12, '#79b77d'], [20, 3, '#79b77d'],
    [19, 3, '#e4b65d'], [5, 1, '#e4b65d'], [4, 1, '#d86b63'], [0, 0, null], [null, 0, null],
  ] as const) {
    const data = state()
    if (left !== null) data.limits = [{ kind: 'five_hour', percentUsed: 100 - left, reset: '' }]
    const svg = renderOfficeSvg(buildScene(data, NOW))
    const bar = svg.match(/<g data-layer="limit-bar">(.*?)<\/g>/)![1]!
    expect(bar.startsWith('<rect x="47" y="50" width="18" height="4" fill="#39353b"/>')).toBe(true)
    expect(bar.includes('<rect x="48" y="51" width="16" height="2" fill="#777b80"/>')).toBe(true)
    expect((bar.match(/<rect /g) ?? []).length).toBe(width ? 3 : 2)
    if (width) expect(bar.endsWith(`<rect x="48" y="51" width="${width}" height="2" fill="${color}"/>`)).toBe(true)
    expect(svg.includes(`Limit Claude: 5 giờ ${left === null ? 'chưa rõ' : `${left}%`} · Tuần chưa rõ`)).toBe(true)
  }
})

test('bar nằm trên đầu, không đụng bubble, bảng tên hoặc hàng trước trong cả hai khu', () => {
  const data = state(Array.from({ length: 5 }, (_, i) => row(`waiting-${i}`, 'waiting')))
  data.codex = { limits: null, runs: Array.from({ length: 6 }, (_, i) => ({
    id: String(i), folder: 'game', status: 'stopped', lastTool: '', tools: 0,
    tokens: null, elapsed: '<1m', lastAt: NOW,
  })) }
  const scene = buildScene(data, NOW)
  const svg = renderOfficeSvg(scene)
  const bars = [...svg.matchAll(/<g data-layer="limit-bar"><rect x="([\d.]+)" y="([\d.]+)" width="18" height="4"/g)]
  expect(bars.length).toBe(12)
  for (const match of bars) {
    const x = Number(match[1]), top = Number(match[2])
    const work = x < 200
    const headY = top + 5
    expect(top + 4).toBeLessThanOrEqual(headY - 1) // Kể cả đầu đang bob lên 1 px.
    expect(x).toBeGreaterThan(x + 9 - 26 + 13) // Bubble ở bên trái đầu.
    const firstHead = work ? 55 : 65
    const stride = work ? 48 : 42
    if (headY > firstHead) {
      const previousTagBottom = headY - stride + (work ? 39 : 33) + 4
      expect(top).toBeGreaterThanOrEqual(previousTagBottom)
      expect(top).toBeGreaterThan(headY - stride + (work ? 39 : 36)) // Hết bàn/sofa hàng trước.
    }
  }
})

test('scene làm tròn limit, SVG chỉ đổi khi phần trăm nguyên đổi hoặc cửa sổ hết hạn', () => {
  const data = accountState()
  const scene = buildScene(data, NOW)
  remember(data, scene)
  const svg = renderOfficeSvg(scene)
  data.limits[0]!.percentUsed = 24.3
  data.codex!.limits!.secondary!.usedPercent = 14.2
  data.agents[1]!.tokens++
  expect(renderOfficeSvg(buildScene(data, NOW + 3000))).toBe(svg)
  data.limits[0]!.percentUsed = 25.2
  expect(renderOfficeSvg(buildScene(data, NOW + 3000)) === svg).toBe(false)
  expect(renderOfficeSvg(buildScene(data, NOW + 60000)).includes('Limit Codex: 5 giờ chưa rõ')).toBe(true)
})


function backgroundTask(id: string, kind: 'shell' | 'monitor' = 'shell', status: 'running' | 'done' = 'running', label = 'Chạy test') {
  return { id, taskId: id, kind, label, status, startedAt: NOW, elapsed: '<1m' }
}

test('mỗi task ngầm đang chạy là một robot; tối đa 6, phần dư hiện +N, escape nhãn, SVG ổn định', () => {
  const data = state()
  data.background = [backgroundTask('a'), backgroundTask('b', 'monitor', 'running', '<script>&"'), backgroundTask('done', 'shell', 'done')]
  const scene = buildScene(data, NOW)
  expect(scene.background?.map(task => task.id)).toEqual(['a', 'b'])
  const svg = renderOfficeSvg(scene)
  expect((svg.match(/data-layer="background-task"/g) ?? []).length).toBe(2)
  expect(svg.includes('<script')).toBe(false)
  expect(svg.includes('&lt;script&gt;&amp;&quot;')).toBe(true)
  expect(svg.includes('Task ngầm · Chạy test · Đang chạy')).toBe(true)
  expect(renderOfficeSvg(buildScene(data, NOW + 5000))).toBe(svg)
  data.background = Array.from({ length: 9 }, (_, i) => backgroundTask('t' + i))
  const full = buildScene(data, NOW)
  expect(full.backgroundOverflow).toBe(3)
  const many = renderOfficeSvg(full)
  expect((many.match(/data-layer="background-task"/g) ?? []).length).toBe(6)
  expect(many.includes('+3')).toBe(true)
  expect(new Set(many.match(/<[a-zA-Z]+/g)).has('<use')).toBe(false)
  expect(buildScene(state(), NOW).background).toEqual([])
  expect(renderOfficeSvg(buildScene(state(), NOW)).includes('background-task')).toBe(false)
})


test('nút zoom phóng quanh tâm, dừng ở 400%, thu về toàn cảnh; di chuyển không ra ngoài canvas', () => {
  let view = FULL_VIEW
  const widths: number[] = []
  for (let i = 0; i < 7; i++) { view = moveView(view, 'in'); widths.push(view.w) }
  expect(widths).toEqual([240, 180, 135, 101, 80, 80, 80])
  expect(viewPercent(view)).toBe(400)
  expect(Math.abs(view.x + view.w / 2 - 160) <= 1).toBe(true)
  for (let i = 0; i < 6; i++) view = moveView(view, 'out')
  expect(view).toEqual(FULL_VIEW)
  expect(moveView(FULL_VIEW, 'out')).toEqual(FULL_VIEW)
  let pan = moveView(FULL_VIEW, 'in')
  const start = pan
  for (let i = 0; i < 9; i++) pan = moveView(pan, 'left')
  expect(pan.x).toBe(0)
  for (let i = 0; i < 9; i++) pan = moveView(pan, 'up')
  expect(pan.y).toBe(0)
  for (let i = 0; i < 9; i++) pan = moveView(pan, 'right')
  expect(pan.x + pan.w).toBe(320)
  for (let i = 0; i < 9; i++) pan = moveView(pan, 'down')
  expect(pan.y + pan.h).toBe(210)
  expect([pan.w, pan.h]).toEqual([start.w, start.h])
  expect(moveView(FULL_VIEW, 'left')).toEqual(FULL_VIEW)
  expect(moveView(FULL_VIEW, 'work').w).toBe(208)
  expect(moveView(FULL_VIEW, 'lounge').x).toBe(213)
  expect(moveView(moveView(FULL_VIEW, 'lounge'), 'all')).toEqual(FULL_VIEW)
  expect(moveView(moveView(FULL_VIEW, 'lounge'), 'out')).toEqual(FULL_VIEW)
})

test('khung nhìn đổi viewBox, giữ tỉ lệ; toàn cảnh không đổi so với mặc định; giá trị lưu hỏng bị bỏ', () => {
  const scene = buildScene(state([row('a')]), NOW)
  const full = renderOfficeSvg(scene)
  expect(full.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="420" viewBox="0 0 320 210"')).toBe(true)
  expect(renderOfficeSvg(scene, FULL_VIEW)).toBe(full)
  const zoomed = renderOfficeSvg(scene, { x: 40, y: 30, w: 160, h: 105 })
  expect(zoomed.includes('width="640" height="420" viewBox="40 30 160 105"')).toBe(true)
  expect(renderOfficeSvg(scene, { x: 213, y: 40, w: 104, h: 167 }).includes('height="1028" viewBox="213 40 104 167"')).toBe(true)
  expect(sanitizeView({ x: 40, y: 30, w: 160, h: 105 })).toEqual({ x: 40, y: 30, w: 160, h: 105 })
  expect(sanitizeView({ x: 300, y: 200, w: 160, h: 105 })).toEqual({ x: 160, y: 105, w: 160, h: 105 })
  for (const bad of [null, 1, 'x', {}, { x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 0, w: 900, h: 90 }, { x: 0.5, y: 0, w: 100, h: 90 }, { x: '0', y: 0, w: 100, h: 90 }]) {
    expect(sanitizeView(bad)).toBe(null)
  }
})
