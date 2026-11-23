import { useState, type ReactElement } from 'react'
import { hexToRgb, hsvToRgb, rgbToHex, rgbToHsv } from '../../../shared/color'
import { EFFECTS, EFFECT_BY_ID, effectColors, withEffect } from '../../../shared/effects'
import type { Scene } from '../../../shared/types'
import { ColorPopover, SWATCHES } from './ColorPopover'
import { Segmented, Slider } from './Controls'
import { FastIcon, MinusIcon, PlusIcon, SlowIcon, SunIcon, SunSmallIcon } from './Icons'
import { LedPreview } from './LedPreview'

function nextColor(colors: string[]): string {
  const last = colors[colors.length - 1] ?? '#ff8a1f'
  const [h, s, v] = rgbToHsv(...hexToRgb(last))
  const [r, g, b] = hsvToRgb(h + 0.14, Math.max(0.55, s), Math.max(0.8, v))
  return rgbToHex(r, g, b)
}

/** A first background for Comet/Starlight: a deep, dim tone of the streak's own color. */
function dimOf(color: string | undefined): string {
  const [r, g, b] = hexToRgb(color ?? '#ffffff')
  return rgbToHex(r * 0.12, g * 0.12, b * 0.12)
}

/** A color slot in the editor: one of the scene's colors, or the background. */
type Slot = number | 'bg'

