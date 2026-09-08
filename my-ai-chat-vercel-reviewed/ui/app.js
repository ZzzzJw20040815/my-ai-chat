import { MODELS, DEFAULT_MODEL, modelName, isAllowedModel } from '../shared/models.js';
import { demoData } from './demo.js';
import { icons } from './icons.js';
import { createChat, createMessage, contextFor } from './state.js';
import { loadOrSeedChats, saveChat } from './storage.js';
import { renderMarkdown } from './markdown.js';
import { consumeStream } from './stream.js';

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const escapeHtml = value => String(value).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const ACTIVE_CHAT_STORAGE_KEY = 'my-ai-chat-active-chat-id';
const chats = new Map();
function demoMarkdown(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  function convert(node) {
    if (node.nodeType === 3) return node.textContent.replace(/\s+/g, ' ');
    if (node.classList?.contains('code-head')) return '';
    if (node.tagName === 'PRE') return '\n\n```' + ($('.code-head span', node.parentElement)?.textContent || 'code') + '\n' + node.textContent + '\n```\n\n';
    if (node.tagName === 'UL') return '\n\n' + [...node.children].map(li => '- ' + li.textContent.trim()).join('\n') + '\n\n';
    const value = [...node.childNodes].map(convert).join('').trim();
    if (node.tagName === 'P') return '\n\n' + value + '\n\n';
    if (node.tagName === 'H3') return '\n\n### ' + value + '\n\n';
    return value;
  }
  return convert(doc.body).trim();
}
function createDemoChats() {
  const seedTime = Date.now();
  return Object.entries(demoData).map(([oldId, data], index) => {
    const chat = createChat();
    chat.id = 'demo-' + oldId;
    chat.createdAt = new Date(seedTime + index).toISOString();
    chat.updatedAt = chat.createdAt;
    chat.title = data.title; chat.demo = true;
    chat.group = data.subtitle.startsWith('Yesterday') ? 'Yesterday' : 'Today';
    chat.messages = data.messages.map(item => createMessage(item.role, item.text || demoMarkdown(item.html), DEFAULT_MODEL));
    return chat;
  });
}
let activeChat, generation = null, editingId = null, toastTimer, storageWarningShown = false;
const conversation = $('#conversation'), input = $('#messageInput');
const sendIcon = $('#sendButton').innerHTML;
const mobile = matchMedia('(max-width: 819px)');
const current = () => chats.get(activeChat);

