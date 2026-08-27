import type { JSX } from 'react';

/**
 * The icons this board uses, drawn rather than installed.
 *
 * An icon package is a dependency to keep current and audit for the sake of a
 * few hundred bytes of path data. These are stroked on a 24-unit grid at one
 * weight, so they read as one family, and every one is `aria-hidden` because it
 * sits beside its own label -- an icon repeating the text next to it only makes
 * a screen reader say everything twice.
 */
function Glyph({ children }: { children: JSX.Element }): JSX.Element {
  return (
    <svg
      className="glyph"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/** The brand mark: a clock face, which is what the product is. */
export const IconMark = (): JSX.Element => (
  <Glyph>
    <g>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </g>
  </Glyph>
);

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

export const IconTeam = (): JSX.Element => (
  <Glyph>
    <g>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <path d="M16.5 5.3a3.2 3.2 0 0 1 0 5.4" />
      <path d="M18 14.4a6.5 6.5 0 0 1 3.5 5.6" />
    </g>
  </Glyph>
);

export const IconSelf = (): JSX.Element => (
  <Glyph>
    <g>
      <rect x="4" y="4" width="16" height="16" rx="3.5" />
      <path d="M9 12.5l2 2 4-4.5" />
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

export const IconMenu = (): JSX.Element => (
  <Glyph>
    <g>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="M9.5 4v16" />
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

export const IconReview = (): JSX.Element => (
  <Glyph>
    <g>
      <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H15l5 5v9.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5Z" />
      <path d="M14.5 4v5.5H20" />
      <path d="M8.5 14h7" />
    </g>
  </Glyph>
);

/** One person, singled out: the file rather than the roster. */
export const IconPerson = (): JSX.Element => (
  <Glyph>
    <g>
      <circle cx="12" cy="8.2" r="3.6" />
      <path d="M5.2 20c0-3.4 3-6 6.8-6s6.8 2.6 6.8 6" />
    </g>
  </Glyph>
);

/** Bars on a baseline: a period summed up rather than a day watched. */
export const IconReport = (): JSX.Element => (
  <Glyph>
    <g>
      <path d="M4 19.5h16" />
      <path d="M7 19.5v-6M12 19.5V8M17 19.5v-9" />
    </g>
  </Glyph>
);

export const IconSettings = (): JSX.Element => (
  <Glyph>
    <g>
      <circle cx="12" cy="12" r="2.8" />
      <path d="M12 3.5v2.2M12 18.3v2.2M4.9 4.9l1.6 1.6M17.5 17.5l1.6 1.6M3.5 12h2.2M18.3 12h2.2M4.9 19.1l1.6-1.6M17.5 6.5l1.6-1.6" />
    </g>
  </Glyph>
);

export const IconKey = (): JSX.Element => (
  <Glyph>
    <g>
      <circle cx="8" cy="16" r="3.2" />
      <path d="m10.3 13.7 7.2-7.2" />
      <path d="m15.4 8.6 2 2" />
      <path d="m18 6 2 2" />
    </g>
  </Glyph>
);

export const IconClock = (): JSX.Element => (
  <Glyph>
    <g>
      <circle cx="12" cy="12" r="8.2" />
      <path d="M12 7.6V12l3.1 1.9" />
    </g>
  </Glyph>
);

export const IconCopy = (): JSX.Element => (
  <Glyph>
    <g>
      <rect x="9" y="9" width="11" height="11" rx="1.8" />
      <path d="M15 6.5A1.5 1.5 0 0 0 13.5 5h-7A1.5 1.5 0 0 0 5 6.5v7A1.5 1.5 0 0 0 6.5 15" />
    </g>
  </Glyph>
);
