import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { AuthProvider } from './contexts/AuthContext';
import './App.css';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Root element not found');

createRoot(rootElement).render(
  <StrictMode>
    <AuthProvider>
      <App />
    </AuthProvider>
  </StrictMode>
);

// Register the service worker for offline/PWA support (production only). Existing
// controlled tabs reload once when an updated worker claims them, so deployments cannot
// leave an installed PWA running an obsolete navigation shell indefinitely.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  const reloadOnControllerChange = Boolean(navigator.serviceWorker.controller);
  let reloading = false;
  if (reloadOnControllerChange) {
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) return;
      reloading = true;
      window.location.reload();
    });
  }
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      .then((registration) => registration.update())
      .catch(() => {
        // Non-fatal: app works without the service worker.
      });
  });
}
