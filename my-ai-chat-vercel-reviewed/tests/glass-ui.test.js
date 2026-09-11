import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const cssUrl = new URL('../ui/styles.css', import.meta.url);

test('glass design tokens provide distinct dark and light wallpaper surfaces', async () => {
  const css = await readFile(cssUrl, 'utf8');
  for (const token of [
    '--glass-bg',
    '--glass-bg-strong',
    '--glass-border',
    '--glass-shadow',
    '--glass-blur',
    '--message-user-bg',
    '--message-assistant-bg',
  ]) {
    assert.match(css, new RegExp(`${token}:`));
  }
  assert.match(css, /html\[data-theme="light"\][^{]*\{[^}]*--message-user-bg:[^}]*--message-assistant-bg:/s);
  assert.match(css, /--wallpaper-tint:\s*rgba\(255, 255, 255, \.1\)/);
});

test('both message roles have readable surfaces without per-message backdrop blur', async () => {
  const css = await readFile(cssUrl, 'utf8');
  assert.match(css, /\.message-bubble\s*\{[^}]*background:\s*var\(--message-user-bg\)[^}]*box-shadow:\s*var\(--glass-shadow-soft\)/s);
  assert.match(css, /\.assistant-body\s*\{[^}]*background:\s*var\(--message-assistant-bg\)[^}]*box-shadow:\s*var\(--glass-shadow-soft\)/s);
  for (const selector of ['message-bubble', 'assistant-body']) {
    const block = css.match(new RegExp(`\\.${selector}\\s*\\{([^}]*)\\}`, 's'))?.[1] || '';
    assert.doesNotMatch(block, /backdrop-filter/);
  }
});

test('blur is reserved for major chrome and Settings keeps one scroll owner', async () => {
  const css = await readFile(cssUrl, 'utf8');
  for (const selector of ['sidebar', 'topbar', 'composer', 'model-menu', 'settings-dialog']) {
    assert.match(css, new RegExp(`\\.${selector}\\s*\\{[^}]*backdrop-filter:`, 's'));
  }
  const dialog = css.match(/\.settings-dialog\s*\{([^}]*)\}/s)?.[1] || '';
  const card = css.match(/\.settings-card\s*\{([^}]*)\}/s)?.[1] || '';
  assert.match(dialog, /overflow:\s*hidden/);
  assert.doesNotMatch(dialog, /overflow-y:\s*(?:auto|scroll)/);
  assert.match(card, /overflow-y:\s*auto/);
  assert.match(css, /padding-bottom:\s*max\(11px, env\(safe-area-inset-bottom\)\)/);
});
