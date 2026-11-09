import type { BackgroundKind, CodexWindow, OfficeView, MonitorState, OfficeAgent, OfficeKind, OfficeScene, OfficeStatus, OfficeZone } from '../types'

export type { OfficeAgent, OfficeScene } from '../types'

const MAIN = '@main'
const CAPACITY = { work: 6, lounge: 6 }
const LABELS: Record<OfficeStatus, string> = {
  pending: 'Chờ chạy', running: 'Đang chạy', waiting: 'Cần phản hồi', failed: 'Thất bại',
  idle: 'Rảnh', completed: 'Hoàn tất', killed: 'Đã dừng', stopped: 'Đã dừng',
}
// Coordinates are the head's top centre; each row owns its furniture and label.
const DESKS = Array.from({ length: CAPACITY.work }, (_, i) => ({ x: 56 + (i % 2) * 98, y: 55 + Math.floor(i / 2) * 48 }))
const SOFAS = Array.from({ length: CAPACITY.lounge }, (_, i) => ({ x: 238 + (i % 2) * 52, y: 65 + Math.floor(i / 2) * 42 }))

function zone(status: OfficeStatus): OfficeZone {
  return status === 'running' || status === 'pending' || status === 'waiting' || status === 'failed' ? 'work' : 'lounge'
}

function priority(agent: OfficeAgent): number {
  return agent.kind === 'main' ? 0 : agent.status === 'running' ? 1
    : agent.status === 'waiting' ? 2 : agent.status === 'failed' ? 3 : 4
}

function compareId(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0 }

/** Tính phần trăm còn lại, chặn giá trị ngoài khoảng và số không hợp lệ. */
export function remaining(used: number): number {
  return Number.isFinite(used) ? Math.round(Math.max(0, Math.min(100, 100 - used)) * 10) / 10 : 0
}

function accountLimit(state: MonitorState, account: OfficeAgent['limit']['account'], now: number): OfficeAgent['limit'] {
  const left = (kind: string, minutes: number): number | null => {
    if (account === 'claude') {
      const limit = state.limits.find(row => row.kind === kind)
      return limit ? Math.round(remaining(limit.percentUsed)) : null
    }
    const window = [state.codex?.limits?.primary, state.codex?.limits?.secondary]
      .find((item): item is CodexWindow => item?.windowMinutes === minutes)
    if (!window || window.expired || (window.resetsAt !== undefined && window.resetsAt * 1000 <= now)) return null
    return Math.round(remaining(window.usedPercent))
  }
  const fiveHourLeft = left('five_hour', 300)
  const weekLeft = left('seven_day', 10080)
  const binding = fiveHourLeft === null ? weekLeft : weekLeft === null ? fiveHourLeft : Math.min(fiveHourLeft, weekLeft)
  return { account, fiveHourLeft, weekLeft, binding, share: null }
}

