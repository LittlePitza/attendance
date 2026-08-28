import { useState, type JSX } from 'react';
import './admin.css';
import { AccountsSection } from './components/AccountsSection';
import { AlertRulesSection } from './components/AlertRulesSection';
import { PeopleSection } from './components/PeopleSection';
import { SchedulesSection } from './components/SchedulesSection';
import { SettingsSection } from './components/SettingsSection';
import { useAdminData } from './useAdminData';

const TABS = [
  { id: 'people', label: 'Personal' },
  { id: 'accounts', label: 'Accesos' },
  { id: 'schedules', label: 'Horarios' },
  { id: 'rules', label: 'Alertas' },
  { id: 'periods', label: 'Periodos' },
] as const;

type Tab = (typeof TABS)[number]['id'];

/**
 * The configuration this system used to require the SQL editor for.
 *
 * Five things, and they are five because they are the tables with rows in them
 * that nobody could reach: who is on the payroll, who can sign in, the hours
 * everything is measured against, what raises an alert and who it goes to, and
 * where a week begins.
 *
 * Tabs rather than five sidebar entries. They are read together -- adding
 * somebody is followed by giving them access and checking a schedule covers
 * them -- and a nav that grew from four items to nine would bury the board they
 * are all in service of.
 *
 * It opens on `Personal`, which is where that sequence starts: the roster is
 * the list the other three hang off, and it is the only one of them that
 * answers a question about a person rather than about a setting.
 */
export function AdminPanel(): JSX.Element {
  const [tab, setTab] = useState<Tab>('people');
  const { accounts, employees, departments, schedules, rules, settings, error, loading, refresh } =
    useAdminData();

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

      {tab === 'people' && (
        <PeopleSection employees={employees} departments={departments} onChanged={reload} />
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

      {tab === 'periods' && <SettingsSection settings={settings} onChanged={reload} />}
    </div>
  );
}
