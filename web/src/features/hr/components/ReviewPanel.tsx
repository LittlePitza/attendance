import { useCallback, useState, type JSX } from 'react';
import { api } from '../../../lib/api';
import { describeReadFailure } from '../../../lib/errors';
import type {
  AlertDecision,
  EmployeeDay,
  OpenAlert,
  PunchDecision,
  ReviewPunch,
  TeamMember,
} from '../../../lib/types';
import {
  ALERT_DECISION_LABELS,
  ALERT_LABELS,
  DECISION_LABELS,
  PUNCH_LABELS,
  SEVERITY_LABELS,
  describeAlert,
  formatTime,
  plural,
} from '../labels';
import { IconAlert, IconReview } from './icons';

/** The database refuses anything shorter, and says so. Saying so first is kinder. */
const MIN_REASON = 10;

/**
 * Where a judgement gets written down.
 *
 * This screen exists because the board could already say *"there is something
 * to review here"* and nothing could act on it. It is the only place in the
 * client that writes, and every write it makes carries a reason.
 *
 * **Deciding an alert lives here, not on the board.** The alerts list is a
 * record of what happened, and a one-click dismissal on it would turn it into
 * an inbox to clear -- there is a test on the board asserting no such button
 * exists. Somebody who missed their entry window and turned up two hours later
 * was still absent at 09:30; what that was worth is a sentence somebody has to
 * write, and this is where they write it.
 *
 * Nothing here is optimistic. After a decision the screen asks the database
 * again rather than predicting the answer, which is the same rule the punch
 * screen follows.
 */