/** Dựng cảnh thuần dữ liệu; giữ ghế cũ và chỉ thay đổi tại các ranh giới thời gian. */
export function buildScene(state: MonitorState, now: number): OfficeScene {
  const agents: OfficeAgent[] = []
  const limits = { claude: accountLimit(state, 'claude', now), codex: accountLimit(state, 'codex', now) }
  const add = (agent: Omit<OfficeAgent, 'firstSeen' | 'seat' | 'zone' | 'limit'>, firstSeen: number): void => {
    const previous = state.officeSeats?.[agent.id]
    agents.push({ ...agent, limit: { ...limits[agent.kind === 'codex' ? 'codex' : 'claude'] }, firstSeen: previous?.firstSeen ?? firstSeen,
      zone: agent.kind === 'main' ? 'work' : zone(agent.status), seat: -1 })
  }
  for (const row of state.agents) {
    const finished = row.status === 'completed' || row.status === 'killed' || row.status === 'failed'
    if (row.id !== MAIN && finished && now - (row.stoppedAt ?? row.startedAt) >= 300000) continue
    const tool = row.active.map(call => call.text).join(' | ') || 'Không có công cụ đang chạy'
    add({ id: row.id, name: row.name, task: (row.id === MAIN ? '' : row.description) || (row.active.length ? tool : LABELS[row.status]),
      kind: row.id === MAIN ? 'main' : 'subagent', status: row.status, lookSeed: row.id,
      parentSeed: row.parentId ?? MAIN, model: row.model, tool, tools: row.tools, elapsed: row.elapsed,
      tokens: row.tokens, tick: row.status === 'completed' && row.stoppedAt !== undefined
        && now >= row.stoppedAt && now - row.stoppedAt < 60000 }, row.startedAt)
  }
  if (!agents.some(agent => agent.id === MAIN)) add({
    id: MAIN, name: 'Claude Code', task: 'Chưa có hoạt động', kind: 'main', status: 'idle',
    lookSeed: MAIN, tool: 'Không có công cụ đang chạy', tools: 0, elapsed: '<1m', tokens: 0, tick: false,
  }, 0)
  for (const run of state.codex?.runs ?? []) add({
    id: `codex:${run.id}`, name: 'Codex CLI', task: run.lastTool || LABELS[run.status],
    kind: 'codex', status: run.status, lookSeed: `codex:${run.id}`, tool: run.lastTool || 'Chưa gọi công cụ',
    tools: run.tools, partial: run.partial, elapsed: run.elapsed, tokens: run.tokens,
    tick: run.status === 'completed' && now >= run.lastAt && now - run.lastAt < 60000,
  }, now)
  // Bao gồm mọi agent có card trong scene, cả những người đang chờ ghế.
  const tokens = { claude: 0, codex: 0 }
  for (const agent of agents) tokens[agent.limit.account] += agent.tokens ?? 0
  for (const agent of agents) {
    const total = tokens[agent.limit.account]
    agent.limit.share = agent.tokens === null || total === 0 ? null : Math.round(agent.tokens / total * 100)
  }
  const overflow = { work: 0, lounge: 0 }
  for (const area of ['work', 'lounge'] as const) {
    const candidates = agents.filter(agent => agent.zone === area)
    // Chọn người theo ưu tiên trước, rồi giữ ghế của những người còn trên sân khấu.
    const chosen = candidates.slice().sort((a, b) => priority(a) - priority(b)
      || (priority(a) === 4 ? b.firstSeen - a.firstSeen : a.firstSeen - b.firstSeen)
      || compareId(a.id, b.id)).slice(0, CAPACITY[area])
    overflow[area] = candidates.length - chosen.length
    const occupied = new Set<number>()
    if (area === 'work') {
      const main = chosen.find(agent => agent.kind === 'main')
      if (main) { main.seat = 0; occupied.add(0) }
    }
    for (const agent of chosen) {
      if (agent.kind === 'main') continue
      const old = state.officeSeats?.[agent.id]
      if (old?.zone === area && old.seat >= 0 && old.seat < CAPACITY[area] && !occupied.has(old.seat)) {
        agent.seat = old.seat
        occupied.add(old.seat)
      }
    }
    for (const agent of chosen.sort((a, b) => a.firstSeen - b.firstSeen || compareId(a.id, b.id))) {
      if (agent.seat >= 0) continue
      let seat = 0
      while (occupied.has(seat)) seat++
      agent.seat = seat
      occupied.add(seat)
    }
  }
  agents.sort((a, b) => compareId(a.id, b.id))
  const onStage = agents.filter(agent => agent.seat >= 0)
  const address = (id: string): string | undefined => {
    if (id === '@codex') return onStage.filter(agent => agent.kind === 'codex')
      .sort((a, b) => priority(a) - priority(b) || compareId(a.id, b.id))[0]?.id
    return onStage.find(agent => agent.id === id || agent.name === id)?.id
  }
  const interactions: OfficeScene['interactions'] = []
  for (const item of state.feed) {
    if (item.kind === 'finish' || now < item.at || now - item.at >= 12000) continue
    const from = address(item.from)
    const to = address(item.to)
    if (from && to && from !== to) interactions.push({ from, to, kind: item.kind })
    if (interactions.length === 6) break
  }
  const running = (state.background ?? []).filter(task => task.status === 'running')
    .sort((a, b) => a.startedAt - b.startedAt || compareId(a.id, b.id))
  const background = running.slice(0, 6).map(({ id, kind, label }) => ({ id, kind, label }))
  return { agents, interactions, overflow, background, backgroundOverflow: running.length - background.length }
}

function hash(value: string): number {
  let result = 2166136261
  for (let i = 0; i < value.length; i++) result = Math.imul(result ^ value.charCodeAt(i), 16777619)
  return result >>> 0
}

function xml(value: string, max = 180): string {
  return value.slice(0, max).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]|[\ud800-\udfff]/gu, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

