import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
// The offline queue is IndexedDB, which jsdom does not provide.
import 'fake-indexeddb/auto';
import { afterEach } from 'vitest';

// Testing Library only registers its own cleanup when Vitest globals are on.
// They are not, deliberately -- imports should be visible in each file -- so
// the unmount is registered here once, for every suite. Without it a component
// from an earlier test is still in the document and assertions about what is
// *absent* quietly pass against the wrong DOM.
afterEach(cleanup);

/**
 * jsdom does not implement `matchMedia`, and every browser has since IE10. The
 * gap is in the test environment rather than in the code, so it is filled here
 * instead of guarded for at every call site.
 *
 * It reports "no preference", which is the default a browser reports too. A
 * test that cares about reduced motion overrides it for itself.
 */
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList,
});
