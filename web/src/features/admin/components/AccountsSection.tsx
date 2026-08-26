import { useCallback, useMemo, useState, type JSX } from 'react';
import { api } from '../../../lib/api';
import { describeReadFailure } from '../../../lib/errors';
import {
  ASSIGNABLE_ROLES,
  type AccountRow,
  type AssignableRole,
  type ProvisionResult,
} from '../../../lib/types';
import { IconCopy, IconKey, IconSearch } from '../../hr/components/icons';
import { plural } from '../../hr/labels';
import { ROLE_LABELS, ROLE_SCOPES, describeLastSignIn } from '../labels';

/** The database refuses anything shorter, and says so. Saying so first is kinder. */
const MIN_REASON = 10;

/**
 * Who can sign in, and the four things HR can do about it.
 *
 * The list is every active person, not every account, because the question this
 * screen answers most often is *"who still cannot get in"* -- and a list of
 * accounts is exactly the list that cannot answer it.
 *
 * Nothing here decides who may act: `list_accounts()` refuses anybody who is
 * not HR or admin outright, and every write is gated again in the database. A
 * role select showing `Administrador` to an HR session is not a hole -- the
 * database refuses it, in Spanish, and that refusal is what the screen prints.
 */
export function AccountsSection({
  accounts,
  onChanged,
}: {
  readonly accounts: readonly AccountRow[];
  readonly onChanged: () => void;
}): JSX.Element {
  const [query, setQuery] = useState('');
  const [pendingOnly, setPendingOnly] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();

    return accounts.filter((account) => {
      if (pendingOnly && account.has_account) {
        return false;
      }
      if (needle === '') {
        return true;
      }
      return (
        account.employee_name.toLowerCase().includes(needle) ||
        (account.department ?? '').toLowerCase().includes(needle) ||
        account.employee_email.toLowerCase().includes(needle)
      );
    });
  }, [accounts, query, pendingOnly]);

  const withoutAccess = accounts.filter((account) => !account.has_account).length;
  const temporary = accounts.filter((account) => account.must_change_password).length;
  const person = accounts.find((account) => account.employee_id === selected) ?? null;

  return (
    <div className="admin__split">
      <section className="panel">
        <div className="panel__head">
          <div>
            <h2 className="panel__title">Accesos</h2>
            <p className="panel__subtitle">
              {withoutAccess === 0
                ? 'Todas las personas activas tienen cuenta.'
                : `${plural(withoutAccess, 'persona', 'personas')} sin cuenta`}
              {temporary > 0 &&
                ` · ${plural(temporary, 'contraseña temporal', 'contraseñas temporales')} sin cambiar`}
            </p>
          </div>

          <div className="panel__tools">
            <label className="search">
              <span className="search__icon">
                <IconSearch />
              </span>
              <span className="sr-only">Buscar persona</span>
              <input
                className="field"
                type="search"
                value={query}
                placeholder="Buscar…"
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <button
              type="button"
              className={pendingOnly ? 'btn btn--solid' : 'btn'}
              aria-pressed={pendingOnly}
              onClick={() => setPendingOnly((only) => !only)}
            >
              Sin cuenta
            </button>
          </div>
        </div>

        <ul className="admin__list">
          {visible.map((account) => (
            <li key={account.employee_id}>
              <button
                type="button"
                className={`admin__pick${selected === account.employee_id ? ' admin__pick--on' : ''}`}
                aria-pressed={selected === account.employee_id}
                onClick={() =>
                  setSelected(selected === account.employee_id ? null : account.employee_id)
                }
              >
                <span className="admin__pick-main">
                  <span className="admin__pick-name">{account.employee_name}</span>
                  <span className="muted">
                    {account.job_title ?? 'Sin puesto'} · {account.department ?? 'Sin departamento'}
                  </span>
                </span>
                <AccessBadge account={account} />
              </button>
            </li>
          ))}
          {visible.length === 0 && (
            <li className="empty">Nadie coincide con esa búsqueda.</li>
          )}
        </ul>
      </section>

      {person === null ? (
        <section className="panel">
          <div className="panel__body">
            <p className="muted">
              Elige a una persona para darle acceso, cambiar su rol, entregarle una contraseña
              temporal o retirarle la cuenta.
            </p>
          </div>
        </section>
      ) : (
        <AccessCard key={person.employee_id} person={person} onChanged={onChanged} />
      )}
    </div>
  );
}

/** Three states, and they are the three questions the list is scanned for. */
function AccessBadge({ account }: { readonly account: AccountRow }): JSX.Element {
  if (!account.has_account) {
    return <span className="pill pill--mute">Sin cuenta</span>;
  }
  if (account.must_change_password) {
    return <span className="pill pill--warn">Contraseña temporal</span>;
  }
  return (
    <span className="pill pill--good">
      {account.role === null ? 'Sin rol' : ROLE_LABELS[account.role]}
    </span>
  );
}

