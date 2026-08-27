import type { JSX } from 'react';
import { REPORT_SCOPES } from '../../../lib/types';
import type {
  AttendanceReport,
  ReportAlertKind,
  ReportPerson,
  ReportScope,
  ReportStandout,
  ReportTotals,
} from '../../../lib/types';
import { ALERT_LABELS, SEVERITY_LABELS, formatClock, plural } from '../labels';
import {
  SCOPE_LABELS,
  VERDICT_LABELS,
  VERDICT_MEANING,
  VERDICT_TONES,
  describePeriod,
  describeReason,
} from '../reportLabels';
import { IconAlert, IconChevron, IconDone, IconOffline, IconTeam } from './icons';

/**
 * What a period was worth, across everybody.
 *
 * **Not one figure here is worked out in the browser**, and that includes the
 * verdict. Whether somebody met a period depends on their schedule, which of its
 * days have already passed, and whether an alert HR did not dismiss landed on
 * one of them -- `attendance_report()` resolves all of that and this lays the
 * answers out. The period itself is resolved there too: the screen sends a scope
 * and an anchor, never a pair of dates, because "this week" has a wrong answer
 * available here and none there.
 *
 * The one thing it decides is what to *draw*, and two of those choices are worth
 * naming. A period still running is never presented as a result, because it is
 * not one. And absences are labelled as days with no entry rather than as days
 * taken: there is no leave table yet, so approved holiday and simply not
 * appearing are the same row, and the screen says so instead of implying a
 * judgement the data cannot support.
 */
export function ReportsPanel({
  report,
  scope,
  onScope,
  onStep,
  onToday,
  atLatest,
  error,
  loading,
}: {
  readonly report: AttendanceReport | null;
  readonly scope: ReportScope;
  readonly onScope: (next: ReportScope) => void;
  readonly onStep: (direction: -1 | 1) => void;
  readonly onToday: () => void;
  readonly atLatest: boolean;
  readonly error: string | null;
  readonly loading: boolean;
}): JSX.Element {
  return (
    <section className="panel">
      <div className="panel__head">
        <div>
          <h2 className="panel__title">Reporte</h2>
          <p className="panel__subtitle">
            {report === null
              ? 'Eligiendo el periodo…'
              : `${describePeriod(report.scope, report.from, report.to)} · ${
                  report.closed ? 'periodo cerrado' : 'periodo en curso'
                }`}
          </p>
        </div>

        <div className="panel__tools">
          <div className="seg" role="group" aria-label="Periodo del reporte">
            {REPORT_SCOPES.map((option) => (
              <button
                key={option}
                className={option === scope ? 'seg__pick seg__pick--on' : 'seg__pick'}
                type="button"
                aria-pressed={option === scope}
                onClick={() => onScope(option)}
              >
                {SCOPE_LABELS[option]}
              </button>
            ))}
          </div>

          <button
            className="btn btn--icon"
            type="button"
            onClick={() => onStep(-1)}
            aria-label={`${SCOPE_LABELS[scope]} anterior`}
          >
            <IconChevron direction="left" />
          </button>
          <button className="btn" type="button" onClick={onToday} disabled={atLatest}>
            Actual
          </button>
          <button
            className="btn btn--icon"
            type="button"
            onClick={() => onStep(1)}
            disabled={atLatest}
            aria-label={`${SCOPE_LABELS[scope]} siguiente`}
          >
            <IconChevron direction="right" />
          </button>
        </div>
      </div>

      {error !== null && (
        <p className="note note--warn" role="status">
          {error}
        </p>
      )}

      {report === null ? (
        loading ? (
          <div className="skeleton skeleton--panel" />
        ) : (
          <p className="empty">No hay nada que reportar en este periodo.</p>
        )
      ) : (
        <div className="panel__body report">
          <Figures totals={report.totals} closed={report.closed} />
          <Compliance totals={report.totals} />
          <Standouts report={report} />
          <Alerts kinds={report.alerts_by_kind} />
          <People people={report.people} />
        </div>
      )}
    </section>
  );
}

