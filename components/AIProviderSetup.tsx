// components/AIProviderSetup.tsx
//
// The "pick a provider, paste a key, Save/Test" block — shared verbatim
// between entrypoints/options/Settings.tsx and entrypoints/welcome/App.tsx
// so the two surfaces can never drift: same storage helpers
// (getSettings/saveSettings from lib/byo-key.ts), same key-test function
// (testApiKey), same masking, same busy-guard behavior. Neither page owns
// its own copy of this logic — they both render this component and pass
// down the settings they already loaded.

import { useEffect, useRef, useState } from 'react';
import { maskApiKey, saveSettings, testApiKey } from '@/lib/byo-key';
import type { DeepAnalysisProvider, KeyTestResult, StoredSettings } from '@/lib/types';

interface AIProviderSetupProps {
  settings: StoredSettings;
  onSettingsChange: (next: StoredSettings) => void;
}

export function AIProviderSetup({ settings, onSettingsChange }: AIProviderSetupProps) {
  const [draftGeminiKey, setDraftGeminiKey] = useState(() => maskApiKey(settings.geminiKey));
  const [draftOpenAIKey, setDraftOpenAIKey] = useState(() => maskApiKey(settings.openaiKey));

  // Re-sync the masked draft whenever the underlying stored key changes from
  // outside this component (e.g. the parent's initial async load resolving
  // after this component has already mounted with the pre-load defaults).
  useEffect(() => {
    setDraftGeminiKey(maskApiKey(settings.geminiKey));
  }, [settings.geminiKey]);
  useEffect(() => {
    setDraftOpenAIKey(maskApiKey(settings.openaiKey));
  }, [settings.openaiKey]);

  async function updateProvider(provider: DeepAnalysisProvider) {
    try {
      onSettingsChange(await saveSettings({ provider }));
    } catch {
      // Storage write failed — leave the previous selection in place rather
      // than throw an unhandled rejection out of a click handler.
    }
  }

  // Return the outcome instead of pushing it into a page-bottom status
  // string — KeyRow shows it inline next to the button that triggered it.
  async function saveKey(provider: DeepAnalysisProvider): Promise<KeyTestResult> {
    const draft = (provider === 'gemini' ? draftGeminiKey : draftOpenAIKey).trim();
    if (draft.includes('*')) {
      return { ok: true, message: 'Key is already saved.' };
    }
    // Guards against wiping an already-saved key: an empty draft here used
    // to come from the field's own onFocus handler clearing the masked
    // display the instant it was clicked (fixed in KeyRow below), and
    // clicking Save right after would have persisted that empty string
    // over the real stored key. Keeping this check even with that fixed —
    // a stray empty Save should never be able to erase a saved key.
    if (!draft) {
      return { ok: false, message: 'Enter an API key first.' };
    }

    const next = provider === 'gemini'
      ? await saveSettings({ geminiKey: draft })
      : await saveSettings({ openaiKey: draft });
    onSettingsChange(next);
    setDraftGeminiKey(maskApiKey(next.geminiKey));
    setDraftOpenAIKey(maskApiKey(next.openaiKey));
    return { ok: true, message: `${provider === 'gemini' ? 'Gemini' : 'OpenAI'} key saved.` };
  }

  async function testKey(provider: DeepAnalysisProvider): Promise<KeyTestResult> {
    const key = provider === 'gemini'
      ? (draftGeminiKey.includes('*') ? settings.geminiKey : draftGeminiKey)
      : (draftOpenAIKey.includes('*') ? settings.openaiKey : draftOpenAIKey);
    return testApiKey(provider, key ?? '');
  }

  return (
    <div className="card">
      <div className="row">
        <span className="row-label">Deep-dive provider</span>
        <div className="segmented" data-active={settings.provider === 'gemini' ? 0 : 1}>
          <button className={settings.provider === 'gemini' ? 'active' : ''} onClick={() => updateProvider('gemini')}>
            Gemini
          </button>
          <button className={settings.provider === 'openai' ? 'active' : ''} onClick={() => updateProvider('openai')}>
            OpenAI
          </button>
        </div>
      </div>
      <div className="divider" />
      {/* Bug fix: only the active provider's key field renders — previously
          both Gemini and OpenAI inputs rendered unconditionally regardless
          of the selected tab, so a user could fill in the wrong key. Keying
          on settings.provider also re-triggers the crossfade animation. */}
      <div className="key-field-wrap" key={settings.provider}>
        {settings.provider === 'gemini' ? (
          <KeyRow
            label="Gemini API key"
            value={draftGeminiKey}
            onChange={setDraftGeminiKey}
            onSave={() => saveKey('gemini')}
            onTest={() => testKey('gemini')}
          />
        ) : (
          <KeyRow
            label="OpenAI API key"
            value={draftOpenAIKey}
            onChange={setDraftOpenAIKey}
            onSave={() => saveKey('openai')}
            onTest={() => testKey('openai')}
          />
        )}
      </div>
    </div>
  );
}

