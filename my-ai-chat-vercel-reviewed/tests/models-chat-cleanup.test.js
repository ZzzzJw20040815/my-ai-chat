import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { handleChat, validateGenerationSettings } from '../server/chat.js';
import { isAllowedModel, MODELS, modelMetadata } from '../shared/models.js';
import { DEFAULT_GLOBAL_SETTINGS } from '../shared/settings.js';
import { createMessage } from '../ui/state.js';

const expected = [
  ['gemini-3.1-pro-preview', 'preview', ['low', 'medium', 'high']],
  ['gemini-3.8-flash', 'stable', ['low', 'medium', 'high']],
  ['gemini-3.7-flash', 'stable', ['low', 'medium', 'high']],
  ['gemini-3.6-flash', 'stable', ['minimal', 'low', 'medium', 'high']],
  ['gemini-3.5-flash', 'stable', ['minimal', 'low', 'medium', 'high']],
  ['gemini-3-flash-preview', 'preview', ['minimal', 'low', 'medium', 'high']],
  ['gemini-3.5-flash-lite', 'stable', ['minimal', 'low', 'medium', 'high']],
  ['gemini-3.1-flash-lite', 'stable', ['minimal', 'low', 'medium', 'high']],
  ['gemini-4-carbon', 'stable', ['low', 'medium', 'high']],
  ['gemini-4-argon', 'stable', ['low', 'medium', 'high']],
  ['gemini-4-hydrogen', 'stable', ['low', 'medium', 'high', 'xhigh']],
];
const testEnv = { GEMINI_API_KEY: 'unit-test-sentinel-not-a-key' };

test('unified model metadata contains every approved API ID and capability', () => {
  assert.deepEqual(MODELS.map(model => [model.id, model.stage, model.capabilities.thinkingLevels]), expected);
  for (const [id] of expected) {
    assert.equal(isAllowedModel(id), true);
    assert.equal(modelMetadata(id).capabilities.topK, false);
    assert.equal(modelMetadata(id).capabilities.safetySettings, true);
    assert.equal(modelMetadata(id).capabilities.samplingOverrides, false);
    assert.equal(modelMetadata(id).capabilities.outputTokenLimit, 65536);
  }
  assert.equal(DEFAULT_GLOBAL_SETTINGS.defaultModel, 'gemini-3.1-pro-preview');
});

test('capability validation never emits unsupported thinking or Top K settings', () => {
  for (const model of MODELS) {
    for (const level of ['minimal', 'low', 'medium', 'high', 'xhigh']) {
      if (model.capabilities.thinkingLevels.includes(level)) {
        assert.deepEqual(validateGenerationSettings({ thinkingLevel: level }, model.id), {
          thinkingConfig: { thinkingLevel: level.toUpperCase() },
        });
      } else {
        assert.throws(() => validateGenerationSettings({ thinkingLevel: level }, model.id), /INVALID_REQUEST/);
      }
    }
    assert.throws(() => validateGenerationSettings({
      samplingOverrides: { enabled: true, temperature: 1, topP: 0.95, topK: 40 },
    }, model.id), /INVALID_REQUEST/);
    const unspecified = validateGenerationSettings({ thinkingLevel: 'default' }, model.id);
    assert.equal(Object.hasOwn(unspecified, 'thinkingConfig'), false);
    assert.equal(JSON.stringify(unspecified).includes('thinkingBudget'), false);
    assert.equal(JSON.stringify(unspecified).includes('thinking_budget'), false);
  }
});

test('Gemini 4 accepts only its curated thinking levels and never substitutes another level', () => {
  const carbon = modelMetadata('gemini-4-carbon');
  const argon = modelMetadata('gemini-4-argon');
  const hydrogen = modelMetadata('gemini-4-hydrogen');
  assert.equal(carbon.capabilities.samplingOverrides, false);
  assert.equal(argon.capabilities.outputTokenLimit, 65536);
  assert.equal(hydrogen.capabilities.outputTokenLimit, 65536);
  assert.deepEqual(validateGenerationSettings({ thinkingLevel: 'xhigh' }, hydrogen.id), {
    thinkingConfig: { thinkingLevel: 'XHIGH' },
  });
  for (const model of [carbon, argon, hydrogen]) {
    assert.deepEqual(validateGenerationSettings({ thinkingLevel: 'default' }, model.id), {});
    assert.deepEqual(validateGenerationSettings(undefined, model.id), {});
  }
  for (const [model, level] of [
    [carbon, 'xhigh'], [carbon, 'minimal'],
    [argon, 'xhigh'], [argon, 'minimal'],
    [hydrogen, 'minimal'],
  ]) {
    assert.throws(() => validateGenerationSettings({ thinkingLevel: level }, model.id), /INVALID_REQUEST/);
  }
});

test('each approved model ID reaches the Gemini transport unchanged', async () => {
  for (const model of MODELS) {
    let received;
    const request = new Request('https://site.example/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://site.example' },
      body: JSON.stringify({ model: model.id, messages: [createMessage('user', 'hello')] }),
    });
    const response = await handleChat(request, testEnv, async function* (_, params) {
      received = params.model;
      assert.deepEqual(params.config.tools, [{ googleSearch: {} }]);
      yield { text: 'ok', candidates: [{ finishReason: 'STOP' }] };
    });
    await response.text();
    assert.equal(received, model.id);
  }
});

test('obsolete Phase 2 badge is removed and expanded model menu remains bounded', async () => {
  const [html, css] = await Promise.all([
    readFile(new URL('../ui/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../ui/styles.css', import.meta.url), 'utf8'),
  ]);
  assert.doesNotMatch(html, /class="prototype-badge"/);
  assert.doesNotMatch(css, /\.prototype-badge/);
  const modelMenuRule = css.match(/\.model-menu\s*\{([^}]+)\}/)?.[1] || '';
  assert.match(modelMenuRule, /max-height:\s*min\(70dvh,\s*520px\)/);
  assert.match(modelMenuRule, /overflow-y:\s*auto/);
  assert.doesNotMatch(modelMenuRule, /overflow-x:\s*auto/);
});
