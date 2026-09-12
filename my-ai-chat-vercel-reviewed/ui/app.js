import { DEFAULT_MODEL, modelDisplayName } from '../shared/models.js';
import { MAX_SYSTEM_INSTRUCTION_LENGTH, SAFETY_CATEGORIES, SAFETY_LEVELS } from '../shared/settings.js';
import { demoData } from './demo.js';
import { icons } from './icons.js';
import {
  activeAssistantVariant,
  addAssistantVariant,
  assistantVariantById,
  createChat,
  createMessage,
  contextFor,
  ensureBranchLineage,
  formatLocalChatTitle,
  removeUserDescendants,
  visibleConversationPath,
} from './state.js';
import {
  CANONICAL_DEMO_ID,
  deleteStoryMemoriesByAnchors,
  deleteWallpaperAsset,
  loadOrSeedChats,
  loadStoryMemories,
  loadWallpaperAsset,
  saveChat,
  saveWallpaperAsset,
  replaceStoryMemorySnapshot,
} from './storage.js';
import { renderMarkdown } from './markdown.js';
import { consumeStream } from './stream.js';
import { loadGlobalSettings, requestSettings, resetGlobalSettings, saveGlobalSettings } from './settings.js';
import { createWallpaperPresenter, decodeWallpaperImage, validateWallpaperFile } from './wallpaper.js';
import {
  MAX_BACKUP_BYTES, createBackup, downloadBackup, importBackup as mergeBackup, parseBackupText,
} from './backup.js';
import { requestStoragePersistence, storagePersistenceStatus } from './storage-persistence.js';
import { availableDefaultModel, createModelCatalog } from './model-catalog.js';
import {
  allStoryAnchors,
  applicableStoryMemory,
  commitStoryMemoryUpdate,
  createStoryMemorySnapshot,
  currentStoryAnchor,
  memoryStatusText,
  storyMemoryConversation,
  storySubtreeAnchorIds,
} from './story-memory.js';

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const escapeHtml = value => String(value).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const ACTIVE_CHAT_STORAGE_KEY = 'my-ai-chat-active-chat-id';
const chats = new Map();
function createDemoChats() {
  const seedTime = Date.now();
  return Object.entries(demoData).map(([oldId, data], index) => {
    const chat = createChat();
    chat.id = oldId === 'welcome' ? CANONICAL_DEMO_ID : 'demo-' + oldId;
    chat.createdAt = new Date(seedTime + index).toISOString();
    chat.updatedAt = chat.createdAt;
    chat.title = data.title; chat.demo = true; chat.titleInitialized = true;
    chat.group = data.subtitle.startsWith('Yesterday') ? 'Yesterday' : 'Today';
    chat.messages = data.messages.map(item => createMessage(item.role, item.text, DEFAULT_MODEL));
    return chat;
  });
}
let activeChat, generation = null, editingId = null, toastTimer, storageWarningShown = false;
let wallpaperRecord = null, wallpaperBusy = false;
let dataTransferBusy = false, persistenceRequestBusy = false;
let modelCatalogBusy = false;
let storyMemoryBusy = false, storyMemoryLoaded = false, storyMemorySnapshots = [];
let persistenceStatus = { state: 'checking', supported: true };
const modelCatalog = createModelCatalog();
let globalSettings = loadGlobalSettings();
function ensureAvailableDefaultModel(confirmed = !!modelCatalog.syncedAt) {
  const available = availableDefaultModel(globalSettings.defaultModel, modelCatalog);
  if (confirmed && available !== globalSettings.defaultModel) {
    globalSettings = saveGlobalSettings({ ...globalSettings, defaultModel: available });
  }
}
ensureAvailableDefaultModel(false);
const modelName = id => modelCatalog.metadata(id)?.name || modelDisplayName(id);
const conversation = $('#conversation'), input = $('#messageInput');
const wallpaperPresenter = createWallpaperPresenter({ conversation, preview: $('#wallpaperPreview') });
const sendIcon = $('#sendButton').innerHTML;
const mobile = matchMedia('(max-width: 819px)');
const current = () => chats.get(activeChat);

