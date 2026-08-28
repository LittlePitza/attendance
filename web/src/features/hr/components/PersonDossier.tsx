import { useMemo, useState, type JSX } from 'react';
import type {
  DossierAdjustment,
  DossierAlert,
  DossierDevice,
  DossierPunch,
  DossierSession,
  EmployeeDossier,
  SessionEvent,
  TeamMember,
} from '../../../lib/types';
import { RecordBody, RecordRange } from '../../admin/components/RecordBody';
import { useEmployeeRecord } from '../../admin/useEmployeeRecord';
import {
  ADJUSTMENT_LABELS,
  ALERT_LABELS,
  ALERT_STATE_LABELS,
  END_REASON_LABELS,
  END_REASON_MEANING,
  PUNCH_LABELS,
  SESSION_EVENT_LABELS,
  SEVERITY_LABELS,
  formatClock,
  formatTime,
  plural,
} from '../labels';
import { IconAlert, IconClock, IconOffline, IconReview, IconSearch, IconTeam } from './icons';

/**
 * One person, in as much detail as the record holds.
 *
 * The figures at the top are `RecordBody` -- the same component Configuración
 * and the board's box mount, reading the same `employee_summary()`. Nothing here
 * recomputes an hour or a percentage. What this page adds is everything the
 * summary does not carry: where they connected from, which machines, every alert
 * whatever its state, what HR changed and why, when the application could not
 * reach the server, and the marks themselves.
 *
 * **It is a page to read, not to act on.** Resetting a day, editing the roster
 * and revoking a device are administrative writes and they live on the screens
 * that own them. A page assembled from six sources is the worst place to put a
 * button: the reader cannot tell which of the six their press will change.
 *
 * Two honesty rules it keeps, both inherited from what the data can support. A
 * session that ended `expired` says "dejó de reportarse" and never "se cerró",
 * because nothing distinguishes a closed lid from a killed application. And a
 * voided punch shows the hour it stopped counting beside the reason somebody
 * typed, rather than disappearing -- a day whose counter reads zero next to four
 * visible marks is only confusing until the reason is there.
 */
