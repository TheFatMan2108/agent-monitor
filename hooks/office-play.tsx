import type { ClientSurface } from 'claude-code'

type PlayProps = {
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

const HIT_TOLERANCE = 6
const NEAREST_RADIUS = 40
const DRAG_THRESHOLD = 1

/** Ưu tiên hộp thân; chỉ dùng tâm gần nhất khi không có hộp nào trúng. */
function hitTarget(targets: PlayProps['targets'], x: number, y: number): PlayProps['targets'][number] | undefined {
  let inside: PlayProps['targets'][number] | undefined
  let nearest: PlayProps['targets'][number] | undefined
  let insideDistance = Infinity
  let nearestDistance = Infinity
  for (const target of targets) {
    const distance = (x - target.x - target.w / 2) ** 2 + (y - target.y - target.h / 2) ** 2
    if (distance < nearestDistance) { nearest = target; nearestDistance = distance }
    if (x >= target.x - HIT_TOLERANCE && x <= target.x + target.w + HIT_TOLERANCE
      && y >= target.y - HIT_TOLERANCE && y <= target.y + target.h + HIT_TOLERANCE
      && distance < insideDistance) { inside = target; insideDistance = distance }
  }
  return inside ?? (nearestDistance <= NEAREST_RADIUS ** 2 ? nearest : undefined)
}

/** Một listener mỗi instance; chỉ redraw khi hiển thị đổi, engine dọn lúc unmount. */
export default function officePlay(props: PlayProps, surface: ClientSurface<PlayState>) {
  const { Box, Text } = surface.elements
  let state = surface.state
  if (state === undefined) {
    const local: PlayState = { props, dragging: false, col: 0, row: 0, hover: '', clicks: 0, last: '' }
    surface.onPointer(event => {
      const col = event.fine?.x ?? event.x + 0.5
      const row = event.fine?.y ?? event.y + 0.5
      const { frame, view, targets } = local.props
      // Cùng quy đổi ô 8×18 với khung phủ; layout có thể chưa đo được vùng.
      const columns = surface.columns > 0 ? surface.columns : frame.w / 8
      const rows = surface.rows > 0 ? surface.rows : frame.h / 18
      const x = view.x + col * view.w / columns
      const y = view.y + row * view.h / rows
      const previousHover = local.hover
      const wasDragging = local.dragging
      const previousCol = local.col
      const previousRow = local.row
      let clicked = false
      if (event.type === 'down' && event.button === 'left') {
        const target = hitTarget(targets, x, y)
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
        if (local.dragging) surface.post({ type: 'drop', id: held.id, x, y })
        else surface.post({ type: 'whip', id: held.id })
        delete local.held
        local.dragging = false
      }
      if (event.type === 'move' && event.button === undefined) local.hover = hitTarget(targets, x, y)?.name ?? ''
      else if (event.type === 'leave') local.hover = ''
      if (clicked || local.hover !== previousHover || local.dragging !== wasDragging
        || (local.dragging && (local.col !== previousCol || local.row !== previousRow))) surface.setState(local)
    })
    surface.setState(local)
    state = local
  }
  state.props = props
  const columns = surface.columns > 0 ? surface.columns : props.frame.w / 8
  const rows = surface.rows > 0 ? surface.rows : props.frame.h / 18
  const estimated = surface.columns <= 0 || surface.rows <= 0
  return <Box position="relative" width="100%" height="100%" overflow="visible">
    {state.dragging && <Box position="absolute" top={state.row} left={state.col}><Text>✋</Text></Box>}
    <Box position="absolute" bottom={0} left={0}>
      <Text dimColor size="caption" wrap="truncate-end">{`🪢 ${state.hover || 'Click nhân vật để quất'} · vùng ${Math.round(columns * 10) / 10}×${Math.round(rows * 10) / 10}${estimated ? ' (ước lượng)' : ''} · bấm ${state.clicks}${state.clicks ? ' → ' + state.last : ''}`}</Text>
    </Box>
  </Box>
}
