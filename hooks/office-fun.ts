import type { FunState, MonitorState, OfficeAgent, Personality } from '../types'

const PERSONALITIES: Personality[] = ['shy', 'grumpy', 'cheerful', 'dramatic', 'lazy', 'stoic']
const LINES: Record<Personality, { hit: string[]; high: string; wake: string; done: string; hello: string; run: string; error: string; ask: string }> = {
  shy: { hit: ['Á! Em xin lỗi…', 'Đừng mà sếp!', 'Em sợ quá…', 'Nhẹ tay thôi…'], high: 'Em khóc mất!', wake: 'Dạ! Em dậy rồi!', done: 'Dạ, xong rồi ạ!', hello: 'Em chào sếp…', run: 'Em làm ngay ạ!', error: 'Em lỡ tay…', ask: 'Sếp giúp em…' },
  grumpy: { hit: ['Đau đấy!', 'Này! Nhẹ thôi!', 'Gì nữa đây?', 'Đang bận mà!'], high: 'Đủ rồi nhé!', wake: 'Hừ! Dậy rồi!', done: 'Hừ, xong.', hello: 'Hừ, chào.', run: 'Rồi, làm đây!', error: 'Lại lỗi nữa!', ask: 'Sếp, xem này!' },
  cheerful: { hit: ['Hehe, làm tiếp!', 'Ui! Vui ghê!', 'Sếp nghịch quá!', 'Hihi, nhột!'], high: 'Combo vui quá!', wake: 'Dậy rồi! Hehe!', done: 'Xong rồi sếp!', hello: 'Chào sếp nhé!', run: 'Bắt đầu nào!', error: 'Ối, sửa ngay!', ask: 'Sếp ơi?' },
  dramatic: { hit: ['Ôi trời ơi!!', 'Cứu em với!', 'Đời thật éo le!', 'Ôi, trái tim!'], high: 'Trời đất sụp đổ!', wake: 'Ôi! Em tỉnh rồi!', done: 'Kiệt tác đã xong!', hello: 'Ngôi sao tới rồi!', run: 'Màn diễn bắt đầu!', error: 'Toang thật rồi!', ask: 'Cứu tinh ơi!' },
  lazy: { hit: ['Ơ… 5 phút nữa', 'Đang mơ đẹp…', 'Từ từ thôi…', 'Em biết rồi mà'], high: 'Thôi! Em làm mà!', wake: 'Ơ… dậy rồi đây', done: 'Xong! Nghỉ nhé…', hello: 'Chào… buồn ngủ', run: 'Làm tí rồi nghỉ…', error: 'Toang… mai sửa?', ask: 'Sếp làm hộ nhé?' },
  stoic: { hit: ['Đã ghi nhận.', 'Vẫn ổn.', 'Tiếp tục thôi.', 'Không vấn đề.'], high: 'Đã đủ dữ liệu.', wake: 'Đã thức.', done: 'Hoàn tất.', hello: 'Xin chào.', run: 'Bắt đầu xử lý.', error: 'Ghi nhận lỗi.', ask: 'Cần xác nhận.' },
}

/** Giữ dữ liệu hình ảnh theo nhân vật đang hiện và các run nền thuộc phiên. */
export function prepareFun(state: MonitorState, agents: OfficeAgent[], now: number): FunState {
  const fun = state.fun ??= { personalities: {}, reactions: {}, awakeUntil: {}, fakeWork: {}, bubbles: {}, lastStatus: {} }
  const ids = new Set([...agents.filter(agent => agent.seat >= 0), ...agents.filter(agent => agent.seat < 0)]
    .slice(0, 50).map(agent => agent.id))
  const statusIds = new Set([...ids, ...(state.codex?.runs ?? []).filter(run => run.background)
    .map(run => '@codex-background:' + run.id)])
  for (const key of Object.keys(fun) as (keyof FunState)[]) {
    const retained = key === 'lastStatus' ? statusIds : ids
    fun[key] = Object.assign(Object.create(null), Object.fromEntries(Object.entries(fun[key]).filter(([id]) => retained.has(id))))
  }
  for (const id of ids) if (!fun.personalities[id]) fun.personalities[id] = PERSONALITIES[Math.min(5, Math.floor(Math.random() * 6))]
  for (const [id, value] of Object.entries(fun.reactions)) if (Math.max(value.until, value.at + 5000) <= now) delete fun.reactions[id]
  for (const [id, until] of Object.entries(fun.awakeUntil)) if (until <= now) delete fun.awakeUntil[id]
  for (const [id, value] of Object.entries(fun.fakeWork)) if (value.bubbleUntil <= now) delete fun.fakeWork[id]
  for (const [id, value] of Object.entries(fun.bubbles)) if (value.until <= now) delete fun.bubbles[id]
  return fun
}