function toast(message) {
  $('#toast').textContent = message; $('#toast').classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 2500);
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
  const latestAssistant = current().messages.filter(m => m.role === 'assistant').at(-1)?.id === message.id;
  const generating = ['sending','generating'].includes(message.status);
  const status = generating ? '<span class="generation-status">' + (message.status === 'sending' ? 'Sending…' : 'Generating…') + '</span>' :
    message.status === 'stopped' ? '<span class="generation-status">Stopped · partial response excluded from context</span>' : '';
  const error = message.error ? '<div class="error-note" role="alert">' + escapeHtml(message.error) + '</div>' : '';
  return '<div class="assistant-mark" aria-hidden="true">AI</div><div class="assistant-body"><div class="message-content">' +
    (message.content ? renderMarkdown(message.content) : generating ? '<div class="typing" aria-label="Generating"><i></i><i></i><i></i></div>' : '') +
    '</div>' + status + error + (message.notice ? '<p class="generation-status">' + escapeHtml(message.notice) + '</p>' : '') +
    '<div class="message-actions">' + action('copy', 'Copy', icons.copy, false, !message.content) +
    (latestAssistant ? action('regenerate', message.status === 'error' || message.status === 'stopped' ? 'Retry' : 'Regenerate', icons.redo, false, busy) : '') +
    action('like', 'Like', icons.like, message.feedback === 'like', generating) +
    action('dislike', 'Dislike', icons.dislike, message.feedback === 'dislike', generating) +
    '</div><span class="message-model">' + escapeHtml(modelName(message.model)) + '</span></div>';
}
function renderConversation(bottom = false) {
  const chat = current(), saved = conversation.scrollTop;
  conversation.innerHTML = '<div class="conversation-inner"><div class="chat-heading"><p class="eyebrow">' +
    escapeHtml(chat.demo ? 'Demo conversation · ' + modelName(chat.model) : chat.group + ' · ' + modelName(chat.model)) +
    '</p><h1>' + escapeHtml(chat.messages.length ? chat.title : 'What would you like to explore?') + '</h1></div><div class="messages"></div></div>';
  for (const message of chat.messages) {
    const article = document.createElement('article'); article.className = 'message ' + message.role;
    article.dataset.messageId = message.id; article.innerHTML = messageHtml(message);
    $('.messages').append(article);
  }
  conversation.scrollTop = bottom ? conversation.scrollHeight : saved;
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
  $('#modelMenu').innerHTML = MODELS.map(model => '<button class="model-option' + (id === model.id ? ' selected' : '') +
    '" role="option" aria-selected="' + (id === model.id) + '" data-model="' + model.id + '"><span><strong>' +
    model.name + '</strong><small>' + model.description + '</small></span><span>' + (id === model.id ? '✓' : '') + '</span></button>').join('');
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
  const chat = createChat(current().model); chats.set(chat.id, chat); $('#chatSearch').value = '';
  selectChat(chat.id); input.focus(); await persistChat(chat);
}
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('my-ai-chat-theme', theme); } catch {}
  $('#themeHint').textContent = theme === 'dark' ? 'Dark' : 'Light';
  $('#quickTheme').setAttribute('aria-label', 'Switch to ' + (theme === 'dark' ? 'light' : 'dark') + ' mode');
  $('meta[name="theme-color"]').content = theme === 'dark' ? '#0f1219' : '#f7f8fb';
  $$('[data-theme-choice]').forEach(b => b.classList.toggle('active', b.dataset.themeChoice === theme));
}
async function generate(chat, user) {
  if (generation) return;
  const assistant = createMessage('assistant', '', chat.model); assistant.status = 'sending';
  chat.messages.push(assistant);
  const job = { chatId: chat.id, messageId: assistant.id, abort: new AbortController() };
  generation = job; syncComposer(); renderConversation(true);
  let readerResponse;
  try {
    readerResponse = await fetch('/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: chat.model, messages: contextFor(chat, user.id) }),
      signal: job.abort.signal,
    });
    if (!readerResponse.ok) {
      const payload = await readerResponse.json().catch(() => null);
      throw new Error(payload?.error?.message || '服务器请求失败，请重试。');
    }
    await consumeStream(readerResponse, event => {
      if (job.abort.signal.aborted) return;
      if (event.type === 'start') assistant.status = 'generating';
      if (event.type === 'delta') { assistant.status = 'generating'; assistant.content += event.text; }
      if (event.type === 'error') { assistant.status = 'error'; assistant.error = event.message; }
      if (event.type === 'done') { assistant.status = 'complete'; assistant.notice = event.notice; }
      updateMessage(chat.id, assistant);
    }, job.abort.signal);
  } catch (error) {
    if (job.abort.signal.aborted) assistant.status = 'stopped';
    else { assistant.status = 'error'; assistant.error = error instanceof TypeError ? '网络连接失败，请检查网络后重试。' : error.message || '生成失败，请重试。'; }
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
  message.status = 'stopped'; updateMessage(chat.id, message); void persistChat(chat);
}
async function retry(messageId) {
  if (generation) return;
  const chat = current(), index = chat.messages.findIndex(m => m.id === messageId);
  if (index < 1 || chat.messages[index].role !== 'assistant' || index !== chat.messages.length - 1) return;
  const user = chat.messages[index - 1];
  chat.messages.splice(index);
  renderConversation(true); await persistChat(chat); void generate(chat, user);
}
$('#composerForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (generation || editingId || !input.value.trim()) return;
  const chat = current(), user = createMessage('user', input.value.trim());
  chat.messages.push(user);
  if (!chat.demo && chat.messages.length === 1) chat.title = user.content.slice(0, 45);
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
  if (!option || generation || !isAllowedModel(option.dataset.model)) return;
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
$('#settingsButton').addEventListener('click', () => { closeSidebar(); $('#settingsDialog').showModal(); });
$('#settingsDialog').addEventListener('close', () => { if (mobile.matches) $('#openSidebar').focus(); });
$('#quickTheme').addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
$$('[data-theme-choice]').forEach(button => button.addEventListener('click', () => setTheme(button.dataset.themeChoice)));
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
  const codeCopy = event.target.closest('[data-code-copy]');
  if (codeCopy) { void copy($('code', codeCopy.closest('.code-block')).textContent); return; }
  const button = event.target.closest('[data-action]');
  const article = button?.closest('[data-message-id]');
  if (!article) return;
  const chat = current(), message = chat.messages.find(m => m.id === article.dataset.messageId);
  if (!message) return;
  switch (button.dataset.action) {
    case 'copy': void copy(message.content); break;
    case 'like': case 'dislike':
      message.feedback = message.feedback === button.dataset.action ? null : button.dataset.action;
      updateMessage(chat.id, message); void persistChat(chat); break;
    case 'regenerate': void retry(message.id); break;
    case 'edit':
      if (generation) return;
      editingId = message.id; syncComposer(); renderConversation(); $('textarea', $('[data-message-id="' + message.id + '"]'))?.focus(); break;
    case 'edit-cancel': editingId = null; syncComposer(); renderConversation(); break;
    case 'edit-save': {
      if (generation) return;
      const value = $('textarea', article).value.trim(); if (!value) return;
      const index = chat.messages.findIndex(m => m.id === message.id);
      message.content = value; message.updatedAt = new Date().toISOString();
      chat.messages.splice(index + 1); editingId = null; renderConversation(true);
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
async function initializeApp() {
  let initialChats;
  try { initialChats = await loadOrSeedChats(createDemoChats); }
  catch {
    storageWarningShown = true;
    initialChats = createDemoChats();
    setTimeout(() => toast('Local storage is unavailable. This session will remain in memory only.'), 0);
  }
  for (const chat of initialChats) chats.set(chat.id, chat);
  let savedActiveChat;
  try { savedActiveChat = localStorage.getItem(ACTIVE_CHAT_STORAGE_KEY); } catch {}
  activeChat = savedActiveChat && chats.has(savedActiveChat) ? savedActiveChat : chats.keys().next().value;
  rememberActiveChat(activeChat);
  let theme = 'dark'; try { theme = localStorage.getItem('my-ai-chat-theme') === 'light' ? 'light' : 'dark'; } catch {}
  setTheme(theme); closeSidebar(); syncModel(); renderHistory(); renderConversation(); syncComposer();
}

await initializeApp();
