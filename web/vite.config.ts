import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig } from 'vitest/config';
import { version } from './package.json' with { type: 'json' };

export default defineConfig({
  // Stamped into the bundle so a session row can say which build opened it.
  // Read from `package.json` rather than written twice: a version that has to
  // be kept in step by hand is a version that is wrong.
  define: { __APP_VERSION__: JSON.stringify(version) },

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
        // The identity the operating system files this application under.
        // Without it the browser derives one from `start_url`, which means the
        // identity is a side effect of a field that may reasonably change --
        // and the Windows policy that makes the app start at sign-in is keyed
        // by exactly this value. `'/'` resolves to what the derived id already
        // is, so declaring it now costs nothing and pins it before any machine
        // has installed the app. Changing it afterwards is a different
        // application to Windows, not an update to this one.
        id: '/',
        name: 'Checador',
        short_name: 'Checador',
        description: 'Registro de entradas, pausas y salidas para trabajo en casa.',
        lang: 'es-MX',
        start_url: '/',
        scope: '/',
        // Launched at sign-in and then launched again from the desktop icon,
        // the employee should arrive at the window that is already open --
        // with whatever is sitting in the offline queue -- rather than at a
        // second copy of it.
        launch_handler: { client_mode: 'focus-existing' },
        display: 'standalone',
        // Not `portrait` any more: this is installed on desktops as well as
        // phones, and locking a laptop window to portrait is a rule invented
        // for a device that is not the one most of these machines are.
        orientation: 'any',
        // The ground the application actually paints, so the splash screen and
        // the window chrome do not flash a colour the app never uses. Changing
        // these is safe in a way changing `id` is not: the operating system
        // files the installation under `id`, and only under `id`.
        background_color: '#fbfaf9',
        theme_color: '#fbfaf9',
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