/** Theo dõi chuyển trạng thái tại change(), không sinh lời thoại theo redraw. */
export function updateFunStatus(state: MonitorState, agents: OfficeAgent[], now: number): void {
  const fun = prepareFun(state, agents, now)
  for (const agent of agents) {
    const personality = fun.personalities[agent.id]
    if (!personality || fun.lastStatus[agent.id] === agent.status) continue
    const lines = LINES[personality]
    const previous = fun.lastStatus[agent.id]
    const message = previous === undefined ? lines.hello : agent.status === 'running' || agent.status === 'pending' ? lines.run
      : agent.status === 'failed' ? lines.error : agent.status === 'waiting' ? lines.ask : lines.done
    fun.bubbles[agent.id] = { text: message, until: now + 4000 }
    fun.lastStatus[agent.id] = agent.status
  }
  for (const run of state.codex?.runs ?? []) {
    if (!run.background) continue
    const key = '@codex-background:' + run.id
    if (fun.lastStatus[key] === 'running' && run.status === 'completed') {
      fun.bubbles.codex = { text: 'Xong!', until: now + 4000 }
      fun.bubbles['@main'] = { text: 'Xong rồi à?!', until: now + 4000 }
    }
    fun.lastStatus[key] = run.status
  }
}

/** Ap dụng hình ảnh lên bản sao scene, tuyệt đối không ghi agent/Codex/ghế thật. */
export function applyFun(state: MonitorState, agents: OfficeAgent[], now: number): void {
  const fun = prepareFun(state, agents, now)
  let fakeIndex = 0
  for (const agent of agents) {
    agent.personality = fun.personalities[agent.id]
    const reaction = fun.reactions[agent.id]
    if (reaction && reaction.until > now) agent.expression = agent.personality
    const fake = fun.fakeWork[agent.id]
    agent.fake = agent.zone === 'lounge' && !!fake && fake.bubbleUntil > now
    agent.typing = !!(agent.fake && fake && fake.workUntil > now)
    if (agent.fake && fake) {
      // Aisles between desks: never reserve or overwrite a real officeSeat.
      agent.funPosition = { x: 105 + fakeIndex % 2 * 96, y: 55 + Math.floor(fakeIndex++ / 2) * 48 }
      const bubble = fun.bubbles[agent.id]
      const hitAfterWork = reaction && reaction.until - 3000 >= fake.workUntil
      const speechAfterWork = bubble && bubble.until - 4000 >= fake.workUntil
      if (!agent.typing && agent.personality && !speechAfterWork && !hitAfterWork) {
        fun.bubbles[agent.id] = { text: LINES[agent.personality].done, until: fake.bubbleUntil }
      }
    }
    agent.speech = fun.bubbles[agent.id]?.until > now ? fun.bubbles[agent.id].text : undefined
    agent.sleeping = !(fun.awakeUntil[agent.id] > now) && (agent.kind === 'codex' && agent.background && agent.status === 'running'
      || agent.zone === 'lounge' && !agent.fake && !agent.speech && !agent.expression && !agent.tick
        && agent.status !== 'waiting' && agent.status !== 'failed')
  }
}

/** Tương tác thuần hình ảnh; caller chỉ truyền nhân vật đã xác thực từ scene. */
export function playFun(state: MonitorState, agent: OfficeAgent, type: 'whip' | 'work', now: number): void {
  const fun = state.fun
  const personality = fun?.personalities[agent.id]
  if (!fun || !personality) return
  if (type === 'work') {
    if (agent.zone !== 'lounge' || agent.fake) return
    fun.fakeWork[agent.id] = { from: now, workUntil: now + 15000, bubbleUntil: now + 19000 }
    delete fun.bubbles[agent.id]
    return
  }
  const previous = fun.reactions[agent.id]
  // Keep a five-second combo window even after the three-second face expires.
  if (previous && now < previous.until - 3000 + 400) return
  const count = previous && now - previous.at < 5000 ? previous.count + 1 : 1
  fun.reactions[agent.id] = { at: previous && count > 1 ? previous.at : now, until: now + 3000, count }
  const lines = LINES[personality]
  const message = agent.sleeping ? lines.wake : count >= 3 ? lines.high : lines.hit[Math.min(3, Math.floor(Math.random() * 4))]
  if (agent.sleeping) fun.awakeUntil[agent.id] = now + 60000
  fun.bubbles[agent.id] = { text: message, until: now + 3000 }
}

/** Mốc hết hạn kế tiếp; không cần timer nhanh khi mọi hiệu ứng đã kết thúc. */
export function nextFunDeadline(fun: FunState | undefined, now: number): number | undefined {
  if (!fun) return
  const deadlines = [
    ...Object.values(fun.reactions).flatMap(value => [value.until, value.at + 5000]),
    ...Object.values(fun.awakeUntil), ...Object.values(fun.bubbles).map(value => value.until),
    ...Object.values(fun.fakeWork).flatMap(value => [value.workUntil, value.bubbleUntil]),
  ].filter(until => until > now)
  return deadlines.length ? Math.min(...deadlines) : undefined
}
