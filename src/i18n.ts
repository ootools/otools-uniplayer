import en from '../i18n/en.json';
import zh from '../i18n/zh.json';
import type { Locale } from './host/contracts';

export type MessageKey = keyof typeof en;
export function translate(locale: Locale, key: MessageKey): string { return (locale === 'zh' ? zh : en)[key]; }
export function initialLocale(): Locale {
  try { const saved = localStorage.getItem('otools-uniplayer:locale'); if (saved === 'zh' || saved === 'en') return saved; } catch { /* optional */ }
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}