const HAIR = ['#382e35', '#654334', '#98613d', '#c48b47', '#d4b58a', '#58606b']
const SKIN = ['#f4d2b5', '#dfac83', '#bb805d', '#855942']
const SHIRTS = ['#609a95', '#cb927d', '#c6a55d', '#7f91b2', '#987da5', '#8a9d70', '#c57879', '#699aa9']
// Original 16px silhouettes: short, bob, spiky, bun, long, cap.
const HAIR_STYLES = [
  ['....oooooooo....', '..oohhhhhhhhoo..', '.ohhhhhhhhhhhho.', '.ohhHhhhhhhhhho.', '..ohhh..hhhho...', '..oh.........o..'],
  ['....oooooooo....', '..oohhhhhhhhoo..', '.ohhhhhhhhhhhho.', 'ohhHhhhhhhhhhho.', 'ohhh........hhho', 'ohh..........hho'],
  ['...oo...oo......', '..ohho.ohho.oo..', '.ohhhhohhhhOhho.', 'ohhHhhhhhhhhhho.', '.ohhhh..hhhho...', '..oh.........o..'],
  ['......oooo......', '.....ohhhho.....', '....oohhhhoo....', '..oohhhhhhhhoo..', '.ohhHhhhhhhhhho.', '.ohhh......hhho.'],
  ['....oooooooo....', '..oohhhhhhhhoo..', '.ohhHhhhhhhhhho.', 'ohhhh......hhhho', 'ohhh........hhho', 'ohh..........hho'],
  ['...oooooooooo...', '..occcccccccco..', '.occcccccccccco.', '.occcCcccccccco.', 'oooooooooooooooo', '..oh.........o..'],
]
const OUTLINE = '#39353b'
const EYES = '#252735'

function rect(x: number, y: number, width: number, height: number, fill: string, extra = ''): string {
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${fill}"${extra}/>`
}

// Merge horizontal colour runs; broad head/body rectangles keep full rooms cheap.
function pixels(grid: readonly string[], palette: Record<string, string>, x = 0, y = 0): string {
  let result = ''
  for (let row = 0; row < grid.length; row++) {
    for (let col = 0; col < grid[row].length;) {
      const letter = grid[row][col]
      const start = col++
      while (col < grid[row].length && grid[row][col] === letter) col++
      if (palette[letter]) result += rect(x + start, y + row, col - start, 1, palette[letter])
    }
  }
  return result
}

function tint(base: string, parent: string): string {
  let color = '#'
  for (let i = 1; i < 7; i += 2) color += Math.round((parseInt(base.slice(i, i + 2), 16) * 3
    + parseInt(parent.slice(i, i + 2), 16)) / 4).toString(16).padStart(2, '0')
  return color
}

