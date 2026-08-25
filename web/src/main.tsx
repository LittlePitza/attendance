import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import { App } from './App';
import './app.css';

// The shell updates itself in the background. Nobody mid-shift should be asked
// to reload before they can clock out.
registerSW({ immediate: true });

const container = document.getElementById('root');
if (container === null) {
  throw new Error('Missing #root element in index.html');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
