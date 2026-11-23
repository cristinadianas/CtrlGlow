import { useEffect, useRef, type ReactElement, type ReactNode } from 'react'
import { DEFAULT_CALIBRATION, WHITE_GROUPS, whiteGroupFor } from '../../../shared/calibration'
import type { AppState, Calibration, Prefs, WhiteGroup } from '../../../shared/types'
import { Slider, Stepper, Toggle } from '../components/Controls'
import { FlashIcon } from '../components/Icons'
import { api, patchState, useRafThrottle } from '../state'

function Row({ title, detail, children }: { title: ReactNode; detail?: ReactNode; children?: ReactNode }): ReactElement {
  return (
    <div className="row">
      <div className="grow">
        <div className="title">{title}</div>
        {detail && <div className="detail">{detail}</div>}
      </div>
      {children}
    </div>
  )
}

export function SettingsPage({ state }: { state: AppState }): ReactElement {
  const prefs = state.prefs
  const setPrefs = (patch: Partial<typeof prefs>): void => {
    patchState((s) => ({ ...s, prefs: { ...s.prefs, ...patch } }))
    void api.setPrefs(patch)
  }
  const connectors = state.lights.filter((l) => l.kind === 'fans' || l.kind === 'connector')

  // Color matching (per-part white balance and brightness)
  const cal = prefs.calibration ?? DEFAULT_CALIBRATION
  const groups = WHITE_GROUPS.filter((g) => state.lights.some((l) => !l.hidden && l.ledCount > 0 && whiteGroupFor(l.kind) === g.id))
  const isDefaultCal = WHITE_GROUPS.every((g) => {
    const a = cal[g.id], b = DEFAULT_CALIBRATION[g.id]
    return a.warmth === b.warmth && a.tint === b.tint && a.brightness === b.brightness
  })
  const sendCal = useRafThrottle((c: Prefs['calibration']) => void api.setPrefs({ calibration: c }))
  const setWhite = (on: boolean): void => {
    patchState((s) => ({ ...s, whiteCheck: on }))
    void api.showWhite(on)
  }
  const adjust = (g: WhiteGroup, patch: Partial<Calibration>): void => {
    const next = { ...cal, [g]: { ...cal[g], ...patch } }
    patchState((s) => ({ ...s, prefs: { ...s.prefs, calibration: next } }))
    sendCal(next)
    if (!state.whiteCheck) setWhite(true) // matching is much easier against white
  }
  // Leaving Settings ends the white check.
  const whiteOn = useRef(state.whiteCheck)
  whiteOn.current = state.whiteCheck
  useEffect(() => () => {
    if (whiteOn.current) void api.showWhite(false)
  }, [])

  return (
    <>
      <div className="page-title-row">
        <div>
          <h1 className="page-title">Settings</h1>
          <p className="page-subtitle">How Lumen starts, runs and talks to your hardware.</p>
        </div>
      </div>

      <div className="section-title">General</div>
      <div className="card list">
        <Row title="Start Lumen when you sign in" detail="Runs quietly in the background, so your scene is back right after a restart.">
          <Toggle label="Start at sign in" on={prefs.launchAtLogin} onChange={(on) => setPrefs({ launchAtLogin: on })} />
        </Row>
        <Row title="Extra-smooth animations" detail="60 frames per second. Turn off for 30 fps and a little less CPU.">
          <Toggle label="60 fps animations" on={prefs.fps === 60} onChange={(on) => setPrefs({ fps: on ? 60 : 30 })} />
        </Row>
      </div>

      <div className="section-title">Color Matching</div>
      <div className="card list">
        <Row title="Show white on every light"
          detail="Compare the lights with your white case, and with each other, while you adjust. Turns off after two minutes, or when you leave Settings.">
          <Toggle label="Show white on every light" on={state.whiteCheck} onChange={setWhite} />
        </Row>
        {groups.map((g) => (
          <div className="row wb-row" key={g.id}>
            <div className="title wb-name">{g.name}</div>
            <div className="grow wb-sliders">
              <Slider label={`${g.name} warmth`} value={cal[g.id].warmth} onChange={(v) => adjust(g.id, { warmth: v })}
                start={<span className="slider-end">Cooler</span>} end={<span className="slider-end">Warmer</span>} />
              <Slider label={`${g.name} tint`} min={-50} max={50} value={cal[g.id].tint} onChange={(v) => adjust(g.id, { tint: v })}
                start={<span className="slider-end">Pinker</span>} end={<span className="slider-end">Greener</span>} />
              <Slider label={`${g.name} brightness`} min={30} max={100} value={cal[g.id].brightness} onChange={(v) => adjust(g.id, { brightness: v })}
                start={<span className="slider-end">Dimmer</span>} end={<span className="slider-end">Brighter</span>} />
            </div>
          </div>
        ))}
        <Row title="Recommended settings" detail="Measured on this PC: much less blue for the fans, strip, graphics card and motherboard; a little less blue and a lower brightness for the memory.">
          <button type="button" className="btn" disabled={isDefaultCal} style={{ opacity: isDefaultCal ? 0.4 : 1 }}
            onClick={() => {
              const next = structuredClone(DEFAULT_CALIBRATION)
              patchState((s) => ({ ...s, prefs: { ...s.prefs, calibration: next } }))
              void api.setPrefs({ calibration: next })
            }}>Reset</button>
        </Row>
      </div>
      <p className="note">
        Screens and LEDs show color differently, so Lumen converts every color for the LEDs: your lights match the
        previews in this app, and pastels and blends keep their color. LEDs also make white look bluish, which lets
        blue take over mixed scenes. Adjust each part until its white matches the case and the other parts.
      </p>

      <div className="section-title">Motherboard Lighting Connectors</div>
      <div className="card list">
        {connectors.map((l) => (
          <Row key={l.key} title={l.name}
            detail={`${l.zoneName} · ${l.resizable ? `${l.ledCount} LEDs` : '12V, one color'}${l.hidden ? ' · hidden' : ''}`}>
            {l.kind === 'fans' && (
              <span className="stepper-group" title="LEDs in one fan ring. Every fan on the hub shows these first LEDs as a loop.">
                <span className="stepper-caption">Per fan</span>
                <Stepper label="LEDs per fan ring" value={l.ringLeds ?? 0} min={0} max={Math.min(64, l.ledCount)}
                  onChange={(n) => {
                    patchState((s) => ({ ...s, lights: s.lights.map((x) => (x.key === l.key ? { ...x, ringLeds: n } : x)) }))
                    void api.setRingLeds(l.key, n)
                  }} />
              </span>
            )}
            {l.resizable && (
              <span className="stepper-group">
                <span className="stepper-caption">Total</span>
                <Stepper label="LED count" value={l.ledCount} min={0} max={l.maxLeds || 256}
                  onChange={(n) => {
                    patchState((s) => ({ ...s, lights: s.lights.map((x) => (x.key === l.key ? { ...x, ledCount: n } : x)) }))
                    void api.setLedCount(l.key, n)
                  }} />
              </span>
            )}
            <button type="button" className="btn" disabled={l.ledCount === 0} style={{ opacity: l.ledCount === 0 ? 0.4 : 1 }}
              onClick={() => void api.identify([l.key])}>
              <FlashIcon size={13} /> Flash
            </button>
            <Toggle label={`Show ${l.name}`} on={!l.hidden} onChange={(on) => {
              patchState((s) => ({ ...s, lights: s.lights.map((x) => (x.key === l.key ? { ...x, hidden: !on } : x)) }))
              void api.setLightHidden(l.key, !on)
            }} />
          </Row>
        ))}
      </div>
      <p className="note">
        Total is the longest chain on a connector: your case strip has 172 LEDs. Every fan ring has 20 LEDs and
        receives the first 20 of the signal, so effects play a full loop on each fan and continue along the strip.
        Parts that share a connector through a be quiet! hub always show the same lighting; moving a hub's cable to a
        free connector (PC switched off, 3-pin 5V connectors only, never the 4-pin 12V one) gives it its own controls.
      </p>

      <div className="section-title">OpenRGB</div>
      <div className="card list">
        <Row
          title={state.connection === 'connected' ? 'Connected' : state.connection === 'connecting' ? 'Connecting…' : 'Not connected'}
          detail={`${state.serverName || 'OpenRGB'} runs as a Windows service and talks to your hardware. Lumen connects to it on this PC only.`}>
          <button type="button" className="btn" onClick={() => void api.reconnect()}>Reconnect</button>
        </Row>
      </div>

      <div className="section-title">About</div>
      <div className="card list">
        <Row title="Lumen 0.1" detail="Lighting for your Ryzen 9 9950X3D · RTX 5080 AERO · X870E AORUS PRO build." />
        <Row title="Quit Lumen" detail="Stops the background service and closes this window. Your lights keep their current colors; animations stop.">
          <button type="button" className="btn danger" onClick={() => {
            void api.quit().finally(() => window.close())
          }}>Quit</button>
        </Row>
      </div>
    </>
  )
}
