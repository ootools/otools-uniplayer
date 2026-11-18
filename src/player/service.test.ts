import { describe, expect, it, vi } from 'vitest';
import { connectSidecar, createHttpSession } from './service';
import type { SidecarApi, SidecarEvent } from 'otools-plugin-sdk';

function sidecarHarness() {
  let handler: ((event: SidecarEvent) => void) | undefined;
  const calls: string[] = [];
  const api = {
    onEvent: async (callback: (event: SidecarEvent) => void) => { calls.push('listen'); handler = callback; return () => { calls.push('unlisten'); }; },
    spawn: async (id: string, args: string[], options: unknown) => { calls.push(JSON.stringify([id, args, options])); return { handle: 'view-1', pid: 17 }; },
    writeStdin: async (handle: string, data: string) => { calls.push('stdin'); const init = JSON.parse(data); expect(handle).toBe('view-1'); expect(init.type).toBe('init'); expect(init.origin).toBe('http://plugin.test'); expect(init.token).toMatch(/^[a-f0-9]{64}$/); handler?.({ handle: 'other', event: 'output', stream: 'stdout', data: '{"event":"ready","port":1111,"protocol":1}\n' }); handler?.({ handle, event: 'output', stream: 'stdout', data: '{"event":"rea' }); handler?.({ handle, event: 'output', stream: 'stdout', data: 'dy","port":43210,"protocol":1}\n' }); },
    kill: vi.fn(async () => { calls.push('kill'); }),
    status: async () => ({ state: 'running' as const, pid: 17 }),
  } satisfies SidecarApi;
  return { api, calls };
}

describe('view sidecar session', () => {
  it('subscribes before spawning, filters other handles and joins ready output', async () => {
    const { api, calls } = sidecarHarness();
    const connection = await connectSidecar(api, 'http://plugin.test');
    expect(calls[0]).toBe('listen');
    expect(calls[1]).toBe('["player",["--stdio"],{"lifetime":"view"}]');
    expect(connection.origin).toBe('http://127.0.0.1:43210');
    expect(connection.token).toMatch(/^[a-f0-9]{64}$/);
    await connection.dispose();
    expect(calls).toContain('unlisten');
  });
  it('sends auth only as headers and keeps paths inside JSON bodies', async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    const response = { generation: 2, effectiveStart: 18, playlist: '/media/2/index.m3u8', mode: 'copy', media: { name: 'one.mkv', duration: 100, videoCodec: 'h264', width: 1920, height: 1080, hdr: false, audioTracks: [{ id: 1, label: 'Main', codec: 'aac' }] } };
    const fetcher = async (input: string | URL | Request, init?: RequestInit) => { requests.push({ url: String(input), init }); return new Response(JSON.stringify(response), { status: 200, headers: { 'Content-Type': 'application/json' } }); };
    const session = createHttpSession({ origin: 'http://127.0.0.1:43210', token: 'private-token', dispose: async () => {} }, fetcher);
    const result = await session.open('/private/movie.mkv', { start: 18 });
    expect(requests[0].url).toBe('http://127.0.0.1:43210/api/open');
    expect(new Headers(requests[0].init?.headers).get('Authorization')).toBe('Bearer private-token');
    expect(JSON.parse(String(requests[0].init?.body))).toEqual({ path: '/private/movie.mkv', start: 18 });
    expect(session.playlistUrl(result)).toBe('http://127.0.0.1:43210/media/2/index.m3u8');
  });
  it('uses the service external subtitleURL field instead of silently returning no subtitle', async () => {
    const fetcher = async () => new Response(JSON.stringify({ subtitleURL: '/media/7/subtitle-external.vtt' }), { status: 200 });
    const session = createHttpSession({ origin: 'http://127.0.0.1:43210', token: 'private-token', dispose: async () => {} }, fetcher);
    expect(await session.selectSubtitle('/media/captions.srt')).toBe('/media/7/subtitle-external.vtt');
  });
  it('rejects credential forwarding to unrelated origins and directory traversal', () => {
    const session = createHttpSession({ origin: 'http://127.0.0.1:43210', token: 'private-token', dispose: async () => {} });
    const xhr = { setRequestHeader: vi.fn(), withCredentials: true } as unknown as XMLHttpRequest;
    expect(() => session.authorizeXHR(xhr, 'http://example.com/media/1/seg.m4s')).toThrow(/unrelated/);
    expect(() => session.authorizeXHR(xhr, 'http://127.0.0.1:43210/api/status')).toThrow(/unrelated/);
    expect(xhr.setRequestHeader).not.toHaveBeenCalled();
    session.authorizeXHR(xhr, 'http://127.0.0.1:43210/media/1/seg-0001.m4s');
    expect(xhr.setRequestHeader).toHaveBeenCalledWith('Authorization', 'Bearer private-token');
    expect(xhr.withCredentials).toBe(false);
  });
});
