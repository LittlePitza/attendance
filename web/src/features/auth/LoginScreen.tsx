import type { AuthError } from '@supabase/supabase-js';
import { useId, useState, type FormEvent, type JSX } from 'react';
import { supabase } from '../../lib/supabase';

/**
 * Sign-in is deliberately the only thing on this screen. Signup is closed --
 * HR creates the accounts -- so there is no register link, and no password
 * reset that would mail a link to an address anyone could type.
 */
export function LoginScreen(): JSX.Element {
  const emailId = useId();
  const passwordId = useId();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const { error: failure } = await supabase.auth.signInWithPassword({ email, password });

    if (failure !== null) {
      setError(signInMessage(failure));
      setBusy(false);
      return;
    }

    // On success the session listener swaps this screen out. Leaving `busy` set
    // keeps the form from being submitted twice during that swap.
  }

  return (
    <main className="screen screen--centered">
      <form className="card login" onSubmit={(event) => void submit(event)}>
        <h1 className="login__title">Checador</h1>
        <p className="login__subtitle">Entra con tu cuenta de trabajo.</p>

        <label className="field" htmlFor={emailId}>
          <span className="field__label">Correo</span>
          <input
            id={emailId}
            className="field__input"
            type="email"
            name="email"
            autoComplete="username"
            inputMode="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>

        <label className="field" htmlFor={passwordId}>
          <span className="field__label">Contraseña</span>
          <input
            id={passwordId}
            className="field__input"
            type="password"
            name="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>

        {error !== null && (
          <p className="notice notice--error" role="alert">
            {error}
          </p>
        )}

        <button className="button button--primary" type="submit" disabled={busy}>
          {busy ? 'Entrando…' : 'Entrar'}
        </button>
      </form>
    </main>
  );
}

/**
 * Auth errors arrive in English from the identity service, and an employee
 * reads this screen. Matching on the stable error code rather than the message
 * keeps a reworded upstream string from silently becoming the generic case.
 *
 * A wrong password and an address that does not exist deliberately produce the
 * same sentence: telling them apart would let anyone check who has an account.
 */
function signInMessage(error: AuthError): string {
  switch (error.code) {
    case 'invalid_credentials':
      return 'Correo o contraseña incorrectos.';
    case 'email_not_confirmed':
      return 'La cuenta todavía no está confirmada. Avisa a Recursos Humanos.';
    case 'over_request_rate_limit':
      return 'Demasiados intentos seguidos. Espera un minuto y vuelve a intentar.';
    default:
      return 'No se pudo entrar. Revisa tu conexión e intenta de nuevo.';
  }
}