function character(seed: string, kind: OfficeKind, parentSeed?: string, headOnly = false, seated = false, headDown = false): string {
  const value = hash(seed)
  const style = (value >>> 9) % HAIR_STYLES.length
  const ownShirt = SHIRTS[(value >>> 13) % SHIRTS.length]
  const shirt = kind === 'main' ? '#b96d50' : kind === 'codex' ? '#343943'
    : kind === 'subagent' ? tint(ownShirt, SHIRTS[hash(parentSeed ?? seed) % SHIRTS.length]) : tint(ownShirt, '#93958e')
  const skin = SKIN[(value >>> 5) % SKIN.length]
  const palette = { o: OUTLINE, h: HAIR[value % HAIR.length], H: '#d9b78a', O: OUTLINE, c: shirt, C: '#eee1b7' }
  let art = '<g data-layer="character">'
  if (kind === 'codex') art += rect(0, 4, 16, 12, '#232b34') + rect(1, 3, 14, 12, '#525963')
  // Stepped, round head, ears and cheek line; facial features never depend on hair.
  art += rect(3, 2, 10, 12, OUTLINE) + rect(1, 4, 14, 8, OUTLINE)
    + rect(2, 5, 12, 6, skin) + rect(3, 3, 10, 9, skin) + rect(4, 12, 8, 1, skin)
    + pixels(HAIR_STYLES[style], palette)
  if (style === 1 || style === 4) {
    const height = style === 4 ? 9 : 6
    art += rect(0, 5, 2, height, OUTLINE) + rect(14, 5, 2, height, OUTLINE)
      + rect(1, 6, 1, height - 1, palette.h) + rect(14, 6, 1, height - 1, palette.h)
  }
  const eyeY = headDown ? 8 : 7
  art += rect(4, eyeY, 2, 3, EYES, ' data-feature="eye"') + rect(10, eyeY, 2, 3, EYES, ' data-feature="eye"')
    + rect(4, eyeY, 1, 1, '#fff6df') + rect(10, eyeY, 1, 1, '#fff6df')
    + rect(7, 11, 2, 1, '#884f48')
  if ((value & 1) === 0) art += rect(3, 10, 2, 1, '#d9937e') + rect(11, 10, 2, 1, '#d9937e')
  if (!headOnly) {
    art += rect(6, 13, 4, 2, skin) + rect(4, 14, 8, 6, OUTLINE) + rect(5, 14, 6, 5, shirt)
      + rect(2, 15, 3, 4, OUTLINE) + rect(11, 15, 3, 4, OUTLINE)
      + rect(3, 15, 2, 3, shirt) + rect(11, 15, 2, 3, shirt)
      + rect(3, 18, 2, 1, skin) + rect(11, 18, 2, 1, skin)
    art += seated
      ? rect(3, 19, 10, 2, '#525364') + rect(2, 20, 4, 2, OUTLINE) + rect(10, 20, 4, 2, OUTLINE)
      : rect(5, 19, 2, 2, '#525364') + rect(9, 19, 2, 2, '#525364')
        + rect(4, 21, 3, 1, OUTLINE) + rect(9, 21, 3, 1, OUTLINE)
    if (kind === 'main') art += rect(7, 14, 1, 5, '#edbf83') + pixels(['.y.', 'yyy', '.y.'], { y: '#f7d983' }, 9, 15)
    if (kind === 'codex') art += rect(5, 14, 1, 3, '#8b9596') + rect(10, 14, 1, 3, '#8b9596')
      + rect(8, 16, 2, 2, '#8cbd83')
    if (kind === 'subagent') art += rect(6, 14, 1, 3, '#f6e4c1') + rect(9, 14, 1, 3, '#f6e4c1')
      + rect(7, 17, 2, 2, '#f6e4c1') + rect(7, 17, 1, 1, '#658da0')
  }
  return art + '</g>'
}

/** Avatar 24×24, đầu nằm trọn trong khung, cùng seed với nhân vật trong phòng. */
export function renderAvatarSvg(lookSeed: string, kind: OfficeKind): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" shape-rendering="crispEdges">${rect(0, 0, 24, 24, '#f0e2c6')}<g transform="translate(2 3) scale(1.25)">${character(lookSeed, kind, undefined, true)}</g></svg>`
}

function text(x: number, y: number, value: string, fill = '#433c40', size = 6): string {
  return `<text x="${x}" y="${y}" fill="${fill}" font-size="${size}" font-family="monospace" font-weight="bold" text-anchor="middle">${xml(value)}</text>`
}

function position(agent: OfficeAgent): { x: number; y: number } {
  return (agent.zone === 'work' ? DESKS : SOFAS)[agent.seat]
}

const PLANT = ['...gg.g...', '..gGGggg..', '.ggGGGggg.', '..ggGGgg..', '....tt....',
  '..oooooooo', '...rrrrro.', '...rrrrro.', '....oooo..']

function mug(x: number, y: number): string {
  return rect(x + 3, y + 1, 2, 3, '#78604e') + rect(x, y, 4, 5, '#fff1d1')
    + rect(x + 1, y, 2, 1, '#8d6d57')
}

