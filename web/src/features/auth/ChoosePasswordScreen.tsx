import { useId, useState, type FormEvent, type JSX } from 'react';
import { api } from '../../lib/api';
import { describeReadFailure } from '../../lib/errors';
import { IconEye, IconLock } from '../shell/icons';
import { AuthLayout } from './AuthLayout';

/**
 * The minimum this project settled on.
 *
 * Twelve characters, and it is not an arbitrary number: the Free plan does not
 * offer the leaked-password check that Pro does, so length is most of what is
 * left. See `docs/free-plan.md` -- it is compensated for, not equivalent.
 */
const MIN_LENGTH = 12;

/**
 * The screen between a temporary password and the application.
 *
 * HR hands out the first password, which means HR knows it. This is the only
 * thing that ends that, so it is a wall rather than a prompt: nothing else is
 * reachable while `must_change_password` is set on the account, and the flag is
 * cleared in the same call that sets the new password -- one round trip, so
 * there is no state where the password changed and the flag did not.
 *
 * There is no "skip" and no way around it except signing out. A reminder that
 * can be dismissed is a reminder that is dismissed.
 */
export function ChoosePasswordScreen({
  onSignOut,
}: {
  readonly onSignOut: () => void;
}): JSX.Element {
  const passwordId = useId();
  const confirmId = useId();

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const tooShort = password !== '' && password.length < MIN_LENGTH;
  const mismatched = confirm !== '' && confirm !== password;
  const ready = password.length >= MIN_LENGTH && confirm === password && !busy;

  // Clamped at the minimum rather than the strongest password imaginable: the
  // bar is twelve characters, and a meter that stays a third full after
  // somebody clears the bar is telling them they failed when they did not.
  const filled = Math.min(1, password.length / MIN_LENGTH);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      await api.chooseOwnPassword(password);
      // The auth client emits USER_UPDATED with the new metadata, and the
      // session listener swaps this screen out. Leaving `busy` set keeps the
      // form from being submitted twice during that swap.
    } catch (failure) {
      setError(describeReadFailure(failure));
      setBusy(false);
    }
  }

  return (
    <AuthLayout
      title="Elige tu contraseña"
      subtitle="La que te dieron es temporal y Recursos Humanos la conoce. Cuando elijas la tuya, nadie más la sabrá."
    >
      <form className="form" onSubmit={(event) => void submit(event)} noValidate>
        <label className="entry" htmlFor={passwordId}>
          <span className="entry__label">Nueva contraseña</span>
          <span className="entry__box">
            <span className="entry__icon">
              <IconLock />
            </span>
            <input
              id={passwordId}
              className="entry__input"
              type={revealed ? 'text' : 'password'}
              name="new-password"
              autoComplete="new-password"
              required
              minLength={MIN_LENGTH}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <button
              className="entry__reveal"
              type="button"
              onClick={() => setRevealed((shown) => !shown)}
              aria-label={revealed ? 'Ocultar la contraseña' : 'Mostrar la contraseña'}
              aria-pressed={revealed}
            >
              <IconEye open={revealed} />
            </button>
          </span>
        </label>

        {/* Said before the attempt, not after it: the rule is not a surprise. */}
        <div className="meter" aria-hidden="true">
          <span className="meter__fill" style={{ scale: `${String(filled)} 1` }} />
        </div>
        <p className="muted">
          {tooShort
            ? `Te faltan ${String(MIN_LENGTH - password.length)} caracteres.`
            : `Al menos ${String(MIN_LENGTH)} caracteres.`}
        </p>

        <label className="entry" htmlFor={confirmId}>
          <span className="entry__label">Repítela</span>
          <span className="entry__box">
            <span className="entry__icon">
              <IconLock />
            </span>
            <input
              id={confirmId}
              className="entry__input"
              type={revealed ? 'text' : 'password'}
              name="confirm-password"
              autoComplete="new-password"
              required
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
            />
          </span>
        </label>

        {mismatched && <p className="muted">Las dos no coinciden.</p>}

        {error !== null && (
          <p className="notice notice--error" role="alert">
            {error}
          </p>
        )}

        <button className="button button--primary button--block" type="submit" disabled={!ready}>
          {busy ? 'Guardando…' : 'Guardar y continuar'}
        </button>

        <button className="button button--quiet button--block" type="button" onClick={onSignOut}>
          Salir
        </button>
      </form>
    </AuthLayout>
  );
}
