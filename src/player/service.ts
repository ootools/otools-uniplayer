import type { SidecarApi, SidecarEvent } from 'otools-plugin-sdk';
import type { MediaServiceFactory, OpenResponse, PlaybackSession, StatusResponse } from '../host/contracts';
import { createSessionToken, JsonLineBuffer, loopbackOrigin, mediaUrl, parseReady } from './protocol';

export class PlayerError extends Error {
  constructor(public readonly code: 'quota' | 'startup' | 'network' | 'media' | 'unsupported', message: string) { super(message); this.name = 'PlayerError'; }
}

export interface SidecarConnection { origin: string; token: string; dispose(): Promise<void> }

export async function connectSidecar(api: SidecarApi, origin: string, timeoutMs = 15_000): Promise<SidecarConnection> {
  const token = createSessionToken();
  const lines = new JsonLineBuffer();
  let handle = '';
  let stop: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const early: SidecarEvent[] = [];
  let resolveReady!: (port: number) => void;
  let rejectReady!: (reason: Error) => void;
  const ready = new Promise<number>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  // Observe immediate exit/error while spawn and init are still pending.
  void ready.catch(() => {});
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    if (timer) clearTimeout(timer);
    stop?.();
    lines.reset();
    if (handle) { try { await api.kill(handle); } catch { /* Host view lifetime remains the final cleanup authority. */ } }
  };
  const receive = (event: SidecarEvent) => {
    if (disposed) return;
    if (!handle) { if (early.length < 32) early.push(event); return; }
    if (event.handle !== handle) return;
    if (event.event === 'exit' || event.event === 'overflow') { rejectReady(new PlayerError('startup', 'The media service stopped before it was ready.')); return; }
    if (event.event !== 'output' || event.stream !== 'stdout') return;
    try {
      for (const line of lines.push(event.data)) {
        const value = parseReady(line);
        if (value) resolveReady(value.port);
      }
    } catch { rejectReady(new PlayerError('startup', 'The media service sent an invalid handshake.')); }
  };
  try {
    stop = await api.onEvent(receive);
    const spawned = await api.spawn('player', ['--stdio'], { lifetime: 'view' });
    handle = spawned.handle;
    for (const event of early) receive(event);
    timer = setTimeout(() => rejectReady(new PlayerError('startup', 'The media service did not become ready.')), timeoutMs);
    await api.writeStdin(handle, `${JSON.stringify({ type: 'init', token, origin })}\n`);
    const port = await ready;
    clearTimeout(timer);
    return { origin: loopbackOrigin(port), token, dispose };
  } catch (error) {
    await dispose();
    const message = error instanceof Error ? error.message : String(error);
    if (/quota|limit|最多|上限|8.*(?:slot|进程|服务)|too many/i.test(message)) throw new PlayerError('quota', 'All 8 playback slots are in use');
    if (error instanceof PlayerError) throw error;
    throw new PlayerError('startup', 'Unable to start the media service. Check the installed player runtime.');
  }
}

export type AuthenticatedSession = PlaybackSession & { authorizeXHR(xhr: XMLHttpRequest, url: string): void };

export function createHttpSession(connection: SidecarConnection, fetcher: typeof fetch = globalThis.fetch): AuthenticatedSession {
  let closed = false;
  const request = async <T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> => {
    if (closed) throw new PlayerError('network', 'The playback session is closed.');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetcher(`${connection.origin}${path}`, {
        method, signal: controller.signal, credentials: 'omit', cache: 'no-store',
        headers: { Authorization: `Bearer ${connection.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) {
        if (response.status === 429) throw new PlayerError('quota', 'All 8 playback slots are in use');
        throw new PlayerError('media', `The media service could not complete this request (${response.status}).`);
      }
      if (response.status === 204) return undefined as T;
      return await response.json() as T;
    } catch (error) {
      if (error instanceof PlayerError) throw error;
      throw new PlayerError('network', 'The local media service is unavailable. Try rebuilding this playback session.');
    } finally { clearTimeout(timeout); }
  };
  const subtitleBlob = async (path: string): Promise<Blob> => {
    const url = new URL(path, connection.origin);
    if (url.origin !== connection.origin || !/^\/(?:api\/subtitle|media\/\d+\/)/.test(url.pathname)) throw new PlayerError('media', 'The subtitle URL is invalid.');
    const response = await fetcher(url.href, { credentials: 'omit', cache: 'no-store', headers: { Authorization: `Bearer ${connection.token}` } });
    if (!response.ok) throw new PlayerError('media', 'The subtitle could not be loaded.');
    return new Blob([await response.text()], { type: 'text/vtt' });
  };
  return {
    demo: false,
    open(path, options = {}) { return request<OpenResponse>('/api/open', { path, ...options }); },
    seek(position, options = {}) { return request<OpenResponse>('/api/seek', { position, ...options }); },
    async pause(position) { await request('/api/pause', { position }); },
    async progress(position, paused, rate) { await request('/api/progress', { position, paused, rate }); },
    status() { return request<StatusResponse>('/api/status'); },
    async close() {
      if (closed) return;
      try { await request('/api/close', {}); } finally { closed = true; await connection.dispose(); }
    },
    playlistUrl(response) { return mediaUrl(connection.origin, response.playlist, response.generation); },
    authorizeXHR(xhr, url) {
      const parsed = new URL(url);
      if (parsed.origin !== connection.origin || !parsed.pathname.startsWith('/media/') || parsed.search || parsed.hash) throw new PlayerError('media', 'Refusing to authorize an unrelated media URL.');
      xhr.setRequestHeader('Authorization', `Bearer ${connection.token}`);
      xhr.withCredentials = false;
    },
    fetchSubtitle: subtitleBlob,
    async selectSubtitle(path) {
      const result = await request<{ generation?: number; subtitleURL?: string; url?: string; subtitle?: string }>('/api/subtitle', { path });
      return result.subtitleURL ?? result.url ?? result.subtitle ?? null;
    },
  };
}

export function createMediaService(api?: SidecarApi): MediaServiceFactory {
  let pending: Promise<PlaybackSession> | null = null;
  return {
    async create() {
      if (!api) throw new PlayerError('unsupported', 'This OTools version does not provide the player sidecar API.');
      pending ??= connectSidecar(api, location.origin).then((connection) => {
        const session = createHttpSession(connection);
        const close = session.close.bind(session);
        session.close = async () => { try { await close(); } finally { pending = null; } };
        return session;
      }).catch((error) => { pending = null; throw error; });
      return pending;
    },
  };
}
