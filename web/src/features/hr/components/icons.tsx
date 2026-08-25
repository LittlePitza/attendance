import type { JSX } from 'react';

/**
 * The eight icons this board uses, drawn rather than installed.
 *
 * An icon set is a dependency to keep current and audit for the sake of a few
 * hundred bytes of path data. These are stroked on a 24-unit grid in the same
 * style throughout, so they read as one family, and `aria-hidden` because every
 * one of them sits beside its own label -- an icon that repeats the text next
 * to it only makes a screen reader say everything twice.
 */
function Glyph({ children }: { children: JSX.Element }): JSX.Element {
  return (
    <svg
      className="glyph"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const IconWorking = (): JSX.Element => (
  <Glyph>
    <g>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </g>
  </Glyph>
);

export const IconBreak = (): JSX.Element => (
  <Glyph>
    <g>
      <path d="M17 8h1a3 3 0 0 1 0 6h-1" />
      <path d="M3 8h14v6a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Z" />
      <path d="M7 2v3M11 2v3" />
    </g>
  </Glyph>
);

export const IconPending = (): JSX.Element => (
  <Glyph>
    <g>
      <circle cx="12" cy="12" r="9" strokeDasharray="3 3" />
      <path d="M12 8v4" />
      <path d="M12 16h.01" />
    </g>
  </Glyph>
);

export const IconDone = (): JSX.Element => (
  <Glyph>
    <g>
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12.5 2.5 2.5 4.5-5" />
    </g>
  </Glyph>
);

export const IconAlert = (): JSX.Element => (
  <Glyph>
    <g>
      <path d="M10.3 3.9 2.6 17a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </g>
  </Glyph>
);

export const IconSearch = (): JSX.Element => (
  <Glyph>
    <g>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.6-3.6" />
    </g>
  </Glyph>
);

export const IconRefresh = (): JSX.Element => (
  <Glyph>
    <g>
      <path d="M20 12a8 8 0 1 1-2.3-5.7" />
      <path d="M20 4v4h-4" />
    </g>
  </Glyph>
);

export const IconChevron = ({ direction }: { direction: 'left' | 'right' }): JSX.Element => (
  <Glyph>
    <path d={direction === 'left' ? 'm14.5 5-7 7 7 7' : 'm9.5 5 7 7-7 7'} />
  </Glyph>
);

export const IconOffline = (): JSX.Element => (
  <Glyph>
    <g>
      <path d="M3 3l18 18" />
      <path d="M8.5 16.4a5 5 0 0 1 7 0" />
      <path d="M5 13a10 10 0 0 1 3.3-2.2" />
      <path d="M19 13a10 10 0 0 0-7.6-2.9" />
      <path d="M12 20h.01" />
    </g>
  </Glyph>
);
