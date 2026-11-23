import type { ReactElement, ReactNode, SVGProps } from 'react'

type P = SVGProps<SVGSVGElement> & { size?: number }

function Svg({ size = 16, children, ...rest }: P & { children: ReactNode }): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      {children}
    </svg>
  )
}

export const SparklesIcon = (p: P): ReactElement => (
  <Svg {...p}>
    <path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z" fill="currentColor" stroke="none" />
    <path d="M19 15l.7 1.8 1.8.7-1.8.7L19 20l-.7-1.8-1.8-.7 1.8-.7z" fill="currentColor" stroke="none" />
  </Svg>
)

export const FanIcon = (p: P): ReactElement => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
    <path d="M12 10.4c0-3 .8-6.4 3.4-6.4 2.4 0 2.9 3.2.2 5.2" />
    <path d="M13.4 12.8c2.6 1.5 5.1 3.9 3.8 6.1-1.2 2.1-4.2.9-4.5-2.4" />
    <path d="M10.6 12.8c-2.6 1.5-5.9 2.5-7.2.2-1.2-2.1 1.3-4.1 4.4-2.8" />
  </Svg>
)

export const GpuIcon = (p: P): ReactElement => (
  <Svg {...p}>
    <rect x="2.5" y="6" width="19" height="10" rx="2" />
    <circle cx="9" cy="11" r="2.6" />
    <circle cx="16" cy="11" r="2.6" />
    <path d="M5 16v2.5M8 16v2.5" />
  </Svg>
)

export const RamIcon = (p: P): ReactElement => (
  <Svg {...p}>
    <rect x="3" y="7" width="18" height="9" rx="1.5" />
    <path d="M6.5 10v3M10.5 10v3M14.5 10v3M18 10v3M5 16v2M19 16v2" />
  </Svg>
)

export const BoardIcon = (p: P): ReactElement => (
  <Svg {...p}>
    <rect x="3.5" y="3.5" width="17" height="17" rx="2.5" />
    <rect x="8" y="8" width="6" height="6" rx="1" />
    <path d="M17 7v4M17 14v3M7 17h4" />
  </Svg>
)

export const PlugIcon = (p: P): ReactElement => (
  <Svg {...p}>
    <path d="M9 3v5M15 3v5M7 8h10v3a5 5 0 01-10 0zM12 16v5" />
  </Svg>
)

export const ScenesIcon = (p: P): ReactElement => (
  <Svg {...p}>
    <rect x="3.5" y="3.5" width="7" height="7" rx="2" />
    <rect x="13.5" y="3.5" width="7" height="7" rx="2" />
    <rect x="3.5" y="13.5" width="7" height="7" rx="2" />
    <rect x="13.5" y="13.5" width="7" height="7" rx="2" />
  </Svg>
)

export const GearIcon = (p: P): ReactElement => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" />
  </Svg>
)

export const SunSmallIcon = (p: P): ReactElement => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M12 5.5v1M12 17.5v1M5.5 12h1M17.5 12h1" />
  </Svg>
)

export const SunIcon = (p: P): ReactElement => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
  </Svg>
)

export const SlowIcon = (p: P): ReactElement => (
  <Svg {...p}>
    <path d="M11 8l-4 4 4 4" />
  </Svg>
)

export const FastIcon = (p: P): ReactElement => (
  <Svg {...p}>
    <path d="M7 8l4 4-4 4M13 8l4 4-4 4" />
  </Svg>
)

export const CheckIcon = (p: P): ReactElement => (
  <Svg {...p} strokeWidth={2.6}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </Svg>
)

export const PlusIcon = (p: P): ReactElement => (
  <Svg {...p} strokeWidth={2.2}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
)

export const MinusIcon = (p: P): ReactElement => (
  <Svg {...p} strokeWidth={2.2}>
    <path d="M5 12h14" />
  </Svg>
)

export const TrashIcon = (p: P): ReactElement => (
  <Svg {...p}>
    <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V4h6v3" />
  </Svg>
)

export const PencilIcon = (p: P): ReactElement => (
  <Svg {...p}>
    <path d="M4 20h4L19 9a2.8 2.8 0 00-4-4L4 16z" />
  </Svg>
)

export const FlashIcon = (p: P): ReactElement => (
  <Svg {...p}>
    <path d="M13 2.5L5 13.5h6l-1 8 8-11h-6z" fill="currentColor" stroke="none" />
  </Svg>
)

export const WarnIcon = (p: P): ReactElement => (
  <Svg {...p}>
    <path d="M12 3.5L2.5 20h19z" />
    <path d="M12 10v4.5M12 17.5v.01" />
  </Svg>
)

export const PowerIcon = (p: P): ReactElement => (
  <Svg {...p}>
    <path d="M12 3v8" />
    <path d="M6.3 6.8a8 8 0 1011.4 0" />
  </Svg>
)
