import { useState, type JSX } from 'react';
import './admin.css';
import { AccountsSection } from './components/AccountsSection';
import { AlertRulesSection } from './components/AlertRulesSection';
import { SchedulesSection } from './components/SchedulesSection';
import { useAdminData } from './useAdminData';

const TABS = [
  { id: 'accounts', label: 'Accesos' },
  { id: 'schedules', label: 'Horarios' },
  { id: 'rules', label: 'Alertas' },
] as const;

type Tab = (typeof TABS)[number]['id'];

/**
 * The configuration this system used to require the SQL editor for.
 *
 * Three things, and they are three because they are the three tables with rows
 * in them that nobody could reach: who can sign in, the hours everything is
 * measured against, and what raises an alert and who it goes to.
 *
 * Tabs rather than three sidebar entries. They are read together -- giving
 * somebody access is followed by checking a schedule covers them -- and a nav
 * that grew from four items to seven would bury the board they are all in
 * service of.
 */
export function AdminPanel(): JSX.Element {
  const [tab, setTab] = useState<Tab>('accounts');
  const { accounts, departments, schedules, rules, error, loading, refresh } = useAdminData();

  const reload = (): void => void refresh();

  if (loading && accounts.length === 0 && error === null) {
    return (
      <div className="admin">
        <div className="skeleton skeleton--panel" />
      </div>
    );
  }

  return (
    <div className="admin">
      <div className="admin__tabs" role="tablist" aria-label="Configuración">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            role="tab"
            type="button"
            aria-selected={tab === entry.id}
            className={`admin__tab${tab === entry.id ? ' admin__tab--on' : ''}`}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {error !== null && (
        <p className="note note--warn" role="status">
          {error}
        </p>
      )}

      {tab === 'accounts' && <AccountsSection accounts={accounts} onChanged={reload} />}

      {tab === 'schedules' && (
        <SchedulesSection
          schedules={schedules}
          departments={departments}
          accounts={accounts}
          onChanged={reload}
        />
      )}

      {tab === 'rules' && (
        <AlertRulesSection rules={rules} departments={departments} onChanged={reload} />
      )}
    </div>
  );
}