function toast(message) {
  const element = $('#toast');
  element.textContent = message; element.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => element.classList.remove('show'), 2500);
}
function rememberActiveChat(id) {
  try { localStorage.setItem(ACTIVE_CHAT_STORAGE_KEY, id); } catch {}
}
async function persistChat(chat) {
  chat.updatedAt = new Date().toISOString();
  try { await saveChat(chat); }
  catch {
    if (!storageWarningShown) {
      storageWarningShown = true;
      toast('Local storage is unavailable. This session will remain in memory only.');
    }
  }
}
function renderHistory() {
  const term = $('#chatSearch').value.trim().toLowerCase();
  for (const section of $$('.history-section:not(.folders-section)')) section.remove();
  for (const group of ['Today', 'Yesterday']) {
    const section = document.createElement('section'); section.className = 'history-section';
    section.innerHTML = '<div class="section-label">' + group + '</div>';
    for (const chat of [...chats.values()].filter(c => c.group === group).reverse()) {
      const button = document.createElement('button');
      button.className = 'history-item chat-item' + (chat.id === activeChat ? ' active' : '');
      button.dataset.chatId = chat.id; button.setAttribute('aria-current', chat.id === activeChat ? 'true' : 'false');
      button.hidden = !chat.title.toLowerCase().includes(term);
      button.innerHTML = '<span class="chat-title">' + escapeHtml(chat.title) + '</span>';
      button.addEventListener('click', () => selectChat(chat.id));
      section.append(button);
    }
    $('.history-scroll').append(section);
  }
  if (![...chats.values()].some(c => c.title.toLowerCase().includes(term))) {
    const empty = document.createElement('p'); empty.className = 'search-empty'; empty.textContent = 'No chats found';
    $('.history-scroll').append(empty);
  }
  $$('.search-empty').slice(0, -1).forEach(el => el.remove());
  if (!term || [...chats.values()].some(c => c.title.toLowerCase().includes(term))) $$('.search-empty').forEach(el => el.remove());
}
function action(action, label, icon, selected = false, disabled = false) {
  return '<button class="action-button' + (selected ? ' active' : '') + '" data-action="' + action + '" aria-label="' + label + '" title="' + label + '"' +
    (['like', 'dislike'].includes(action) ? ' aria-pressed="' + selected + '"' : '') + (disabled ? ' disabled' : '') +
    '>' + icon + '<span class="action-label">' + label + '</span></button>';
}
function messageHtml(message) {
  const busy = !!generation;
  if (message.role === 'user') {
    if (editingId === message.id) return '<div class="edit-area"><textarea aria-label="Edit message" maxlength="50000">' + escapeHtml(message.content) +
      '</textarea><p class="edit-note">Saving starts a revised turn; later replies in this chat are removed.</p><div class="edit-controls"><button class="small-button" data-action="edit-cancel">Cancel</button><button class="small-button primary" data-action="edit-save">Save & resend</button></div></div>';
    return '<div class="message-bubble"><p>' + escapeHtml(message.content) + '</p></div><div class="message-actions">' +
      action('edit', 'Edit', icons.edit, false, busy) + action('copy', 'Copy', icons.copy) + '</div>';
  }
  const variant = activeAssistantVariant(message);
  const variants = Array.isArray(message.variants) && message.variants.length ? message.variants : [message];
  const variantIndex = Math.max(0, variants.findIndex(item => item.id === variant.id));
  const latestAssistant = visibleConversationPath(current()).filter(m => m.role === 'assistant').at(-1)?.id === message.id;
  const generating = ['sending','generating'].includes(variant.status);
  const status = generating ? '<span class="generation-status">' + (variant.status === 'sending' ? 'Sending…' : 'Generating…') + '</span>' :
    variant.status === 'stopped' ? '<span class="generation-status">Stopped · partial response excluded from context</span>' : '';
  const error = variant.error ? '<div class="error-note" role="alert">' + escapeHtml(variant.error) + '</div>' : '';
  const variantNav = variants.length > 1 ? '<span class="variant-nav" aria-label="Response variants"><button data-action="variant-prev" aria-label="Previous response" title="Previous response"' +
    (busy || variantIndex === 0 ? ' disabled' : '') + '>‹</button><span>' + (variantIndex + 1) + ' / ' + variants.length + '</span><button data-action="variant-next" aria-label="Next response" title="Next response"' +
    (busy || variantIndex === variants.length - 1 ? ' disabled' : '') + '>›</button></span>' : '';
  return '<div class="assistant-mark" aria-hidden="true">AI</div><div class="assistant-body"><div class="message-content">' +
    (variant.content ? renderMarkdown(variant.content) : generating ? '<div class="typing" aria-label="Generating"><i></i><i></i><i></i></div>' : '') +
    '</div>' + status + error + (variant.notice ? '<p class="generation-status">' + escapeHtml(variant.notice) + '</p>' : '') +
    '<div class="message-actions">' + action('copy', 'Copy', icons.copy, false, !variant.content) +
    (latestAssistant ? action('regenerate', variant.status === 'error' || variant.status === 'stopped' ? 'Retry' : 'Regenerate', icons.redo, false, busy) : '') +
    action('like', 'Like', icons.like, variant.feedback === 'like', generating) +
    action('dislike', 'Dislike', icons.dislike, variant.feedback === 'dislike', generating) + variantNav +
    '</div><span class="message-model">' + escapeHtml(modelName(variant.model)) + '</span></div>';
}
function renderConversation(bottom = false) {
  const chat = current(), saved = conversation.scrollTop;
  const memory = applicableStoryMemory(chat, storyMemorySnapshots);
  const memoryDisabled = storyMemoryBusy || !!generation || !currentStoryAnchor(chat);
  conversation.innerHTML = '<div class="conversation-inner"><div class="chat-heading"><p class="eyebrow">' +
    escapeHtml(chat.demo ? 'Demo conversation · ' + modelName(chat.model) : chat.group + ' · ' + modelName(chat.model)) +
    '</p><h1>' + escapeHtml(chat.messages.length ? chat.title : 'What would you like to explore?') +
    '</h1><div class="story-memory-control"><span>' + escapeHtml(memoryStatusText(memory)) +
    '</span><button class="small-button" type="button" data-update-story-memory' + (memoryDisabled ? ' disabled' : '') + '>' +
    (storyMemoryBusy ? 'Updating…' : 'Update Memory') + '</button></div></div><div class="messages"></div></div>';
  for (const message of visibleConversationPath(chat)) {
    const article = document.createElement('article'); article.className = 'message ' + message.role;
    article.dataset.messageId = message.id; article.innerHTML = messageHtml(message);
    $('.messages').append(article);
  }
  conversation.scrollTop = bottom ? conversation.scrollHeight : saved;
}

