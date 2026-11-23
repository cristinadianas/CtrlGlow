import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from 'react'

export function Toggle({ on, onChange, disabled, label }: {
  on: boolean
  onChange: (on: boolean) => void
  disabled?: boolean
  label: string
}): ReactElement {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      className={`toggle${on ? ' on' : ''}`}
      onClick={() => onChange(!on)}
    />
  )
}

export function Slider({ value, min = 0, max = 100, onChange, label, start, end, fill }: {
  value: number
  min?: number
  max?: number
  onChange: (v: number) => void
  label: string
  start?: ReactNode
  end?: ReactNode
  fill?: string
}): ReactElement {
  const pct = ((value - min) / (max - min)) * 100
  return (
    <div className="slider-row">
      {start}
      <input
        className="slider"
        type="range"
        aria-label={label}
        min={min}
        max={max}
        value={value}
        style={{ '--pct': `${pct}%`, ...(fill ? { '--fill': fill } : {}) } as CSSProperties}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {end}
    </div>
  )
}

export function Segmented<T extends string>({ options, value, onChange, label }: {
  options: { value: T; label: string }[]
  value: T
  onChange: (v: T) => void
  label: string
}): ReactElement {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const [thumb, setThumb] = useState<{ left: number; width: number } | null>(null)
  const index = options.findIndex((o) => o.value === value)

  useLayoutEffect(() => {
    const el = refs.current[index]
    if (el) setThumb({ left: el.offsetLeft, width: el.offsetWidth })
  }, [index, options.length, options.map((o) => o.label).join('|')])

  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {thumb && index >= 0 && <div className="thumb" style={{ left: thumb.left, width: thumb.width }} />}
      {options.map((o, i) => (
        <button
          key={o.value}
          ref={(el) => {
            refs.current[i] = el
          }}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={o.value === value ? 'on' : ''}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Stepper({ value, min, max, onChange, label }: {
  value: number
  min: number
  max: number
  onChange: (v: number) => void
  label: string
}): ReactElement {
  const [text, setText] = useState(String(value))
  useLayoutEffect(() => setText(String(value)), [value])
  const commit = (v: number): void => {
    const n = Math.max(min, Math.min(max, Math.round(v)))
    setText(String(n))
    if (n !== value) onChange(n)
  }
  return (
    <div className="stepper" aria-label={label}>
      <button type="button" aria-label={`Decrease ${label}`} onClick={() => commit(value - 1)}>−</button>
      <input
        value={text}
        inputMode="numeric"
        onChange={(e) => setText(e.target.value.replace(/[^0-9]/g, ''))}
        onBlur={() => commit(Number(text || 0))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit(Number(text || 0))
        }}
      />
      <button type="button" aria-label={`Increase ${label}`} onClick={() => commit(value + 1)}>+</button>
    </div>
  )
}
