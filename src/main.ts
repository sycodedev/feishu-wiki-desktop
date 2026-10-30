import { app, BrowserWindow, WebContentsView, session, ipcMain, shell, dialog, Menu, clipboard } from 'electron';
import type { Session, WebPreferences, IpcMainInvokeEvent, BrowserWindowConstructorOptions } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { destination, normalizeInput, WIKI_HOME } from './navigation.js';
import type { TabState, DesktopState } from './shared.js';
import { i18n } from './i18n/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const smoke = !app.isPackaged && process.argv.includes('--prototype-smoke');
const probe = process.argv.includes('--prototype-probe') && Boolean(process.env.WIKI_PROBE_RESULT && process.env.WIKI_PROFILE_PATH);
if (smoke) {
  const recordFailure = (error: unknown): void => {
    if (process.env.WIKI_SMOKE_RESULT) writeFileSync(process.env.WIKI_SMOKE_RESULT,
      JSON.stringify({ passed: false, stage: 'startup', error: error instanceof Error ? error.stack : String(error) }, null, 2));
    app.exit(1);
  };
  process.on('uncaughtException', recordFailure);
  process.on('unhandledRejection', recordFailure);
}
app.setName('FeishuWiki');
const profile = path.resolve(process.env.WIKI_PROFILE_PATH ||
  (app.isPackaged ? app.getPath('userData') : path.join(here, '../profile')));
mkdirSync(profile, { recursive: true });
mkdirSync(path.join(profile, 'chromium'), { recursive: true });
mkdirSync(path.join(profile, 'crashes'), { recursive: true });
app.setPath('userData', profile);
app.setPath('sessionData', path.join(profile, 'chromium'));
app.setPath('crashDumps', path.join(profile, 'crashes'));
app.setAppLogsPath(path.join(profile, 'logs'));

interface Tab extends TabState { view: WebContentsView | null; }
let win: BrowserWindow;
let wikiSession: Session;
let tabs: Tab[] = [];
let nextId = 1;
let activeId = 0;
let online = true;
let busy = false;
let closeConfirmed = false;
let notice = '';
let download = '';
let bounds = { x: 0, y: 74, width: 1200, height: 600 };
const shellFile = path.join(here, 'ui/index.html');
const shellUrl = pathToFileURL(shellFile).href;

function state(): DesktopState {
  const active = tabs.find(tab => tab.id === activeId);
  const history = active?.view?.webContents.navigationHistory;
  return {
    tabs: tabs.map(({ view: _view, ...tab }) => tab), activeId,
    canGoBack: history?.canGoBack() ?? false,
    canGoForward: history?.canGoForward() ?? false,
    online, busy, notice, download,
  };
}

function publish(): void {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('desktop:state', state());
}

function layout(): void {
  if (!win || win.isDestroyed()) return;
  const { width, height } = win.getContentBounds();
  for (const tab of tabs) {
    if (!tab.view || tab.view.webContents.isDestroyed()) continue;
    tab.view.setBounds({
      x: Math.min(bounds.x, width), y: Math.min(bounds.y, height),
      width: Math.max(0, Math.min(bounds.width, width - bounds.x)),
      height: Math.max(0, Math.min(bounds.height, height - bounds.y)),
    });
    tab.view.setVisible(tab.id === activeId && !tab.error);
  }
}

function activate(id: number): void {
  const tab = tabs.find(candidate => candidate.id === id);
  if (!tab) return;
  activeId = id;
  layout(); publish();
  if (tab.view && !tab.error) tab.view.webContents.focus();
}

async function openExternal(url: string): Promise<void> {
  // Only parsed HTTP(S) destinations reach the OS; never pass an arbitrary protocol.
  const parsed = new URL(url);
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) return;
  try { await shell.openExternal(parsed.href); notice = i18n.nav.openExternalNotice; }
  catch { notice = i18n.nav.openExternalError; }
  publish();
}

function securePreferences(inherited: WebPreferences = {}): WebPreferences {
  const preferences = { ...inherited };
  delete preferences.preload;
  return {
    ...preferences, session: wikiSession, nodeIntegration: false,
    nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
    contextIsolation: true, sandbox: true, webSecurity: true,
    allowRunningInsecureContent: false, webviewTag: false, spellcheck: false,
  };
}

function update(tab: Tab): void {
  if (!tab.view || tab.view.webContents.isDestroyed()) return;
  const wc = tab.view.webContents;
  tab.url = wc.getURL() || tab.url;
  publish();
}

