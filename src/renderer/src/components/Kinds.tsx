import type { ReactElement } from 'react'
import type { LightKind } from '../../../shared/types'
import { BoardIcon, FanIcon, GpuIcon, PlugIcon, RamIcon, SparklesIcon } from './Icons'

export const KIND_STYLE: Record<LightKind, { bg: string; Icon: (p: { size?: number }) => ReactElement }> = {
  fans: { bg: 'linear-gradient(135deg, #3ec6ff, #0a7cff)', Icon: FanIcon },
  gpu: { bg: 'linear-gradient(135deg, #5fe07c, #24b047)', Icon: GpuIcon },
  ram: { bg: 'linear-gradient(135deg, #ffb340, #ff8400)', Icon: RamIcon },
  board: { bg: 'linear-gradient(135deg, #9a98ff, #5856e8)', Icon: BoardIcon },
  connector: { bg: 'linear-gradient(135deg, #b4b4b9, #8a8a90)', Icon: PlugIcon },
  other: { bg: 'linear-gradient(135deg, #b4b4b9, #8a8a90)', Icon: SparklesIcon }
}

export const ALL_LIGHTS_BG = 'linear-gradient(135deg, #ff9a2e, #ff5e8a 55%, #6c5cff)'

export function KindIcon({ kind, size = 26, iconSize = 15 }: { kind: LightKind; size?: number; iconSize?: number }): ReactElement {
  const { bg, Icon } = KIND_STYLE[kind]
  return (
    <span className="icon" style={{ background: bg, width: size, height: size }}>
      <Icon size={iconSize} />
    </span>
  )
}
