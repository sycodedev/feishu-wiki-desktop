import type { DesktopBridge, DesktopState, Action } from './shared.js';
import { i18n } from './i18n/index.js';

declare global { interface Window { wikiDesktop: DesktopBridge; } }
const api = window.wikiDesktop;

const element = <T extends HTMLElement>(id: string): T => {
  const result = document.getElementById(id);
  if (!result) throw new Error(`Missing element: ${id}`);
  return result as T;
};

let latest: DesktopState | null = null;
const address = element<HTMLInputElement>('address');
const viewport = element<HTMLElement>('viewport');
const loadingBar = element<HTMLElement>('loading-bar');
const clipboardCard = element<HTMLElement>('clipboard-card');
const clipboardUrl = element<HTMLElement>('clipboard-url');

const perform = (action: Action): void => {
  void api.perform(action).catch(() => {
    element('notice').hidden = false;
    element('notice').textContent = i18n.error.actionFailed;
  });
};

const button = (id: string, action: Action): void => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('click', () => perform(action));
};

button('new-tab', { type: 'new-tab' });
button('back', { type: 'back' });
button('forward', { type: 'forward' });
button('reload', { type: 'reload' });
button('retry', { type: 'reload' });
button('home', { type: 'wiki-home' });
button('enter-wiki', { type: 'wiki-home' });
button('open-browser', { type: 'open-browser' });
button('error-browser', { type: 'open-browser' });
button('copy-link-btn', { type: 'copy-link' });
button('logout', { type: 'logout' });

element('address-form').addEventListener('submit', event => {
  event.preventDefault();
  if (address.value.trim()) perform({ type: 'open', url: address.value });
});

function reportLayout(): void {
  const rect = viewport.getBoundingClientRect();
  perform({ type: 'layout', x: rect.x, y: rect.y, width: rect.width, height: rect.height });
}
new ResizeObserver(reportLayout).observe(viewport);

/* Smart Clipboard Detector */
let lastDetectedUrl = '';
async function checkClipboard(): Promise<void> {
  if (latest && latest.tabs.find(t => t.id === latest?.activeId)?.kind !== 'home') return;
  try {
    const text = (await navigator.clipboard.readText()).trim();
    if (!text || text === lastDetectedUrl) return;
    const isFeishuDoc = /^https:\/\/[a-zA-Z0-9.-]+\.feishu\.cn\/(?:wiki|docx?|docs|sheets?|base|bitable|file|drive)\//i.test(text);
    if (isFeishuDoc) {
      lastDetectedUrl = text;
      clipboardUrl.textContent = text;
      clipboardCard.hidden = false;
    }
  } catch {
    // Clipboard permission not granted or unsupported; silently ignore.
  }
}

const clipboardOpen = document.getElementById('clipboard-open');
if (clipboardOpen) {
  clipboardOpen.addEventListener('click', () => {
    if (lastDetectedUrl) {
      perform({ type: 'open', url: lastDetectedUrl });
      clipboardCard.hidden = true;
    }
  });
}
const clipboardDismiss = document.getElementById('clipboard-dismiss');
if (clipboardDismiss) {
  clipboardDismiss.addEventListener('click', () => {
    clipboardCard.hidden = true;
  });
}

function render(state: DesktopState): void {
  const previousId = latest?.activeId;
  latest = state;
  const active = state.tabs.find(tab => tab.id === state.activeId);
  const list = element('tabs');
  list.replaceChildren();

  for (const tab of state.tabs) {
    const container = document.createElement('div');
    container.className = `tab${tab.id === state.activeId ? ' active' : ''}${tab.loading ? ' loading' : ''}`;
    container.setAttribute('role', 'tab');
    container.setAttribute('aria-selected', String(tab.id === state.activeId));
    container.tabIndex = tab.id === state.activeId ? 0 : -1;
    container.title = tab.title;

    const dot = document.createElement('span');
    dot.className = 'tab-dot';
    dot.setAttribute('aria-hidden', 'true');

    const title = document.createElement('span');
    title.className = 'tab-label';
    title.textContent = tab.title;

    const close = document.createElement('button');
    close.className = 'tab-close';
    close.textContent = '×';
    close.title = i18n.nav.closeTab;
    close.setAttribute('aria-label', `${i18n.nav.closeTab}: ${tab.title}`);
    close.disabled = state.busy;
    close.addEventListener('click', event => {
      event.stopPropagation();
      perform({ type: 'close-tab', id: tab.id });
    });

    container.addEventListener('click', () => {
      if (!state.busy) perform({ type: 'activate', id: tab.id });
    });
    container.addEventListener('keydown', event => {
      if (event.key === 'Enter') perform({ type: 'activate', id: tab.id });
    });

    container.append(dot, title, close);
    list.append(container);
  }

  if (document.activeElement !== address || previousId !== state.activeId) {
    address.value = active?.url ?? '';
  }

  // Micro-loading bar indication
  loadingBar.hidden = !active?.loading;

  element<HTMLButtonElement>('back').disabled = !state.canGoBack || state.busy;
  element<HTMLButtonElement>('forward').disabled = !state.canGoForward || state.busy;

  for (const id of ['reload', 'open-browser', 'copy-link-btn']) {
    const el = document.getElementById(id) as HTMLButtonElement | null;
    if (el) el.disabled = active?.kind !== 'page' || state.busy;
  }

  element<HTMLButtonElement>('new-tab').disabled = state.busy;
  element<HTMLButtonElement>('logout').disabled = state.busy;

  element('welcome').hidden = active?.kind !== 'home';
  if (active?.kind === 'home') void checkClipboard();

  element('page-error').hidden = !active?.error;
  element('error-message').textContent = active?.error ?? '';

  element('notice').hidden = !state.notice;
  element('notice').textContent = state.notice;

  element('offline').hidden = state.online;
  element('connection-text').textContent = state.online ? i18n.status.online : i18n.status.offline;
  element('connection-dot').classList.toggle('offline-dot', !state.online);
  element('download').textContent = state.download || i18n.status.secureConnection;

  reportLayout();
}

api.onState(render);
api.onFocusAddress(() => { address.focus(); address.select(); });
void api.getState().then(render);

const reportOnline = () => perform({ type: 'online', value: navigator.onLine });
window.addEventListener('online', reportOnline);
window.addEventListener('offline', reportOnline);
window.addEventListener('focus', () => void checkClipboard());
reportOnline();

document.addEventListener('keydown', event => {
  if (!event.ctrlKey && !event.metaKey) return;
  const key = event.key.toLowerCase();
  if (key === 't') { event.preventDefault(); perform({ type: 'new-tab' }); }
  if (key === 'w' && latest) { event.preventDefault(); perform({ type: 'close-tab', id: latest.activeId }); }
  if (key === 'l') { event.preventDefault(); address.focus(); address.select(); }
  if (key === 'r') { event.preventDefault(); perform({ type: 'reload' }); }
  if (key === 'tab' && latest?.tabs.length) {
    event.preventDefault();
    const index = latest.tabs.findIndex(tab => tab.id === latest!.activeId);
    const tab = latest.tabs[(index + (event.shiftKey ? -1 : 1) + latest.tabs.length) % latest.tabs.length];
    if (tab) perform({ type: 'activate', id: tab.id });
  }
});
