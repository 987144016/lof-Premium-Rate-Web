import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App';
import './styles.css';

const SCROLL_STORAGE_KEY = 'premium-estimator:scroll-position';

function setupScrollPersistence() {
  if (typeof window === 'undefined') {
    return;
  }

  const saveScroll = () => {
    try {
      window.sessionStorage.setItem(SCROLL_STORAGE_KEY, String(window.scrollY));
    } catch {
      // Ignore storage failures in restricted browser contexts.
    }
  };

  const restoreScroll = () => {
    let raw: string | null = null;

    try {
      raw = window.sessionStorage.getItem(SCROLL_STORAGE_KEY);
    } catch {
      return;
    }

    if (!raw) {
      return;
    }

    const y = Number(raw);
    if (!Number.isFinite(y)) {
      return;
    }

    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        window.scrollTo({ top: y, left: 0, behavior: 'auto' });
      });
    });
  };

  window.addEventListener('scroll', saveScroll, { passive: true });
  window.addEventListener('beforeunload', saveScroll);
  restoreScroll();
}

setupScrollPersistence();

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>,
);
