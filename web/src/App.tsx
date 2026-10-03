import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { api, useLive } from './api';
import { AccessPage } from './pages/AccessPage';
import { CompanyPage } from './pages/CompanyPage';
import { DecisionPage, DecisionsPage } from './pages/DecisionPage';
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
  company: <><rect x="3" y="3" width="6" height="6" /><rect x="11" y="3" width="6" height="6" /><rect x="3" y="11" width="6" height="6" /><rect x="11" y="11" width="6" height="6" /></>,
  office: <><rect x="3" y="4" width="14" height="12" /><path d="M3 10h14M10 4v12" /></>,
  results: <><path d="M5 3h7l3 3v11H5z" /><path d="M12 3v3h3" /></>,
  access: <><circle cx="7" cy="10" r="3.5" /><path d="M10.5 10H17M15 10v3" /></>,
  costs: <path d="M4 16V9M10 16V4M16 16v-5" />,
  settings: <><circle cx="10" cy="10" r="2.5" /><path d="M10 3v2M10 15v2M3 10h2M15 10h2M5 5l1.4 1.4M13.6 13.6L15 15M15 5l-1.4 1.4M6.4 13.6L5 15" /></>,
};
const Icon = ({ name }: { name: string }) => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">{ICON[name]}</svg>
);

const NAV = [
  { id: 'company', href: '#/', label: 'Perusahaan' },
  { id: 'office', href: '#/office', label: 'Kantor' },
  { id: 'results', href: '#/results', label: 'Hasil' },
  { id: 'access', href: '#/access', label: 'Akses' },
  { id: 'summary', href: '#/summary', label: 'Biaya', icon: 'costs', hideSm: true },
  { id: 'settings', href: '#/settings', label: 'Pengaturan', icon: 'settings', hideSm: true },
] as const;
const MORE = [
  { id: 'objectives', href: '#/objectives', label: 'Objective' },
  { id: 'decisions', href: '#/decisions', label: 'Keputusan' },
  { id: 'knowledge', href: '#/knowledge', label: 'Knowledge' },
];

function sectionOf(route: string) {
  if (route.startsWith('/objectives')) return 'objectives';
  if (route.startsWith('/decisions')) return 'decisions';
  if (route.startsWith('/settings')) return 'settings';
  if (route.startsWith('/knowledge')) return 'knowledge';
  if (route.startsWith('/summary')) return 'summary';
  if (route.startsWith('/results')) return 'results';
  if (route.startsWith('/access')) return 'access';
  if (route.startsWith('/office')) return 'office';
  return 'company';
}

function Sidebar({ section }: { section: string }) {
  const { data } = useLive(api.office);
  const needs = data?.inbox.length ?? 0;
  return (
    <aside className="sb">
      <a href="#/" className="sb-brand">
        <svg width="24" height="24" viewBox="0 0 28 28" fill="none" stroke="#111418" strokeWidth="2.4" aria-hidden="true">
          <rect x="2" y="2" width="24" height="24" />
          <path d="M2 12h10M12 2v6M12 12v14M18 12h8M18 12v5" />
        </svg>
        Virtual Office
      </a>
      <nav className="sb-nav" aria-label="Utama">
        {NAV.map((n) => (
          <a key={n.id} href={n.href} aria-current={section === n.id ? 'page' : undefined} className={'hideSm' in n && n.hideSm ? 'hide-sm' : undefined}>
            <Icon name={'icon' in n ? n.icon : n.id} />
            {n.label}
            {n.id === 'company' && needs > 0 && <span className="count" aria-label={`${needs} perlu Anda`}>{needs}</span>}
          </a>
        ))}
      </nav>
      <div className="sb-sec">
        {MORE.map((m) => (
          <a key={m.id} href={m.href} aria-current={section === m.id ? 'page' : undefined}>
            {m.label}
          </a>
        ))}
        {data?.forceRuntime && <span className="sb-note" style={{ marginTop: 8 }}>Mode {data.forceRuntime}</span>}
      </div>
    </aside>
  );
}

export function App() {
  const route = useHashRoute();
  const objectiveMatch = route.match(/^\/objectives\/([0-9a-f-]{36})$/);
  const decisionMatch = route.match(/^\/decisions\/([0-9a-f-]{36})$/);
  const section = sectionOf(route);

  return (
    <div className="shell">
      <Sidebar section={section} />
      <div className="shell-main">
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
        ) : section === 'access' ? (
          <AccessPage />
        ) : section === 'office' ? (
          <OfficePage />
        ) : (
          <CompanyPage />
        )}
      </div>
    </div>
  );
}