function createPage(url: string, inherited?: BrowserWindowConstructorOptions, deferLoad = false, background = false): Tab {
  const tab: Tab = {
    id: nextId++, kind: 'page', title: i18n.tabs.loading, url,
    loading: true, error: null,
    // Keep Electron's entire constructor object: it carries the native popup WebContents.
    view: new WebContentsView({ ...inherited, webPreferences: securePreferences(inherited?.webPreferences) }),
  };
  tabs.push(tab);
  const view = tab.view!;
  const wc = view.webContents;
  win.contentView.addChildView(view);
  const guard = (event: Electron.Event, nextUrl: string): void => {
    const target = destination(nextUrl, wc.getURL() || tab.url);
    if (target.kind === 'internal') return;
    event.preventDefault();
    if (target.kind === 'external') void openExternal(target.url);
    else { notice = target.message; publish(); }
  };
  wc.on('will-navigate', (event, nextUrl) => guard(event, nextUrl));
  wc.on('will-redirect', (event, nextUrl, _inPage, mainFrame) => { if (mainFrame) guard(event, nextUrl); });
  wc.on('did-start-loading', () => { tab.loading = true; tab.error = null; layout(); publish(); });
  wc.on('did-stop-loading', () => { tab.loading = false; update(tab); });
  wc.on('did-navigate', () => { tab.error = null; update(tab); layout(); });
  wc.on('did-navigate-in-page', () => {
    const next = wc.getURL();
    const target = destination(next, tab.url);
    if (target.kind !== 'internal') {
      // SPA history changes cannot be cancelled. Hide the page and return to a known safe entry.
      view.setVisible(false);
      if (target.kind === 'external') void openExternal(target.url);
      void wc.loadURL(WIKI_HOME).catch(() => undefined);
    } else update(tab);
  });
  wc.on('page-title-updated', (_event, title) => { tab.title = title.slice(0, 160) || i18n.tabs.defaultDoc; publish(); });
  wc.on('did-fail-load', (_event, code, _description, _url, mainFrame) => {
    if (!mainFrame || code === -3) return;
    tab.error = i18n.error.loadFailed;
    tab.loading = false; layout(); publish();
  });
  wc.on('render-process-gone', () => {
    tab.error = i18n.error.renderCrash;
    tab.loading = false; layout(); publish();
  });
  wc.setWindowOpenHandler(details => {
    const target = destination(details.url, wc.getURL() || tab.url);
    if (target.kind === 'external') { void openExternal(target.url); return { action: 'deny' }; }
    if (target.kind === 'blocked') { notice = target.message; publish(); return { action: 'deny' }; }
    return {
      action: 'allow',
      overrideBrowserWindowOptions: { webPreferences: securePreferences() },
      createWindow: options => {
        // Native creation retains POST bodies and window.opener for official flows.
        const child = createPage(details.url, options, true, details.disposition === 'background-tab');
        return child.view!.webContents;
      },
    };
  });
  wc.on('context-menu', (_event, params) => {
    const template: Electron.MenuItemConstructorOptions[] = [];
    if (params.linkURL) {
      const target = destination(params.linkURL, wc.getURL());
      if (target.kind === 'internal') template.push({ label: '在新标签页打开', click: () => { createPage(target.url); } });
      if (target.kind !== 'blocked') template.push({ label: '复制链接', click: () => clipboard.writeText(params.linkURL) });
      template.push({ type: 'separator' });
    }
    template.push({ role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' });
    Menu.buildFromTemplate(template).popup({ window: win });
  });
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !(input.control || input.meta)) return;
    if (shortcut(input.key.toLowerCase(), input.shift)) event.preventDefault();
  });
  wc.on('destroyed', () => {
    if (!tabs.some(candidate => candidate.id === tab.id)) return;
    if (!win.isDestroyed()) win.contentView.removeChildView(view);
    tabs = tabs.filter(candidate => candidate.id !== tab.id);
    if (activeId === tab.id) activeId = tabs.at(-1)?.id ?? 0;
    layout(); publish();
  });
  if (!background) activate(tab.id); else { layout(); publish(); }
  if (!deferLoad) void wc.loadURL(url).catch(() => undefined);
  return tab;
}

function createHome(): void {
  tabs.push({ id: nextId++, kind: 'home', title: i18n.tabs.homeTitle, url: '', loading: false, error: null, view: null });
  activate(tabs.at(-1)!.id);
}

function trustedSender(event: IpcMainInvokeEvent): void {
  if (event.sender !== win.webContents || event.senderFrame?.url !== shellUrl) throw new Error('Untrusted IPC sender');
}

