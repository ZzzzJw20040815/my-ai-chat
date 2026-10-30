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
