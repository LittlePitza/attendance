import { useId, useState, type FormEvent, type JSX } from 'react';
import { api } from '../../lib/api';
import { describeReadFailure } from '../../lib/errors';

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
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const tooShort = password !== '' && password.length < MIN_LENGTH;
  const mismatched = confirm !== '' && confirm !== password;
  const ready = password.length >= MIN_LENGTH && confirm === password && !busy;

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
    <main className="screen screen--centered">
      <form className="card login" onSubmit={(event) => void submit(event)}>
        <h1 className="login__title">Elige tu contraseña</h1>
        <p className="login__subtitle">
          La que te dieron es temporal y Recursos Humanos la conoce. Cuando elijas la tuya, nadie
          más la sabrá.
        </p>

        <label className="field" htmlFor={passwordId}>
          <span className="field__label">Nueva contraseña</span>
          <input
            id={passwordId}
            className="field__input"
            type="password"
            name="new-password"
            autoComplete="new-password"
            required
            minLength={MIN_LENGTH}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>

        <label className="field" htmlFor={confirmId}>
          <span className="field__label">Repítela</span>
          <input
            id={confirmId}
            className="field__input"
            type="password"
            name="confirm-password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
          />
        </label>

        {/* Said before the attempt, not after it: the rule is not a surprise. */}
        <p className="muted">
          {tooShort
            ? `Te faltan ${String(MIN_LENGTH - password.length)} caracteres.`
            : mismatched
              ? 'Las dos no coinciden.'
              : `Al menos ${String(MIN_LENGTH)} caracteres.`}
        </p>

        {error !== null && (
          <p className="notice notice--error" role="alert">
            {error}
          </p>
        )}

        <button className="button button--primary" type="submit" disabled={!ready}>
          {busy ? 'Guardando…' : 'Guardar y continuar'}
        </button>

        <button className="button button--quiet" type="button" onClick={onSignOut}>
          Salir
        </button>
      </form>
    </main>
  );
}
