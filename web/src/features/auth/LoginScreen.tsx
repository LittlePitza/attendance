import type { AuthError } from '@supabase/supabase-js';
import { useId, useState, type FormEvent, type JSX } from 'react';
import { readLocal, writeLocal } from '../../lib/storage';
import { supabase } from '../../lib/supabase';
import { IconEye, IconLock, IconMail } from '../shell/icons';
import { AuthLayout } from './AuthLayout';

/** The address this machine signed in with last, when the person asked for it. */
const REMEMBERED_EMAIL_KEY = 'attendance.remembered_email';

/**
 * Sign-in is deliberately the only thing on this screen.
 *
 * Signup is closed -- HR creates the accounts -- so there is no register link.
 * There is no reset link either, and that is a decision rather than an omission:
 * a reset that mails a link to whatever address is typed lets anybody find out
 * which addresses have accounts, and every one of these accounts belongs to
 * somebody who can walk up to HR. The screen says so instead of hiding it.
 *
 * What it does offer is the address remembered on this machine. Only the
 * address, never the password: it saves the daily typing on a work computer
 * that one person uses, and it is the person's own email rather than a secret.
 * It is opt-in and forgotten the moment the box is cleared.
 */
export function LoginScreen(): JSX.Element {
  const emailId = useId();
  const passwordId = useId();
  const rememberId = useId();

  const remembered = readLocal(REMEMBERED_EMAIL_KEY);

  const [email, setEmail] = useState(remembered ?? '');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(remembered !== null && remembered !== '');
  const [revealed, setRevealed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [helping, setHelping] = useState(false);
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

    // Written only once the address is known to be real, so a typo is never
    // what greets the next launch.
    writeLocal(REMEMBERED_EMAIL_KEY, remember ? email.trim() : '');

    // On success the session listener swaps this screen out. Leaving `busy` set
    // keeps the form from being submitted twice during that swap.
  }

  return (
    <AuthLayout
      title="Bienvenido de vuelta"
      subtitle="Entra con tu cuenta de trabajo para registrar tu jornada."
      footer={
        <p className="muted">
          ¿Todavía no tienes acceso? Recursos Humanos crea las cuentas.
        </p>
      }
    >
      <form className="form" onSubmit={(event) => void submit(event)} noValidate>
        <label className="entry" htmlFor={emailId}>
          <span className="entry__label">Correo</span>
          <span className="entry__box">
            <span className="entry__icon">
              <IconMail />
            </span>
            <input
              id={emailId}
              className="entry__input"
              type="email"
              name="email"
              placeholder="nombre@plasticospimsa.com"
              autoComplete="username"
              inputMode="email"
              autoCapitalize="none"
              spellCheck={false}
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </span>
        </label>

        <label className="entry" htmlFor={passwordId}>
          <span className="entry__label">Contraseña</span>
          <span className="entry__box">
            <span className="entry__icon">
              <IconLock />
            </span>
            <input
              id={passwordId}
              className="entry__input"
              type={revealed ? 'text' : 'password'}
              name="password"
              placeholder="••••••••••••"
              autoComplete="current-password"
              required
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

        <div className="form__row">
          <label className="check" htmlFor={rememberId}>
            <input
              id={rememberId}
              type="checkbox"
              checked={remember}
              onChange={(event) => setRemember(event.target.checked)}
            />
            <span>Recordar mi correo</span>
          </label>

          <button
            className="link"
            type="button"
            onClick={() => setHelping((shown) => !shown)}
            aria-expanded={helping}
          >
            ¿Olvidaste tu contraseña?
          </button>
        </div>

        {helping && (
          <p className="notice notice--info" role="status">
            Pídele a Recursos Humanos que te genere una nueva. Te darán una temporal y la
            cambiarás tú al entrar, para que nadie más la sepa.
          </p>
        )}

        {error !== null && (
          <p className="notice notice--error" role="alert">
            {error}
          </p>
        )}

        <button className="button button--primary button--block" type="submit" disabled={busy}>
          {busy ? 'Entrando…' : 'Entrar'}
        </button>
      </form>
    </AuthLayout>
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