function Figures({
  totals,
  closed,
}: {
  readonly totals: ReportTotals;
  readonly closed: boolean;
}): JSX.Element {
  return (
    <div className="stats">
      <Figure
        label="Home Office"
        value={String(totals.people_home_office)}
        caption={`de ${plural(totals.people, 'persona', 'personas')} en el periodo`}
        icon={<IconTeam />}
      />
      <Figure
        label="Horas trabajadas"
        value={formatClock(totals.worked_seconds)}
        caption={
          // Against the elapsed expectation, not the whole period's: a week
          // measured against Friday on a Tuesday reports a gap that is only the
          // calendar. Once the period is closed the two are the same thing.
          closed
            ? `de ${formatClock(totals.expected_seconds)} esperadas`
            : `de ${formatClock(totals.expected_seconds_elapsed)} esperadas hasta hoy`
        }
        icon={<IconDone />}
      />
      <Figure
        label="Días con registro"
        value={String(totals.days_worked)}
        caption={`de ${String(totals.days_scheduled)} días programados`}
        icon={<IconTeam />}
      />
      <Figure
        label="Puntualidad"
        value={totals.punctuality_pct === null ? '—' : `${String(totals.punctuality_pct)}%`}
        caption={
          totals.late_days === 0
            ? 'Sin retardos en el periodo'
            : plural(totals.late_days, 'retardo', 'retardos')
        }
        icon={<IconDone />}
      />
      <Figure
        label="Alertas"
        value={String(totals.alerts_total)}
        caption={totals.alerts_total === 0 ? 'Nada registrado' : 'sin contar las descartadas'}
        icon={<IconAlert />}
      />
      <Figure
        label="Desconexiones"
        value={String(totals.offline_days)}
        caption="días con marcajes sincronizados después"
        icon={<IconOffline />}
      />
    </div>
  );
}

function Figure({
  label,
  value,
  caption,
  icon,
}: {
  readonly label: string;
  readonly value: string;
  readonly caption: string;
  readonly icon: JSX.Element;
}): JSX.Element {
  return (
    <div className="stat">
      <span className="stat__icon" aria-hidden="true">
        {icon}
      </span>
      <span className="stat__label">{label}</span>
      <span className="stat__value">{value}</span>
      <span className="stat__caption">{caption}</span>
    </div>
  );
}

/**
 * The verdicts, as a count each.
 *
 * `pending` and `not_scheduled` are shown beside the three results rather than
 * folded into them. Hiding them would make the three add up to something other
 * than the number of people, which is the arithmetic a reader does first.
 */
