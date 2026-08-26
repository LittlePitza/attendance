import type { CSSProperties, JSX } from 'react';

/**
 * The one decorative thing in the application, and the reason it earns its
 * place: it is the only surface that tells somebody at a glance which screen
 * they are on before they have read a word of it.
 *
 * Five blurred shapes drifting behind the content. Not an image and not a
 * dependency -- five divs and a blur, which is a few hundred bytes and renders
 * on the compositor, so it costs a phone nothing while it sits there. A JPEG of
 * the same thing would be a hundred times the size, would not adapt to the
 * shape of the panel it fills, and would have to be cached by the service
 * worker to survive going offline.
 *
 * Two intensities, because the same wash cannot do both jobs:
 *
 *   `panel`  the sign-in page's right-hand side, where it is the whole point
 *            of the surface and can be as saturated as it likes.
 *   `wash`   behind the greeting on the punch screen, where text sits on top
 *            of it and legibility outranks the effect.
 *
 * The drift stops entirely under `prefers-reduced-motion`, in CSS, and what is
 * left is a still gradient rather than a blank panel: the setting asks for less
 * movement, not for less design.
 */
export function Mesh({ variant }: { readonly variant: 'panel' | 'wash' }): JSX.Element {
  return (
    <div className={`mesh mesh--${variant}`} aria-hidden="true">
      {BLOBS.map((blob, index) => (
        <span
          key={blob.tone}
          className={`mesh__blob mesh__blob--${blob.tone}`}
          style={
            {
              '--x': blob.x,
              '--y': blob.y,
              '--size': blob.size,
              // Each shape drifts on its own clock. Shared timings would make
              // the five move as one shape, which reads as a sliding image
              // rather than as something alive.
              '--duration': `${String(blob.duration)}s`,
              '--delay': `${String(index * -3.5)}s`,
            } as CSSProperties
          }
        />
      ))}
    </div>
  );
}

/**
 * Placed by hand rather than at random. A random arrangement re-rolls on every
 * render and is a different picture each time somebody opens the application;
 * these five sit where they sit, so the page has a face.
 */
const BLOBS = [
  { tone: 'violet', x: '18%', y: '22%', size: '58%', duration: 26 },
  { tone: 'pink', x: '74%', y: '18%', size: '52%', duration: 31 },
  { tone: 'sky', x: '62%', y: '68%', size: '64%', duration: 24 },
  { tone: 'peach', x: '22%', y: '78%', size: '46%', duration: 34 },
  { tone: 'aqua', x: '46%', y: '46%', size: '40%', duration: 29 },
] as const;
