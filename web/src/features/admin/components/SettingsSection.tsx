import { useCallback, useState, type JSX } from 'react';
import { api } from '../../../lib/api';
import { describeReadFailure } from '../../../lib/errors';
import type { AttendanceSettings } from '../../../lib/types';
import { IconReport } from '../../hr/components/icons';
import { WEEKDAYS, describeWeekSpan } from '../labels';

/**
 * Where a week begins.
 *
 * The company's week runs Thursday to Wednesday, which no date library and no
 * Postgres builtin knows: `date_trunc('week', ...)` is ISO and starts on Monday.
 * So the convention is a setting, and this is the one screen that moves it.
 *
 * **It changes a meaning, not a number.** No week is stored anywhere -- Reportes
 * resolves its bounds on every read and the weekly grouping in every summary is
 * derived the same way -- so saving this does not migrate or recompute anything.
 * It changes what the word "semana" refers to from the next read onwards, on
 * every screen at once, which is the point and also the reason it is said out
 * loud beside the control rather than left to be discovered.
 *
 * The selector is built from `WEEKDAYS`, the same list the schedule screen uses,
 * and it computes no dates: the span beneath it is the convention named, not a
 * week worked out here. That arithmetic lives in `internal.week_start()` and
 * nowhere else.
 */
export function SettingsSection({
  settings,
  onChanged,
}: {
  readonly settings: AttendanceSettings | null;
  readonly onChanged: () => void;
}): JSX.Element {
  if (settings === null) {
    return (
      <section className="panel">
        <div className="panel__head">
          <div>
            <h2 className="panel__title">
              <IconReport />
              Periodos
            </h2>
          </div>
        </div>
        <div className="panel__body">
          {/* The settings_read policy admits hr and admin. A manager reaching
            * this tab is the policy working, so it says so instead of showing an
            * empty control that would look broken. */}
          <p className="note">Esta configuración solo la puede ver Recursos Humanos o un administrador.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="panel">
      <div className="panel__head">
        <div>
          <h2 className="panel__title">
            <IconReport />
            Periodos
          </h2>
          <p className="panel__subtitle">
            Con qué día empieza la semana en los reportes y en los resúmenes.
          </p>
        </div>
      </div>

      <div className="panel__body">
        <WeekStartField settings={settings} onChanged={onChanged} />
      </div>
    </section>
  );
}

function WeekStartField({
  settings,
  onChanged,
}: {
  readonly settings: AttendanceSettings;
  readonly onChanged: () => void;
}): JSX.Element {
  const [dow, setDow] = useState(settings.week_start_dow);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState<number | null>(null);

  const save = useCallback(async (): Promise<void> => {
    setBusy(true);
    setFailure(null);
    setSaved(null);
    try {
      // What came back from the write, not what the reload will eventually
      // say: the confirmation is evidence the database accepted this day, and
      // it must not depend on a second read landing.
      const stored = await api.saveSettings(dow);
      setSaved(stored.week_start_dow);
      onChanged();
    } catch (error) {
      // The database's own Spanish sentence, not a kinder one invented here.
      setFailure(describeReadFailure(error));
    } finally {
      setBusy(false);
    }
  }, [dow, onChanged]);

  const changed = dow !== settings.week_start_dow;

  /**
   * The picker still shows what was written.
   *
   * Not `!changed`: that asks whether the reload has caught up, and a slow or
   * failed reload would swallow the confirmation for a write that succeeded --
   * which is how somebody ends up pressing Guardar twice.
   */
  const confirmed = saved !== null && saved === dow;

  return (
    <div className="admin__rule">
      <div className="admin__rule-head">
        <span className="admin__rule-name">Inicio de la semana</span>
        <span className="pill pill--mute">{describeWeekSpan(settings.week_start_dow)}</span>
      </div>

      <div className="admin__rule-body">
        <label className="admin__field">
          <span className="admin__label">Primer día</span>
          <select
            className="field"
            value={String(dow)}
            onChange={(event) => {
              setDow(Number.parseInt(event.target.value, 10));
              setSaved(null);
            }}
          >
            {WEEKDAYS.map((day) => (
              <option key={day.iso} value={String(day.iso)}>
                {day.long.charAt(0).toUpperCase() + day.long.slice(1)}
              </option>
            ))}
          </select>
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

      <p className="admin__hint">
        {changed ? describeWeekSpan(dow) : describeWeekSpan(settings.week_start_dow)}. Cambia lo
        que significa «semana» en Reportes y en el resumen semanal de cada persona, desde la
        siguiente consulta. No mueve ningún dato: ninguna semana está guardada.
      </p>

      {dow !== settings.default_week_start_dow && (
        <p className="admin__hint">
          Sin esta configuración el sistema usaría {describeWeekSpan(settings.default_week_start_dow).toLowerCase()}.
        </p>
      )}

      {confirmed && (
        <p className="note" role="status">
          Guardado. Reportes ya usa la semana nueva.
        </p>
      )}

      {failure !== null && <p className="review__error">{failure}</p>}
    </div>
  );
}
