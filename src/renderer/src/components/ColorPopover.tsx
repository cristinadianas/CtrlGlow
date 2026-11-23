import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react'
import { hexToRgb, hsvToRgb, rgbToHex, rgbToHsv } from '../../../shared/color'

export const SWATCHES = [
  '#ffffff', '#ffd9a8', '#bfe3ff', '#ff3b30', '#ff6a1a', '#ff9f0a', '#ffd60a', '#a6ff00', '#34c759',
  '#00e5c0', '#00c7ff', '#0a84ff', '#3d5afe', '#7b61ff', '#bf5af2', '#ff2d95', '#ff6f91', '#d47800'
]

export function ColorPopover({ color, anchor, onChange, onClose }: {
  color: string
  anchor: DOMRect
  onChange: (hex: string) => void
  onClose: () => void
}): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const [hex, setHex] = useState(color)
  const [h, s] = rgbToHsv(...hexToRgb(color))
  const [pos, setPos] = useState({ left: anchor.left, top: anchor.bottom + 10 })

  useEffect(() => setHex(color), [color])

  useLayoutEffect(() => {
    const box = boxRef.current
    if (!box) return
    const w = box.offsetWidth
    const hgt = box.offsetHeight
    let left = anchor.left + anchor.width / 2 - w / 2
    let top = anchor.bottom + 10
    left = Math.max(12, Math.min(window.innerWidth - w - 12, left))
    if (top + hgt > window.innerHeight - 12) top = Math.max(12, anchor.top - hgt - 10)
    setPos({ left, top })
  }, [anchor])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Spectrum: hue across, saturation down (white at the bottom). Brightness lives in its own slider.
  useEffect(() => {
    const c = canvasRef.current
    if (!c) return
    const ctx = c.getContext('2d')
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    c.width = c.clientWidth * dpr
    c.height = c.clientHeight * dpr
    const hue = ctx.createLinearGradient(0, 0, c.width, 0)
    for (let i = 0; i <= 12; i++) {
      const [r, g, b] = hsvToRgb(i / 12, 1, 1)
      hue.addColorStop(i / 12, `rgb(${r},${g},${b})`)
    }
    ctx.fillStyle = hue
    ctx.fillRect(0, 0, c.width, c.height)
    const white = ctx.createLinearGradient(0, 0, 0, c.height)
    white.addColorStop(0, 'rgba(255,255,255,0)')
    white.addColorStop(1, 'rgba(255,255,255,1)')
    ctx.fillStyle = white
    ctx.fillRect(0, 0, c.width, c.height)
  }, [])

  const pick = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height))
    const [r, g, b] = hsvToRgb(Math.min(x, 0.9999), 1 - y, 1)
    onChange(rgbToHex(r, g, b))
  }

  return (
    <>
      <div className="popover-backdrop" onPointerDown={onClose} />
      <div ref={boxRef} className="popover" style={{ left: pos.left, top: pos.top }} role="dialog" aria-label="Choose a color">
        <div
          className="spectrum"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId)
            pick(e)
          }}
          onPointerMove={(e) => {
            if (e.buttons & 1) pick(e)
          }}
        >
          <canvas ref={canvasRef} />
          <div className="pin" style={{ left: `${h * 100}%`, top: `${(1 - s) * 100}%`, background: color }} />
        </div>
        <div className="mini-swatches">
          {SWATCHES.map((c) => (
            <button key={c} type="button" className="mini-swatch" style={{ background: c }} aria-label={c} onClick={() => onChange(c)} />
          ))}
        </div>
        <div className="hex-row">
          <div className="preview" style={{ background: color }} />
          <input
            className="text-input"
            value={hex}
            spellCheck={false}
            aria-label="Hex color"
            onChange={(e) => {
              const v = e.target.value.trim()
              setHex(v)
              const norm = v.startsWith('#') ? v : `#${v}`
              if (/^#[0-9a-f]{6}$/i.test(norm)) onChange(norm.toLowerCase())
            }}
          />
        </div>
      </div>
    </>
  )
}
