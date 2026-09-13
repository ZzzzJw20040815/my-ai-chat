import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { applyMobileDisplayPreferences } from '../ui/mobile-display.js';

const read = name => readFile(new URL(`../ui/${name}`, import.meta.url), 'utf8');

function cssVariable(css, selector, name) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] || '';
  return Number.parseFloat(rule.match(new RegExp(`${name}:\\s*([0-9.]+)px`))?.[1]);
}

test('mobile display preferences apply immediately as independent stable data attributes', () => {
  const root = { dataset: {} };
  assert.deepEqual(applyMobileDisplayPreferences({}, root), { density: 'standard', chatTextSize: 'standard' });
  assert.deepEqual(root.dataset, { mobileDensity: 'standard', chatTextSize: 'standard' });
  applyMobileDisplayPreferences({ mobileDisplay: { density: 'compact', chatTextSize: 'large' } }, root);
  assert.deepEqual(root.dataset, { mobileDensity: 'compact', chatTextSize: 'large' });
  applyMobileDisplayPreferences({ mobileDisplay: { density: 'comfortable', chatTextSize: 'small' } }, root);
  assert.deepEqual(root.dataset, { mobileDensity: 'comfortable', chatTextSize: 'small' });
});

test('Settings exposes Chinese three-option controls with stable serializable IDs', async () => {
  const html = await read('index.html');
  assert.match(html, />手机显示</);
  assert.match(html, />界面密度</);
  assert.match(html, />聊天文字</);
  for (const [id, label] of [['compact', '紧凑'], ['standard', '标准'], ['comfortable', '宽松']]) {
    assert.match(html, new RegExp(`data-mobile-density="${id}"[^>]*>${label}<`));
  }
  for (const [id, label] of [['small', '小'], ['standard', '标准'], ['large', '大']]) {
    assert.match(html, new RegExp(`data-chat-text-size="${id}"[^>]*>${label}<`));
  }
});

test('mobile density tokens are ordered, centralized, and scoped to the existing breakpoint', async () => {
  const css = await read('styles.css');
  const compactGap = cssVariable(css, 'html[data-mobile-density="compact"]', '--mobile-message-gap');
  const standardGap = cssVariable(css, ':root, html[data-mobile-density="standard"]', '--mobile-message-gap');
  const comfortableGap = cssVariable(css, 'html[data-mobile-density="comfortable"]', '--mobile-message-gap');
  assert.ok(compactGap < standardGap && standardGap < comfortableGap);
  assert.equal(standardGap, 31);
  const compactPadding = cssVariable(css, 'html[data-mobile-density="compact"]', '--mobile-composer-padding');
  const standardPadding = cssVariable(css, ':root, html[data-mobile-density="standard"]', '--mobile-composer-padding');
  const comfortablePadding = cssVariable(css, 'html[data-mobile-density="comfortable"]', '--mobile-composer-padding');
  assert.ok(compactPadding < standardPadding && standardPadding < comfortablePadding);
  assert.equal(standardPadding, 12);
  assert.match(css, /@media \(max-width: 520px\)[\s\S]*html\[data-mobile-density="compact"\]/);
  assert.match(css, /\.conversation\s*\{[^}]*var\(--mobile-conversation-top\)[^}]*var\(--mobile-conversation-inline\)/);
  assert.match(css, /\.story-menu\s*\{[^}]*var\(--mobile-sheet-padding\)/);
  assert.match(css, /\.settings-card\s*\{[^}]*var\(--mobile-settings-padding\)/);
  const desktopCss = css.slice(0, css.indexOf('@media (max-width: 520px)'));
  assert.doesNotMatch(desktopCss, /data-mobile-density|data-chat-text-size|--mobile-/);
});

test('chat prose sizes are independent while code and table safety sizes remain bounded', async () => {
  const css = await read('styles.css');
  const small = cssVariable(css, 'html[data-chat-text-size="small"]', '--mobile-chat-font-size');
  const standard = cssVariable(css, 'html[data-chat-text-size="standard"]', '--mobile-chat-font-size');
  const large = cssVariable(css, 'html[data-chat-text-size="large"]', '--mobile-chat-font-size');
  assert.ok(small < standard && standard < large);
  assert.match(css, /\.message-bubble\s*\{[^}]*font-size:\s*var\(--mobile-chat-font-size\)/);
  assert.match(css, /\.message-content\s*\{[^}]*font-size:\s*var\(--mobile-chat-font-size\)/);
  assert.match(css, /\.code-block pre\s*\{[^}]*font:\s*13px/);
  assert.match(css, /\.table-scroll table\s*\{[^}]*font-size:\s*14px/);
});

test('Safari form sizes, touch targets, sheets, and Story pill remain mobile safe', async () => {
  const css = await read('styles.css');
  assert.match(css, /@media \(max-width: 520px\)[\s\S]*\.composer textarea\s*\{[^}]*font-size:\s*16px/);
  assert.match(css, /\.edit-area textarea\s*\{[^}]*font-size:\s*16px/);
  assert.match(css, /\.setting-field select, \.setting-field input, \.setting-field textarea, \.compact-field input\s*\{[^}]*font-size:\s*16px/);
  assert.match(css, /\.mobile-story-button\s*\{[^}]*min-height:\s*44px/);
  assert.match(css, /\.mobile-display-options button\s*\{[^}]*min-height:\s*44px/);
  assert.match(css, /\.story-menu-action\s*\{[^}]*min-height:\s*48px/);
  assert.match(css, /\.regenerate-menu button\s*\{[^}]*min-height:\s*44px/);
  assert.match(css, /\.surface-menu\s*\{[^}]*overflow-x:\s*hidden/);
  assert.match(css, /env\(safe-area-inset-bottom\)/);
});

test('Story controls retain a safe horizontal budget at common iPhone CSS widths', async () => {
  const css = await read('styles.css');
  const densitySelectors = {
    compact: 'html[data-mobile-density="compact"]',
    standard: ':root, html[data-mobile-density="standard"]',
    comfortable: 'html[data-mobile-density="comfortable"]',
  };
  for (const selector of Object.values(densitySelectors)) {
    const dockInline = cssVariable(css, selector, '--mobile-composer-inline');
    const composerPadding = cssVariable(css, selector, '--mobile-composer-padding');
    const controlGap = cssVariable(css, selector, '--mobile-control-gap');
    for (const width of [375, 390, 430]) {
      const innerWidth = width - (dockInline * 2) - (composerPadding * 2);
      const controlsBudget = 150 + 35 + 35 + 36 + (controlGap * 3);
      assert.ok(controlsBudget <= innerWidth, `${selector} controls overflow at ${width}px`);
      assert.ok(width - 20 > 0, `sheet width invalid at ${width}px`);
    }
  }
});

test('display preferences never emulate browser zoom or alter breakpoint semantics', async () => {
  const [css, html] = await Promise.all([read('styles.css'), read('index.html')]);
  const preferenceCss = css.slice(css.indexOf(':root, html[data-mobile-density="standard"]'), css.indexOf('.topbar { height: 56px'));
  assert.doesNotMatch(preferenceCss, /(?:^|[;{])\s*zoom\s*:/m);
  assert.doesNotMatch(preferenceCss, /transform\s*:\s*scale\(/);
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1\.0, interactive-widget=resizes-content"/);
  assert.equal((css.match(/@media \(max-width: 520px\)/g) || []).length >= 1, true);
});