function room(detail: boolean): string {
  let art = rect(0, 0, 320, 210, '#8d6d57') + rect(3, 3, 314, 204, '#e8c68c')
  if (detail) for (let y = 43; y < 208; y += 11) {
    art += rect(4, y, 207, 1, '#d4ae75')
    for (let x = y % 22 === 21 ? 14 : 41; x < 210; x += 54) art += rect(x, y - 10, 1, 10, '#d9b77f')
  }
  art += rect(213, 40, 103, 167, '#b9d4bf')
  if (detail) {
    for (let y = 46; y < 207; y += 14) art += rect(214, y, 102, 1, '#a7c8b3')
    for (let x = 220; x < 316; x += 14) art += rect(x, 40, 1, 167, '#aacbb7')
  }
  art += rect(4, 4, 312, 34, '#f5e7c9') + rect(4, 37, 312, 4, '#ba936e')
    + rect(210, 41, 3, 160, '#907d69') + rect(211, 41, 3, 158, '#f0dfbc')
  for (const x of [18, 160]) art += rect(x, 9, 30, 23, '#9c7b5e') + rect(x + 2, 11, 26, 18, '#9cbec6')
    + rect(x + 3, 12, 11, 7, '#cce3df') + rect(x + 16, 12, 10, 7, '#dcece1')
    + rect(x + 14, 11, 2, 18, '#f2dfb9') + rect(x + 2, 20, 26, 2, '#f2dfb9')
    + rect(x - 2, 31, 34, 2, '#b48c62')
  art += rect(66, 14, 74, 15, '#486d87') + rect(68, 16, 70, 11, '#648fa4')
    + text(103, 24, 'LÀM VIỆC', '#fff2d1', 6)
    + rect(240, 14, 47, 15, '#658d75') + text(263.5, 24, 'NGHỈ', '#f7f0d7', 6)
    + rect(201, 12, 15, 17, '#8e7761') + rect(203, 14, 11, 13, '#fff3d7')
    + rect(208, 16, 1, 6, '#65504b') + rect(208, 21, 4, 1, '#65504b')
  // Woven lounge rug, coffee station and a small wall bookshelf.
  art += rect(218, 65, 93, 126, '#92b7a6') + rect(220, 67, 89, 122, '#d8d9b5')
    + rect(223, 70, 83, 116, '#c4ccb0')
    + rect(220, 58, 33, 3, '#8b6b55') + rect(222, 47, 13, 11, '#48494a')
    + rect(224, 48, 9, 3, '#8ba8a0') + rect(225, 53, 7, 5, '#252f35') + mug(226, 53) + mug(242, 53)
    + rect(267, 44, 35, 17, '#8b6b55') + rect(269, 46, 31, 12, '#e0bf8a')
  for (let i = 0; i < 7; i++) art += rect(271 + i * 4, 48 + i % 2, 3, 9 - i % 2, SHIRTS[i])
  art += rect(245, 196, 39, 7, '#78604e') + rect(246, 195, 37, 5, '#d9b079')
    + rect(248, 203, 2, 2, '#78604e') + rect(279, 203, 2, 2, '#78604e') + mug(252, 191) + mug(272, 191)
  if (detail) for (const [x, y] of [[298, 44], [9, 194]]) art += pixels(PLANT,
    { g: '#638c69', G: '#91af73', t: '#9c8053', o: '#7d6251', r: '#c18461' }, x, y)
  return art
}

function chair(x: number, y: number): string {
  return rect(x - 13, y + 14, 26, 20, '#8f6e58') + rect(x - 11, y + 15, 22, 16, '#758c83')
    + rect(x - 9, y + 16, 18, 2, '#a3b6a0')
}

function sofa(x: number, y: number, index: number): string {
  const color = ['#c98d80', '#86aaa0', '#c5aa70', '#a294bc', '#7b9ca0', '#bd8b91'][index]
  return rect(x - 19, y + 14, 38, 20, '#625b59') + rect(x - 17, y + 15, 34, 17, color)
    + rect(x - 15, y + 16, 14, 8, '#e2c9ac') + rect(x + 1, y + 16, 14, 8, '#e2c9ac')
    + rect(x - 15, y + 25, 14, 6, color) + rect(x + 1, y + 25, 14, 6, color)
    + rect(x - 21, y + 22, 6, 10, '#625b59') + rect(x + 15, y + 22, 6, 10, '#625b59')
    + rect(x - 20, y + 23, 4, 7, color) + rect(x + 16, y + 23, 4, 7, color)
    + rect(x - 16, y + 34, 3, 2, '#78604e') + rect(x + 13, y + 34, 3, 2, '#78604e')
}

function deskFront(x: number, y: number, occupied: boolean, detail: boolean): string {
  let art = `<g data-layer="desk-front">${rect(x - 41, y + 29, 82, 6, '#78604e')}${rect(x - 40, y + 29, 80, 2, '#f0cc93')}${rect(x - 39, y + 31, 78, 3, '#c18e60')}${rect(x - 38, y + 35, 3, 4, '#78604e')}${rect(x + 35, y + 35, 3, 4, '#78604e')}</g>`
  // Low laptop lives to the right of the head and chest, never in front of them.
  art += rect(x + 16, y + 19, 17, 10, '#3f454b') + rect(x + 17, y + 20, 15, 7, occupied ? '#9ecfc7' : '#657b80')
    + rect(x + 14, y + 29, 21, 1, '#59616a')
  if (occupied) art += `<g>${rect(x + 19, y + 22, 9, 1, '#dbf0d2')}<animate attributeName="opacity" values="1;.5;1" dur="2s" repeatCount="indefinite"/></g>`
  if (detail) art += mug(x - 31, y + 24) + rect(x - 22, y + 28, 9, 1, '#f4dfb4')
  return art
}

