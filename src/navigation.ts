import { i18n } from './i18n/index.js';

export const WIKI_HOME = 'https://www.feishu.cn/wiki/';

export type Destination =
  | { kind: 'internal'; url: string; purpose: 'document' | 'login' | 'attachment' | 'popup' }
  | { kind: 'external'; url: string }
  | { kind: 'blocked'; message: string };

const loginHosts = new Set([
  'accounts.feishu.cn', 'passport.feishu.cn', 'login.feishu.cn',
  'sso.feishu.cn', 'passport.feishu.net', 'accounts.feishu.net',
]);
const documentPath = /^\/(?:wiki|docx?|docs|sheets?|base|bitable|mindnotes?|slides|file|drive|explorer|space|folder)(?:\/|$)/i;
const loginPath = /^\/(?:accounts?|passport|auth|login|sso)(?:\/|$)/i;

export function isFeishuHost(host: string): boolean {
  return host === 'feishu.cn' || host.endsWith('.feishu.cn');
}

/** Top-level navigation policy; embedded official resources keep normal browser rules. */
export function destination(raw: string, opener?: string): Destination {
  if (raw === 'about:blank' && opener && destination(opener).kind === 'internal') {
    return { kind: 'internal', url: raw, purpose: 'popup' };
  }
  let url: URL;
  try { url = new URL(raw); }
  catch { return { kind: 'blocked', message: i18n.navigation.invalidUrl }; }
  if (url.username || url.password) return { kind: 'blocked', message: i18n.navigation.credentialsBlocked };
  if (url.protocol === 'blob:') {
    try {
      const parent = opener ? new URL(opener) : null;
      if (parent && url.origin === parent.origin && destination(parent.href).kind === 'internal') {
        return { kind: 'internal', url: url.href, purpose: 'attachment' };
      }
    } catch { /* Invalid or untrusted blob origin. */ }
    return { kind: 'blocked', message: i18n.navigation.blobUntrusted };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { kind: 'blocked', message: i18n.navigation.unsupportedProtocol };
  }
  if (isFeishuHost(url.hostname) || loginHosts.has(url.hostname)) {
    if (url.protocol !== 'https:' || url.port) {
      return { kind: 'blocked', message: i18n.navigation.nonHttpsFeishu };
    }
    if (loginHosts.has(url.hostname) || loginPath.test(url.pathname)) {
      return { kind: 'internal', url: url.href, purpose: 'login' };
    }
    if (documentPath.test(url.pathname) || (url.hostname === 'docs.feishu.cn' && url.pathname === '/')) {
      return { kind: 'internal', url: url.href, purpose: 'document' };
    }
  }
  return { kind: 'external', url: url.href };
}

export function normalizeInput(input: string): string {
  const value = input.trim();
  return /^[\w.-]+\.feishu\.cn(?:[/?#]|$)/i.test(value) ? `https://${value}` : value;
}

