import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  SCROLL_TO_BOTTOM_HIDE_DISTANCE,
  SCROLL_TO_BOTTOM_SHOW_DISTANCE,
  scrollConversationToBottom,
  scrollToBottomVisible,
  shouldFollowStreaming,
} from '../ui/scroll-position.js';

const scroller = distance => ({ scrollHeight: 2000, clientHeight: 600, scrollTop: 1400 - distance });

test('scroll-to-bottom visibility uses stable show/hide hysteresis', () => {
  assert.equal(scrollToBottomVisible(scroller(SCROLL_TO_BOTTOM_SHOW_DISTANCE + 1), false), true);
  assert.equal(scrollToBottomVisible(scroller(200), false), false);
  assert.equal(scrollToBottomVisible(scroller(200), true), true);
  assert.equal(scrollToBottomVisible(scroller(SCROLL_TO_BOTTOM_HIDE_DISTANCE), true), false);
});

test('streaming follows near bottom but preserves intentional history browsing', () => {
  assert.equal(shouldFollowStreaming(scroller(80)), true);
  assert.equal(shouldFollowStreaming(scroller(500)), false);
});

test('scroll action targets the real bottom and honors reduced motion', () => {
  const calls = [], target = { scrollHeight: 2400, scrollTo: options => calls.push(options) };
  scrollConversationToBottom(target, false);
  scrollConversationToBottom(target, true);
  assert.deepEqual(calls, [
    { top: 2400, behavior: 'smooth' },
    { top: 2400, behavior: 'auto' },
  ]);
});

test('floating control is touch-safe, safe-area aware and both runtime surfaces share the same decision helper', async () => {
  const [html, css, app] = await Promise.all([
    readFile(new URL('../ui/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../ui/styles.css', import.meta.url), 'utf8'),
    readFile(new URL('../ui/app.js', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /id="scrollToBottom"[^>]*aria-label="滚动到最新消息"/);
  assert.match(css, /\.scroll-to-bottom\s*\{[^}]*width:\s*46px;[^}]*height:\s*46px/s);
  assert.match(app, /env\(safe-area-inset-bottom/);
  assert.ok((app.match(/continuationAvailability\(/g) || []).length >= 4);
  assert.doesNotMatch(css, /\.scroll-to-bottom[^}]*transform:\s*scale/s);
});
