import { expect, test } from 'claude-code/testing'
import type { AgentRow, MonitorState, OfficeKind, OfficeScene } from '../types'
import { buildScene, renderAvatarSvg, renderOfficeSvg } from './office'

const NOW = 1804734000000

function row(id: string, status: AgentRow['status'] = 'running', startedAt = NOW - 10000): AgentRow {
  return { id, name: id, description: 'Kiểm tra mã', status, startedAt,
    stoppedAt: status === 'running' || status === 'pending' || status === 'waiting' ? undefined : NOW,
    elapsed: '<1m', tools: 0, tokens: 0, active: [], turns: [] }
}

function state(agents: AgentRow[] = []): MonitorState {
  return { agents, limits: [], contextRemaining: null, feed: [], sessions: null, codex: null }
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
  for (const kind of ['main', 'codex', 'subagent', 'session'] as const) {
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
  for (const kind of ['main', 'codex', 'subagent', 'session'] as OfficeKind[]) {
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

test('mọi trạng thái Codex và phiên Claude khác được ánh xạ đúng khu và loại', () => {
  for (const status of ['running', 'stopped', 'completed'] as const) {
    const data = state()
    data.codex = { limits: null, runs: [{ id: 'run', folder: 'game', status, lastTool: '', tools: 2,
      tokens: 10, elapsed: '<1m', lastAt: NOW }] }
    const agent = buildScene(data, NOW).agents.find(agent => agent.kind === 'codex')!
    expect(agent.zone).toBe(status === 'running' ? 'work' : 'lounge')
    expect(agent.status).toBe(status)
  }
  for (const [input, output, area] of [
    ['busy', 'running', 'work'], ['working', 'running', 'work'], ['thinking', 'running', 'work'],
    ['● Đang chạy', 'running', 'work'], ['Đang suy nghĩ', 'running', 'work'],
    ['◷ Đang chờ', 'waiting', 'work'], ['✗ Thất bại', 'failed', 'work'], ['◌ Chờ chạy', 'pending', 'work'],
    ['○ Rảnh', 'idle', 'lounge'], ['✓ Hoàn tất', 'completed', 'lounge'], ['Đã dừng', 'stopped', 'lounge'],
    ['Đã đóng', 'stopped', 'lounge'], ['Chưa rõ', 'idle', 'lounge'],
  ]) {
    const data = state()
    data.sessions = [{ id: 'other', name: 'Phiên khác', folder: 'game', status: input,
      waitingFor: '—', statusUpdatedAt: NOW, age: '<1m' }]
    const agent = buildScene(data, NOW).agents.find(agent => agent.kind === 'session')!
    expect(agent.status).toBe(output)
    expect(agent.zone).toBe(area)
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
