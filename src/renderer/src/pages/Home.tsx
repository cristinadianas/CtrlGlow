import type { ReactElement } from 'react'
import { EFFECT_BY_ID } from '../../../shared/effects'
import type { AppState } from '../../../shared/types'
import type { Route } from '../App'
import { Slider, Toggle } from '../components/Controls'
import { SunIcon, SunSmallIcon } from '../components/Icons'
import { KindIcon } from '../components/Kinds'
import { PcPreview } from '../components/PcPreview'
import { SceneEditor } from '../components/SceneEditor'
import { api, averageColor, patchState, useFrame, useRafThrottle, useSceneSender, type LightGroup } from '../state'

export function HomePage({ state, groups, onNavigate }: {
  state: AppState
  groups: LightGroup[]
  onNavigate: (r: Route) => void
}): ReactElement {
  const send = useSceneSender()
  const sendBrightness = useRafThrottle((v: number) => void api.setBrightness(v))
  const frame = useFrame(150)
  const meta = EFFECT_BY_ID[state.scene.effect]
  const preset = state.presets.find((p) => p.id === state.activePresetId)
  const customCount = groups.filter((g) => g.lights.some((l) => l.scene)).length

  return (
    <>
      <div className="page-title-row">
        <div>
          <h1 className="page-title">All Lights</h1>
          <p className="page-subtitle">Every light in your PC, together.</p>
        </div>
      </div>

      <div className="card hero">
        <div className="hero-visual">
          <PcPreview lights={state.lights} power={state.power} brightness={state.brightness} />
        </div>
        <div className="hero-panel">
          <div>
            <div className="eyebrow">{preset ? 'Scene' : 'Now showing'}</div>
            <div className="hero-effect">{preset ? preset.name : meta.name}</div>
            <div className="hero-blurb">{preset ? `${meta.name} · ${meta.blurb}` : meta.blurb}</div>
            {customCount > 0 && (
              <div className="hero-blurb" style={{ marginTop: 8 }}>
                {customCount === 1 ? '1 device has' : `${customCount} devices have`} its own look.
              </div>
            )}
          </div>

          <div>
            <div className="slider-label">
              <span>Brightness</span>
              <span>{state.brightness}%</span>
            </div>
            <Slider label="Brightness" min={1} value={state.brightness}
              start={<SunSmallIcon size={16} />} end={<SunIcon size={18} />}
              onChange={(v) => {
                patchState((s) => ({ ...s, brightness: v }))
                sendBrightness(v)
              }} />
          </div>

          <div className="power-row" style={{ background: 'var(--well)' }}>
            <span>Lights</span>
            <Toggle label="Lights on" on={state.power} onChange={(on) => {
              patchState((s) => ({ ...s, power: on }))
              void api.setPower(on)
            }} />
          </div>

          <div>
            <div className="eyebrow" style={{ marginBottom: 10 }}>Quick scenes</div>
            <div className="chip-row">
              {state.presets.slice(0, 6).map((p) => (
                <button key={p.id} type="button" className="btn" style={p.id === state.activePresetId ? { background: 'var(--accent)', color: '#fff' } : undefined}
                  onClick={() => {
                    patchState((s) => ({ ...s, activePresetId: p.id, scene: p.scene }))
                    void api.applyPreset(p.id)
                  }}>
                  {p.name}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <SceneEditor scene={state.scene} onChange={(s) => send({ kind: 'all' }, s)} />

      <div className="section-title">Devices</div>
      <div className="device-grid">
        {groups.map((g) => {
          const custom = g.lights.filter((l) => l.scene)
          const sub = custom.length === 0
            ? 'Matching All Lights'
            : custom.length === g.lights.length && g.lights.every((l) => l.scene?.effect === custom[0].scene?.effect)
              ? `Own look · ${EFFECT_BY_ID[custom[0].scene!.effect].name}`
              : 'Partly custom'
          const color = averageColor(frame, g.lights.map((l) => l.key))
          return (
            <button key={g.id} type="button" className="device-tile" onClick={() => onNavigate({ page: 'group', id: g.id })}>
              <span className="glow" style={{ background: color, opacity: state.power ? 0.55 : 0.1 }} />
              <KindIcon kind={g.kind} size={34} iconSize={18} />
              <div>
                <div className="name">{g.name}</div>
                <div className="sub">{sub}</div>
              </div>
            </button>
          )
        })}
      </div>
    </>
  )
}