function occupant(agent: OfficeAgent): string {
  const { x, y } = position(agent)
  const running = agent.status === 'running'
  const resting = agent.zone === 'lounge' || agent.status === 'idle' || agent.status === 'completed' || agent.status === 'killed'
  const percent = (value: number | null): string => value === null ? 'chưa rõ' : `${value}%`
  const limit = `Limit ${agent.limit.account === 'codex' ? 'Codex' : 'Claude'}: 5 giờ ${percent(agent.limit.fiveHourLeft)} · Tuần ${percent(agent.limit.weekLeft)}`
  const calls = agent.kind === 'codex' && agent.partial ? ` · ${agent.tools}+ lần gọi` : ''
  let art = `<g transform="translate(${x - 12} ${y})"><title>${xml(agent.name)} · ${xml(agent.task)} · ${LABELS[agent.status]}${calls} · ${limit}</title><g>`
  if (resting) art += '<animateTransform attributeName="transform" type="translate" values="0 0;0 -1;0 0" dur="3s" repeatCount="indefinite"/>'
  if (agent.status === 'failed') art += '<animateTransform attributeName="transform" type="translate" values="0 1;0 2;0 1" dur="3s" repeatCount="indefinite"/>'
  art += `<g transform="scale(1.5)">${character(agent.lookSeed, agent.kind, agent.parentSeed, false, true, agent.status === 'failed')}</g>`
  art += '</g></g>'
  return art
}

function hands(agent: OfficeAgent): string {
  if (agent.zone !== 'work') return ''
  const { x, y } = position(agent)
  const skin = SKIN[(hash(agent.lookSeed) >>> 5) % SKIN.length]
  let art = `<g transform="translate(${x} ${y + 28})"><g>${rect(-8, 0, 5, 2, OUTLINE)}${rect(3, 0, 5, 2, OUTLINE)}${rect(-7, 0, 4, 1, skin)}${rect(3, 0, 4, 1, skin)}`
  if (agent.status === 'running') art += '<animateTransform attributeName="transform" type="translate" values="0 0;0 -1;0 0;0 -1" dur=".8s" repeatCount="indefinite" calcMode="discrete"/>'
  if (agent.status === 'waiting') art += rect(10, -8, 2, 8, skin) + rect(9, -10, 3, 3, skin)
  return art + '</g></g>'
}

function nameTag(agent: OfficeAgent): string {
  if (agent.kind !== 'main' && agent.kind !== 'codex') return ''
  const { x, y } = position(agent)
  const width = agent.kind === 'main' ? 38 : 32
  // Plaque nằm trên mép ghế/sofa, chừa khoảng phía trên đầu của hàng kế tiếp.
  const top = y + (agent.zone === 'work' ? 39 : 33)
  return rect(x - width / 2, top, width, 4, '#f6e7c8')
    + text(x, top + 3.3, agent.kind === 'main' ? 'Claude Code' : 'Codex CLI', '#65534b', 3.5)
}

function limitBar(agent: OfficeAgent): string {
  const { x, y } = position(agent)
  const value = agent.limit.binding
  const width = value === null ? 0 : Math.round(16 * value / 100)
  const color = value === null ? '#777b80' : value < 5 ? '#d86b63' : value < 20 ? '#e4b65d' : '#79b77d'
  return `<g data-layer="limit-bar">${rect(x - 9, y - 5, 18, 4, OUTLINE)}${rect(x - 8, y - 4, 16, 2, '#777b80')}${width ? rect(x - 8, y - 4, width, 2, color) : ''}</g>`
}

function statusBubble(agent: OfficeAgent): string {
  const bubble = agent.status === 'waiting' ? '?' : agent.status === 'failed' ? '!'
    : agent.tick ? '✓' : agent.status === 'stopped' || agent.status === 'killed' ? 'z' : ''
  if (!bubble) return ''
  const { x, y } = position(agent)
  const color = agent.status === 'failed' ? '#d48678' : agent.tick ? '#a2c39a' : '#edc777'
  // Always to the left of the face, away from the right-hand laptop.
  return `<g transform="translate(${x - 26} ${y + 2})">${rect(0, 0, 12, 11, OUTLINE)}${rect(1, 1, 10, 9, color)}${rect(10, 10, 3, 3, OUTLINE)}${rect(10, 10, 2, 2, color)}${text(6, 8, bubble, '#473d3d', 8)}<animate attributeName="opacity" values="1;.7;1" dur="2s" repeatCount="indefinite"/></g>`
}

