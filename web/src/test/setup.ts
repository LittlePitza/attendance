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
