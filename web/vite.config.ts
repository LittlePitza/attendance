import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The repository keeps one `.env`, at its root, described by the `.env.example`
  // beside it. Without this, Vite looks for a second one inside `web/`, finds
  // nothing, and produces a bundle that builds cleanly and then refuses to
  // start because the Supabase URL it was given is `undefined`.
  envDir: '..',

  plugins: [
    react(),
    VitePWA({
      // The shell updates itself. An employee who is mid-shift should never be
      // asked to reload before they can clock out.
      registerType: 'autoUpdate',
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,woff2}'],
        // Never serve a cached API response: the state of a workday is exactly
        // the thing that must not come from yesterday. Offline punching is
        // handled by the queue, not by pretending a request succeeded.
        navigateFallbackDenylist: [/^\/rest\//, /^\/auth\//],
        // The one exception to "nothing external is cached": the font files.
        // They never change behind their hashed URLs, and without this the
        // board falls back to the system stack the moment it is offline.
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\//,
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'google-fonts-stylesheets' },
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\//,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-files',
              expiration: { maxEntries: 12, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      manifest: {
        name: 'Checador',
        short_name: 'Checador',
        description: 'Registro de entradas, pausas y salidas para trabajo en casa.',
        lang: 'es-MX',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#0f172a',
        theme_color: '#0f172a',
        icons: [
          {
            src: '/icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any',
          },
          {
            src: '/icon-maskable.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'maskable',
          },
        ],
      },
    }),
  ],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    restoreMocks: true,
    clearMocks: true,
    // The Supabase client is built at import time, so these have to exist
    // before any module under test loads. They point nowhere on purpose:
    // every test that would touch the network mocks it.
    env: {
      VITE_SUPABASE_URL: 'http://127.0.0.1:54321',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'test-publishable-key',
    },
  },
});