const ROBOT = ['....aa....', '....aa....', '.oooooooo.', 'obbbbbbbbo', 'obeebbeebo', 'obbbbbbbbo',
  '.oooooooo.', '..occcco..', '.occcccco.', '..occcco..', '..oo..oo..']
const ROBOT_COLORS: Record<BackgroundKind, string> = {
  shell: '#5f9c95', monitor: '#d9a64f', workflow: '#9a7fb0', mcp: '#6f8fb8', other: '#8d9398',
}
const ROBOTS_SHOWN = 6

/** Mỗi task ngầm đang chạy là một robot đi tuần ở hành lang dưới khu làm việc. */
function backgroundRobots(scene: OfficeScene): string {
  let art = ''
  const tasks = scene.background ?? []
  tasks.slice(0, ROBOTS_SHOWN).forEach((task, index) => {
    const body = pixels(ROBOT, { o: OUTLINE, b: '#e6e2d6', e: '#3f8f7f', a: ROBOT_COLORS[task.kind], c: ROBOT_COLORS[task.kind] })
    art += '<g transform="translate(' + (34 + index * 21) + ' 196)" data-layer="background-task"><title>Task ngầm · ' + xml(task.label) + ' · Đang chạy</title><g>' + body
      + '<animateTransform attributeName="transform" type="translate" values="0 0;4 0;0 0;-4 0;0 0" dur="3.2s" begin="' + (index * 0.4).toFixed(1) + 's" repeatCount="indefinite"/></g></g>'
  })
  if (scene.backgroundOverflow) art += rect(160, 196, 16, 10, '#f1deb5') + text(168, 203.5, '+' + scene.backgroundOverflow, '#765d4c', 6)
  return art
}

const CANVAS = { w: 320, h: 210 }
const MIN_VIEW_WIDTH = 80
const ZOOM_STEP = 0.75
export const FULL_VIEW: OfficeView = { x: 0, y: 0, w: CANVAS.w, h: CANVAS.h }
const VIEW_REGIONS = { all: FULL_VIEW, work: { x: 4, y: 40, w: 208, h: 167 }, lounge: { x: 213, y: 40, w: 104, h: 167 } }
export const OFFICE_ACTIONS = ['in', 'out', 'left', 'right', 'up', 'down', 'all', 'work', 'lounge'] as const
export type OfficeAction = typeof OFFICE_ACTIONS[number]

function clampView(view: OfficeView): OfficeView {
  const w = Math.min(CANVAS.w, view.w)
  const h = Math.min(CANVAS.h, view.h)
  return { x: Math.max(0, Math.min(CANVAS.w - w, view.x)), y: Math.max(0, Math.min(CANVAS.h - h, view.y)), w, h }
}

/** Phóng quanh tâm khung nhìn; tới mép canvas thì trở về toàn cảnh. */
function zoomView(view: OfficeView, factor: number): OfficeView {
  const ratio = Math.max(factor, MIN_VIEW_WIDTH / view.w)
  const w = Math.round(view.w * ratio)
  const h = Math.round(view.h * ratio)
  if (w >= CANVAS.w || h >= CANVAS.h) return FULL_VIEW
  return clampView({ x: Math.round(view.x + (view.w - w) / 2), y: Math.round(view.y + (view.h - h) / 2), w, h })
}

/** Tính khung nhìn mới cho một nút điều khiển. */
export function moveView(view: OfficeView, action: OfficeAction): OfficeView {
  if (action === 'in') return zoomView(view, ZOOM_STEP)
  if (action === 'out') return zoomView(view, 1 / ZOOM_STEP)
  if (action === 'all' || action === 'work' || action === 'lounge') return VIEW_REGIONS[action]
  const stepX = Math.max(1, Math.round(view.w / 4))
  const stepY = Math.max(1, Math.round(view.h / 4))
  return clampView({ ...view, x: view.x + (action === 'left' ? -stepX : action === 'right' ? stepX : 0),
    y: view.y + (action === 'up' ? -stepY : action === 'down' ? stepY : 0) })
}

