import { describe, expect, it } from 'vitest';
import { resolveTheme, applyTheme } from './theme';

describe('self-contained theme', () => {
  it('prefers host injection over cached mode and uses the host accent', () => {
    expect(resolveTheme({ themeMode: 'dark', themeAccent: 'emerald', resolvedTheme: 'dark' }, { mode: 'light', accent: 'violet' }, false))
      .toEqual({ mode: 'dark', resolved: 'dark', accent: '#10b981' });
  });
  it('falls back to cache/system and rejects unsafe CSS colors', () => {
    expect(resolveTheme(undefined, { mode: 'system', accent: 'url(evil)' }, true)).toEqual({ mode: 'system', resolved: 'dark', accent: '#8b5cf6' });
    expect(resolveTheme(undefined, { mode: 'light', accent: '#4477ee' }, true).accent).toBe('#4477ee');
  });
  it('applies dark/light and accent tokens without relying on host stylesheets', () => {
    const classes = new Set<string>();
    const props = new Map<string, string>();
    const root = { classList: { toggle(key: string, enabled: boolean) { if (enabled) classes.add(key); else classes.delete(key); } }, style: { colorScheme: '', setProperty(key: string, value: string) { props.set(key, value); } }, setAttribute() {} };
    applyTheme(root as unknown as HTMLElement, { mode: 'dark', resolved: 'dark', accent: '#10b981' });
    expect(classes.has('dark')).toBe(true);
    expect(props.get('--accent')).toBe('#10b981');
    expect(root.style.colorScheme).toBe('dark');
  });
});