export function ReviewPanel({
  team,
  alerts,
  day,
  dayError,
  dayLoading,
  selected,
  onSelect,
  timeZone,
  onDecided,
}: {
  readonly team: readonly TeamMember[];
  readonly alerts: readonly OpenAlert[];
  readonly day: EmployeeDay | null;
  readonly dayError: string | null;
  readonly dayLoading: boolean;
  readonly selected: string | null;
  readonly onSelect: (employeeId: string | null) => void;
  readonly timeZone: string;
  readonly onDecided: () => void;
}): JSX.Element {
  const flagged = team.filter((member) => member.needs_review);

  return (
    <div className="review">
      <section className="card">
        <h2 className="card__title">
          <IconReview />
          Marcajes por revisar
        </h2>

        {flagged.length === 0 ? (
          <p className="muted">
            Ninguna jornada quedó marcada para revisión. Los marcajes que llegan con el
            reloj del equipo fuera de hora, o mucho después de ocurrir, aparecen aquí.
          </p>
        ) : (
          <ul className="review__list">
            {flagged.map((member) => (
              <li key={member.employee_id}>
                <button
                  type="button"
                  className={`review__pick${
                    selected === member.employee_id ? ' review__pick--on' : ''
                  }`}
                  aria-pressed={selected === member.employee_id}
                  onClick={() =>
                    onSelect(selected === member.employee_id ? null : member.employee_id)
                  }
                >
                  <span className="review__who">{member.employee_name}</span>
                  <span className="muted">{member.department ?? 'Sin departamento'}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {dayError !== null && <p className="review__error">{dayError}</p>}
        {dayLoading && <p className="muted">Cargando la jornada…</p>}

        {day !== null && (
          <PunchEvidence day={day} timeZone={timeZone} onDecided={onDecided} />
        )}
      </section>

      <AlertDecisions alerts={alerts} onDecided={onDecided} />
    </div>
  );
}

/** The punches of one day, with what the device claimed when each arrived. */
function PunchEvidence({
  day,
  timeZone,
  onDecided,
}: {
  readonly day: EmployeeDay;
  readonly timeZone: string;
  readonly onDecided: () => void;
}): JSX.Element {
  const pending = day.punches.filter((punch) => punch.needs_review);

  return (
    <div className="review__day">
      <h3 className="review__day-title">
        {day.employee_name} · {day.date}
      </h3>

      {pending.length === 0 ? (
        <p className="muted">Esta jornada ya no tiene marcajes pendientes.</p>
      ) : (
        <ul className="review__punches">
          {pending.map((punch) => (
            <PunchRow
              key={punch.id}
              punch={punch}
              timeZone={timeZone}
              onDecided={onDecided}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function PunchRow({
  punch,
  timeZone,
  onDecided,
}: {
  readonly punch: ReviewPunch;
  readonly timeZone: string;
  readonly onDecided: () => void;
}): JSX.Element {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const decide = useCallback(
    async (decision: PunchDecision): Promise<void> => {
      setBusy(true);
      setFailure(null);
      try {
        await api.reviewPunch(punch.id, decision, reason);
        setReason('');
        onDecided();
      } catch (error) {
        // The database writes these in Spanish because HR reads them. Showing
        // its words beats inventing kinder ones that say less.
        setFailure(describeReadFailure(error));
      } finally {
        setBusy(false);
      }
    },
    [punch.id, reason, onDecided],
  );

  const ready = reason.trim().length >= MIN_REASON && !busy;

  return (
    <li className="review__punch">
      <div className="review__punch-head">
        <strong>{PUNCH_LABELS[punch.kind]}</strong>
        <span className="review__stamp">{formatTime(punch.occurred_at, timeZone)}</span>
        {punch.decision !== null && (
          <span className="review__verdict">{DECISION_LABELS[punch.decision.kind]}</span>
        )}
      </div>

      {/* The engine's own words for why it did not trust this punch. */}
      {punch.review_reason !== null && (
        <p className="review__why">{punch.review_reason}</p>
      )}

      <dl className="review__evidence">
        <div>
          <dt>Origen</dt>
          <dd>{punch.source === 'offline' ? 'Sincronizado' : 'En línea'}</dd>
        </div>
        {punch.client_reported_at !== null && (
          <div>
            <dt>Hora del equipo</dt>
            <dd>{formatTime(punch.client_reported_at, timeZone)}</dd>
          </div>
        )}
        {punch.clock_skew_ms !== null && (
          <div>
            <dt>Desfase</dt>
            <dd>{plural(Math.round(Math.abs(punch.clock_skew_ms) / 1000), 'segundo', 'segundos')}</dd>
          </div>
        )}
        {punch.sync_delay_seconds !== null && (
          <div>
            <dt>Tardó en llegar</dt>
            <dd>{plural(Math.round(punch.sync_delay_seconds / 60), 'minuto', 'minutos')}</dd>
          </div>
        )}
      </dl>

      <label className="review__field">
        <span className="review__label">Motivo</span>
        <textarea
          className="review__reason"
          value={reason}
          rows={2}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Por qué se aprueba o se rechaza. Queda en el expediente."
        />
      </label>

      <div className="review__actions">
        <button
          type="button"
          className="btn btn--solid"
          disabled={!ready}
          onClick={() => void decide('approve_offline')}
        >
          Aprobar
        </button>
        <button
          type="button"
          className="btn btn--quiet"
          disabled={!ready}
          onClick={() => void decide('reject_offline')}
        >
          Rechazar
        </button>
      </div>

      {failure !== null && <p className="review__error">{failure}</p>}
    </li>
  );
}

/** Alerts, and the sentence that closes one. */
function AlertDecisions({
  alerts,
  onDecided,
}: {
  readonly alerts: readonly OpenAlert[];
  readonly onDecided: () => void;
}): JSX.Element {
  return (
    <section className="card">
      <h2 className="card__title">
        <IconAlert />
        Alertas por resolver
      </h2>

      {alerts.length === 0 ? (
        <p className="muted">No hay alertas abiertas.</p>
      ) : (
        <ul className="review__punches">
          {alerts.map((alert) => (
            <AlertRow key={alert.id} alert={alert} onDecided={onDecided} />
          ))}
        </ul>
      )}
    </section>
  );
}

function AlertRow({
  alert,
  onDecided,
}: {
  readonly alert: OpenAlert;
  readonly onDecided: () => void;
}): JSX.Element {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const decide = useCallback(
    async (state: AlertDecision): Promise<void> => {
      setBusy(true);
      setFailure(null);
      try {
        await api.decideAlert(alert.id, state, note);
        setNote('');
        onDecided();
      } catch (error) {
        setFailure(describeReadFailure(error));
      } finally {
        setBusy(false);
      }
    },
    [alert.id, note, onDecided],
  );

  const ready = note.trim().length >= MIN_REASON && !busy;

  return (
    <li className="review__punch">
      <div className="review__punch-head">
        <strong>{ALERT_LABELS[alert.kind]}</strong>
        <span className="review__stamp">{alert.employee_name}</span>
        <span className="review__verdict">{SEVERITY_LABELS[alert.severity]}</span>
      </div>

      <p className="review__why">{describeAlert(alert.kind, alert.details)}</p>

      <label className="review__field">
        <span className="review__label">Nota</span>
        <textarea
          className="review__reason"
          value={note}
          rows={2}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Qué se decidió y por qué. La alerta no se borra: queda con esta nota."
        />
      </label>

      <div className="review__actions">
        {(Object.keys(ALERT_DECISION_LABELS) as AlertDecision[]).map((state) => (
          <button
            key={state}
            type="button"
            className={state === 'resolved' ? 'btn btn--solid' : 'btn btn--quiet'}
            disabled={!ready}
            onClick={() => void decide(state)}
          >
            {ALERT_DECISION_LABELS[state]}
          </button>
        ))}
      </div>

      {failure !== null && <p className="review__error">{failure}</p>}
    </li>
  );
}
