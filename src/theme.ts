export interface ThemeInjection { themeMode?: string; themeAccent?: string; resolvedTheme?: string }
export interface ThemeCache { mode?: string; accent?: string }
export interface ResolvedTheme { mode: 'light' | 'dark' | 'system'; resolved: 'light' | 'dark'; accent: string }

const ACCENTS: Record<string, string> = {
  classic: '#8b5cf6', violet: '#8b5cf6', emerald: '#10b981', amber: '#f59e0b', pink: '#ec4899',
};
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export function resolveTheme(injected: ThemeInjection | undefined, cached: ThemeCache, systemDark: boolean): ResolvedTheme {
  const mode = injected?.themeMode === 'dark' || injected?.themeMode === 'light' || injected?.themeMode === 'system'
    ? injected.themeMode : cached.mode === 'dark' || cached.mode === 'light' || cached.mode === 'system' ? cached.mode : 'system';
  const resolved = injected?.resolvedTheme === 'dark' || injected?.resolvedTheme === 'light'
    ? injected.resolvedTheme : mode === 'system' ? systemDark ? 'dark' : 'light' : mode;
  const accent = injected?.themeAccent && (ACCENTS[injected.themeAccent] || HEX.test(injected.themeAccent))
    ? ACCENTS[injected.themeAccent] ?? injected.themeAccent
    : cached.accent && (ACCENTS[cached.accent] || HEX.test(cached.accent))
      ? ACCENTS[cached.accent] ?? cached.accent : ACCENTS.classic;
  return { mode, resolved, accent };
}

export function applyTheme(root: HTMLElement, theme: ResolvedTheme): void {
  root.classList.toggle('dark', theme.resolved === 'dark');
  root.classList.toggle('light', theme.resolved === 'light');
  root.style.colorScheme = theme.resolved;
  root.style.setProperty('--accent', theme.accent);
  root.style.setProperty('--accent-soft', `${theme.accent}22`);
  root.setAttribute('data-theme-mode', theme.mode);
}

export function installTheme(): () => void {
  const readCache = (): ThemeCache => {
    try { return { mode: localStorage.getItem('otools:theme-mode') ?? undefined, accent: localStorage.getItem('otools:theme-accent') ?? undefined }; }
    catch { return {}; }
  };
  const host = (window as Window & { __OTOOLS_THEME__?: ThemeInjection }).__OTOOLS_THEME__;
  const media = window.matchMedia?.('(prefers-color-scheme: dark)');
  const apply = (injected?: ThemeInjection) => applyTheme(document.documentElement, resolveTheme(injected ?? host, readCache(), Boolean(media?.matches)));
  apply();
  const onTheme = (event: Event) => {
    const detail = (event as CustomEvent<ThemeInjection>).detail;
    if (detail && typeof detail === 'object') apply(detail);
  };
  window.addEventListener('otools-theme-changed', onTheme);
  const onSystem = () => { if ((host?.themeMode ?? readCache().mode ?? 'system') === 'system') apply(); };
  media?.addEventListener?.('change', onSystem);
  return () => { window.removeEventListener('otools-theme-changed', onTheme); media?.removeEventListener?.('change', onSystem); };
}