export function PersonDossier({
  team,
  selectedId,
  onSelect,
  dossier,
  error,
  loading,
  days,
  onDays,
  timeZone,
}: {
  readonly team: readonly TeamMember[];
  readonly selectedId: string | null;
  readonly onSelect: (employeeId: string | null) => void;
  readonly dossier: EmployeeDossier | null;
  readonly error: string | null;
  readonly loading: boolean;
  readonly days: number;
  readonly onDays: (days: number) => void;
  readonly timeZone: string;
}): JSX.Element {
  const [query, setQuery] = useState('');

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === '') {
      return team;
    }
    return team.filter(
      (member) =>
        member.employee_name.toLowerCase().includes(needle) ||
        (member.department ?? '').toLowerCase().includes(needle),
    );
  }, [team, query]);

  return (
    <div className="review review--dossier">
      <section className="panel">
        <div className="panel__head">
          <div>
            <h2 className="panel__title">Personas</h2>
            <p className="panel__subtitle">{plural(team.length, 'persona', 'personas')}</p>
          </div>
        </div>

        <label className="search search--panel">
          <span className="search__icon">
            <IconSearch />
          </span>
          <span className="sr-only">Buscar a una persona</span>
          <input
            className="field"
            type="search"
            value={query}
            placeholder="Buscar…"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>

        {visible.length === 0 ? (
          <p className="empty">Nadie coincide.</p>
        ) : (
          <ul className="dossier__people">
            {visible.map((member) => (
              <li key={member.employee_id}>
                <button
                  className={
                    member.employee_id === selectedId
                      ? 'dossier__person dossier__person--on'
                      : 'dossier__person'
                  }
                  type="button"
                  aria-pressed={member.employee_id === selectedId}
                  onClick={() =>
                    onSelect(member.employee_id === selectedId ? null : member.employee_id)
                  }
                >
                  <span className="dossier__person-name">{member.employee_name}</span>
                  <span className="dossier__person-dept">
                    {member.department ?? 'Sin departamento'}
                    {/* Marked, not hidden. The board leaves these twenty-three
                      * out because it is about a day being worked; this page is
                      * about what the record holds, and "no account, therefore
                      * nothing" is an answer somebody comes here to get. Only a
                      * definite false marks: the key is absent until the
                      * migration lands. */}
                    {member.has_account === false && ' · sin cuenta'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {selectedId === null ? (
        <section className="panel">
          <p className="empty">
            <IconTeam />
            Elige a una persona para ver su expediente completo.
          </p>
        </section>
      ) : (
        <Dossier
          dossier={dossier}
          error={error}
          loading={loading}
          days={days}
          onDays={onDays}
          timeZone={timeZone}
        />
      )}
    </div>
  );
}

function Dossier({
  dossier,
  error,
  loading,
  days,
  onDays,
  timeZone,
}: {
  readonly dossier: EmployeeDossier | null;
  readonly error: string | null;
  readonly loading: boolean;
  readonly days: number;
  readonly onDays: (days: number) => void;
  readonly timeZone: string;
}): JSX.Element {
  // `RecordBody` reads its own summary and access log. Feeding it the dossier's
  // copy would be a second path to the same figures, so it keeps its own -- the
  // dossier's `summary` is what proves the two agree, not what feeds them.
  const record = useEmployeeRecord(dossier?.employee.employee_id ?? null, days);

  if (error !== null) {
    return (
      <section className="panel">
        <p className="note note--warn" role="status">
          {error}
        </p>
      </section>
    );
  }

  if (dossier === null) {
    return (
      <section className="panel">
        {loading ? <div className="skeleton skeleton--panel" /> : null}
      </section>
    );
  }

  const zone = dossier.employee.time_zone || timeZone;

  return (
    <section className="panel">
      <div className="panel__head">
        <div>
          <h2 className="panel__title">{dossier.employee.employee_name}</h2>
          <p className="panel__subtitle">
            {[
              dossier.employee.job_title,
              dossier.employee.department ?? 'Sin departamento',
              dossier.employee.email,
            ]
              .filter((part) => part !== null && part !== '')
              .join(' · ')}
          </p>
        </div>
        <div className="panel__tools">
          <RecordRange days={days} onChange={onDays} />
        </div>
      </div>

      <div className="panel__body dossier">
        {!dossier.employee.has_account && (
          <p className="note note--warn" role="note">
            Esta persona no tiene cuenta, así que no puede marcar. Todo lo que sigue estará vacío
            mientras no se le dé acceso en <strong>Configuración → Accesos</strong>.
          </p>
        )}

        {dossier.employee.state === 'baja' && (
          <p className="note" role="note">
            Dada de baja. Su registro se conserva: nada se borra en este sistema.
          </p>
        )}

        <RecordBody record={record} />

        <Connectivity connectivity={dossier.connectivity} zone={zone} />
        <Sessions sessions={dossier.sessions} zone={zone} />
        <Devices devices={dossier.devices} />
        <Alerts alerts={dossier.alerts} />
        <Adjustments adjustments={dossier.adjustments} zone={zone} />
        <Punches punches={dossier.punches} zone={zone} />
      </div>
    </section>
  );
}

/**
 * The gaps, and the one thing worth understanding about them: the hour the
 * server heard is not the hour it happened. A `connection_lost` cannot be sent
 * while the connection is lost, so the device remembers the moment and reports
 * it on the way back — and this shows the device's hour, saying whose it is.
 */
function Connectivity({
  connectivity,
  zone,
}: {
  readonly connectivity: EmployeeDossier['connectivity'];
  readonly zone: string;
}): JSX.Element {
  const lost = connectivity.counts.connection_lost ?? 0;

  return (
    <div className="dossier__section">
      <h3 className="dossier__title">
        <IconOffline />
        Conexión
      </h3>

      {connectivity.items.length === 0 ? (
        <p className="muted">
          Sin interrupciones registradas en el rango. Solo se registran las que la aplicación
          alcanzó a reportar: un equipo apagado de golpe no deja rastro aquí, sino en la sesión
          que dejó de reportarse.
        </p>
      ) : (
        <>
          <p className="dossier__note">
            {lost === 0
              ? 'Sin cortes de conexión; lo de abajo es actividad de la ventana.'
              : `${plural(lost, 'corte de conexión', 'cortes de conexión')} en el rango.`}{' '}
            La hora es la que reportó el equipo: un corte no se puede avisar mientras dura.
          </p>
          <ul className="dossier__events">
            {connectivity.items.map((event: SessionEvent) => (
              <li className="dossier__event" key={event.id}>
                <span
                  className={
                    event.kind === 'connection_lost' || event.kind === 'request_failed'
                      ? 'swatch swatch--bad'
                      : event.kind === 'connection_back'
                        ? 'swatch swatch--good'
                        : 'swatch swatch--soft'
                  }
                  aria-hidden="true"
                />
                <span className="dossier__event-kind">{SESSION_EVENT_LABELS[event.kind]}</span>
                <span className="dossier__event-when">
                  {formatTime(event.client_reported_at ?? event.occurred_at, zone)}
                  {event.client_reported_at !== null && (
                    <span className="muted"> · reportado {formatTime(event.occurred_at, zone)}</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function Sessions({
  sessions,
  zone,
}: {
  readonly sessions: readonly DossierSession[];
  readonly zone: string;
}): JSX.Element {
  return (
    <div className="dossier__section">
      <h3 className="dossier__title">
        <IconClock />
        Sesiones
      </h3>

      {sessions.length === 0 ? (
        <p className="muted">No ha abierto la aplicación en el rango.</p>
      ) : (
        <div className="dossier__scroll">
          <table className="dossier__table">
            <thead>
              <tr>
                <th scope="col">Inicio</th>
                <th scope="col">Fin</th>
                <th scope="col">Duración</th>
                <th scope="col">Equipo</th>
                <th scope="col">Desde</th>
                <th scope="col">Cómo terminó</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((session) => (
                <tr key={session.id}>
                  <th scope="row">{formatTime(session.started_at, zone)}</th>
                  <td>
                    {session.ended_at === null ? (
                      <span className="pill pill--good">abierta</span>
                    ) : (
                      formatTime(session.ended_at, zone)
                    )}
                  </td>
                  <td>{formatClock(session.seconds)}</td>
                  <td>{session.platform ?? 'sin identificar'}</td>
                  <td className="dossier__ip">{session.ip ?? '—'}</td>
                  <td>
                    {session.end_reason === null ? (
                      '—'
                    ) : (
                      <span
                        className={
                          session.end_reason === 'expired' ? 'pill pill--warn' : 'pill pill--mute'
                        }
                        title={END_REASON_MEANING[session.end_reason]}
                      >
                        {END_REASON_LABELS[session.end_reason]}
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

function Devices({ devices }: { readonly devices: readonly DossierDevice[] }): JSX.Element {
  return (
    <div className="dossier__section">
      <h3 className="dossier__title">
        <IconTeam />
        Equipos
      </h3>

      {devices.length === 0 ? (
        <p className="muted">Ningún equipo registrado.</p>
      ) : (
        <ul className="dossier__devices">
          {devices.map((device) => (
            <li className="dossier__device" key={device.device_id}>
              <span className="dossier__device-agent">
                {device.user_agent ?? 'Equipo sin identificar'}
              </span>
              <span className="dossier__device-span">
                Visto por última vez {formatDate(device.last_seen_at)} · desde{' '}
                {formatDate(device.first_seen_at)}
              </span>
              {device.revoked_at !== null && <span className="pill pill--bad">revocado</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Alerts({ alerts }: { readonly alerts: readonly DossierAlert[] }): JSX.Element {
  // `?? null` rather than a direct comparison: during a deploy window the key is
  // absent, and `undefined !== null` would mark every alert without effect.
  const open = alerts.filter(
    (alert) => alert.state === 'open' && (alert.superseded_at ?? null) === null,
  ).length;
  const voided = alerts.filter((alert) => (alert.superseded_at ?? null) !== null).length;

  return (
    <div className="dossier__section">
      <h3 className="dossier__title">
        <IconAlert />
        Alertas
      </h3>

      {alerts.length === 0 ? (
        <p className="muted">Ninguna alerta en el rango.</p>
      ) : (
        <>
          <p className="dossier__note">
            Todas las del rango, no solo las abiertas ({open} sin atender). Una que RH descartó
            sigue aquí: el historial es el historial.
            {voided > 0 &&
              ` ${String(voided)} quedaron sin efecto porque se anularon los marcajes que las` +
                ' originaron — no cuentan en ninguna cifra.'}
          </p>
          <ul className="dossier__alerts">
            {alerts.map((alert) => (
              <li
                className={
                  (alert.superseded_at ?? null) === null
                    ? 'dossier__alert'
                    : 'dossier__alert is-void'
                }
                key={alert.id}
              >
                <span
                  className={`alert__stripe alert__stripe--${alert.severity}`}
                  aria-hidden="true"
                />
                <span className="dossier__alert-body">
                  <span className="dossier__alert-kind">{ALERT_LABELS[alert.kind]}</span>
                  <span className="dossier__alert-note">
                    {formatDate(alert.alert_date)} · {SEVERITY_LABELS[alert.severity]}
                    {alert.note !== null && alert.note !== '' && ` · ${alert.note}`}
                  </span>
                </span>
                {(alert.superseded_at ?? null) !== null ? (
                  <span
                    className="pill pill--mute"
                    title="Se anularon los marcajes que la originaron, así que no cuenta en ninguna cifra."
                  >
                    Sin efecto
                  </span>
                ) : (
                  <span
                    className={
                      alert.state === 'open'
                        ? 'pill pill--warn'
                        : alert.state === 'dismissed'
                          ? 'pill pill--mute'
                          : 'pill pill--good'
                    }
                  >
                    {ALERT_STATE_LABELS[alert.state]}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function Adjustments({
  adjustments,
  zone,
}: {
  readonly adjustments: readonly DossierAdjustment[];
  readonly zone: string;
}): JSX.Element {
  return (
    <div className="dossier__section">
      <h3 className="dossier__title">
        <IconReview />
        Cambios al registro
      </h3>

      {adjustments.length === 0 ? (
        <p className="muted">Nadie ha ajustado nada de este registro.</p>
      ) : (
        <ul className="dossier__changes">
          {adjustments.map((adjustment) => (
            <li className="dossier__change" key={adjustment.id}>
              <span className="dossier__change-kind">
                {ADJUSTMENT_LABELS[adjustment.kind] ?? adjustment.kind}
              </span>
              <span className="dossier__change-when">
                {formatDate(adjustment.work_date)} · {formatTime(adjustment.created_at, zone)} ·{' '}
                {adjustment.actor ?? 'cuenta administrativa'}
              </span>
              <span className="dossier__change-why">{adjustment.reason}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Punches({
  punches,
  zone,
}: {
  readonly punches: readonly DossierPunch[];
  readonly zone: string;
}): JSX.Element {
  return (
    <div className="dossier__section">
      <h3 className="dossier__title">
        <IconClock />
        Marcajes
      </h3>

      {punches.length === 0 ? (
        <p className="muted">Sin marcajes en el rango.</p>
      ) : (
        <div className="dossier__scroll">
          <table className="dossier__table">
            <thead>
              <tr>
                <th scope="col">Día</th>
                <th scope="col">Marcaje</th>
                <th scope="col">Hora</th>
                <th scope="col">Origen</th>
                <th scope="col">Estado</th>
              </tr>
            </thead>
            <tbody>
              {punches.map((punch) => (
                <tr key={punch.id} className={punch.voided_at === null ? undefined : 'is-void'}>
                  <th scope="row">{formatDate(punch.work_date)}</th>
                  <td>{PUNCH_LABELS[punch.kind]}</td>
                  <td>{formatTime(punch.occurred_at, zone)}</td>
                  <td>
                    {punch.source === 'offline' ? (
                      <span className="pill pill--mute">sincronizado</span>
                    ) : (
                      'en línea'
                    )}
                  </td>
                  <td>
                    {punch.voided_at !== null ? (
                      <>
                        <span className="pill pill--bad">anulado</span>
                        <span className="dossier__void">{punch.void_reason}</span>
                      </>
                    ) : punch.needs_review ? (
                      <span className="pill pill--warn">por revisar</span>
                    ) : (
                      '—'
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

/** A date the database already resolved, formatted without shifting it. */
function formatDate(iso: string): string {
  const stamp = iso.length === 10 ? `${iso}T00:00:00Z` : iso;
  return new Intl.DateTimeFormat('es-MX', {
    day: 'numeric',
    month: 'short',
    ...(iso.length === 10 ? { timeZone: 'UTC' } : {}),
  }).format(new Date(stamp));
}
