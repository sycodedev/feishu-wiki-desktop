import assert from 'node:assert/strict';
import { once } from 'node:events';
import os from 'node:os';
import type { BrowserWindow, Session, WebContents, WebContentsView } from 'electron';
import { destination, normalizeInput } from './navigation.js';
import type { DesktopState } from './shared.js';

interface Context {
  win: BrowserWindow;
  wikiSession: Session;
  state(): DesktopState;
  action(value: unknown): Promise<void>;
  createPage(url: string): { id: number; view: WebContentsView | null };
  closeTab(id: number): Promise<boolean>;
  clearLogin(): Promise<void>;
  getContents(id: number): WebContents | undefined;
}

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, label: string): Promise<void> {
  for (let count = 0; count < 100; count++) { if (check()) return; await pause(100); }
  throw new Error(`Timed out: ${label}`);
}

export async function runSmoke(ctx: Context): Promise<unknown> {
  const checks: string[] = [];
  const phase = process.env.WIKI_SMOKE_PHASE ?? 'seed';
  // This response handler is installed only for an explicitly isolated smoke profile.
  // It serves synthetic pages without contacting or impersonating a live Feishu account.
  await ctx.wikiSession.protocol.handle('https', async request => {
    const payload = request.method === 'POST' ? await request.text() : '';
    return new Response(`<!doctype html><meta charset="utf-8"><title>本地兼容性测试页</title>
      <body><input id="editor" value="本地测试内容"><form method="POST" action="https://smoke.feishu.cn/docx/post" target="_blank"><input name="sample" value="synthetic"><button id="post">POST popup</button></form>
      <script>window.fixtureMethod=${JSON.stringify(request.method)};window.fixturePayload=${JSON.stringify(payload)};</script></body>`,
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  });
  if (phase === 'seed') await ctx.wikiSession.clearData();

  const cases: [string, 'internal' | 'external' | 'blocked'][] = [
    ['https://www.feishu.cn/wiki/', 'internal'],
    ['https://sample.feishu.cn/docx/test', 'internal'],
    ['https://sample.feishu.cn/sheets/test', 'internal'],
    ['https://sample.feishu.cn/base/test', 'internal'],
    ['https://accounts.feishu.cn/accounts/page/login', 'internal'],
    ['https://sample.feishu.cn/messenger/', 'external'],
    ['https://sample.feishu.cn/video/', 'external'],
    ['https://feishu.cn.attacker.invalid/wiki/test', 'external'],
    ['https://sample.feishu.cn:8443/wiki/test', 'blocked'],
    ['https://user:password@sample.feishu.cn/wiki/test', 'blocked'],
    ['javascript:alert(1)', 'blocked'], ['file:///C:/Windows/win.ini', 'blocked'],
    ['feishu://open', 'blocked'], ['http://sample.feishu.cn/wiki/test', 'blocked'],
    ['about:blank', 'blocked'],
  ];
  for (const [url, kind] of cases) assert.equal(destination(url).kind, kind, url);
  assert.equal(destination('about:blank', 'https://sample.feishu.cn/wiki/test').kind, 'internal');
  assert.equal(destination('blob:https://sample.feishu.cn/abc', 'https://sample.feishu.cn/wiki/test').kind, 'internal');
  assert.equal(destination('blob:https://other.feishu.cn/abc', 'https://sample.feishu.cn/wiki/test').kind, 'blocked');
  assert.equal(normalizeInput('sample.feishu.cn/wiki/test'), 'https://sample.feishu.cn/wiki/test');
  checks.push('Navigation routes, origin boundaries, unsupported protocols, popup and blob policy');

  const local = await ctx.win.webContents.executeJavaScript('({ bridge: typeof window.wikiDesktop, node: typeof window.require, title: document.title })') as { bridge: string; node: string; title: string };
  assert.equal(local.bridge, 'object'); assert.equal(local.node, 'undefined');
  checks.push('Sandboxed local shell loads with a narrow preload bridge');

  const first = ctx.createPage('https://smoke.feishu.cn/wiki/fixture');
  const wc = first.view!.webContents;
  await once(wc, 'did-finish-load');
  const remote = await wc.executeJavaScript('({ node: typeof window.require, bridge: typeof window.wikiDesktop })') as { node: string; bridge: string };
  assert.equal(remote.node, 'undefined'); assert.equal(remote.bridge, 'undefined');
  checks.push('Remote pages have no Node.js or desktop IPC bridge');

  if (phase === 'seed') {
    await ctx.wikiSession.cookies.set({ url: 'https://smoke.feishu.cn/', name: 'prototype-session', value: 'synthetic', secure: true, httpOnly: true, expirationDate: Date.now() / 1000 + 3600 });
    await ctx.wikiSession.cookies.set({ url: 'https://smoke.feishu.cn/', name: 'prototype-session-only', value: 'synthetic', secure: true, httpOnly: true });
    await wc.executeJavaScript('localStorage.setItem("prototype-session", "synthetic")');
    await ctx.wikiSession.cookies.flushStore();
    ctx.wikiSession.flushStorageData();
    checks.push('Synthetic persistent session seeded; next process checks restart behavior');
  } else {
    assert.equal((await ctx.wikiSession.cookies.get({ name: 'prototype-session' })).length, 1);
    assert.equal((await ctx.wikiSession.cookies.get({ name: 'prototype-session-only' })).length, 0, 'Electron discards session-only cookies on restart; persist partition alone cannot remember these');
    checks.push('Session-only cookies are discarded on restart; remembered official login still requires manual validation');
    assert.equal(await wc.executeJavaScript('localStorage.getItem("prototype-session")'), 'synthetic');
    checks.push('Cookies and local storage survive a real process restart');
  }

  const countBeforePopup = ctx.state().tabs.length;
  await wc.executeJavaScript('Boolean(window.open("https://smoke.feishu.cn/docx/popup"))');
  await until(() => ctx.state().tabs.length === countBeforePopup + 1, 'native popup tab');
  let popup = ctx.state().tabs.at(-1)!;
  await until(() => !ctx.state().tabs.find(tab => tab.id === popup.id)?.loading, 'popup load');
  assert.equal(await ctx.getContents(popup.id)!.executeJavaScript('Boolean(window.opener)'), true);
  assert.equal(await ctx.getContents(popup.id)!.executeJavaScript('localStorage.getItem("prototype-session")'), 'synthetic');
  checks.push('Native popup uses a tab, preserves opener and shares the same session');

  const countBeforePost = ctx.state().tabs.length;
  await wc.executeJavaScript('document.getElementById("post").click()');
  await until(() => ctx.state().tabs.length === countBeforePost + 1, 'POST popup');
  popup = ctx.state().tabs.at(-1)!;
  await until(() => !ctx.state().tabs.find(tab => tab.id === popup.id)?.loading, 'POST load');
  assert.equal(await ctx.getContents(popup.id)!.executeJavaScript('window.fixtureMethod'), 'POST');
  assert.equal(await ctx.getContents(popup.id)!.executeJavaScript('window.fixturePayload'), 'sample=synthetic');
  checks.push('POST-to-new-window payload survives tab adoption');

  const countBeforeSelfClose = ctx.state().tabs.length;
  const viewsBeforeSelfClose = ctx.win.contentView.children.length;
  await wc.executeJavaScript('Boolean(window.open("https://smoke.feishu.cn/docx/self-close"))');
  await until(() => ctx.state().tabs.length === countBeforeSelfClose + 1, 'self-closing popup tab');
  const selfClosing = ctx.state().tabs.at(-1)!;
  await until(() => !ctx.state().tabs.find(tab => tab.id === selfClosing.id)?.loading, 'self-closing popup load');
  await ctx.getContents(selfClosing.id)!.executeJavaScript('window.close()').catch(() => undefined);
  await until(() => ctx.state().tabs.length === countBeforeSelfClose, 'native popup closure');
  assert.equal(ctx.win.contentView.children.length, viewsBeforeSelfClose);
  checks.push('A popup closing itself releases both its tab and native view');

  await ctx.action({ type: 'activate', id: first.id });
  assert.equal(ctx.state().activeId, first.id);
  const countBeforeClose = ctx.state().tabs.length;
  assert.equal(await ctx.closeTab(popup.id), true);
  assert.equal(ctx.state().tabs.length, countBeforeClose - 1);
  checks.push('Tab switching and page closure release the corresponding renderer');

  await ctx.action({ type: 'online', value: false });
  await until(() => !ctx.state().online, 'offline state');
  await ctx.action({ type: 'online', value: true });
  await ctx.action({ type: 'open', url: 'javascript:alert(1)' });
  assert.match(ctx.state().notice, /仅打开网页/);
  checks.push('Offline signal and blocked input are reflected without reporting save success');

  if (phase !== 'seed') {
    await ctx.clearLogin();
    assert.equal((await ctx.wikiSession.cookies.get({ name: 'prototype-session' })).length, 0);
    assert.equal(ctx.state().tabs.every(tab => tab.kind === 'home'), true);
    const after = ctx.createPage('https://smoke.feishu.cn/wiki/after-logout');
    await once(after.view!.webContents, 'did-finish-load');
    assert.equal(await after.view!.webContents.executeJavaScript('localStorage.getItem("prototype-session")'), null);
    checks.push('Logout destroys all old pages and clears synthetic cookies and local storage');
  }
  return { passed: true, phase, environment: { electron: process.versions.electron, chromium: process.versions.chrome, os: os.release(), arch: process.arch }, checks,
    limitation: 'Synthetic offline fixtures only. Real Feishu login, editing, uploads, downloads and content consistency are NOT validated.' };
}
