import type { CSSProperties, JSX, ReactNode } from 'react';
import { useCountUp } from '../../../hooks/useCountUp';

export type StatTone = 'working' | 'break' | 'pending' | 'done' | 'alert';

interface StatCardProps {
  readonly tone: StatTone;
  readonly label: string;
  readonly value: number;
  readonly caption: string;
  readonly icon: ReactNode;
  readonly index: number;
  readonly selected?: boolean;
  readonly onSelect?: () => void;
}

/**
 * One figure, large enough to read from across a room.
 *
 * The whole card is the control when it filters the board, rather than a small
 * button inside it: the number and its label are what somebody is aiming at,
 * and a 44px target hidden in the corner of a large card is a target that gets
 * missed. When it does not filter anything it renders as plain markup and never
 * as a button that does nothing.
 *
 * `--index` feeds the entrance stagger in CSS, so the row assembles left to
 * right instead of appearing all at once.
 */
export function StatCard({
  tone,
  label,
  value,
  caption,
  icon,
  index,
  selected = false,
  onSelect,
}: StatCardProps): JSX.Element {
  const shown = useCountUp(value);

  const content = (
    <>
      <span className="stat__head">
        <span className="stat__label">{label}</span>
        <span className={`stat__icon stat__icon--${tone}`}>{icon}</span>
      </span>
      <span className="stat__value">{shown}</span>
      <span className="stat__caption">{caption}</span>
    </>
  );

  const className = `card stat stat--${tone}${selected ? ' stat--selected' : ''}`;

  if (onSelect === undefined) {
    return (
      <div className={className} style={{ '--index': index } as CSSProperties}>
        {content}
      </div>
    );
  }

  return (
    <button
      type="button"
      className={className}
      style={{ '--index': index } as CSSProperties}
      onClick={onSelect}
      aria-pressed={selected}
    >
      {content}
    </button>
  );
}
