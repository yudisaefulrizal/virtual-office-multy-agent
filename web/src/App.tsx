import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { api, onUnauthorized, useLive } from './api';
import { AccessPage } from './pages/AccessPage';
import { CompanyPage, ProfilePage } from './pages/CompanyPage';
import { DecisionPage, DecisionsPage } from './pages/DecisionPage';
import { GrowthPage } from './pages/GrowthPage';
import { KnowledgePage } from './pages/KnowledgePage';
import { ObjectivePage } from './pages/ObjectivePage';
import { ObjectivesPage } from './pages/ObjectivesPage';
import { OfficePage } from './pages/OfficePage';
import { ResultsPage } from './pages/ResultsPage';
import { SettingsPage } from './pages/SettingsPage';
import { SummaryPage } from './pages/SummaryPage';

function useHashRoute() {
  const [hash, setHash] = useState(() => window.location.hash || '#/');
  useEffect(() => {
    const on = () => setHash(window.location.hash || '#/');
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash.slice(1);
}

const ICON: Record<string, ReactNode> = {
  company: <><path d="M10 2.5l7 4v7l-7 4-7-4v-7z" /><path d="M3 6.5l7 4 7-4M10 10.5v7" /></>,
  office: <><rect x="3" y="4" width="14" height="12" rx="1.5" /><path d="M3 10h14M10 4v12" /></>,
  growth: <path d="M3 16l5-5 3 3 6-8M13 6h4v4" />,
  results: <><path d="M5 3h7l3 3v11H5z" /><path d="M12 3v3h3M8 10h4M8 13h4" /></>,
  access: <><circle cx="7" cy="10" r="3.5" /><path d="M10.5 10H17M15 10v3" /></>,
  costs: <path d="M4 16V9M10 16V4M16 16v-5" />,
  settings: <><circle cx="10" cy="10" r="2.5" /><path d="M10 3v2M10 15v2M3 10h2M15 10h2M5 5l1.4 1.4M13.6 13.6L15 15M15 5l-1.4 1.4M6.4 13.6L5 15" /></>,
  objectives: <><path d="M7 5h10M7 10h10M7 15h10" /><circle cx="3.5" cy="5" r=".8" /><circle cx="3.5" cy="10" r=".8" /><circle cx="3.5" cy="15" r=".8" /></>,
  decisions: <><path d="M4 10.5l4 4 8-9" /></>,
  knowledge: <><path d="M4 4.5A1.5 1.5 0 015.5 3H16v12H5.5A1.5 1.5 0 004 16.5z" /><path d="M4 16.5A1.5 1.5 0 005.5 18H16" /></>,
};
const Icon = ({ name, size = 20 }: { name: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{ICON[name]}</svg>
);

const NAV = [
  { id: 'company', href: '#/', label: 'Beranda' },
  { id: 'office', href: '#/office', label: 'Kantor' },
  { id: 'results', href: '#/results', label: 'Hasil' },
  { id: 'growth', href: '#/growth', label: 'Tumbuh' },
  { id: 'access', href: '#/access', label: 'Akses' },
  { id: 'summary', href: '#/summary', label: 'Biaya', icon: 'costs', hideSm: true },
] as const;
const MORE = [
  { id: 'objectives', href: '#/objectives', label: 'Objective' },
  { id: 'decisions', href: '#/decisions', label: 'Keputusan' },
  { id: 'knowledge', href: '#/knowledge', label: 'Ilmu' },
  { id: 'settings', href: '#/settings', label: 'Atur' },
];

function sectionOf(route: string) {
  for (const id of ['objectives', 'decisions', 'settings', 'knowledge', 'summary', 'results', 'growth', 'access', 'office', 'profile']) {
    if (route.startsWith(`/${id}`)) return id;
  }
  return 'company';
}

/** Logo: kubus voxel isometrik. */
const Logo = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 2l9 5-9 5-9-5z" fill="#a9c3ff" />
    <path d="M3 7l9 5v10l-9-5z" fill="#6e9bff" />
    <path d="M21 7l-9 5v10l9-5z" fill="#3c5fc4" />
  </svg>
);

function Rail({ section, needs, onLogout }: { section: string; needs: number; onLogout?: () => void }) {
  return (
    <aside className="rail" aria-label="Navigasi">
      <a href="#/" className="rail-logo" aria-label="Virtual Office" style={{ minHeight: 40, width: 40 }}><Logo /></a>
      <nav aria-label="Utama" style={{ display: 'contents' }}>
        {NAV.map((n) => (
          <a key={n.id} href={n.href} aria-current={section === n.id ? 'page' : undefined} className={'hideSm' in n && n.hideSm ? 'hide-sm' : undefined}>
            <Icon name={'icon' in n ? n.icon : n.id} />
            {n.label}
            {n.id === 'company' && needs > 0 && <span className="count" aria-label={`${needs} perlu Anda`}>{needs}</span>}
          </a>
        ))}
      </nav>
      <div className="rail-bottom">
        <span className="rail-sep" />
        {MORE.map((m) => (
          <a key={m.id} href={m.href} aria-current={section === m.id ? 'page' : undefined}>
            <Icon name={m.id} size={18} />
            {m.label}
          </a>
        ))}
        {onLogout && (
          <a href="#/" onClick={(e) => (e.preventDefault(), onLogout())}>
            <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 4H5a1 1 0 00-1 1v10a1 1 0 001 1h3M12 7l3 3-3 3M15 10H8" /></svg>
            Keluar
          </a>
        )}
      </div>
    </aside>
  );
}

function Kpi({ label, value, max, money }: { label: string; value: number; max: number; money?: boolean }) {
  const fmt = (n: number) => (money ? `$${n.toFixed(n < 10 ? 2 : 0)}` : String(Math.round(n)));
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="kpi">
      <span className="kpi-top">{label}<b>{fmt(value)}{max > 0 ? ` / ${fmt(max)}` : ''}</b></span>
      <div className={`meter${pct >= 80 ? ' warn' : ''}`} role="img" aria-label={`${label}: ${fmt(value)}${max > 0 ? ` dari ${fmt(max)}` : ''}`}>
        <span style={{ width: `${max > 0 ? pct : 0}%` }} />
      </div>
    </div>
  );
}

function TopBar({ needs }: { needs: number }) {
  const { data, refresh } = useLive(api.company);
  const [busy, setBusy] = useState(false);
  const c = data?.company;
  const running = data?.state === 'running';
  const work = data?.objectives.filter((o) => o.mode !== 'agenda' && !['completed', 'failed', 'cancelled'].includes(o.status)).length ?? 0;
  const toggle = async () => {
    setBusy(true);
    await api.companyAction(running ? 'pause' : 'start').catch(() => undefined);
    setBusy(false);
    refresh();
  };
  return (
    <header className="topbar">
      <div className="tb-name">
        <span className={`live${running ? '' : ' off'}`} aria-hidden="true" />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{c?.name || 'Virtual Office'}</span>
        {data && data.state !== 'unset' && <span className={`pill ${running ? 'pill-green' : 'pill-grey'}`}>{running ? 'Berjalan' : 'Dijeda'}</span>}
      </div>
      {c && (
        <div className="tb-kpis">
          <Kpi label="Pekerjaan" value={work} max={c.maxActiveObjectives} />
          <Kpi label="Kuota" value={data?.quota?.used ?? 0} max={data?.quota?.max ?? 0} />
          <Kpi label="Budget" value={data?.spentUsd ?? 0} max={c.monthlyBudgetUsd} money />
        </div>
      )}
      <div className="tb-actions">
        {needs > 0 && <a className="btn btn-sm btn-amber" href="#/">Perlu Anda · {needs}</a>}
        {c && <a className="btn btn-sm btn-ghost" href="#/profile">Profil</a>}
        {c && <button type="button" className={`btn btn-sm ${running ? 'btn-ghost' : ''}`} disabled={busy} onClick={toggle}>{running ? 'Jeda' : 'Jalankan'}</button>}
      </div>
    </header>
  );
}

function LoginPage({ onDone }: { onDone: () => void }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 16 }}>
      <form
        className="card"
        style={{ width: 'min(380px, 100%)', gap: 18 }}
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await api.login(code);
            setCode('');
            onDone();
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><Logo /><strong style={{ fontSize: 17 }}>Virtual Office</strong></div>
        <div className="field">
          <label htmlFor="access-code">Kode akses</label>
          <input id="access-code" type="password" autoComplete="current-password" autoFocus value={code} onChange={(e) => setCode(e.target.value)} />
        </div>
        {error && <p className="error" role="alert" style={{ margin: 0 }}>{error}</p>}
        <button className="btn" type="submit" disabled={busy || !code}>{busy ? 'Memeriksa…' : 'Masuk'}</button>
      </form>
    </main>
  );
}

