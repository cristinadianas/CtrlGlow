import { useEffect, useState, type ReactElement } from 'react'
import type { AppState } from '../../shared/types'
import { Toggle } from './components/Controls'
import { GearIcon, ScenesIcon, SparklesIcon, WarnIcon } from './components/Icons'
import { ALL_LIGHTS_BG, KindIcon } from './components/Kinds'
import { GroupPage } from './pages/Group'
import { HomePage } from './pages/Home'
import { ScenesPage } from './pages/Scenes'
import { SettingsPage } from './pages/Settings'
import { api, averageColor, groupLights, patchState, useAppState, useFrame, useServiceStatus, type LightGroup } from './state'

export type Route = { page: 'home' } | { page: 'group'; id: string } | { page: 'scenes' } | { page: 'settings' }

function initialRoute(): Route {
  const h = decodeURIComponent(location.hash.replace(/^#/, ''))
  if (h === 'scenes' || h === 'settings') return { page: h }
  if (h.startsWith('group:')) return { page: 'group', id: h.slice(6) }
  return { page: 'home' }
}

export function App(): ReactElement {
  const state = useAppState()
  const service = useServiceStatus()
  const [route, setRoute] = useState<Route>(initialRoute)

  const groups = state ? groupLights(state.lights) : []
  const group = route.page === 'group' ? groups.find((g) => g.id === route.id) : undefined

  useEffect(() => {
    if (route.page === 'group' && state && state.lights.length && !group) setRoute({ page: 'home' })
  }, [route, group, state])

  if (service === 'down') {
    return (
      <div className="service-down">
        <div className="card card-pad">
          <div className="brand-mark" style={{ width: 48, height: 48, borderRadius: 14, margin: '0 auto 16px' }} />
          <h2>Lumen isn't running</h2>
          <p>Open <strong>Lumen</strong> from the Start menu to start it again. Your lights keep their current colors in the meantime.</p>
        </div>
      </div>
    )
  }

  if (!state) {
    return (
      <div className="app">
        <aside className="sidebar"><div className="sidebar-top" /></aside>
        <main className="content"><div className="content-header" /></main>
      </div>
    )
  }

  const routeKey = route.page === 'group' ? `group:${route.id}` : route.page
  return (
    <div className="app">
      <Sidebar state={state} groups={groups} route={route} onNavigate={setRoute} />
      <main className="content">
        <div className="content-header" />
        <div className="page">
          <div className="page-inner fade-in" key={routeKey}>
            {state.connection !== 'connected' && <OfflineBanner state={state} />}
            {route.page === 'home' && <HomePage state={state} groups={groups} onNavigate={setRoute} />}
            {route.page === 'group' && group && <GroupPage state={state} group={group} />}
            {route.page === 'scenes' && <ScenesPage state={state} />}
            {route.page === 'settings' && <SettingsPage state={state} />}
          </div>
        </div>
      </main>
    </div>
  )
}

function Sidebar({ state, groups, route, onNavigate }: {
  state: AppState
  groups: LightGroup[]
  route: Route
  onNavigate: (r: Route) => void
}): ReactElement {
  const frame = useFrame(150)
  const allColor = averageColor(frame, state.lights.filter((l) => !l.hidden).map((l) => l.key))
  const dim = state.power ? 1 : 0.25
  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <div className="brand-mark" />
        <div className="brand-name">Lumen</div>
      </div>
      <nav className="nav">
        <NavItem active={route.page === 'home'} onClick={() => onNavigate({ page: 'home' })}
          icon={<span className="icon" style={{ background: ALL_LIGHTS_BG }}><SparklesIcon size={15} /></span>}
          label="All Lights" dot={allColor} dim={dim} />

        <div className="nav-section">Devices</div>
        {groups.map((g) => (
          <NavItem key={g.id} active={route.page === 'group' && route.id === g.id}
            onClick={() => onNavigate({ page: 'group', id: g.id })}
            icon={<KindIcon kind={g.kind} />} label={g.name}
            dot={averageColor(frame, g.lights.map((l) => l.key))} dim={dim} />
        ))}

        <div className="nav-section">Library</div>
        <NavItem active={route.page === 'scenes'} onClick={() => onNavigate({ page: 'scenes' })}
          icon={<span className="icon" style={{ background: 'linear-gradient(135deg, #ff6b8b, #ff2d55)' }}><ScenesIcon size={14} /></span>}
          label="Scenes" />
        <NavItem active={route.page === 'settings'} onClick={() => onNavigate({ page: 'settings' })}
          icon={<span className="icon" style={{ background: 'linear-gradient(135deg, #b4b4b9, #8a8a90)' }}><GearIcon size={15} /></span>}
          label="Settings" />
      </nav>

      <div className="sidebar-footer">
        <div className="power-row">
          <span>Lights</span>
          <Toggle label="Lights on" on={state.power} onChange={(on) => {
            patchState((s) => ({ ...s, power: on }))
            void api.setPower(on)
          }} />
        </div>
        <div className="status">
          <span className="status-dot" style={{ background: state.connection === 'connected' ? 'var(--green)' : state.connection === 'connecting' ? 'var(--orange)' : 'var(--red)' }} />
          {state.connection === 'connected' ? `Connected to ${state.serverName || 'OpenRGB'}` : state.connection === 'connecting' ? 'Connecting…' : 'OpenRGB not reachable'}
        </div>
      </div>
    </aside>
  )
}

function NavItem({ active, onClick, icon, label, dot, dim = 1 }: {
  active: boolean
  onClick: () => void
  icon: ReactElement
  label: string
  dot?: string
  dim?: number
}): ReactElement {
  return (
    <button type="button" className={`nav-item${active ? ' active' : ''}`} onClick={onClick} aria-current={active ? 'page' : undefined}>
      {icon}
      <span className="label">{label}</span>
      {dot && <span className="live-dot" style={{ background: dot, opacity: dim, boxShadow: `0 0 8px ${dot}` }} />}
    </button>
  )
}

function OfflineBanner({ state }: { state: AppState }): ReactElement {
  return (
    <div className="banner">
      <WarnIcon size={20} />
      <div className="grow">
        <strong style={{ color: 'var(--text)' }}>{state.connection === 'connecting' ? 'Connecting to OpenRGB…' : "Lumen can't reach OpenRGB"}</strong>
        The OpenRGB service talks to your hardware. Lumen keeps trying in the background.
      </div>
      <button type="button" className="btn" onClick={() => void api.reconnect()}>Try Again</button>
    </div>
  )
}
