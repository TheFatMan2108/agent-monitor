import type { ClientSurface } from 'claude-code'

type ResizeProps = { width: number; height: number }
type Size = { w: number; h: number }
type ResizeState = {
  props: ResizeProps
  width: number
  height: number
  dragging: boolean
  startX: number
  startY: number
  startWidth: number
  startHeight: number
  pending?: Size
}

const CELL_WIDTH = 8
const CELL_HEIGHT = 18
// Surface module chạy riêng, không import được hằng từ hooks/office.
const SIZE_LIMITS = { minWidth: 160, maxWidth: 1280, minHeight: 105, maxHeight: 840 } as const

function snap(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value / 8) * 8))
}

/** Một listener và timer mỗi instance; engine tự dọn khi Client unmount. */
export default function officeResize(props: ResizeProps, surface: ClientSurface<ResizeState>) {
  const { Box, Text } = surface.elements
  let state = surface.state
  if (state === undefined) {
    const local: ResizeState = {
      props, width: props.width, height: props.height, dragging: false,
      startX: 0, startY: 0, startWidth: props.width, startHeight: props.height,
    }
    const finish = () => {
      local.dragging = false
      if (local.width !== local.startWidth || local.height !== local.startHeight) {
        surface.post({ type: 'resize', w: local.width, h: local.height, done: true })
      }
      delete local.pending
    }
    surface.onPointer(event => {
      if (event.type === 'down' && event.button === 'left') {
        local.dragging = true
        local.startX = event.fine?.x ?? event.x
        local.startY = event.fine?.y ?? event.y
        local.startWidth = local.width = local.props.width
        local.startHeight = local.height = local.props.height
      } else if (local.dragging && (event.type === 'up' || (event.type === 'move' && event.button === undefined))) {
        finish()
      } else if (local.dragging && event.type === 'move') {
        const width = snap(local.startWidth + ((event.fine?.x ?? event.x) - local.startX) * CELL_WIDTH,
          SIZE_LIMITS.minWidth, SIZE_LIMITS.maxWidth)
        const height = snap(local.startHeight + ((event.fine?.y ?? event.y) - local.startY) * CELL_HEIGHT,
          SIZE_LIMITS.minHeight, SIZE_LIMITS.maxHeight)
        if (width !== local.width || height !== local.height) {
          local.width = width
          local.height = height
          local.pending = { w: width, h: height }
          surface.setState(local)
        }
      }
    })
    surface.every(100, () => {
      if (!local.pending) return
      surface.post({ type: 'resize', ...local.pending })
      delete local.pending
    })
    surface.setState(local)
    state = local
  }
  if (!state.dragging && (state.props.width !== props.width || state.props.height !== props.height)) {
    state.width = props.width
    state.height = props.height
  }
  state.props = props
  return <Box borderStyle="round" paddingX={1}><Text dimColor>⤡ Giữ và kéo ở đây: ngang đổi rộng, dọc đổi cao · {state.width}×{state.height}</Text></Box>
}
