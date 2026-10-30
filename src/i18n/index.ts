import { zhCN } from './zh-CN.js';
import type { TranslationDict } from './zh-CN.js';

export const i18n = zhCN;
export type { TranslationDict };

/** Format a message template with key-value interpolations */
export function format(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(params[key] ?? ''));
}