function Compliance({ totals }: { readonly totals: ReportTotals }): JSX.Element {
  const rows = [
    { verdict: 'met' as const, count: totals.people_met },
    { verdict: 'partial' as const, count: totals.people_partial },
    { verdict: 'missed' as const, count: totals.people_missed },
    { verdict: 'pending' as const, count: totals.people_pending },
    { verdict: 'not_scheduled' as const, count: totals.people_not_scheduled },
  ].filter((row) => row.count > 0);

  return (
    <div className="report__section">
      <h3 className="report__title">Cumplimiento</h3>

      {rows.length === 0 ? (
        <p className="muted">Nadie entra en el periodo.</p>
      ) : (
        <ul className="report__verdicts">
          {rows.map((row) => (
            <li className="report__verdict" key={row.verdict}>
              <span className={`pill pill--${VERDICT_TONES[row.verdict]}`}>
                {VERDICT_LABELS[row.verdict]}
              </span>
              <span className="report__verdict-count">{row.count}</span>
              <span className="report__verdict-note">{VERDICT_MEANING[row.verdict]}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Standouts({ report }: { readonly report: AttendanceReport }): JSX.Element {
  const lists = [
    {
      key: 'punctual',
      title: 'Puntualidad impecable',
      note: 'Sin un retardo ni una falta en el periodo.',
      items: report.standouts.punctual,
      unit: (value: number) => plural(value, 'día', 'días'),
      tone: 'good' as const,
    },
    {
      key: 'most_hours',
      title: 'Más horas',
      note: 'Horas efectivas, sin contar pausas.',
      items: report.standouts.most_hours,
      unit: (value: number) => formatClock(value),
      tone: 'info' as const,
    },
    {
      key: 'most_late',
      title: 'Más entradas tardías',
      note: 'Alertas de retardo que RH no ha descartado.',
      items: report.standouts.most_late,
      unit: (value: number) => plural(value, 'retardo', 'retardos'),
      tone: 'warn' as const,
    },
    {
      key: 'most_absent',
      title: 'Más días sin entrada',
      note: 'Días programados que ya pasaron y no tienen ningún marcaje.',
      items: report.standouts.most_absent,
      unit: (value: number) => plural(value, 'día', 'días'),
      tone: 'bad' as const,
    },
  ];

  const anything = lists.some((list) => list.items.length > 0);

  return (
    <div className="report__section">
      <h3 className="report__title">Quién destacó</h3>

      {!anything ? (
        <p className="muted">Nadie destaca en este periodo, en ningún sentido.</p>
      ) : (
        <div className="report__standouts">
          {lists
            .filter((list) => list.items.length > 0)
            .map((list) => (
              <div className="report__standout" key={list.key}>
                <h4 className="report__standout-title">
                  <span className={`swatch swatch--${list.tone}`} aria-hidden="true" />
                  {list.title}
                </h4>
                <p className="report__standout-note">{list.note}</p>
                <ol className="report__standout-list">
                  {list.items.map((person: ReportStandout) => (
                    <li className="report__standout-row" key={person.employee_id}>
                      <span className="report__standout-who">{person.employee_name}</span>
                      <span className="report__standout-value">{list.unit(person.value)}</span>
                    </li>
                  ))}
                </ol>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

function Alerts({ kinds }: { readonly kinds: readonly ReportAlertKind[] }): JSX.Element {
  return (
    <div className="report__section">
      <h3 className="report__title">Alertas del periodo</h3>

      {kinds.length === 0 ? (
        <p className="muted">Ninguna alerta quedó registrada en este periodo.</p>
      ) : (
        <ul className="report__alerts">
          {kinds.map((kind) => (
            <li className="report__alert" key={kind.kind}>
              <span className={`alert__stripe alert__stripe--${kind.severity}`} aria-hidden="true" />
              <span className="report__alert-body">
                <span className="report__alert-kind">{ALERT_LABELS[kind.kind]}</span>
                <span className="report__alert-note">
                  {SEVERITY_LABELS[kind.severity]} ·{' '}
                  {plural(kind.people, 'persona', 'personas')}
                  {kind.dismissed > 0 && ` · ${String(kind.dismissed)} descartadas`}
                </span>
              </span>
              <span className="report__alert-count">{kind.total}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function People({ people }: { readonly people: readonly ReportPerson[] }): JSX.Element {
  return (
    <div className="report__section">
      <h3 className="report__title">Persona por persona</h3>

      {/* The one place the report says out loud what an absence is and is not.
        * Until there is a leave table, a day of approved holiday and a day
        * somebody did not appear are the same row, and a column headed "faltas"
        * would be asserting the difference. */}
      <p className="note" role="note">
        «Sin entrada» son días programados que ya pasaron y no tienen ningún marcaje. Todavía no
        hay registro de vacaciones ni permisos, así que un día autorizado se ve igual que una
        ausencia: hay que contrastarlo a mano.
      </p>

      {people.length === 0 ? (
        <p className="empty">Nadie entra en este periodo.</p>
      ) : (
        <div className="report__scroll">
          <table className="report__table">
            <thead>
              <tr>
                <th scope="col">Persona</th>
                <th scope="col">Home Office</th>
                <th scope="col">Horas</th>
                <th scope="col">Retardos</th>
                <th scope="col">Sin entrada</th>
                <th scope="col">Alertas</th>
                <th scope="col">Resultado</th>
              </tr>
            </thead>
            <tbody>
              {people.map((person) => (
                <tr key={person.employee_id}>
                  <th scope="row">
                    <span className="report__who">{person.employee_name}</span>
                    <span className="report__dept">
                      {person.department ?? 'Sin departamento'}
                      {person.employee_state === 'baja' && ' · dado de baja'}
                    </span>
                  </th>
                  <td>
                    {plural(person.days_worked, 'día', 'días')}{' '}
                    <span className="muted">de {person.days_scheduled}</span>
                  </td>
                  <td>
                    {formatClock(person.worked_seconds)}{' '}
                    <span className="muted">de {formatClock(person.expected_seconds)}</span>
                  </td>
                  <td>{person.late_days === 0 ? '—' : person.late_days}</td>
                  <td>{person.absent_days === 0 ? '—' : person.absent_days}</td>
                  <td>{person.alerts_total === 0 ? '—' : person.alerts_total}</td>
                  <td>
                    <span className={`pill pill--${VERDICT_TONES[person.compliance]}`}>
                      {VERDICT_LABELS[person.compliance]}
                    </span>
                    {person.reasons.length > 0 && (
                      <span className="report__reasons">
                        {person.reasons.map((reason) => describeReason(reason)).join(' · ')}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
