import { useEffect, useRef, type ReactElement } from 'react'
import { renderScene } from '../../../shared/effects'
import type { Scene } from '../../../shared/types'
import { animate } from '../state'

/**
 * A small canvas that plays a scene on a virtual LED strip, using the exact same
 * effect code that drives the hardware.
 */
export function LedPreview({ scene, leds = 24, height = 58, className }: {
  scene: Scene
  leds?: number
  height?: number
  className?: string
}): ReactElement {
  const ref = useRef<HTMLCanvasElement>(null)
  const sceneRef = useRef(scene)
  sceneRef.current = scene

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const buf = new Float32Array(leds * 3)
    let last = -1
    let visible = true
    const io = new IntersectionObserver((entries) => {
      visible = entries[0]?.isIntersecting ?? true
    })
    io.observe(canvas)

    const draw = (t: number): void => {
      if (!visible || t - last < 1 / 30) return
      last = t
      const dpr = window.devicePixelRatio || 1
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      if (canvas.width !== Math.round(w * dpr)) {
        canvas.width = Math.round(w * dpr)
        canvas.height = Math.round(h * dpr)
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      renderScene(sceneRef.current, { t, count: leds, phase: 0, seed: 0.37 }, buf)
      const level = 1
      ctx.clearRect(0, 0, w, h)
      ctx.fillStyle = '#0c0c0f'
      ctx.fillRect(0, 0, w, h)

      const cell = w / leds
      // soft diffused glow
      ctx.filter = `blur(${Math.max(6, cell * 0.9)}px)`
      for (let i = 0; i < leds; i++) {
        const o = i * 3
        ctx.fillStyle = `rgb(${buf[o] * level},${buf[o + 1] * level},${buf[o + 2] * level})`
        ctx.fillRect(i * cell - cell * 0.2, h * 0.18, cell * 1.4, h * 0.64)
      }
      ctx.filter = 'none'
      // crisp LED dots
      for (let i = 0; i < leds; i++) {
        const o = i * 3
        ctx.fillStyle = `rgb(${Math.min(255, buf[o] * 1.1 + 25)},${Math.min(255, buf[o + 1] * 1.1 + 25)},${Math.min(255, buf[o + 2] * 1.1 + 25)})`
        ctx.beginPath()
        ctx.arc(i * cell + cell / 2, h / 2, Math.min(2.6, cell * 0.22), 0, Math.PI * 2)
        ctx.fill()
      }
    }
    const stop = animate(draw)
    return () => {
      stop()
      io.disconnect()
    }
  }, [leds])

  return <canvas ref={ref} className={className} style={{ height }} />
}
