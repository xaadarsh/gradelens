export default defineBackground(() => {
  // browser.runtime.openOptionsPage() is not available from content-script
  // contexts (only privileged extension pages: background/popup/options),
  // so TrustPanel.tsx's footer Settings link — rendered by the content
  // script on the host page — relays through this listener instead.
  browser.runtime.onMessage.addListener((message) => {
    if (message?.type === 'gradelens:open-options') {
      browser.runtime.openOptionsPage().catch(() => undefined);
    }
  });

  // First-run onboarding only — never on an update (reason 'update') or a
  // browser/shared-profile reload (reason 'chrome_update'/'shared_module_update'),
  // or every extension update would re-open the welcome tab on every user.
  browser.runtime.onInstalled.addListener((details) => {
    if (details.reason !== 'install') return;
    browser.tabs.create({ url: browser.runtime.getURL('/welcome.html') }).catch(() => undefined);
  });
});
