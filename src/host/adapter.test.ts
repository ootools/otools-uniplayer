// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHostAdapter } from './adapter';

const invoke = vi.fn();
const listen = vi.fn();
vi.mock('otools-plugin-sdk/runtime', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  listen: (...args: unknown[]) => listen(...args),
  getOtoolsApi: () => window.otools,
}));
vi.mock('otools-plugin-sdk', () => ({ onOtoolsOpenFile: (handler: (files: unknown[]) => void) => window.otools?.onOtoolsOpenFile?.(handler) }));
vi.mock('otools-plugin-sdk/dialog', () => ({ pickFiles: async () => ['/real/one.mkv', '/real/two.mp4'] }));

afterEach(() => { vi.resetAllMocks(); delete (window as Window & { otools?: unknown }).otools; delete window.__TAURI_INTERNALS__; });

describe('OTools host adapter boundaries', () => {
  it('uses host picker paths and requires the advertised multi-instance capability for routing', async () => {
    const opened: unknown[] = [];
    window.otools = { apiVersion: 4, pickFiles: async () => ['/real/one.mkv', '/real/two.mp4'], instances: { open: async (request: unknown) => { opened.push(request); return [{ instanceId: 'a' }, { instanceId: 'b' }]; } } } as never;
    window.__TAURI_INTERNALS__ = { invoke: vi.fn(), transformCallback: vi.fn(() => 1) } as never;
    const host = createHostAdapter();
    expect(await host.pickFiles()).toEqual(['/real/one.mkv', '/real/two.mp4']);
    expect(await host.openInstances({ files: ['/1.mp4', '/2.mp4'], reuse: 'document' })).toEqual(['a', 'b']);
    expect(opened).toEqual([{ files: ['/1.mp4', '/2.mp4'], reuse: 'document' }]);
  });
  it('resolves the asynchronous host instance before restoring its document and activity', async () => {
    window.otools = { instances: { current: async () => ({ instanceId: 'restored', documentPath: '/media/restored.mp4', active: false }) } } as never;
    const host = createHostAdapter();
    await host.ready?.();
    expect(host.instanceId).toBe('restored');
    expect(host.lastOpenedFile()).toBe('/media/restored.mp4');
    expect(host.activity).toBe('inactive');
  });
  it('refuses to fabricate file paths or route instances when host capabilities are absent', async () => {
    window.otools = { apiVersion: 3, pickFiles: async () => null } as never;
    expect(await createHostAdapter().pickFiles()).toEqual([]);
    await expect(createHostAdapter().openInstances({ files: ['/x.mp4'], reuse: 'new' })).rejects.toThrow(/multiple document instance/);
  });
  it('passes only Tauri drag-drop paths and ignores browser fake file names', async () => {
    window.otools = { apiVersion: 2 } as never;
    window.__TAURI_INTERNALS__ = { invoke: vi.fn(), transformCallback: vi.fn(() => 1) } as never;
    listen.mockImplementation(async (_event: string, callback: (event: { payload: unknown }) => void) => { callback({ payload: { type: 'drop', paths: ['/real/dragged.mkv'] } }); return vi.fn(); });
    const received: string[][] = [];
    const host = createHostAdapter();
    await host.listenDrop((paths) => received.push(paths));
    expect(received).toEqual([['/real/dragged.mkv']]);
    const browser = createHostAdapter({ forceBrowser: true });
    await browser.listenDrop((paths) => received.push(paths));
    const drop = new Event('drop');
    Object.defineProperty(drop, 'dataTransfer', { value: { files: [{ name: 'C:\\fake\\movie.mp4' }] } });
    window.dispatchEvent(drop);
    expect(received).toHaveLength(1);
  });
  it('preserves close cleanup before acknowledgement and pauses this instance on host deactivation', async () => {
    let callback: ((event: { payload: unknown }) => void) | undefined;
    const invokeCalls: unknown[][] = [];
    invoke.mockImplementation(async (...args: unknown[]) => { invokeCalls.push(args); return true; });
    listen.mockImplementation(async (_event: string, handler: (event: { payload: unknown }) => void) => { callback = handler; return vi.fn(); });
    window.otools = { apiVersion: 2, savePluginLocalState: vi.fn(), invokeNative: vi.fn(), sidecar: { onEvent: async () => vi.fn(), writeStdin: vi.fn(), kill: vi.fn() } } as never;
    window.__TAURI_INTERNALS__ = { invoke: vi.fn(), transformCallback: vi.fn(() => 1) } as never;
    const host = createHostAdapter();
    const calls: string[] = [];
    const detachClose = host.beforeClose(async () => { calls.push('saved'); });
    await flushTauriListeners();
    callback?.({ payload: { token: 'close-17' } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(['saved']);
    expect(invokeCalls.at(-1)?.[0]).toBe('resolve_tools_tab_close_ack');
    detachClose();
  });
});

async function flushTauriListeners() { await Promise.resolve(); await Promise.resolve(); }
