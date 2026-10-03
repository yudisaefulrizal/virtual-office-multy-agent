import { useEffect, useState } from 'react';
import { api, useLive } from './api';
import { DecisionPage, DecisionsPage } from './pages/DecisionPage';
import { KnowledgePage } from './pages/KnowledgePage';
import { ObjectivePage } from './pages/ObjectivePage';
import { ObjectivesPage } from './pages/ObjectivesPage';
import { OfficePage } from './pages/OfficePage';
import { SettingsPage } from './pages/SettingsPage';

function useHashRoute() {
  const [hash, setHash] = useState(() => window.location.hash || '#/');
  useEffect(() => {
    const on = () => setHash(window.location.hash || '#/');
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash.slice(1);
}

function QuotaMeter() {
  const { data } = useLive(api.office);
  const rt = data?.runtimes.find((r) => r.id === 'claude-cli');
  if (data?.forceRuntime) {
    return (
      <div className="quota">
        <div className="quota-row">
          <span style={{ fontWeight: 600 }}>Mode {data.forceRuntime}</span>
        </div>
        <div className="small muted">Semua agent memakai runtime {data.forceRuntime}. Kuota Claude tidak terpakai.</div>
      </div>
    );
  }
  if (!rt?.quota) return null;
  const pct = Math.min(100, Math.round((rt.quota.used / rt.quota.max) * 100));
  return (
    <div className="quota">
      <div className="quota-row">
        <span style={{ fontWeight: 600 }}>Kuota Claude CLI</span>
        <span className="mono muted">
          {rt.quota.used}/{rt.quota.max} run
        </span>
      </div>
      <div className={`meter${pct >= 80 ? ' warn' : ''}`}>
        <span style={{ width: `${pct}%` }} />
      </div>
      <div className="small muted">
        {rt.cooldownUntil
          ? `Ditunda sampai ${new Date(rt.cooldownUntil).toLocaleTimeString('id-ID')}`
          : `Jendela ${rt.quota.windowHours} jam terakhir`}
      </div>
    </div>
  );
}

function PendingBadge() {
  const { data } = useLive(api.decisions);
  const n = data?.filter((d) => d.status === 'proposed').length ?? 0;
  return n > 0 ? <span className="badge" aria-label={`${n} menunggu`}>{n}</span> : null;
}

export function App() {
  const route = useHashRoute();
  const objectiveMatch = route.match(/^\/objectives\/([0-9a-f-]{36})$/);
  const decisionMatch = route.match(/^\/decisions\/([0-9a-f-]{36})$/);
  const section = route.startsWith('/objectives')
    ? 'objectives'
    : route.startsWith('/decisions')
      ? 'decisions'
      : route.startsWith('/settings')
        ? 'settings'
        : route.startsWith('/knowledge')
          ? 'knowledge'
          : 'office';

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <a href="#/" className="brand">
            <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="#23282E" strokeWidth="2" aria-hidden="true">
              <rect x="2" y="2" width="24" height="24" />
              <path d="M2 12h10M12 2v6M12 12v14M18 12h8M18 12v5" />
            </svg>
            <span>
              <span className="brand-name">Virtual Office</span>
              <span className="brand-sub">kantor utama</span>
            </span>
          </a>
          <nav className="nav" aria-label="Utama">
            <a href="#/" aria-current={section === 'office' ? 'page' : undefined}>
              Kantor
            </a>
            <a href="#/objectives" aria-current={section === 'objectives' ? 'page' : undefined}>
              Objective
            </a>
            <a href="#/decisions" aria-current={section === 'decisions' ? 'page' : undefined} className="row" style={{ gap: 8 }}>
              Keputusan <PendingBadge />
            </a>
            <a href="#/knowledge" aria-current={section === 'knowledge' ? 'page' : undefined}>
              Knowledge
            </a>
            <a href="#/settings" aria-current={section === 'settings' ? 'page' : undefined}>
              Pengaturan
            </a>
          </nav>
          <QuotaMeter />
        </div>
      </header>
      {objectiveMatch ? (
        <ObjectivePage id={objectiveMatch[1]!} />
      ) : decisionMatch ? (
        <DecisionPage id={decisionMatch[1]!} />
      ) : section === 'decisions' ? (
        <DecisionsPage />
      ) : section === 'objectives' ? (
        <ObjectivesPage />
      ) : section === 'settings' ? (
        <SettingsPage />
      ) : section === 'knowledge' ? (
        <KnowledgePage />
      ) : (
        <OfficePage />
      )}
    </>
  );
}