/** Memeriksa sesi dulu; dashboard (dan semua pemanggilan datanya) baru dimuat setelah boleh masuk. */
export function App() {
  const [session, setSession] = useState<{ required: boolean; authenticated: boolean } | null>(null);
  const check = () => api.session().then(setSession).catch(() => setSession({ required: true, authenticated: false }));
  useEffect(() => {
    void check();
    return onUnauthorized(() => setSession({ required: true, authenticated: false }));
  }, []);
  if (!session) return null;
  if (!session.authenticated) return <LoginPage onDone={() => void check()} />;
  return <Dashboard canLogout={session.required} onLogout={() => void api.logout().finally(() => window.location.reload())} />;
}

function Dashboard({ canLogout, onLogout }: { canLogout: boolean; onLogout: () => void }) {
  const route = useHashRoute();
  const objectiveMatch = route.match(/^\/objectives\/([0-9a-f-]{36})$/);
  const decisionMatch = route.match(/^\/decisions\/([0-9a-f-]{36})$/);
  const section = sectionOf(route);
  const office = useLive(api.office);
  const needs = office.data?.inbox.length ?? 0;

  return (
    <div className="shell">
      <Rail section={section} needs={needs} onLogout={canLogout ? onLogout : undefined} />
      <div className="shell-main">
        <TopBar needs={needs} />
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
        ) : section === 'summary' ? (
          <SummaryPage />
        ) : section === 'results' ? (
          <ResultsPage />
        ) : section === 'growth' ? (
          <GrowthPage />
        ) : section === 'access' ? (
          <AccessPage />
        ) : section === 'office' ? (
          <OfficePage />
        ) : section === 'profile' ? (
          <ProfilePage />
        ) : (
          <CompanyPage />
        )}
      </div>
    </div>
  );
}
