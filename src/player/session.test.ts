// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPlayerSession } from './session';
import { createMockHost } from '../host/mock';
import { createMockMediaService } from './mock-service';

const bind = vi.fn();
vi.mock('./hls', () => ({ bindAuthenticatedHls: (...args: unknown[]) => bind(...args) }));
afterEach(() => { localStorage.clear(); vi.resetAllMocks(); });

describe('player session video boundary', () => {
  it('does not attempt playback after the HLS binding reports unsupported media', async () => {
    bind.mockImplementation((_video, _session, _response, onError) => {
      onError('MSE unavailable'); return { destroy() {} };
    });
    const host = createMockHost();
    const factory = createMockMediaService();
    const mock = await factory.create('one');
    const play = vi.fn(async () => {});
    const video = { play, pause: vi.fn() } as unknown as HTMLVideoElement;
    const player = createPlayerSession(host, { create: async () => ({ ...mock, demo: false }) }, () => video);
    await player.open('/demo/Alpine light.mp4');
    expect(player.state.phase).toBe('error');
    expect(play).not.toHaveBeenCalled();
    await player.close();
  });
  it('does not auto-play when the view becomes inactive during media startup', async () => {
    bind.mockImplementation(() => ({ destroy() {} }));
    const host = createMockHost();
    const mock = await createMockMediaService().create('one');
    let resolveOpen!: (value: Awaited<ReturnType<typeof mock.open>>) => void;
    const open = new Promise<Awaited<ReturnType<typeof mock.open>>>(resolve => { resolveOpen = resolve; });
    const pause = vi.fn(async () => {});
    let active = true;
    const play = vi.fn(async () => {});
    const video = { play, pause: vi.fn() } as unknown as HTMLVideoElement;
    const player = createPlayerSession(host, { create: async () => ({ ...mock, demo: false, open: async () => open, pause }) }, () => video, () => active);
    const pending = player.open('/demo/Alpine light.mp4');
    await Promise.resolve();
    active = false;
    resolveOpen(await mock.open('/demo/Alpine light.mp4'));
    await pending;
    expect(player.state.phase).toBe('paused');
    expect(play).not.toHaveBeenCalled();
    expect(pause).toHaveBeenCalledOnce();
    await player.close();
  });
  it('respects a pause issued after the new media response but before actual video.play', async () => {
    const host = createMockHost();
    const mock = await createMockMediaService().create('one');
    const play = vi.fn(async () => {});
    const video = { play, pause: vi.fn() } as unknown as HTMLVideoElement;
    let active = true;
    let player: ReturnType<typeof createPlayerSession>;
    bind.mockImplementation(() => { active = false; void player.pause(); return { destroy() {} }; });
    player = createPlayerSession(host, { create: async () => ({ ...mock, demo: false }) }, () => video, () => active);
    await player.open('/demo/Alpine light.mp4');
    expect(player.state.phase).toBe('paused');
    expect(play).not.toHaveBeenCalled();
    await player.close();
  });
  it('reloads the selected subtitle with source time offset after a pipeline seek', async () => {
    bind.mockImplementation(() => ({ destroy() {} }));
    vi.stubGlobal('Blob', NodeBlob);
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:subtitle');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
    const host = createMockHost();
    const mock = await createMockMediaService().create('one');
    const subtitleText = 'WEBVTT\n\n00:00:10.000 --> 00:00:12.000\nHello\n';
    const fetchSubtitle = vi.fn(async () => ({ text: async () => subtitleText, type: 'text/vtt' }) as Blob);
    const player = createPlayerSession(host, { create: async () => ({ ...mock, fetchSubtitle }) }, () => null);
    await player.open('/demo/Alpine light.mp4');
    await player.subtitles('track:3');
    expect(fetchSubtitle).toHaveBeenCalledOnce();
    await player.seek(8);
    expect(fetchSubtitle).toHaveBeenCalledTimes(2);
    expect(player.state.subtitleUrl).toBe('blob:subtitle');
    const blob = createObjectURL.mock.calls.at(-1)?.[0] as Blob | undefined;
    expect(blob).toBeDefined();
    expect(await blob!.text()).toContain('00:00:02.000 --> 00:00:04.000');
    await player.close();
    vi.unstubAllGlobals();
  });
  it('starts a retried service with a fresh generation gate after process replacement', async () => {
    bind.mockImplementation(() => ({ destroy() {} }));
    const host = createMockHost();
    const factory = createMockMediaService();
    const player = createPlayerSession(host, factory, () => null);
    await player.open('/demo/Alpine light.mp4');
    await player.seek(15);
    expect(player.state.response?.generation).toBe(2);
    await player.retry();
    expect(player.state.phase).toBe('playing');
    expect(player.state.busy).toBe(false);
    expect(player.state.response?.generation).toBe(1);
    await player.close();
  });
});