async function updateStoryMemory() {
  const chat = current();
  if (storyMemoryBusy || generation || !chat) return;
  const anchorId = currentStoryAnchor(chat);
  if (!anchorId) return;
  const applicable = applicableStoryMemory(chat, storyMemorySnapshots);
  storyMemoryBusy = true; renderConversation();
  try {
    const response = await fetch('/api/story-memory', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: chat.model, chatId: chat.id, anchorId,
        messages: storyMemoryConversation(chat), existingMemory: applicable?.memory || null,
      }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.memory) throw new Error('Story memory request failed');
    if (!allStoryAnchors(chat).has(anchorId)) throw new Error('Story branch changed');
    const snapshot = createStoryMemorySnapshot({ chatId: chat.id, anchorId, memory: payload.memory });
    storyMemorySnapshots = await commitStoryMemoryUpdate(
      storyMemorySnapshots, snapshot, item => replaceStoryMemorySnapshot(item),
    );
    toast('Memory updated.');
  } catch {
    toast('Could not update story memory. Your chat was not changed.');
  } finally {
    storyMemoryBusy = false;
    if (current()?.id === chat.id) renderConversation();
  }
}
function updateMessage(chatId, message) {
  if (activeChat !== chatId) return;
  const nearBottom = conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 100;
  const element = $('[data-message-id="' + message.id + '"]');
  if (element) element.innerHTML = messageHtml(message);
  if (nearBottom) conversation.scrollTop = conversation.scrollHeight;
}
function syncComposer() {
  const active = generation?.chatId === activeChat;
  $('#sendButton').type = active ? 'button' : 'submit';
  $('#sendButton').setAttribute('aria-label', active ? 'Stop generation' : 'Send message');
  $('#sendButton').title = active ? 'Stop generation' : 'Send message';
  $('#sendButton').innerHTML = active ? '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" fill="currentColor" stroke="none"/></svg>' : sendIcon;
  $('#sendButton').disabled = !active && (!!generation || !!editingId || !input.value.trim());
  $('#modelButton').disabled = !!generation;
  input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 160) + 'px';
}
function syncModel() {
  const id = current().model;
  $('#currentModel').textContent = modelName(id); input.placeholder = 'Message ' + modelName(id) + '…';
  $('#modelMenu').innerHTML = modelCatalog.models.map(model => '<button class="model-option' + (id === model.id ? ' selected' : '') +
    '" role="option" aria-selected="' + (id === model.id) + '" data-model="' + model.id + '"><span><strong>' +
    escapeHtml(model.name) + (model.source === 'discovered' ? ' <span class="model-source-badge">Auto</span>' : '') +
    '</strong><small>' + escapeHtml(model.description) + '</small></span><span>' + (id === model.id ? '✓' : '') + '</span></button>').join('');
}
function setModelMenu(open, focus = false) {
  $('#modelMenu').classList.toggle('open', open); $('#modelButton').setAttribute('aria-expanded', String(open));
  if (open && focus) $('.model-option.selected')?.focus();
}
function closeSidebar(restore = false) {
  $('#sidebar').classList.remove('open'); $('#mobileScrim').classList.remove('show');
  $('#openSidebar').setAttribute('aria-expanded', 'false');
  $('.main-panel').inert = false; $('#sidebar').inert = mobile.matches;
  if (restore && mobile.matches) $('#openSidebar').focus();
}
function openSidebar() {
  $('#sidebar').inert = false; $('#sidebar').classList.add('open'); $('#mobileScrim').classList.add('show');
  $('#openSidebar').setAttribute('aria-expanded', 'true'); $('.main-panel').inert = true; $('#closeSidebar').focus();
}
function selectChat(id) {
  current().draft = input.value; current().scrollTop = conversation.scrollTop;
  activeChat = id; editingId = null; input.value = current().draft;
  rememberActiveChat(activeChat);
  closeSidebar(); syncModel(); syncComposer(); renderHistory(); renderConversation();
  conversation.scrollTop = current().scrollTop;
}
async function newChat() {
  const chat = createChat(availableDefaultModel(globalSettings.defaultModel, modelCatalog)); chats.set(chat.id, chat); $('#chatSearch').value = '';
  selectChat(chat.id); input.focus(); await persistChat(chat);
}
function syncSettingsUi() {
  $('#defaultModelSetting').innerHTML = modelCatalog.models.map(model => '<option value="' + model.id + '">' + escapeHtml(model.name) +
    (model.source === 'discovered' ? ' · Auto' : '') + '</option>').join('');
  $('#defaultModelSetting').value = availableDefaultModel(globalSettings.defaultModel, modelCatalog);
  $('#refreshModels').disabled = modelCatalogBusy;
  $('#refreshModels').textContent = modelCatalogBusy ? 'Refreshing…' : 'Refresh Models';
  $('#modelCatalogSynced').textContent = modelCatalog.syncedAt
    ? 'Last synced: ' + new Date(modelCatalog.syncedAt).toLocaleString() : 'Last synced: Never';
  $('#systemInstructionSetting').value = globalSettings.systemInstruction;
  $('#systemInstructionCount').textContent = globalSettings.systemInstruction.length + ' / ' + MAX_SYSTEM_INSTRUCTION_LENGTH;
  $('#contextLimitSetting').value = globalSettings.contextLimit;
  $('#maxOutputTokensSetting').value = globalSettings.maxOutputTokens ?? '';
  $('#thinkingLevelSetting').value = globalSettings.thinkingLevel;
  const capabilities = modelCatalog.metadata(globalSettings.defaultModel)?.capabilities;
  for (const option of $('#thinkingLevelSetting').options) {
    option.disabled = option.value !== 'default' && !capabilities?.thinkingLevels.includes(option.value);
  }
  if ($('#thinkingLevelSetting').selectedOptions[0]?.disabled) {
    globalSettings = saveGlobalSettings({ ...globalSettings, thinkingLevel: 'default' });
    $('#thinkingLevelSetting').value = 'default';
  }
  const samplingSupported = capabilities?.samplingOverrides === true;
  $('#samplingEnabledSetting').checked = samplingSupported && globalSettings.samplingOverrides.enabled;
  $('#samplingEnabledSetting').disabled = !samplingSupported;
  $('#temperatureSetting').value = globalSettings.samplingOverrides.temperature;
  $('#topPSetting').value = globalSettings.samplingOverrides.topP;
  $('#topKSetting').value = globalSettings.samplingOverrides.topK;
  const topKSupported = capabilities?.topK === true;
  $('#topKSetting').disabled = !globalSettings.samplingOverrides.enabled || !topKSupported;
  $('#topKField').classList.toggle('unsupported', !topKSupported);
  $('#topKSupport').textContent = topKSupported ? '' : 'Not supported by the selected model.';
  $('#advancedFields').disabled = !samplingSupported || !globalSettings.samplingOverrides.enabled;
  // A fieldset disables all descendants, then Top K adds its model capability constraint.
  if (samplingSupported && globalSettings.samplingOverrides.enabled) $('#topKSetting').disabled = !topKSupported;
  const safetySupported = capabilities?.safetySettings === true;
  $('#safetyModeSetting').disabled = !safetySupported;
  $('#safetyModeSetting').value = safetySupported ? globalSettings.safetySettings.mode : 'default';
  const customSafety = safetySupported && globalSettings.safetySettings.mode === 'custom';
  $('#safetyCustomFields').hidden = !customSafety;
  $('#safetyCustomFields').innerHTML = SAFETY_CATEGORIES.map(({ key, label }) =>
    '<div class="safety-category-row"><strong>' + escapeHtml(label) + '</strong><div class="safety-levels" role="radiogroup" aria-label="' +
    escapeHtml(label) + ' safety threshold">' + SAFETY_LEVELS.map(({ label: levelLabel, shortLabel, threshold }) =>
      '<button type="button" role="radio" aria-checked="' + (globalSettings.safetySettings[key] === threshold) + '" aria-label="' +
      escapeHtml(levelLabel) + '" title="' + escapeHtml(levelLabel) + '" class="' + (globalSettings.safetySettings[key] === threshold ? 'active' : '') +
      '" data-safety-category="' + key + '" data-safety-threshold="' + threshold + '">' + escapeHtml(shortLabel) + '</button>'
    ).join('') + '</div></div>'
  ).join('');
  const hasWallpaper = !!wallpaperRecord;
  $('#wallpaperCurrent').hidden = !hasWallpaper;
  $('#wallpaperName').textContent = wallpaperRecord?.name || '';
  $('#chooseWallpaper').textContent = hasWallpaper ? 'Change Image' : 'Choose Image';
  $('#chooseWallpaper').disabled = wallpaperBusy;
  $('#removeWallpaper').hidden = !hasWallpaper;
  $('#removeWallpaper').disabled = wallpaperBusy;
  $('#exportBackup').disabled = dataTransferBusy || !!generation;
  $('#importBackup').disabled = dataTransferBusy || !!generation;
  const persistenceMessages = {
    checking: 'Checking storage protection…',
    unsupported: 'Persistent storage is not supported by this browser.',
    'best-effort': 'Storage protection: Best effort',
    persistent: 'Storage protection: Persistent',
    denied: 'The browser did not grant persistent storage. Your chats are still saved locally and can be backed up manually.',
  };
  $('#storageProtectionStatus').textContent = persistenceMessages[persistenceStatus.state] || persistenceMessages['best-effort'];
  $('#requestStoragePersistence').hidden = !persistenceStatus.supported || persistenceStatus.state === 'persistent';
  $('#requestStoragePersistence').disabled = persistenceRequestBusy;
}
function updateGlobalSettings(patch) {
  globalSettings = saveGlobalSettings({ ...globalSettings, ...patch });
  syncSettingsUi();
}
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('my-ai-chat-theme', theme); } catch {}
  $('#themeHint').textContent = theme === 'dark' ? 'Dark' : 'Light';
  $('#quickTheme').setAttribute('aria-label', 'Switch to ' + (theme === 'dark' ? 'light' : 'dark') + ' mode');
  $('meta[name="theme-color"]').content = theme === 'dark' ? '#0f1219' : '#f7f8fb';
  $$('[data-theme-choice]').forEach(b => b.classList.toggle('active', b.dataset.themeChoice === theme));
}
async function refreshStoragePersistence() {
  persistenceStatus = await storagePersistenceStatus();
  syncSettingsUi();
}
async function generate(chat, user, existingTurn = null, existingVariant = null) {
  if (generation) return;
  const assistant = existingTurn || createMessage('assistant', '', chat.model);
  const variant = existingVariant || assistant;
  variant.status = 'sending';
  if (!existingTurn) {
    assistant.parentUserId = user.id;
    chat.messages.push(assistant);
  }
  const job = { chatId: chat.id, messageId: assistant.id, variantId: variant.id, abort: new AbortController() };
  generation = job; syncComposer(); renderConversation(true);
  let readerResponse;
  try {
    readerResponse = await fetch('/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: chat.model,
        messages: contextFor(chat, user.id, globalSettings.contextLimit),
        storyMemory: applicableStoryMemory(chat, storyMemorySnapshots)?.memory || null,
        settings: requestSettings(globalSettings, modelCatalog.metadata(chat.model) || {
          source: 'discovered', capabilities: { thinkingLevels: [], samplingOverrides: false, safetySettings: false },
        }),
      }),
      signal: job.abort.signal,
    });
    if (!readerResponse.ok) {
      const payload = await readerResponse.json().catch(() => null);
      throw new Error(payload?.error?.message || '服务器请求失败，请重试。');
    }
    await consumeStream(readerResponse, event => {
      if (job.abort.signal.aborted) return;
      if (event.type === 'start') variant.status = 'generating';
      if (event.type === 'delta') { variant.status = 'generating'; variant.content += event.text; }
      if (event.type === 'error') { variant.status = 'error'; variant.error = event.message; }
      if (event.type === 'done') { variant.status = 'complete'; variant.notice = event.notice; }
      updateMessage(chat.id, assistant);
    }, job.abort.signal);
  } catch (error) {
    if (job.abort.signal.aborted) variant.status = 'stopped';
    else { variant.status = 'error'; variant.error = error instanceof TypeError ? '网络连接失败，请检查网络后重试。' : error.message || '生成失败，请重试。'; }
  } finally {
    if (generation === job) generation = null;
    updateMessage(chat.id, assistant);
    syncComposer();
    if (activeChat === chat.id) renderConversation();
    await persistChat(chat);
  }
}
function stopGeneration() {
  if (!generation) return;
  generation.abort.abort();
  const chat = chats.get(generation.chatId);
  const message = chat.messages.find(m => m.id === generation.messageId);
  const variant = assistantVariantById(message, generation.variantId);
  if (variant) variant.status = 'stopped';
  updateMessage(chat.id, message); void persistChat(chat);
}
async function retry(messageId) {
  if (generation) return;
  const chat = current(), path = visibleConversationPath(chat);
  const message = chat.messages.find(item => item.id === messageId);
  if (!message || message.role !== 'assistant' || path.filter(item => item.role === 'assistant').at(-1)?.id !== messageId) return;
  const user = chat.messages.find(item => item.id === message.parentUserId && item.role === 'user');
  if (!user) return;
  const variantMessage = createMessage('assistant', '', chat.model);
  variantMessage.status = 'sending';
  const variant = addAssistantVariant(message, variantMessage);
  renderConversation(true); await persistChat(chat); void generate(chat, user, message, variant);
}
$('#composerForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (generation || editingId || !input.value.trim()) return;
  const chat = current(), user = createMessage('user', input.value.trim());
  const leafAssistant = visibleConversationPath(chat).filter(message => message.role === 'assistant').at(-1);
  user.parentVariantId = leafAssistant ? activeAssistantVariant(leafAssistant).id : null;
  chat.messages.push(user);
  if (!chat.demo && chat.titleInitialized === false && chat.messages.length === 1) {
    chat.title = formatLocalChatTitle(user.createdAt);
    chat.titleInitialized = true;
  }
  chat.draft = ''; input.value = ''; renderHistory(); renderConversation(true); syncComposer();
  await persistChat(chat); void generate(chat, user);
});
$('#sendButton').addEventListener('click', () => { if (generation?.chatId === activeChat) stopGeneration(); });
input.addEventListener('input', () => { current().draft = input.value; syncComposer(); });
input.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault(); if (!generation) $('#composerForm').requestSubmit();
  }
});
$('#newChatButton').addEventListener('click', () => void newChat());
$('#chatSearch').addEventListener('input', renderHistory);
$('#foldersToggle').addEventListener('click', () => {
  const expanded = $('#foldersToggle').getAttribute('aria-expanded') === 'true';
  $('#foldersToggle').setAttribute('aria-expanded', String(!expanded)); $('#folderList').classList.toggle('collapsed', expanded);
});
$$('.folder-item').forEach(b => b.addEventListener('click', () => toast('Demo folder · organization is not connected yet')));
$('#modelButton').addEventListener('click', () => setModelMenu(!$('#modelMenu').classList.contains('open'), true));
$('#modelMenu').addEventListener('click', event => {
  const option = event.target.closest('[data-model]');
  if (!option || generation || !modelCatalog.has(option.dataset.model)) return;
  current().model = option.dataset.model; void persistChat(current());
  syncModel(); setModelMenu(false); renderConversation(); $('#modelButton').focus();
});
$('#modelMenu').addEventListener('keydown', event => {
  if (!['ArrowDown','ArrowUp','Home','End'].includes(event.key)) return;
  event.preventDefault(); const options = $$('.model-option'), index = options.indexOf(document.activeElement);
  options[event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length].focus();
});
document.addEventListener('click', event => { if (!event.target.closest('.model-wrap')) setModelMenu(false); });
$('#openSidebar').addEventListener('click', openSidebar);
$('#closeSidebar').addEventListener('click', () => closeSidebar(true));
$('#mobileScrim').addEventListener('click', () => closeSidebar(true));
mobile.addEventListener('change', () => closeSidebar());
$('#settingsButton').addEventListener('click', () => { closeSidebar(); syncSettingsUi(); $('#settingsDialog').showModal(); });
$('#settingsDialog').addEventListener('close', () => { if (mobile.matches) $('#openSidebar').focus(); });
$('#quickTheme').addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
$$('[data-theme-choice]').forEach(button => button.addEventListener('click', () => setTheme(button.dataset.themeChoice)));
$('#exportBackup').addEventListener('click', () => {
  if (dataTransferBusy || generation) return;
  dataTransferBusy = true; syncSettingsUi();
  try {
    const backup = createBackup({
      chats: [...chats.values()],
      settings: globalSettings,
      activeChatId: activeChat,
      theme: document.documentElement.dataset.theme,
    });
    downloadBackup(backup);
    toast('Backup downloaded');
  } catch {
    toast('Backup could not be exported. Please try again.');
  } finally {
    dataTransferBusy = false; syncSettingsUi();
  }
});
$('#importBackup').addEventListener('click', () => { if (!dataTransferBusy && !generation) $('#backupInput').click(); });
$('#backupInput').addEventListener('change', async event => {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file || dataTransferBusy || generation) return;
  dataTransferBusy = true; syncSettingsUi();
  try {
    const jsonType = !file.type || file.type === 'application/json' || file.name.toLowerCase().endsWith('.json');
    if (!jsonType || !file.size || file.size > MAX_BACKUP_BYTES) throw new Error('Invalid backup file');
    const backup = parseBackupText(await file.text());
    const exported = new Date(backup.exportedAt).toLocaleString();
    const confirmed = window.confirm(
      `Import backup from ${exported}\n${backup.chats.length} chats found.\n\n` +
      'This will merge the backup with your current chats. Existing newer chats will be kept.'
    );
    if (!confirmed) return;
    const previousActiveChat = activeChat;
    const result = await mergeBackup(backup);
    chats.clear();
    for (const chat of result.chats) chats.set(chat.id, ensureBranchLineage(chat));
    globalSettings = result.settings;
    activeChat = result.activeChatId && chats.has(result.activeChatId)
      ? result.activeChatId
      : chats.has(previousActiveChat) ? previousActiveChat : chats.keys().next().value;
    rememberActiveChat(activeChat);
    if (result.theme) setTheme(result.theme);
    editingId = null; input.value = current()?.draft || '';
    syncModel(); renderHistory(); renderConversation(); syncComposer(); syncSettingsUi();
    $('#settingsDialog').close();
    toast(`Backup imported · ${result.added} added, ${result.updated} updated`);
  } catch {
    toast('This backup file could not be imported.');
  } finally {
    dataTransferBusy = false; syncSettingsUi();
  }
});
$('#requestStoragePersistence').addEventListener('click', async () => {
  if (persistenceRequestBusy) return;
  persistenceRequestBusy = true; syncSettingsUi();
  persistenceStatus = await requestStoragePersistence();
  persistenceRequestBusy = false; syncSettingsUi();
});
$('#chooseWallpaper').addEventListener('click', () => { if (!wallpaperBusy) $('#wallpaperInput').click(); });
$('#wallpaperInput').addEventListener('change', async event => {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file || wallpaperBusy) return;
  wallpaperBusy = true; syncSettingsUi();
  try {
    validateWallpaperFile(file);
    await decodeWallpaperImage(file);
    const saved = await saveWallpaperAsset(file);
    wallpaperPresenter.show(saved);
    wallpaperRecord = saved;
    toast('Chat wallpaper updated');
  } catch (error) {
    const friendly = error?.message?.startsWith('Choose a ') || error?.message?.startsWith('This image') || error?.message?.startsWith('Wallpaper images')
      ? error.message
      : 'Wallpaper could not be saved. Your previous wallpaper is unchanged.';
    toast(friendly);
  } finally {
    wallpaperBusy = false; syncSettingsUi();
  }
});
$('#removeWallpaper').addEventListener('click', async () => {
  if (!wallpaperRecord || wallpaperBusy) return;
  wallpaperBusy = true; syncSettingsUi();
  try {
    await deleteWallpaperAsset();
    wallpaperPresenter.clear();
    wallpaperRecord = null;
    toast('Chat wallpaper removed');
  } catch {
    toast('Wallpaper could not be removed. Please try again.');
  } finally {
    wallpaperBusy = false; syncSettingsUi();
  }
});
$('#defaultModelSetting').addEventListener('change', event => updateGlobalSettings({ defaultModel: event.target.value }));
$('#refreshModels').addEventListener('click', async () => {
  if (modelCatalogBusy) return;
  modelCatalogBusy = true; syncSettingsUi();
  try {
    await modelCatalog.refresh({ force: true });
    ensureAvailableDefaultModel(true);
    syncModel(); syncSettingsUi();
    toast('Models updated.');
  } catch {
    toast('Could not refresh models. Existing models are still available.');
  } finally {
    modelCatalogBusy = false; syncSettingsUi();
  }
});
$('#systemInstructionSetting').addEventListener('input', event => {
  globalSettings = saveGlobalSettings({ ...globalSettings, systemInstruction: event.target.value });
  $('#systemInstructionCount').textContent = globalSettings.systemInstruction.length + ' / ' + MAX_SYSTEM_INSTRUCTION_LENGTH;
});
$('#clearSystemInstruction').addEventListener('click', () => updateGlobalSettings({ systemInstruction: '' }));
$('#contextLimitSetting').addEventListener('change', event => updateGlobalSettings({ contextLimit: event.target.value }));
$('#maxOutputTokensSetting').addEventListener('change', event => {
  const value = event.target.value.trim();
  updateGlobalSettings({ maxOutputTokens: value ? Number(value) : null });
});
$('#thinkingLevelSetting').addEventListener('change', event => updateGlobalSettings({ thinkingLevel: event.target.value }));
$('#samplingEnabledSetting').addEventListener('change', event => updateGlobalSettings({
  samplingOverrides: { ...globalSettings.samplingOverrides, enabled: event.target.checked },
}));
$('#safetyModeSetting').addEventListener('change', event => updateGlobalSettings({
  safetySettings: { ...globalSettings.safetySettings, mode: event.target.value },
}));
$('#safetyCustomFields').addEventListener('click', event => {
  const button = event.target.closest('[data-safety-category][data-safety-threshold]');
  if (!button) return;
  updateGlobalSettings({
    safetySettings: { ...globalSettings.safetySettings, [button.dataset.safetyCategory]: button.dataset.safetyThreshold },
  });
});
for (const [selector, key] of [['#temperatureSetting', 'temperature'], ['#topPSetting', 'topP'], ['#topKSetting', 'topK']]) {
  $(selector).addEventListener('change', event => updateGlobalSettings({
    samplingOverrides: { ...globalSettings.samplingOverrides, [key]: Number(event.target.value) },
  }));
}
$('#resetGlobalSettings').addEventListener('click', () => {
  globalSettings = resetGlobalSettings(); syncSettingsUi(); toast('Model settings reset to defaults');
});
async function copy(text) {
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else {
      const field = document.createElement('textarea'), focused = document.activeElement;
      field.value = text; field.style.cssText = 'position:fixed;left:-9999px'; document.body.append(field);
      field.select(); const success = document.execCommand('copy'); field.remove(); focused?.focus();
      if (!success) throw new Error('Clipboard unavailable');
    }
    toast('Copied to clipboard');
  }
  catch { toast('Clipboard unavailable. Please select and copy the text.'); }
}
conversation.addEventListener('click', async event => {
  if (event.target.closest('[data-update-story-memory]')) { void updateStoryMemory(); return; }
  const codeCopy = event.target.closest('[data-code-copy]');
  if (codeCopy) { void copy($('code', codeCopy.closest('.code-block')).textContent); return; }
  const button = event.target.closest('[data-action]');
  const article = button?.closest('[data-message-id]');
  if (!article) return;
  const chat = current(), message = chat.messages.find(m => m.id === article.dataset.messageId);
  if (!message) return;
  switch (button.dataset.action) {
    case 'copy': void copy(message.role === 'assistant' ? activeAssistantVariant(message).content : message.content); break;
    case 'like': case 'dislike':
      {
        const target = message.role === 'assistant' ? activeAssistantVariant(message) : message;
        target.feedback = target.feedback === button.dataset.action ? null : button.dataset.action;
      }
      updateMessage(chat.id, message); void persistChat(chat); break;
    case 'regenerate': void retry(message.id); break;
    case 'variant-prev': case 'variant-next': {
      if (generation || !Array.isArray(message.variants)) return;
      const index = message.variants.findIndex(variant => variant.id === message.activeVariantId);
      const next = index + (button.dataset.action === 'variant-next' ? 1 : -1);
      if (next < 0 || next >= message.variants.length) return;
      message.activeVariantId = message.variants[next].id;
      renderConversation(); void persistChat(chat); break;
    }
    case 'edit':
      if (generation) return;
      editingId = message.id; syncComposer(); renderConversation(); $('textarea', $('[data-message-id="' + message.id + '"]'))?.focus(); break;
    case 'edit-cancel': editingId = null; syncComposer(); renderConversation(); break;
    case 'edit-save': {
      if (generation) return;
      const value = $('textarea', article).value.trim(); if (!value) return;
      const prunedAnchors = storySubtreeAnchorIds(chat, message.id);
      const hasStoredMemory = storyMemorySnapshots.some(snapshot => snapshot.chatId === chat.id && prunedAnchors.has(snapshot.anchorId));
      if (!storyMemoryLoaded || hasStoredMemory) {
        try { await deleteStoryMemoriesByAnchors(chat.id, prunedAnchors); }
        catch { toast('Could not revise this branch because local memory cleanup failed.'); return; }
      }
      storyMemorySnapshots = storyMemorySnapshots.filter(snapshot => snapshot.chatId !== chat.id || !prunedAnchors.has(snapshot.anchorId));
      message.content = value; message.updatedAt = new Date().toISOString();
      removeUserDescendants(chat, message.id); editingId = null; renderConversation(true);
      await persistChat(chat); void generate(chat, message); break;
    }
  }
});
document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && !$('#settingsDialog').open) { event.preventDefault(); void newChat(); }
  if (event.key === 'Escape') { closeSidebar(true); setModelMenu(false); }
  if (event.key === 'Tab' && mobile.matches && $('#sidebar').classList.contains('open')) {
    const controls = $$('button:not([disabled]),input', $('#sidebar')).filter(el => el.getClientRects().length);
    if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1).focus(); }
    else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0].focus(); }
  }
});
new ResizeObserver(() => {
  conversation.style.paddingBottom = Math.ceil($('.composer-dock').getBoundingClientRect().height + 28) + 'px';
}).observe($('.composer-dock'));
window.addEventListener('pagehide', event => { if (!event.persisted) wallpaperPresenter.dispose(); });
async function initializeApp() {
  let initialChats;
  try { initialChats = await loadOrSeedChats(createDemoChats); }
  catch {
    storageWarningShown = true;
    initialChats = createDemoChats();
    setTimeout(() => toast('Local storage is unavailable. This session will remain in memory only.'), 0);
  }
  for (const chat of initialChats) chats.set(chat.id, ensureBranchLineage(chat));
  try { storyMemorySnapshots = await loadStoryMemories(); storyMemoryLoaded = true; }
  catch { storyMemorySnapshots = []; storyMemoryLoaded = false; }
  let savedActiveChat;
  try { savedActiveChat = localStorage.getItem(ACTIVE_CHAT_STORAGE_KEY); } catch {}
  activeChat = savedActiveChat && chats.has(savedActiveChat) ? savedActiveChat : chats.keys().next().value;
  rememberActiveChat(activeChat);
  let theme = 'dark'; try { theme = localStorage.getItem('my-ai-chat-theme') === 'light' ? 'light' : 'dark'; } catch {}
  try {
    const storedWallpaper = await loadWallpaperAsset();
    if (storedWallpaper?.blob) {
      wallpaperPresenter.show(storedWallpaper);
      wallpaperRecord = storedWallpaper;
    }
  } catch {
    setTimeout(() => toast('Wallpaper could not be restored from this device.'), 0);
  }
  setTheme(theme); closeSidebar(); syncModel(); renderHistory(); renderConversation(); syncComposer();
  syncSettingsUi();
  void refreshStoragePersistence();
  void modelCatalog.autoRefresh().then(result => {
    if (!result.ok) return;
    ensureAvailableDefaultModel(true);
    syncModel(); syncSettingsUi();
  });
}

await initializeApp();