/** Nhận khung nhìn đã lưu, bỏ qua giá trị hỏng. */
export function sanitizeView(value: unknown): OfficeView | null {
  if (value === null || typeof value !== 'object') return null
  const { x, y, w, h } = value as Record<string, unknown>
  for (const part of [x, y, w, h]) if (typeof part !== 'number' || !Number.isInteger(part)) return null
  const view = { x, y, w, h } as OfficeView
  if (view.w < MIN_VIEW_WIDTH || view.h < 1 || view.w > CANVAS.w || view.h > CANVAS.h) return null
  return clampView(view)
}

export function viewPercent(view: OfficeView): number {
  return Math.round(CANVAS.w / view.w * 100)
}

function draw(scene: OfficeScene, detail: boolean, view: OfficeView): string {
  let art = '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="' + Math.round(640 * view.h / view.w) + '" viewBox="' + view.x + ' ' + view.y + ' ' + view.w + ' ' + view.h + '" shape-rendering="crispEdges">'
  art += room(detail)
  const visible = scene.agents.filter(agent => agent.seat >= 0)
    .sort((a, b) => position(a).y - position(b).y || position(a).x - position(b).x)
  // Each cell is a depth stack: seat back → person → desk front → hands.
  for (const area of ['work', 'lounge'] as const) {
    const seats = area === 'work' ? DESKS : SOFAS
    for (let i = 0; i < seats.length; i++) {
      const { x, y } = seats[i]
      const agent = visible.find(item => item.zone === area && item.seat === i)
      art += area === 'work' ? chair(x, y) : sofa(x, y, i)
      if (agent) art += occupant(agent)
      if (area === 'work') art += deskFront(x, y, !!agent, detail)
      if (agent) art += hands(agent) + nameTag(agent)
    }
  }
  if (scene.overflow.work) art += rect(178, 194, 26, 11, '#f1deb5') + text(191, 202, `+${scene.overflow.work}`, '#765d4c', 8)
  if (scene.overflow.lounge) art += rect(286, 194, 26, 11, '#ecdfb9') + text(299, 202, `+${scene.overflow.lounge}`, '#597366', 8)
  art += backgroundRobots(scene)
  for (const agent of visible) art += statusBubble(agent) + limitBar(agent)
  // Envelopes are the final layer, head-to-head, with a cheap soft dotted trail.
  for (const item of scene.interactions.slice(0, 6)) {
    const from = visible.find(agent => agent.id === item.from)
    const to = visible.find(agent => agent.id === item.to)
    if (!from || !to) continue
    const a = position(from), b = position(to)
    if (detail) for (let dot = 1; dot < 8; dot++) art += rect(
      Math.round(a.x + (b.x - a.x) * dot / 8), Math.round(a.y + 10 + (b.y - a.y) * dot / 8), 1, 1, '#78604e', ' opacity=".3"')
    art += `<g>${rect(-4, -3, 9, 7, OUTLINE)}${rect(-3, -2, 7, 5, '#fff1ce')}${pixels(['c.....c', '.c...c.', '..ccc..'], { c: item.kind === 'codex' ? '#59836b' : '#a36549' }, -3, -2)}<animateMotion path="M ${a.x} ${a.y + 10} L ${b.x} ${b.y + 10}" dur="2.4s" repeatCount="indefinite"/><animate attributeName="opacity" values="0;1;1;0" dur="2.4s" repeatCount="indefinite"/></g>`
  }
  return art + '</svg>'
}

/** SVG ổn định, có giới hạn; dữ liệu không tin cậy được escape và cắt trước khi vẽ. */
export function renderOfficeSvg(scene: OfficeScene, view: OfficeView = FULL_VIEW): string {
  const detailed = draw(scene, true, view)
  if (detailed.length <= 131072) return detailed
  const simple = draw(scene, false, view)
  if (simple.length <= 131072) return simple
  // SMELL: caller-created scenes can exceed capacity → bound them to valid, unique seats.
  const occupied = new Set<string>()
  const agents = scene.agents.filter(agent => {
    const key = `${agent.zone}:${agent.seat}`
    if (!Number.isInteger(agent.seat) || agent.seat < 0 || agent.seat >= CAPACITY[agent.zone] || occupied.has(key)) return false
    occupied.add(key)
    return true
  })
  return draw({ ...scene, agents }, false, view)
}