async function closeTab(id: number, replenish = true): Promise<boolean> {
  const tab = tabs.find(candidate => candidate.id === id);
  if (!tab) return true;
  const wc = tab.view?.webContents;
  if (wc && !wc.isDestroyed()) {
    const closed = await new Promise<boolean>(resolve => {
      const done = () => { wc.removeListener('will-prevent-unload', beforeUnload); resolve(true); };
      const beforeUnload = (event: Electron.Event) => {
        const leave = dialog.showMessageBoxSync(win, {
          type: 'question', title: i18n.dialog.leaveTitle,
          message: i18n.dialog.leaveMessage,
          buttons: [i18n.dialog.leaveStay, i18n.dialog.leaveLeave], defaultId: 0, cancelId: 0,
        });
        if (leave === 1) event.preventDefault();
        else { wc.removeListener('destroyed', done); resolve(false); }
      };
      wc.once('destroyed', done);
      wc.once('will-prevent-unload', beforeUnload);
      wc.close({ waitForBeforeUnload: true });
    });
    if (!closed) return false;
  }
  tabs = tabs.filter(candidate => candidate.id !== id);
  if (!tabs.length && replenish) createHome();
  else if (!tabs.some(candidate => candidate.id === activeId)) activate(tabs.at(-1)?.id ?? 0);
  layout(); publish();
  return true;
}

async function closeAll(): Promise<boolean> {
  for (const tab of [...tabs]) if (!await closeTab(tab.id, false)) return false;
  return true;
}

async function clearLogin(): Promise<void> {
  if (!await closeAll()) { notice = i18n.dialog.logoutCancelled; return; }
  await wikiSession.closeAllConnections();
  await wikiSession.clearData();
  await wikiSession.clearAuthCache();
  notice = i18n.dialog.logoutSuccess;
  createHome();
}

async function logout(): Promise<void> {
  const result = await dialog.showMessageBox(win, {
    type: 'question', title: i18n.dialog.logoutTitle,
    message: i18n.dialog.logoutMessage,
    detail: i18n.dialog.logoutDetail,
    buttons: [i18n.dialog.logoutCancel, i18n.dialog.logoutConfirm], defaultId: 0, cancelId: 0,
  });
  if (result.response !== 1) return;
  busy = true; publish();
  try { await clearLogin(); }
  catch { notice = i18n.dialog.logoutFailed; }
  finally { busy = false; publish(); }
}

function shortcut(key: string, shift = false): boolean {
  if (busy) return false;
  if (key === 't') { createHome(); return true; }
  if (key === 'w') { void closeTab(activeId); return true; }
  if (key === 'l') { win.webContents.focus(); win.webContents.send('desktop:focus-address'); return true; }
  if (key === 'r') { tabs.find(tab => tab.id === activeId)?.view?.webContents.reload(); return true; }
  if (key === 'tab') {
    const index = tabs.findIndex(tab => tab.id === activeId);
    const next = tabs[(index + (shift ? -1 : 1) + tabs.length) % tabs.length];
    if (next) activate(next.id);
    return true;
  }
  return false;
}

async function action(value: unknown): Promise<void> {
  if (!value || typeof value !== 'object' || !('type' in value) || typeof value.type !== 'string') return;
  const active = tabs.find(tab => tab.id === activeId);
  const wc = active?.view?.webContents;
  if (busy && value.type !== 'layout' && value.type !== 'online') return;
  switch (value.type) {
    case 'new-tab': createHome(); break;
    case 'wiki-home': createPage(WIKI_HOME); break;
    case 'activate': if ('id' in value && typeof value.id === 'number') activate(value.id); break;
    case 'close-tab': if ('id' in value && typeof value.id === 'number') await closeTab(value.id); break;
    case 'open': {
      if (!('url' in value) || typeof value.url !== 'string' || value.url.length > 16384) return;
      const target = destination(normalizeInput(value.url));
      if (target.kind === 'blocked') notice = target.message;
      else if (target.kind === 'external') await openExternal(target.url);
      else createPage(target.url);
      break;
    }
    case 'back': if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); break;
    case 'forward': if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward(); break;
    case 'reload':
      if (wc && active) {
        active.error = null; layout();
        if (wc.getURL()) wc.reload(); else void wc.loadURL(active.url).catch(() => undefined);
      }
      break;
    case 'copy-link': if (active?.url) { clipboard.writeText(active.url); notice = i18n.nav.copySuccess; } break;
    case 'open-browser': if (active?.url && destination(active.url).kind !== 'blocked') await openExternal(active.url); break;
    case 'logout': await logout(); break;
    case 'online': if ('value' in value && typeof value.value === 'boolean') online = value.value; break;
    case 'layout': {
      const finite = (number: unknown): number is number => typeof number === 'number' && Number.isFinite(number);
      if ('x' in value && 'y' in value && 'width' in value && 'height' in value &&
          finite(value.x) && finite(value.y) && finite(value.width) && finite(value.height)) {
        bounds = { x: Math.max(0, Math.round(value.x)), y: Math.max(50, Math.round(value.y)), width: Math.max(0, Math.round(value.width)), height: Math.max(0, Math.round(value.height)) };
        layout();
      }
      return;
    }
  }
  publish();
}

