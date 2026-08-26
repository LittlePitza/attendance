import type { JSX } from 'react';

/**
 * The icons the employee-facing screens use, drawn rather than installed.
 *
 * An icon package is a dependency to keep current and audit for the sake of a
 * few hundred bytes of path data. These are stroked on a 24-unit grid at one
 * weight, so they read as one family, and every one is `aria-hidden` because it
 * sits beside its own label -- an icon repeating the text next to it only makes
 * a screen reader say everything twice.
 *
 * Deliberately a separate set from `features/hr/components/icons.tsx`, in the
 * same way the two stylesheets are separate. The board is a dense grid read on
 * a desk and this is a phone held for five seconds at the start of a shift;
 * they share `lib/` and nothing visual, and a shared icon file would be the
 * first thread pulling one look into the other.
 */
function Glyph({ children }: { readonly children: JSX.Element }): JSX.Element {
  return (
    <svg
      className="ico"
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

/**
 * The brand mark: a burst of rays around a clock face.
 *
 * The rays are generated rather than written out because twenty-four of them by
 * hand is twenty-four chances to mistype a number, and the loop says what the
 * shape *is* -- evenly spaced rays -- in a way a list of coordinates does not.
 */
const RAY_ANGLES = Array.from({ length: 24 }, (_, index) => index * 15);

export const IconMark = (): JSX.Element => (
  <svg
    className="ico"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeLinecap="round"
    aria-hidden="true"
    focusable="false"
  >
    <g strokeWidth="1.3">
      {RAY_ANGLES.map((angle) => (
        <line
          key={angle}
          x1="12"
          y1="1.6"
          x2="12"
          y2={
            // Alternating lengths, so the burst has the ragged edge the shape
            // is recognisable by instead of reading as a solid disc.
            angle % 30 === 0 ? '6.2' : '4.8'
          }
          transform={`rotate(${String(angle)} 12 12)`}
        />
      ))}
    </g>
    <circle cx="12" cy="12" r="4.4" strokeWidth="1.6" />
    <path d="M12 9.4V12l1.9 1.2" strokeWidth="1.6" strokeLinejoin="round" />
  </svg>
);

export const IconPlay = (): JSX.Element => (
  <Glyph>
    <g>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M10.2 9.1 15 12l-4.8 2.9Z" />
    </g>
  </Glyph>
);

export const IconPause = (): JSX.Element => (
  <Glyph>
    <g>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M10.2 9.3v5.4M13.8 9.3v5.4" />
    </g>
  </Glyph>
);

export const IconStop = (): JSX.Element => (
  <Glyph>
    <g>
      <circle cx="12" cy="12" r="8.6" />
      <rect x="9.4" y="9.4" width="5.2" height="5.2" rx="1.2" />
    </g>
  </Glyph>
);

export const IconClock = (): JSX.Element => (
  <Glyph>
    <g>
      <circle cx="12" cy="12" r="8.4" />
      <path d="M12 7.4V12l3.2 2" />
    </g>
  </Glyph>
);

export const IconCoffee = (): JSX.Element => (
  <Glyph>
    <g>
      <path d="M17 9h1.2a2.8 2.8 0 0 1 0 5.6H17" />
      <path d="M3.6 8.6h13.2v5.8a4.2 4.2 0 0 1-4.2 4.2H7.8a4.2 4.2 0 0 1-4.2-4.2Z" />
      <path d="M7.6 2.6v2.6M11.4 2.6v2.6" />
    </g>
  </Glyph>
);

export const IconTarget = (): JSX.Element => (
  <Glyph>
    <g>
      <circle cx="12" cy="12" r="8.4" />
      <circle cx="12" cy="12" r="4.4" />
      <circle cx="12" cy="12" r="0.9" />
    </g>
  </Glyph>
);

export const IconFlame = (): JSX.Element => (
  <Glyph>
    <g>
      <path d="M12 2.8c3.4 3 5.2 5.6 5.2 8.4a5.2 5.2 0 0 1-10.4 0c0-1.3.5-2.6 1.5-3.9.4 1.1 1 1.8 1.8 2.1.1-2.5.7-4.6 1.9-6.6Z" />
    </g>
  </Glyph>
);

export const IconChart = (): JSX.Element => (
  <Glyph>
    <g>
      <path d="M4 20h16" />
      <path d="M6.5 20v-6M11 20V7.5M15.5 20v-4M20 20V11" />
    </g>
  </Glyph>
);

export const IconDevice = (): JSX.Element => (
  <Glyph>
    <g>
      <rect x="2.8" y="4.4" width="18.4" height="12" rx="2.2" />
      <path d="M8.6 20h6.8M12 16.4V20" />
    </g>
  </Glyph>
);

export const IconPin = (): JSX.Element => (
  <Glyph>
    <g>
      <path d="M12 21s6.4-5.6 6.4-10.2a6.4 6.4 0 0 0-12.8 0C5.6 15.4 12 21 12 21Z" />
      <circle cx="12" cy="10.6" r="2.4" />
    </g>
  </Glyph>
);

export const IconOffline = (): JSX.Element => (
  <Glyph>
    <g>
      <path d="M3 3 21 21" />
      <path d="M8.5 16.4a5 5 0 0 1 7 0" />
      <path d="M5 13a10 10 0 0 1 3.3-2.2" />
      <path d="M19 13a10 10 0 0 0-7.6-2.9" />
      <path d="M12 20h.01" />
    </g>
  </Glyph>
);

export const IconCheck = (): JSX.Element => (
  <Glyph>
    <g>
      <circle cx="12" cy="12" r="8.6" />
      <path d="m8.4 12.4 2.6 2.6 4.6-5.2" />
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

export const IconExit = (): JSX.Element => (
  <Glyph>
    <g>
      <path d="M14.5 4.5h3.2A1.8 1.8 0 0 1 19.5 6.3v11.4a1.8 1.8 0 0 1-1.8 1.8h-3.2" />
      <path d="M10 8.2 6.2 12l3.8 3.8" />
      <path d="M6.6 12H15" />
    </g>
  </Glyph>
);

export const IconLock = (): JSX.Element => (
  <Glyph>
    <g>
      <rect x="4.6" y="10.4" width="14.8" height="9.4" rx="2.2" />
      <path d="M8.4 10.4V7.8a3.6 3.6 0 0 1 7.2 0v2.6" />
      <path d="M12 14.2v2" />
    </g>
  </Glyph>
);

export const IconMail = (): JSX.Element => (
  <Glyph>
    <g>
      <rect x="2.8" y="5.2" width="18.4" height="13.6" rx="2.4" />
      <path d="m3.6 7.4 7.3 5a2 2 0 0 0 2.2 0l7.3-5" />
    </g>
  </Glyph>
);

export const IconEye = ({ open }: { readonly open: boolean }): JSX.Element => (
  <Glyph>
    <g>
      <path d="M2.6 12S6 5.8 12 5.8 21.4 12 21.4 12 18 18.2 12 18.2 2.6 12 2.6 12Z" />
      <circle cx="12" cy="12" r="2.9" />
      {!open && <path d="M4 20 20 4" />}
    </g>
  </Glyph>
);
