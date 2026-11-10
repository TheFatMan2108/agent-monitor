import type { ClientSurface } from 'claude-code'

type PlayProps = {
  frame: { w: number; h: number }
  view: { x: number; y: number; w: number; h: number }
  targets: Array<{ id: string; x: number; y: number; w: number; h: number; draggable: boolean }>
}
type PlayState = {
  props: PlayProps
  held?: { id: string; draggable: boolean; x: number; y: number }
  dragging: boolean
  col: number
  row: number
}

/** Một listener mỗi instance; chỉ redraw khi con trỏ đổi, engine dọn lúc unmount. */
export default function officePlay(props: PlayProps, surface: ClientSurface<PlayState>) {
  const { Box, Text } = surface.elements
  let state = surface.state
  if (state === undefined) {
    const local: PlayState = { props, dragging: false, col: 0, row: 0 }
    surface.onPointer(event => {
      if (surface.columns <= 0 || surface.rows <= 0) return
      const col = event.fine?.x ?? event.x + 0.5
      const row = event.fine?.y ?? event.y + 0.5
      const { frame, view, targets } = local.props
      const pxPerCol = frame.w / surface.columns
      const pxPerRow = frame.h / surface.rows
      const x = view.x + col * pxPerCol * view.w / frame.w
      const y = view.y + row * pxPerRow * view.h / frame.h
      if (event.type === 'down' && event.button === 'left') {
        let closest: PlayProps['targets'][number] | undefined
        let distance = Infinity
        for (const target of targets) {
          if (x < target.x - 6 || x > target.x + target.w + 6 || y < target.y - 6 || y > target.y + target.h + 6) continue
          const delta = (x - target.x - target.w / 2) ** 2 + (y - target.y - target.h / 2) ** 2
          if (delta < distance) { closest = target; distance = delta }
        }
        local.held = closest ? { id: closest.id, draggable: closest.draggable, x: col, y: row } : undefined
        local.dragging = false
      } else if (local.held && event.type === 'move') {
        if (event.button !== 'left') {
          delete local.held
          local.dragging = false
        } else {
          if (local.held.draggable && Math.hypot(col - local.held.x, row - local.held.y) > 1) local.dragging = true
          local.col = Math.max(0, Math.min(surface.columns - 1, event.x))
          local.row = Math.max(0, Math.min(surface.rows - 1, event.y))
        }
        surface.setState(local)
      } else if (local.held && event.type === 'up') {
        const held = local.held
        if (local.dragging) surface.post({ type: 'drop', id: held.id, x, y })
        else surface.post({ type: 'whip', id: held.id })
        delete local.held
        local.dragging = false
        surface.setState(local)
      }
    })
    surface.setState(local)
    state = local
  }
  state.props = props
  return <Box width="100%" height="100%">{state.dragging && <Box position="absolute" top={state.row} left={state.col}><Text>✋</Text></Box>}</Box>
}
