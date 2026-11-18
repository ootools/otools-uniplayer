import { open } from '@tauri-apps/plugin-dialog';
import { getOtoolsApi, invoke, listen } from 'otools-plugin-sdk/runtime';
import { onOtoolsOpenFile } from 'otools-plugin-sdk';
import { createPlaybackStorage } from '../domain/storage';
import type { HostAdapter, HostFile, InstanceOpenRequest } from './contracts';

interface InstanceInfo { instanceId?: string; id?: string; documentPath?: string; document?: string; active?: boolean }
interface InstancesCapability {
  open(request: InstanceOpenRequest): Promise<InstanceInfo[]>;
  current?(): InstanceInfo | Promise<InstanceInfo | null> | null;
  onActivity?(handler: (event: { active?: boolean; instanceId?: string } | boolean) => void): (() => void) | Promise<() => void>;
}

function instances(): InstancesCapability | undefined {
  return (getOtoolsApi() as unknown as { instances?: InstancesCapability } | undefined)?.instances;
}

function fallbackInstanceId(): string {
  const query = new URLSearchParams(location.search);
  const hinted = query.get('otoolsInstance') ?? query.get('otoolsInstanceId') ?? query.get('instanceId');
  if (hinted) return hinted;
  const label = window.__TAURI_INTERNALS__?.metadata?.currentWebview?.label;
  if (label) return label;
  try {
    const cached = sessionStorage.getItem('otools-uniplayer:instance');
    if (cached) return cached;
    const id = crypto.randomUUID();
    sessionStorage.setItem('otools-uniplayer:instance', id);
    return id;
  } catch { return crypto.randomUUID(); }
}

export function createHostAdapter(options: { forceBrowser?: boolean } = {}): HostAdapter {
  const api = options.forceBrowser ? undefined : getOtoolsApi();
  const store = createPlaybackStorage();
  let instanceId = fallbackInstanceId();
  let lastDocument: string | null = null;
  let currentActivity: HostAdapter['activity'] = 'unknown';
  const current = api ? instances()?.current?.() : undefined;
  const applyCurrent = (value: InstanceInfo | null | undefined) => {
    if (!value) return;
    instanceId = value.instanceId ?? value.id ?? instanceId;
    lastDocument = value.documentPath ?? value.document ?? null;
    currentActivity = value.active === false ? 'inactive' : value.active === true ? 'active' : 'unknown';
  };
  const ready = Promise.resolve(current).then(applyCurrent);
  void ready.catch(() => {});
  return {
    kind: api ? 'otools' : 'browser',
    get instanceId() { return instanceId; },
    get activity() { return currentActivity; },
    isTauri: Boolean(api && window.__TAURI_INTERNALS__?.invoke),
    clipboardAvailable: Boolean(api?.copyText),
    ready: () => ready,
    async pickFiles() {
      if (!api) return [];
      const options = { multiple: true, directory: false, title: 'UniPlayer', filters: [{ name: 'Media', extensions: ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'mp3', 'flac', 'wav'] }] };
      const result = typeof api.pickFiles === 'function' ? await api.pickFiles(options) : await open(options);
      return Array.isArray(result) ? result : typeof result === 'string' ? [result] : [];
    },
    async pickSubtitle() {
      if (!api) return null;
      const result = await open({ multiple: false, directory: false, title: 'UniPlayer · Subtitles', filters: [{ name: 'Subtitles', extensions: ['srt', 'vtt'] }] });
      return typeof result === 'string' ? result : null;
    },
    async openInstances(request) {
      const capability = api ? instances() : undefined;
      if (!capability?.open) throw new Error('This host does not support multiple document instances yet. Update OTools to open files in separate tabs.');
      const results = await capability.open({ files: [...request.files], reuse: request.reuse });
      return results.map((result) => result.instanceId ?? result.id ?? '').filter(Boolean);
    },
    lastOpenedFile() { return lastDocument ?? store.last(instanceId)?.path ?? null; },
    async listenFiles(handler) {
      if (!api) return () => {};
      const stop = await onOtoolsOpenFile((files) => { if (files[0]?.path) lastDocument = files[0].path; handler(files); });
      return () => { void stop?.(); };
    },
    async listenDrop(handler) {
      if (!api || !window.__TAURI_INTERNALS__?.invoke) return () => {};
      const stop = await listen<{ paths?: string[]; type?: string }>('tauri://drag-drop', (event) => {
        if (Array.isArray(event.payload?.paths)) handler(event.payload.paths.filter((path) => typeof path === 'string'));
      });
      return () => { void stop(); };
    },
    listenActivity(handler) {
      const capability = api ? instances() : undefined;
      let active = true;
      let unlisten: (() => void) | undefined;
      if (capability?.onActivity) {
        const stop = capability.onActivity((event) => {
          if (!active) return;
          const isActive = typeof event === 'boolean' ? event : event.active !== false;
          if (typeof event === 'object' && event.instanceId && event.instanceId !== instanceId) return;
          currentActivity = isActive ? 'active' : 'inactive';
          handler(isActive);
        });
        void Promise.resolve(stop).then((value) => { if (active) unlisten = value; else value(); });
      }
      const onVisibility = () => { if (!capability?.onActivity) handler(!document.hidden); };
      document.addEventListener('visibilitychange', onVisibility);
      return () => { active = false; unlisten?.(); document.removeEventListener('visibilitychange', onVisibility); };
    },
    beforeClose(handler) {
      let live = true;
      let stop: (() => void | Promise<void>) | undefined;
      const onLocal = (event: Event) => {
        const detail = (event as CustomEvent<{ payload?: { token?: string }; token?: string }>).detail;
        const token = detail?.payload?.token ?? detail?.token;
        if (token) void finish(token);
      };
      let closing: Promise<void> | null = null;
      const finish = (token: string): Promise<void> => {
        if (!live) return Promise.resolve();
        closing ??= handler();
        return closing.finally(() => api ? invoke('resolve_tools_tab_close_ack', { token }).then(() => {}) : Promise.resolve());
      };
      if (api) {
        window.addEventListener('otools-tauri:otools:tab-before-close', onLocal);
        void listen<{ token: string }>('otools:tab-before-close', (event) => { if (event.payload?.token) void finish(event.payload.token); })
          .then(async (value) => { if (!live) await value(); else stop = value; })
          .catch(() => {});
        void invoke('register_tools_tab_close_hook', { enabled: true }).catch(() => {});
      }
      return () => { live = false; void stop?.(); window.removeEventListener('otools-tauri:otools:tab-before-close', onLocal); };
    },
    loadPlayback: (id, path) => store.load(id, path),
    savePlayback: (id, path, state) => store.save(id, path, state),
    async readTextFile(path) {
      if (!api?.readHostFile) throw new Error('Host file access is unavailable');
      const file = await api.readHostFile(path);
      return new TextDecoder().decode(Uint8Array.from(atob(file.dataBase64), (value) => value.charCodeAt(0)));
    },
    toast(message) { api?.showNotification?.(message); },
  };
}

export function normalizeDelivered(files: HostFile[]): string[] {
  return files.map((file) => file.path).filter(Boolean);
}
