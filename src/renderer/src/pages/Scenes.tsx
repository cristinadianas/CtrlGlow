import { useState, type ReactElement } from 'react'
import { EFFECT_BY_ID } from '../../../shared/effects'
import type { AppState, Preset } from '../../../shared/types'
import { CheckIcon, PencilIcon, PlusIcon, TrashIcon } from '../components/Icons'
import { LedPreview } from '../components/LedPreview'
import { api, patchState } from '../state'

type Dialog = { kind: 'save' } | { kind: 'rename'; preset: Preset } | { kind: 'delete'; preset: Preset } | null

export function ScenesPage({ state }: { state: AppState }): ReactElement {
  const [dialog, setDialog] = useState<Dialog>(null)
  const mine = state.presets.filter((p) => !p.builtIn)
  const builtIn = state.presets.filter((p) => p.builtIn)

  const apply = (p: Preset): void => {
    patchState((s) => ({ ...s, activePresetId: p.id, scene: p.scene }))
    void api.applyPreset(p.id)
  }

  const card = (p: Preset): ReactElement => {
    const on = p.id === state.activePresetId
    const custom = Object.keys(p.overrides).length
    return (
      <div key={p.id} role="button" tabIndex={0} className={`scene-card${on ? ' on' : ''}`} onClick={() => apply(p)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') apply(p)
        }}>
        <LedPreview scene={p.scene} leds={32} height={96} />
        {on && <span className="check"><CheckIcon size={13} /></span>}
        <div className="meta">
          <div style={{ minWidth: 0 }}>
            <div className="name">{p.name}</div>
            <div className="kind">{EFFECT_BY_ID[p.scene.effect].name}{custom ? ` · ${custom} custom` : ''}</div>
          </div>
          {!p.builtIn && (
            <div className="actions">
              <button type="button" className="icon-btn" aria-label={`Rename ${p.name}`} onClick={(e) => { e.stopPropagation(); setDialog({ kind: 'rename', preset: p }) }}>
                <PencilIcon size={15} />
              </button>
              <button type="button" className="icon-btn" aria-label={`Delete ${p.name}`} onClick={(e) => { e.stopPropagation(); setDialog({ kind: 'delete', preset: p }) }}>
                <TrashIcon size={15} />
              </button>
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="page-title-row">
        <div>
          <h1 className="page-title">Scenes</h1>
          <p className="page-subtitle">Saved looks for your whole PC. Click one to switch to it.</p>
        </div>
        <button type="button" className="btn primary" onClick={() => setDialog({ kind: 'save' })}>
          <PlusIcon size={14} /> Save Current Look
        </button>
      </div>

      {mine.length > 0 && (
        <>
          <div className="section-title">Your Scenes</div>
          <div className="scene-grid">{mine.map(card)}</div>
        </>
      )}

      <div className="section-title">Built-in</div>
      <div className="scene-grid">{builtIn.map(card)}</div>

      {dialog?.kind === 'save' && (
        <NameDialog title="Save Current Look" confirm="Save" initial="" placeholder="e.g. Late Night"
          onCancel={() => setDialog(null)} onConfirm={(name) => { void api.savePreset(name); setDialog(null) }} />
      )}
      {dialog?.kind === 'rename' && (
        <NameDialog title="Rename Scene" confirm="Rename" initial={dialog.preset.name}
          onCancel={() => setDialog(null)} onConfirm={(name) => { void api.renamePreset(dialog.preset.id, name); setDialog(null) }} />
      )}
      {dialog?.kind === 'delete' && (
        <div className="modal-backdrop" onClick={() => setDialog(null)}>
          <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <h3>Delete “{dialog.preset.name}”?</h3>
            <div style={{ color: 'var(--text-2)' }}>This only removes the saved scene. Your lights stay as they are.</div>
            <div className="actions">
              <button type="button" className="btn" onClick={() => setDialog(null)}>Cancel</button>
              <button type="button" className="btn primary" style={{ background: 'var(--red)' }}
                onClick={() => { void api.deletePreset(dialog.preset.id); setDialog(null) }}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function NameDialog({ title, confirm, initial, placeholder, onCancel, onConfirm }: {
  title: string
  confirm: string
  initial: string
  placeholder?: string
  onCancel: () => void
  onConfirm: (name: string) => void
}): ReactElement {
  const [name, setName] = useState(initial)
  const ok = name.trim().length > 0
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <input className="text-input" autoFocus value={name} placeholder={placeholder}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && ok) onConfirm(name.trim())
            if (e.key === 'Escape') onCancel()
          }} />
        <div className="actions">
          <button type="button" className="btn" onClick={onCancel}>Cancel</button>
          <button type="button" className="btn primary" disabled={!ok} style={{ opacity: ok ? 1 : 0.5 }} onClick={() => ok && onConfirm(name.trim())}>{confirm}</button>
        </div>
      </div>
    </div>
  )
}
