import type { ClientSurface } from 'claude-code'

type PlayProps = {
  workArea: { x: number; y: number; w: number; h: number }
  frame: { w: number; h: number }
  view: { x: number; y: number; w: number; h: number }
  targets: Array<{ id: string; name: string; x: number; y: number; w: number; h: number; draggable: boolean }>
}
type PlayState = {
  props: PlayProps
  held?: { id: string; x: number; y: number }
  dragging: boolean
  col: number
  row: number
  hover: string
  clicks: number
  last: string
}

const MAX_HIT_TOLERANCE = 4
const DRAG_THRESHOLD = 1

/** Chỉ nhận hộp thân; nếu chồng hộp thì chọn tâm gần điểm nhất. */
function hitTarget(targets: PlayProps['targets'], x: number, y: number, tolX = 0, tolY = 0): PlayProps['targets'][number] | undefined {
  let inside: PlayProps['targets'][number] | undefined
  let insideDistance = Infinity
  for (const target of targets) {
    const distance = (x - target.x - target.w / 2) ** 2 + (y - target.y - target.h / 2) ** 2
    if (x >= target.x - tolX && x <= target.x + target.w + tolX
      && y >= target.y - tolY && y <= target.y + target.h + tolY
      && distance < insideDistance) { inside = target; insideDistance = distance }
  }
  return inside
}

/** Một listener mỗi instance; chỉ redraw khi hiển thị đổi, engine dọn lúc unmount. */
export default function officePlay(props: PlayProps, surface: ClientSurface<PlayState>) {
  const { Box, Text } = surface.elements
  let state = surface.state
  if (state === undefined) {
    const local: PlayState = { props, dragging: false, col: 0, row: 0, hover: '', clicks: 0, last: '' }
    surface.onPointer(event => {
      const { columns, rows } = surface
      if (columns <= 0 || rows <= 0) {
        delete local.held
        local.dragging = false
        local.hover = ''
        return
      }
      const col = event.x
      const row = event.y
      const { view, targets } = local.props
      const fx = Math.max(0, Math.min(1, (col + 0.5) / columns))
      const fy = Math.max(0, Math.min(1, (row + 0.5) / rows))
      const x = view.x + fx * view.w
      const y = view.y + fy * view.h
      const tolX = Math.min(MAX_HIT_TOLERANCE, 0.5 * view.w / columns)
      const tolY = Math.min(MAX_HIT_TOLERANCE, 0.5 * view.h / rows)
      const previousHover = local.hover
      const wasDragging = local.dragging
      const previousCol = local.col
      const previousRow = local.row
      let clicked = false
      if (event.type === 'down' && event.button === 'left') {
        const target = hitTarget(targets, x, y, tolX, tolY)
        local.clicks++
        local.last = target?.name ?? 'trượt'
        clicked = true
        local.held = target?.draggable ? { id: target.id, x: col, y: row } : undefined
        local.dragging = false
        if (target && !target.draggable) surface.post({ type: 'whip', id: target.id })
      } else if (local.held && (event.type === 'move' || event.type === 'leave')) {
        if (event.type === 'leave' || event.button !== 'left') {
          // Click thiếu up vẫn quất đúng một lần; mất capture khi kéo thì hủy kéo.
          if (!local.dragging) surface.post({ type: 'whip', id: local.held.id })
          delete local.held
          local.dragging = false
        } else {
          if (Math.hypot(col - local.held.x, row - local.held.y) > DRAG_THRESHOLD) local.dragging = true
          local.col = Math.max(0, Math.min(columns - 1, event.x))
          local.row = Math.max(0, Math.min(rows - 1, event.y))
        }
      } else if (local.held && event.type === 'up' && event.button === 'left') {
        const held = local.held
        if (local.dragging) {
          const area = local.props.workArea
          if (!area || (x >= area.x && x < area.x + area.w && y >= area.y && y < area.y + area.h)) {
            surface.post({ type: 'drop', id: held.id, x, y })
          }
        } else surface.post({ type: 'whip', id: held.id })
        delete local.held
        local.dragging = false
      }
      local.hover = event.type === 'leave' ? '' : hitTarget(targets, x, y)?.name ?? ''
      if (clicked || local.hover !== previousHover || local.dragging !== wasDragging
        || (local.dragging && (local.col !== previousCol || local.row !== previousRow))) surface.setState(local)
    })
    surface.setState(local)
    state = local
  }
  state.props = props
  const { columns, rows } = surface
  const measuring = columns <= 0 || rows <= 0
  return <Box position="relative" width="100%" height="100%" overflow="visible">
    {state.dragging && <Box position="absolute" top={state.row} left={state.col}><Text>✋</Text></Box>}
    <Box position="absolute" bottom={0} left={0}>
      <Text dimColor size="caption" wrap="truncate-end">{`🪢 ${measuring ? 'đang đo vùng…' : state.hover || 'Click nhân vật để quất'} · vùng ${columns}×${rows} · bấm ${state.clicks}${state.clicks ? ' → ' + state.last : ''}`}</Text>
    </Box>
  </Box>
}
