// Applies the saved theme before React mounts so there is no flash. Only the two known theme names
// are accepted; anything else falls back to the OS preference, so a stale value can never desync
// the toggle (ThemeToggle.tsx normalises the same way). A file rather than an inline script because
// the server's CSP (`script-src 'self'`) refuses inline script on the shell it serves.
// Set here because a classic script runs before any module: zod otherwise probes `new Function` to
// choose a faster parser, which a strict CSP reports as a violation.
globalThis.__zod_globalConfig = { jitless: true }

;(() => {
  var saved = localStorage.getItem('theme')
  if (saved !== 'rocketpod-light' && saved !== 'rocketpod-dark') {
    saved = window.matchMedia?.('(prefers-color-scheme: dark)').matches
      ? 'rocketpod-dark'
      : 'rocketpod-light'
  }
  document.documentElement.setAttribute('data-theme', saved)
})()
