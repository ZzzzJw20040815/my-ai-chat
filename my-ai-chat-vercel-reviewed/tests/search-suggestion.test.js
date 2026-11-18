import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { SEARCH_SUGGESTION_ATTACK, SEARCH_SUGGESTION_SAMPLE } from './search-suggestion-sample.js';
import { mountSearchSuggestion, sanitizeSearchSuggestionHtml, webSearchMarkup } from '../shared/web-search.js';

const escapeHtml = value => String(value).replace(/[&<>'"]/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
}[character]));

function windowForTest() {
  return new JSDOM('<!doctype html><html><body><p id="outside" class="outside-only">outside</p><div id="host"></div></body></html>').window;
}

test('search suggestion sample keeps visible content and drops active markup', () => {
  const win = windowForTest();
  const clean = sanitizeSearchSuggestionHtml(SEARCH_SUGGESTION_ATTACK, win);
  assert.match(clean, /local qa/);
  assert.match(clean, /https:\/\/www\.google\.com\/search\?q=local\+qa/);
  assert.match(clean, /#1a0dab/);
  assert.match(clean, /<svg/);
  assert.match(clean, /target="_blank"/);
  assert.match(clean, /rel="noopener noreferrer"/);
  assert.equal(/<script/i.test(clean), false);
  assert.equal(/\son[a-z]+=/i.test(clean), false);
  assert.equal(/javascript:/i.test(clean), false);
  assert.equal(/<(?:form|input|iframe)\b/i.test(clean), false);
});

test('search suggestion styles drop imports and non-https urls without changing the sample', () => {
  const win = windowForTest();
  const styled = `<style>
@import "http://evil.example/a.css";
@import url("https://cdn.example/imported.css");
.chip a { color: #1a0dab; background-image: url("http://evil.example/x.png"); }
.ok { background-image: url("https://cdn.example/y.png"); }
</style>
<div style="color: #1a0dab; background: url(http://evil.example/z.png) url('https://cdn.example/w.png')">local qa</div>`;
  const clean = sanitizeSearchSuggestionHtml(styled, win);
  assert.equal(/@import/i.test(clean), false);
  assert.equal(/http:\/\//i.test(clean), false);
  assert.equal(/imported\.css/.test(clean), false);
  assert.match(clean, /https:\/\/cdn\.example\/y\.png/);
  assert.match(clean, /https:\/\/cdn\.example\/w\.png/);
  assert.match(clean, /#1a0dab/);
  assert.match(clean, /local qa/);

  const sample = sanitizeSearchSuggestionHtml(SEARCH_SUGGESTION_SAMPLE, win);
  assert.match(sample, /local qa/);
  assert.match(sample, /https:\/\/www\.google\.com\/search\?q=local\+qa/);
  assert.match(sample, /#1a0dab/);
  assert.match(sample, /<svg/);
  assert.equal(/url\(/i.test(sample), false);
});

test('a fixed search suggestion stays contained by the shadow host', () => {
  const win = windowForTest();
  const fixed = `${SEARCH_SUGGESTION_SAMPLE}<div class="fixed-probe" style="position: fixed; top: 0; left: 0">fixed chip</div>`;
  const host = win.document.getElementById('host');
  host.innerHTML = webSearchMarkup({ searchSuggestionHtml: fixed }, escapeHtml, win);
  const suggestionHost = host.querySelector('.search-suggestion-host');
  const shadow = mountSearchSuggestion(suggestionHost, win);
  const probe = shadow.querySelector('.fixed-probe');
  assert.equal(suggestionHost.style.getPropertyValue('contain'), 'paint');
  assert.equal(suggestionHost.style.getPropertyValue('overflow'), 'hidden');
  assert.equal(win.getComputedStyle(suggestionHost).overflow, 'hidden');
  assert.ok(probe);
  assert.equal(win.getComputedStyle(probe).position, 'fixed');
  assert.equal(suggestionHost.contains(probe), false);
  assert.equal(shadow.contains(probe), true);
});

test('search suggestion styles stay inside the shadow root', () => {
  const win = windowForTest();
  const host = win.document.getElementById('host');
  host.innerHTML = webSearchMarkup({ searchSuggestionHtml: SEARCH_SUGGESTION_SAMPLE }, escapeHtml, win);
  const suggestionHost = host.querySelector('.search-suggestion-host');
  const shadow = mountSearchSuggestion(suggestionHost, win);
  assert.match(shadow.innerHTML, /local qa/);
  assert.match(shadow.innerHTML, /\.outside-only/);
  assert.equal(win.document.querySelector('style'), null);
  assert.equal(win.document.body.innerHTML.includes('.outside-only'), false);
  assert.equal(suggestionHost.querySelector('template'), null);
});
