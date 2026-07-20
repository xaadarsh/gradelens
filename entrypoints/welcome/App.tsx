// entrypoints/welcome/App.tsx
//
// First-run onboarding page (WXT unlisted HTML entrypoint, built to
// welcome.html). Opened once by entrypoints/background.ts on a fresh
// install — never on update, never re-shown after the user closes it. Same
// React setup, design tokens, and storage helpers as the options page; the
// AI setup block below is the exact same component Settings.tsx renders
// (components/AIProviderSetup.tsx), not a reimplementation.

import { useEffect, useState } from 'react';
import { AIProviderSetup } from '@/components/AIProviderSetup';
import { getSettings } from '@/lib/byo-key';
import { GUMROAD_CHECKOUT_URL } from '@/lib/license';
import type { StoredSettings } from '@/lib/types';

const PRIVACY_POLICY_URL = 'https://xaadarsh.github.io/gradelens-privacy/';
const SUPPORT_EMAIL = 'aadarshraj380@gmail.com';

function App() {
  const [settings, setSettings] = useState<StoredSettings>({ provider: 'gemini', enabled: true, theme: 'light' });

  // Same pattern as Settings.tsx: html/body sit outside .settings-shell in
  // the tree, so mirror the stored theme preference onto <html> too, or the
  // dark-mode page-canvas rule in Settings.css (shared via Welcome.css)
  // can't see it. Welcome only ever reads the theme the user already has
  // set (defaulting to light) — no toggle of its own, that's Settings' job.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', settings.theme);
  }, [settings.theme]);

  useEffect(() => {
    getSettings().then(setSettings).catch(() => undefined);
  }, []);

  function finishOnboarding() {
    window.close();
  }

  return (
    <main className="settings-shell welcome-shell" data-theme={settings.theme}>
      <header className="settings-header">
        <div className="settings-brand">
          <ShieldIcon className="settings-shield" />
          <p className="settings-wordmark">GradeLens</p>
        </div>
      </header>

      <div className="settings-inner welcome-inner">
        <section className="welcome-hero">
          <h1>Welcome to GradeLens</h1>
          <p className="welcome-tagline">Know if Amazon reviews can be trusted — before you buy.</p>
        </section>

        <div className="settings-section">
          <p className="section-label"><StepsIcon /> How it works</p>
          <div className="card">
            <div className="row welcome-step">
              <span className="welcome-step-num">1</span>
              <span className="row-label welcome-step-text">Open any Amazon product page — GradeLens grades the reviews automatically.</span>
            </div>
            <div className="divider" />
            <div className="row welcome-step">
              <span className="welcome-step-num">2</span>
              <span className="row-label welcome-step-text">Read the grade, confidence, and verdict line right on the page.</span>
            </div>
            <div className="divider" />
            <div className="row welcome-step">
              <span className="welcome-step-num">3</span>
              <span className="row-label welcome-step-text">Optional: run an AI deep dive for a written verdict (needs your own key).</span>
            </div>
          </div>
        </div>

        <div className="settings-section">
          <p className="section-label"><ProviderIcon /> AI Setup (optional)</p>
          <AIProviderSetup settings={settings} onSettingsChange={setSettings} />
          <p className="welcome-ai-note">
            Bring your own key — your data never touches our servers. Optional; the grade works without it.
          </p>
        </div>

        <div className="settings-section">
          <div className="card welcome-pro-card">
            <p className="welcome-pro-title">Unlock unlimited AI deep dives</p>
            <p className="welcome-pro-sub">GradeLens Pro — $9 lifetime</p>
            <a className="pill pill-gold welcome-pro-link" href={GUMROAD_CHECKOUT_URL} target="_blank" rel="noopener noreferrer">
              Get Pro →
            </a>
          </div>
        </div>

        <button className="welcome-cta" onClick={finishOnboarding}>You're all set →</button>

        <footer className="welcome-footer">
          <a href={PRIVACY_POLICY_URL} target="_blank" rel="noreferrer">Privacy Policy</a>
          <span className="welcome-footer-dot">·</span>
          <a href={`mailto:${SUPPORT_EMAIL}`}>Support</a>
        </footer>
      </div>
    </main>
  );
}

function ShieldIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M12 2.5L4.5 5.4v5.7c0 5.2 3.3 9.6 7.5 11 4.2-1.4 7.5-5.8 7.5-11V5.4L12 2.5z" fill="currentColor" />
    </svg>
  );
}

function StepsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" />
      <path d="M8 12.3l2.6 2.6 5.4-5.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ProviderIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect x="7" y="7" width="10" height="10" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export default App;