export function SceneEditor({ scene, onChange, showLevel = false }: {
  scene: Scene
  onChange: (scene: Scene) => void
  showLevel?: boolean
}): ReactElement {
  const meta = EFFECT_BY_ID[scene.effect]
  const [slot, setSlot] = useState<Slot>(0)
  const [popover, setPopover] = useState<{ slot: Slot; rect: DOMRect } | null>(null)
  const colors = effectColors(scene)
  const hasBg = meta.background !== undefined
  const bg = hasBg ? scene.background : undefined
  const selected: Slot = slot === 'bg' ? (bg ? 'bg' : 0) : Math.min(slot, Math.max(0, colors.length - 1))
  const colorAt = (s: Slot): string | undefined => (s === 'bg' ? bg : colors[s])

  const setColor = (s: Slot, hex: string): void => {
    if (s === 'bg') return onChange({ ...scene, background: hex })
    const next = [...scene.colors] // keeps colors this effect doesn't show, for when the user switches back
    next[s] = hex
    onChange({ ...scene, colors: next })
  }
  const removeBackground = (): void => {
    const next = { ...scene }
    delete next.background
    onChange(next)
    setSlot(0)
  }

  return (
    <>
      <div className="section-title">Effect</div>
      <div className="effects-grid">
        {EFFECTS.map((e) => {
          const on = e.id === scene.effect
          const preview = on ? scene : { ...withEffect(scene, e.id), speed: Math.max(scene.speed, 30) }
          return (
            <button key={e.id} type="button" className={`effect-tile${on ? ' on' : ''}`} aria-pressed={on} onClick={() => onChange(withEffect(scene, e.id))}>
              <LedPreview scene={preview} />
              <div className="meta">
                <div className="name">{e.name}</div>
                <div className="blurb">{e.blurb}</div>
              </div>
            </button>
          )
        })}
      </div>

      <div className="card card-pad" style={{ marginTop: 16 }}>
        <div className="controls-grid">
          <div>
            <div className="control-label">
              <span>{colors.length > 1 ? 'Colors' : 'Color'}</span>
              {meta.colors.max > 1 && <span className="hint">Up to {meta.colors.max}</span>}
            </div>
            {colors.length === 0 ? (
              <div className="note" style={{ margin: 0 }}>{meta.name} uses the whole spectrum, so there's nothing to pick here.</div>
            ) : (
              <>
                <div className="swatches">
                  {colors.map((c, i) => (
                    <div key={i}>
                      <button
                        type="button"
                        className={`swatch${i === selected && (colors.length > 1 || bg) ? ' selected' : ''}`}
                        style={{ background: c }}
                        aria-label={`${meta.colors.labels?.[i] ?? `Color ${i + 1}`}: ${c}. Click to change`}
                        onClick={(ev) => {
                          setSlot(i)
                          setPopover({ slot: i, rect: ev.currentTarget.getBoundingClientRect() })
                        }}
                      />
                      {meta.colors.labels && <div className="swatch-label">{meta.colors.labels[i]}</div>}
                    </div>
                  ))}
                  {colors.length < meta.colors.max && (
                    <button type="button" className="swatch add" aria-label="Add a color" onClick={() => {
                      onChange({ ...scene, colors: [...colors, nextColor(colors)] })
                      setSlot(colors.length)
                    }}>
                      <PlusIcon size={15} />
                    </button>
                  )}
                  {hasBg && (
                    <div>
                      {bg ? (
                        <button
                          type="button"
                          className={`swatch${selected === 'bg' ? ' selected' : ''}`}
                          style={{ background: bg }}
                          aria-label={`Background: ${bg}. Click to change`}
                          onClick={(ev) => {
                            setSlot('bg')
                            setPopover({ slot: 'bg', rect: ev.currentTarget.getBoundingClientRect() })
                          }}
                        />
                      ) : (
                        <button type="button" className="swatch add" aria-label="Add a background color (now dark)" onClick={() => {
                          onChange({ ...scene, background: dimOf(colors[0]) })
                          setSlot('bg')
                        }}>
                          <PlusIcon size={15} />
                        </button>
                      )}
                      <div className="swatch-label">{bg ? 'Background' : 'Dark'}</div>
                    </div>
                  )}
                  {selected === 'bg' ? (
                    <button type="button" className="swatch add" aria-label="Remove the background (back to dark)" onClick={removeBackground}>
                      <MinusIcon size={15} />
                    </button>
                  ) : colors.length > Math.max(1, meta.colors.min) && (
                    <button type="button" className="swatch add" aria-label="Remove the selected color" onClick={() => {
                      // An explicit removal: drop any kept colors too, so none of them pops into the freed slot.
                      const next = colors.filter((_, i) => i !== selected)
                      onChange({ ...scene, colors: next })
                      setSlot(Math.max(0, selected - 1))
                    }}>
                      <MinusIcon size={15} />
                    </button>
                  )}
                </div>
                <div className="mini-swatches" style={{ marginTop: 18 }}>
                  {SWATCHES.map((c) => (
                    <button key={c} type="button" className="mini-swatch" style={{ background: c }} aria-label={`Use ${c}`} onClick={() => setColor(selected, c)} />
                  ))}
                </div>
              </>
            )}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
            {meta.speed && (
              <div>
                <div className="slider-label">
                  <span>Speed</span>
                  <span>{scene.effect === 'gradient' && scene.speed === 0 ? 'Still' : ''}</span>
                </div>
                <Slider label="Speed" value={scene.speed} onChange={(v) => onChange({ ...scene, speed: v })}
                  start={<SlowIcon size={16} />} end={<FastIcon size={16} />} />
              </div>
            )}
            {scene.effect === 'wave' && (
              <div>
                <div className="slider-label"><span>Style</span></div>
                <Segmented
                  label="Style"
                  options={[{ value: 'flow', label: 'Flowing' }, { value: 'bands', label: 'Bands' }]}
                  value={scene.bands ? 'bands' : 'flow'}
                  onChange={(v) => {
                    const next = { ...scene }
                    if (v === 'bands') next.bands = true
                    else delete next.bands
                    onChange(next)
                  }}
                />
              </div>
            )}
            {meta.direction && (
              <div>
                <div className="slider-label"><span>Direction</span></div>
                <Segmented
                  label="Direction"
                  options={[{ value: 'forward', label: 'Forward' }, { value: 'reverse', label: 'Reverse' }]}
                  value={scene.reverse ? 'reverse' : 'forward'}
                  onChange={(v) => onChange({ ...scene, reverse: v === 'reverse' })}
                />
              </div>
            )}
            {showLevel && (
              <div>
                <div className="slider-label">
                  <span>Brightness</span>
                  <span>{scene.level}%</span>
                </div>
                <Slider label="Brightness" min={1} value={scene.level} onChange={(v) => onChange({ ...scene, level: v })}
                  start={<SunSmallIcon size={16} />} end={<SunIcon size={18} />} />
              </div>
            )}
            {!meta.speed && !meta.direction && !showLevel && (
              <div className="note" style={{ margin: 0 }}>A steady, solid color. Pick one of the swatches, or click the color to fine-tune it.</div>
            )}
          </div>
        </div>
      </div>

      {popover && colorAt(popover.slot) && (
        <ColorPopover
          color={colorAt(popover.slot)!}
          anchor={popover.rect}
          onChange={(hex) => setColor(popover.slot, hex)}
          onClose={() => setPopover(null)}
        />
      )}
    </>
  )
}