function AccessCard({
  person,
  onChanged,
}: {
  readonly person: AccountRow;
  readonly onChanged: () => void;
}): JSX.Element {
  const [role, setRole] = useState<AssignableRole>(person.role ?? 'employee');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [handout, setHandout] = useState<ProvisionResult | null>(null);

  /**
   * One place runs every action, so the busy flag, the failure and the reason
   * box cannot get out of step with each other. `onChanged` re-reads the list
   * rather than predicting it, which is the same rule the punch screen follows.
   */
  const run = useCallback(
    async (action: () => Promise<ProvisionResult | unknown>, keepReason = false): Promise<void> => {
      setBusy(true);
      setFailure(null);
      try {
        const result = await action();
        setHandout(
          typeof result === 'object' && result !== null && 'temporary_password' in result
            ? (result as ProvisionResult)
            : null,
        );
        if (!keepReason) {
          setReason('');
        }
        onChanged();
      } catch (error) {
        setFailure(describeReadFailure(error));
      } finally {
        setBusy(false);
      }
    },
    [onChanged],
  );

  const reasonReady = reason.trim().length >= MIN_REASON;

  return (
    <section className="panel">
      <div className="panel__head">
        <div>
          <h2 className="panel__title">{person.employee_name}</h2>
          <p className="panel__subtitle">
            {person.employee_email}
            {person.has_account && ` · ${describeLastSignIn(person.last_sign_in_at)}`}
          </p>
        </div>
      </div>

      <div className="panel__body admin__form">
        <dl className="admin__facts">
          <div>
            <dt>Departamento</dt>
            <dd>{person.department ?? 'Sin departamento'}</dd>
          </div>
          <div>
            <dt>Horario que le aplica</dt>
            <dd>{person.schedule_name ?? 'Ninguno hoy'}</dd>
          </div>
          <div>
            <dt>Acceso</dt>
            <dd>{person.has_account ? (person.role === null ? 'Sin rol' : ROLE_LABELS[person.role]) : 'Sin cuenta'}</dd>
          </div>
        </dl>

        <div className="admin__field">
          <label className="admin__labelled">
            <span className="admin__label">Rol</span>
            <select
              className="field"
              value={role}
              onChange={(event) => setRole(event.target.value as AssignableRole)}
            >
              {ASSIGNABLE_ROLES.map((option) => (
                <option key={option} value={option}>
                  {ROLE_LABELS[option]}
                </option>
              ))}
            </select>
          </label>
          <span className="admin__hint">{ROLE_SCOPES[role]}</span>
        </div>

        {person.has_account ? (
          <>
            <label className="admin__field admin__labelled">
              <span className="admin__label">Motivo</span>
              <textarea
                className="admin__reason"
                rows={2}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Por qué cambia su acceso. Queda en la bitácora."
              />
            </label>

            <div className="admin__actions">
              <button
                type="button"
                className="btn btn--solid"
                disabled={busy || !reasonReady || role === person.role}
                onClick={() => void run(() => api.setAccountRole(person.employee_id, role, reason))}
              >
                Guardar rol
              </button>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => void run(() => api.resetPassword(person.employee_id))}
              >
                <IconKey />
                Contraseña temporal
              </button>
              <button
                type="button"
                className="btn btn--danger"
                disabled={busy || !reasonReady}
                onClick={() => void run(() => api.revokeAccount(person.employee_id, reason))}
              >
                Retirar acceso
              </button>
            </div>
            {role === person.role && (
              <p className="admin__hint">
                Ya tiene ese rol. Elige otro para poder guardar el cambio.
              </p>
            )}
          </>
        ) : (
          <div className="admin__actions">
            <button
              type="button"
              className="btn btn--solid"
              disabled={busy}
              onClick={() => void run(() => api.createAccount(person.employee_id, role))}
            >
              Crear acceso
            </button>
            <span className="admin__hint">
              Se crea con {person.employee_email} y una contraseña temporal que solo se muestra una
              vez.
            </span>
          </div>
        )}

        {handout?.temporary_password !== undefined && (
          <Handout result={handout} onDismiss={() => setHandout(null)} />
        )}

        {handout !== null && handout.recorded === false && (
          <p className="note note--warn" role="status">
            La contraseña se cambió, pero no se pudo escribir en la bitácora. Avisa a Sistemas.
          </p>
        )}

        {failure !== null && <p className="review__error">{failure}</p>}
      </div>
    </section>
  );
}

/**
 * The one moment a credential is on screen.
 *
 * It is deliberately loud and deliberately dismissible: nothing stores it, so
 * the only way back to it is another reset, and somebody reading it off a
 * shoulder is exactly the risk it is worth being loud about.
 */
function Handout({
  result,
  onDismiss,
}: {
  readonly result: ProvisionResult;
  readonly onDismiss: () => void;
}): JSX.Element {
  const [copied, setCopied] = useState(false);
  const password = result.temporary_password ?? '';

  const copy = useCallback((): void => {
    // Not available over plain HTTP, and refused if the document is not
    // focused. The password is on screen either way, so a failure here costs
    // the convenience and nothing else.
    void navigator.clipboard
      .writeText(password)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  }, [password]);

  return (
    <div className="admin__handout" role="status">
      <p className="admin__handout-title">Contraseña temporal de {result.employee_name}</p>
      <div className="admin__handout-row">
        <code className="admin__secret">{password}</code>
        <button type="button" className="btn" onClick={copy}>
          <IconCopy />
          {copied ? 'Copiada' : 'Copiar'}
        </button>
        <button type="button" className="btn btn--quiet" onClick={onDismiss}>
          Ocultar
        </button>
      </div>
      <p className="admin__hint">
        Entrégala en persona. La aplicación le pedirá cambiarla en cuanto entre, y a partir de ese
        momento nadie más la conoce. No se puede volver a consultar.
      </p>
    </div>
  );
}