function configureSession(): void {
  wikiSession = session.fromPartition('persist:wiki-official');
  wikiSession.setPermissionCheckHandler((_contents, permission, origin) => {
    return permission === 'clipboard-sanitized-write' && destination(origin + '/wiki/').kind === 'internal';
  });
  wikiSession.setPermissionRequestHandler((contents, permission, callback) => {
    const trusted = contents && destination(contents.getURL()).kind === 'internal';
    if (!trusted) { callback(false); return; }
    if (permission === 'clipboard-sanitized-write') { callback(true); return; }
    if (permission === 'clipboard-read') {
      void dialog.showMessageBox(win, {
        type: 'question', title: i18n.dialog.clipboardPermissionTitle, message: i18n.dialog.clipboardPermissionMessage,
        buttons: [i18n.dialog.clipboardPermissionDeny, i18n.dialog.clipboardPermissionAllow], defaultId: 0, cancelId: 0,
      }).then(result => callback(result.response === 1)).catch(() => callback(false));
    } else { callback(false); notice = i18n.dialog.devicePermissionNotice; publish(); }
  });
  wikiSession.on('will-download', (_event, item) => {
    item.setSaveDialogOptions({ title: i18n.download.saveDialogTitle });
    const name = item.getFilename().slice(0, 80);
    download = `${i18n.download.preparing} · ${name}`; publish();
    item.on('updated', (_updateEvent, status) => {
      const total = item.getTotalBytes();
      const progress = total ? `${Math.round(item.getReceivedBytes() / total * 100)}%` : i18n.download.downloading;
      download = status === 'interrupted' ? `${i18n.download.interrupted} · ${name}` : `${progress} · ${name}`; publish();
    });
    item.once('done', (_doneEvent, status) => {
      download = `${status === 'completed' ? i18n.download.completed : status === 'cancelled' ? i18n.download.cancelled : i18n.download.incomplete} · ${name}`; publish();
    });
  });
}

async function start(): Promise<void> {
  configureSession();
  win = new BrowserWindow({
    width: 1380, height: 920, minWidth: 1000, minHeight: 680,
    title: i18n.app.name, backgroundColor: '#f8f9fa',
    show: !smoke, titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#f8f9fa', symbolColor: '#2b382e', height: 38 },
    webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  Menu.setApplicationMenu(null);
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  ipcMain.handle('desktop:state', event => { trustedSender(event); return state(); });
  ipcMain.handle('desktop:action', async (event, value: unknown) => {
    if (closeConfirmed || win.isDestroyed() || event.sender.isDestroyed()) return;
    trustedSender(event); await action(value);
  });
  win.on('resize', layout);
  win.on('close', event => {
    if (closeConfirmed) return;
    event.preventDefault();
    if (busy) return;
    busy = true; publish();
    void closeAll().then(async closed => {
      busy = false;
      if (closed) {
        try {
          await wikiSession.cookies.flushStore();
          wikiSession.flushStorageData();
          closeConfirmed = true;
          win.close();
        } catch {
          notice = i18n.dialog.closeSessionFlushing;
          if (!tabs.length) createHome();
          publish();
        }
      }
      else { if (!tabs.length) createHome(); publish(); }
    });
  });
  await win.loadFile(shellFile);
  createHome();
  if (process.argv.includes('--open-wiki')) createPage(WIKI_HOME);
  if (probe) {
    const { observeLoginPage } = await import('./probe.js');
    try {
      const result = await observeLoginPage(win, () => createPage(WIKI_HOME).view!.webContents);
      writeFileSync(process.env.WIKI_PROBE_RESULT!, JSON.stringify(result, null, 2));
    } catch (error) {
      writeFileSync(process.env.WIKI_PROBE_RESULT!, JSON.stringify({ loginPageObserved: false, error: error instanceof Error ? error.message : String(error) }, null, 2));
    }
    closeConfirmed = true; app.quit();
  }
  if (smoke) {
    const { runSmoke } = await import('./smoke.js');
    try {
      const result = await runSmoke({ win, wikiSession, state, action, createPage, closeTab, clearLogin, getContents: id => tabs.find(tab => tab.id === id)?.view?.webContents });
      writeFileSync(process.env.WIKI_SMOKE_RESULT!, JSON.stringify(result, null, 2));
      closeConfirmed = true; app.quit();
    } catch (error) {
      writeFileSync(process.env.WIKI_SMOKE_RESULT!, JSON.stringify({ passed: false, error: error instanceof Error ? error.message : String(error) }, null, 2));
      closeConfirmed = true; app.exit(1);
    }
  }
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { win.restore(); win.focus(); } });
  app.whenReady().then(start).catch(() => { console.error('Prototype startup failed.'); app.exit(1); });
  app.on('window-all-closed', () => app.quit());
}
