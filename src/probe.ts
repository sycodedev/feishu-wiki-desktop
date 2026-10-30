import { app } from 'electron';
import type { BrowserWindow, WebContents } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

interface Observation {
  host: string;
  hasLogin: boolean;
  hasAlternativeLogin: boolean;
  node: string;
  bridge: string;
}

export async function observeLoginPage(win: BrowserWindow, openWiki: () => WebContents): Promise<unknown> {
  await new Promise(resolve => setTimeout(resolve, 500));
  const screenshot = process.env.WIKI_CAPTURE_PATH;
  if (screenshot) {
    mkdirSync(path.dirname(screenshot), { recursive: true });
    writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG());
  }
  const page = openWiki();
  const deadline = Date.now() + 15000;
  let last: Observation | null = null;
  while (Date.now() < deadline) {
    try {
      last = await Promise.race([
        page.executeJavaScript(`({host:location.hostname,hasLogin:/登录|log in/i.test(document.body?.innerText||''),hasAlternativeLogin:/手机号|邮箱|phone|email/i.test(document.body?.innerText||''),node:typeof window.require,bridge:typeof window.wikiDesktop})`) as Promise<Observation>,
        new Promise<null>(resolve => setTimeout(() => resolve(null), 1000)),
      ]) ?? last;
      if (last?.hasLogin && /(?:accounts|passport|login)\.feishu\.(?:cn|net)$/.test(last.host)) break;
    } catch { /* A navigation can replace the document while it is observed. */ }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  const metrics = app.getAppMetrics();
  return {
    observationOnly: true,
    loginPageObserved: Boolean(last?.hasLogin && /(?:accounts|passport|login)\.feishu\.(?:cn|net)$/.test(last.host)),
    lastObservation: last,
    environment: { electron: process.versions.electron, chromium: process.versions.chrome, arch: process.arch },
    processCount: metrics.length,
    workingSetMiB: Math.round(metrics.reduce((sum, metric) => sum + metric.memory.workingSetSize, 0) / 1024),
    authenticatedFeaturesVerified: false,
    note: 'Read-only observation of a fresh, unauthenticated session. No credentials entered and no QR code operated.',
  };
}
