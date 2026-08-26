import type { JSX, ReactNode } from 'react';
import { useTick } from '../../hooks/useTick';
import { IconMark } from '../shell/icons';
import { Mesh } from '../shell/Mesh';

/**
 * The shell both signed-out screens sit in: a form on the left, the mesh on the
 * right.
 *
 * The split is what a person recognises before they read anything, so signing
 * in and choosing a first password look like the same place rather than like
 * two applications. Below 60rem the art panel becomes a band above the form
 * instead of disappearing -- on a phone the mark and the clock are still the
 * fastest way to know which application opened.
 *
 * The clock over the mesh is the device's, in the browser's own zone, and it is
 * the one figure on this screen that is not decoration: this is a time clock,
 * and the thing somebody wants to know at the moment they open it is what time
 * it is. Nobody has signed in yet, so there is no employee zone to prefer over
 * the machine's -- and the record is stamped by the server regardless of what
 * this says.
 */
export function AuthLayout({
  title,
  subtitle,
  children,
  footer = null,
}: {
  readonly title: string;
  readonly subtitle: string;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
}): JSX.Element {
  return (
    <main className="auth">
      <section className="auth__panel">
        <div className="auth__form">
          <span className="auth__mark">
            <IconMark />
          </span>

          <h1 className="auth__title">{title}</h1>
          <p className="auth__subtitle">{subtitle}</p>

          {children}

          {footer !== null && <div className="auth__footer">{footer}</div>}
        </div>
      </section>

      <aside className="auth__art">
        <Mesh variant="panel" />
        <DeviceClock />
      </aside>
    </main>
  );
}

function DeviceClock(): JSX.Element {
  const now = useTick(1000);

  return (
    <div className="auth__clock">
      <p className="auth__time">
        {new Intl.DateTimeFormat('es-MX', {
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
        }).format(now)}
      </p>
      <p className="auth__day">
        {new Intl.DateTimeFormat('es-MX', {
          weekday: 'long',
          day: 'numeric',
          month: 'long',
        }).format(now)}
      </p>
    </div>
  );
}
