import { useCallback, useMemo, useState, type JSX } from 'react';
import { api } from '../../../lib/api';
import { describeReadFailure } from '../../../lib/errors';
import { ALERT_KINDS, type AlertRuleRow, type DepartmentRow } from '../../../lib/types';
import { IconAlert } from '../../hr/components/icons';
import { ALERT_LABELS } from '../../hr/labels';
import { THRESHOLD_MEANING } from '../labels';

/**
 * What raises an alert, and who gets told.
 *
 * The `recipients` column is why this screen matters most: the dispatcher reads
 * it, and while it is empty every notification falls back to a deployment
 * setting -- and with that unset, it refuses to guess and records the failure
 * rather than mailing attendance alerts to the help desk's own queue. Filling in
 * one address here is the durable fix.
 *
 * **An absent rule is not a disabled rule.** A kind with no row falls back to
 * the evaluator's own threshold, so switching one off is `activa: no` on a row
 * that exists. Nothing here deletes, for exactly that reason.
 *
 * A department row overrides the company row for that kind. Both are kept: the
 * company row is what covers the eight people who have no department.
 */
export function AlertRulesSection({
  rules,
  departments,
  onChanged,
}: {
  readonly rules: readonly AlertRuleRow[];
  readonly departments: readonly DepartmentRow[];
  readonly onChanged: () => void;
}): JSX.Element {
  const [scopeId, setScopeId] = useState<string>('');

  const shown = useMemo(
    () => rules.filter((rule) => (rule.department_id ?? '') === scopeId),
    [rules, scopeId],
  );

  // A department with no rows of its own inherits every company rule, so the
  // screen offers the kinds that are missing rather than an empty list.
  const missing = useMemo(
    () => ALERT_KINDS.filter((kind) => !shown.some((rule) => rule.kind === kind)),
    [shown],
  );

  const withOverrides = useMemo(
    () => new Set(rules.map((rule) => rule.department_id).filter((id) => id !== null)),
    [rules],
  );

  return (
    <section className="panel">
      <div className="panel__head">
        <div>
          <h2 className="panel__title">
            <IconAlert />
            Reglas de alerta
          </h2>
          <p className="panel__subtitle">
            Sin destinatarios la alerta se levanta pero no se envía a nadie.
          </p>
        </div>

        <div className="panel__tools">
          <label>
            <span className="sr-only">Alcance de las reglas</span>
            <select
              className="field"
              value={scopeId}
              onChange={(event) => setScopeId(event.target.value)}
            >
              <option value="">Toda la empresa</option>
              {departments.map((department) => (
                <option key={department.id} value={department.id}>
                  {department.name}
                  {withOverrides.has(department.id) ? ' · con reglas propias' : ''}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div className="panel__body admin__rules">
        {scopeId !== '' && (
          <p className="note" role="status">
            Lo que no tenga regla propia aquí se rige por la de toda la empresa.
          </p>
        )}

        {shown.map((rule) => (
          <RuleRow key={rule.id} rule={rule} onChanged={onChanged} />
        ))}

        {missing.map((kind) => (
          <RuleRow
            key={`new-${kind}`}
            rule={{
              id: `new-${kind}`,
              department_id: scopeId === '' ? null : scopeId,
              department: '',
              kind,
              active: true,
              threshold_minutes: 15,
              recipients: null,
              updated_at: '',
            }}
            isNew
            onChanged={onChanged}
          />
        ))}
      </div>
    </section>
  );
}

function RuleRow({
  rule,
  isNew = false,
  onChanged,
}: {
  readonly rule: AlertRuleRow;
  readonly isNew?: boolean;
  readonly onChanged: () => void;
}): JSX.Element {
  const [active, setActive] = useState(rule.active);
  const [threshold, setThreshold] = useState(rule.threshold_minutes);
  const [recipients, setRecipients] = useState(rule.recipients ?? '');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const save = useCallback(async (): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      await api.saveAlertRule({
        kind: rule.kind,
        active,
        thresholdMinutes: threshold,
        // Blank is not a decision to send nowhere: the dispatcher falls back to
        // its deployment default. The database stores blank and null the same
        // way, so sending null says what is meant.
        recipients: recipients.trim() === '' ? null : recipients.trim(),
        departmentId: rule.department_id,
      });
      onChanged();
    } catch (error) {
      setFailure(describeReadFailure(error));
    } finally {
      setBusy(false);
    }
  }, [rule.kind, rule.department_id, active, threshold, recipients, onChanged]);

  const changed =
    active !== rule.active ||
    threshold !== rule.threshold_minutes ||
    recipients.trim() !== (rule.recipients ?? '');

  // The one kind that fires on an event rather than after a wait. Showing it a
  // threshold box would invite setting a number that changes nothing.
  const timed = rule.kind !== 'review_offline';

  return (
    <div className={`admin__rule${active ? '' : ' admin__rule--off'}`}>
      <div className="admin__rule-head">
        <span className="admin__rule-name">{ALERT_LABELS[rule.kind]}</span>
        {isNew && <span className="pill pill--mute">Hereda</span>}
        <label className="admin__toggle">
          <input
            type="checkbox"
            checked={active}
            onChange={(event) => setActive(event.target.checked)}
          />
          <span>Activa</span>
        </label>
      </div>

      <div className="admin__rule-body">
        {timed && (
          <label className="admin__field admin__field--narrow">
            <span className="admin__label">Umbral</span>
            <input
              className="field"
              type="number"
              min={0}
              max={1440}
              value={threshold}
              onChange={(event) => {
                const parsed = Number.parseInt(event.target.value, 10);
                setThreshold(Number.isNaN(parsed) ? 0 : parsed);
              }}
            />
          </label>
        )}

        <label className="admin__field">
          <span className="admin__label">Destinatarios</span>
          <input
            className="field"
            type="text"
            value={recipients}
            placeholder="rh@plasticospimsa.com, gte.rh@plasticospimsa.com"
            onChange={(event) => setRecipients(event.target.value)}
          />
        </label>

        <button
          type="button"
          className="btn btn--solid"
          disabled={busy || !changed}
          onClick={() => void save()}
        >
          Guardar
        </button>
      </div>

      <p className="admin__hint">{THRESHOLD_MEANING[rule.kind]}</p>
      {recipients.trim() === '' && active && (
        <p className="admin__hint admin__hint--warn">
          Sin destinatarios esta alerta se registra pero no se envía por correo.
        </p>
      )}
      {failure !== null && <p className="review__error">{failure}</p>}
    </div>
  );
}