function KeyRow(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onSave: () => Promise<KeyTestResult>;
  onTest: () => Promise<KeyTestResult>;
}) {
  // busyRef is the actual guard: a ref mutates synchronously and is shared
  // across handler invocations regardless of React's render/batching
  // timing, unlike a useState value, which is only updated after a
  // re-render — two click() calls fired back-to-back in the same tick both
  // still read the OLD state value if the guard were state-based, so both
  // would slip past an `if (busy !== 'idle') return` check and fire two
  // concurrent requests with the same key. That's exactly what was tripping
  // Gemini's rate limit and producing inconsistent pass/fail results.
  // `busy` state stays alongside it purely to drive the visible
  // "Saving…"/"Testing…" label and disabled styling.
  const busyRef = useRef(false);
  const [busy, setBusy] = useState<'idle' | 'saving' | 'testing'>('idle');
  const [feedback, setFeedback] = useState<KeyTestResult | null>(null);

  async function run(phase: 'saving' | 'testing', action: () => Promise<KeyTestResult>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(phase);
    setFeedback(null);
    try {
      setFeedback(await action());
    } catch (error) {
      // Without this catch, a throw from action() (e.g. storage.local.set
      // failing) would leave busyRef stuck true forever — Save/Test would
      // be permanently disabled for the rest of the session.
      setFeedback({ ok: false, message: error instanceof Error ? error.message : 'Something went wrong.' });
    } finally {
      busyRef.current = false;
      setBusy('idle');
    }
  }

  return (
    <div className="key-field-block">
      <div className="row key-row">
        <label className="key-row-label">
          {props.label}
          <input
            autoComplete="off"
            onFocus={(event) => {
              // Select-all, don't clear: a plain click/tab into the field
              // was wiping the masked value on focus alone, before any
              // typing — the field looked like the saved key had vanished.
              // Selecting it instead means clicking-away leaves it
              // untouched, while typing still naturally replaces the
              // selected mask with the new key (standard input behavior).
              if (props.value.includes('*')) event.target.select();
            }}
            onChange={(event) => props.onChange(event.target.value)}
            placeholder="Paste API key"
            type={props.value.includes('*') ? 'text' : 'password'}
            value={props.value}
          />
        </label>
        <button
          className="btn-sm btn-primary-sm"
          disabled={busy !== 'idle'}
          onClick={() => run('saving', props.onSave)}
          title="Save key"
        >
          {busy === 'saving' ? 'Saving…' : 'Save'}
        </button>
        <button
          className="btn-sm btn-outline-sm"
          disabled={busy !== 'idle'}
          onClick={() => run('testing', props.onTest)}
          title="Test connection"
        >
          {busy === 'testing' ? 'Testing…' : 'Test'}
        </button>
      </div>
      {feedback ? (
        <p className={`key-row-feedback ${feedback.ok ? 'key-row-feedback--ok' : 'key-row-feedback--error'}`}>
          {feedback.message}
        </p>
      ) : null}
    </div>
  );
}
