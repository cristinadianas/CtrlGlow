import { useEffect, useState, type ReactElement } from 'react'
import { EFFECT_BY_ID } from '../../../shared/effects'
import type { AppState, LightKind } from '../../../shared/types'
import { Segmented, Toggle } from '../components/Controls'
import { FlashIcon } from '../components/Icons'
import { PcPreview } from '../components/PcPreview'
import { SceneEditor } from '../components/SceneEditor'
import { api, patchState, useSceneSender, type LightGroup } from '../state'

const ABOUT: Partial<Record<LightKind, string>> = {
  fans:
    'The AIO pump, all 10 fans and the side light strip share motherboard connector 1 through be quiet! hubs, ' +
    'so they always light up together. Effects play a full loop on every 20-LED fan ring and continue along the ' +
    '172-LED strip, so every color shows up everywhere. Two connectors are free if you ever want to split them; see Settings.',
  ram: 'Each Kingston FURY stick has 12 LEDs. Choose a stick above to give it its own look.',
  gpu: 'The RTX 5080 AERO has a single lighting zone, so it shows one color at a time. Animated effects change that color over time.',
  board: 'Two accent zones on the X870E AORUS PRO: the I/O cover (10 LEDs) and the chipset (4 LEDs).',
  connector: 'Nothing is plugged into this connector right now. Set its LED count in Settings after connecting something.'
}

export function GroupPage({ state, group }: { state: AppState; group: LightGroup }): ReactElement {
  const send = useSceneSender()
  const [sel, setSel] = useState<string>('all')
  useEffect(() => setSel('all'), [group.id])

  const targets = sel === 'all' ? group.lights : group.lights.filter((l) => l.key === sel)
  const keys = targets.map((l) => l.key)
  const synced = targets.every((l) => !l.scene)
  const mixed = !synced && targets.some((l) => !l.scene || JSON.stringify(l.scene) !== JSON.stringify(targets[0].scene))
  const editing = targets.find((l) => l.scene)?.scene ?? state.scene
  const leds = group.lights.reduce((n, l) => n + l.ledCount, 0)
  const single = group.lights.length === 1 ? group.lights[0] : sel !== 'all' ? targets[0] : null
  const notResponding = state.connection === 'connected' && group.lights.some((l) => !l.online)

  const [name, setName] = useState(single?.name ?? '')
  useEffect(() => setName(single?.name ?? ''), [single?.key, single?.name])

  return (
    <>
      <div className="page-title-row">
        <div>
          <h1 className="page-title">{group.name}</h1>
          <p className="page-subtitle">
            {group.lights[0]?.deviceName} · {leds} {leds === 1 ? 'LED' : 'LEDs'}
            {notResponding && <span style={{ color: 'var(--orange)' }}> · Not responding (changes apply when it&apos;s back)</span>}
          </p>
        </div>
        <button type="button" className="btn" onClick={() => void api.identify(keys)} title="Flashes this device so you can spot it in your PC">
          <FlashIcon size={14} /> Flash to Find
        </button>
      </div>

      <div className="card hero">
        <div className="hero-visual">
          <PcPreview lights={state.lights} focus={group.id} power={state.power} brightness={state.brightness} />
        </div>
        <div className="hero-panel">
          <div>
            <div className="eyebrow">{synced ? 'Following' : 'Own look'}</div>
            <div className="hero-effect">{synced ? 'All Lights' : mixed ? 'Mixed' : EFFECT_BY_ID[editing.effect].name}</div>
            <div className="hero-blurb">
              {synced ? 'Changes on the All Lights page apply here too.' : mixed ? 'These lights have different looks. Editing below updates all of them.' : EFFECT_BY_ID[editing.effect].blurb}
            </div>
          </div>

          {group.lights.length > 1 && (
            <Segmented
              label="Which lights to edit"
              options={[{ value: 'all', label: `Both` }, ...group.lights.map((l) => ({ value: l.key, label: l.name }))].map((o, i) =>
                i === 0 && group.lights.length > 2 ? { ...o, label: 'All' } : o
              )}
              value={sel}
              onChange={setSel}
            />
          )}

          <div className="power-row" style={{ background: 'var(--well)' }}>
            <span>Match All Lights</span>
            <Toggle label="Match All Lights" on={synced} onChange={(on) => send({ kind: 'lights', keys }, on ? null : { ...editing })} />
          </div>

          {single && (
            <div>
              <div className="eyebrow" style={{ marginBottom: 8 }}>Name</div>
              <input
                className="text-input"
                value={name}
                placeholder={single.defaultName}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => {
                  if (name.trim() !== single.name) {
                    patchState((s) => ({ ...s, lights: s.lights.map((l) => (l.key === single.key ? { ...l, name: name.trim() || l.defaultName } : l)) }))
                    void api.renameLight(single.key, name)
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur()
                }}
              />
            </div>
          )}
        </div>
      </div>

      {synced ? (
        <div className="card card-pad" style={{ marginTop: 16, color: 'var(--text-2)' }}>
          This device follows <strong style={{ color: 'var(--text)' }}>All Lights</strong>. Turn off “Match All Lights” to give it its own color, effect and brightness.
        </div>
      ) : (
        <SceneEditor scene={editing} showLevel onChange={(s) => send({ kind: 'lights', keys }, s)} />
      )}

      {ABOUT[group.kind] && <p className="note" style={{ marginTop: 18 }}>{ABOUT[group.kind]}</p>}
    </>
  )
}
