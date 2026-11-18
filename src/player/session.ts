import { reactive, nextTick } from 'vue';
import type { HostAdapter, MediaServiceFactory, OpenResponse, PlaybackSession } from '../host/contracts';
import type { LoadIntent } from '../domain/playback';
import { globalPosition, resolveLoadPlan } from '../domain/playback';
import { GenerationGate } from './protocol';
import { bindAuthenticatedHls } from './hls';
import type { VideoBinding } from './hls';
import { PlayerError } from './service';
import { offsetVtt } from './subtitles';

export function createPlayerSession(host: HostAdapter, factory: MediaServiceFactory, getVideo: () => HTMLVideoElement | null, canPlay: () => boolean = () => true) {
  const state = reactive({
    path: '', phase: 'idle' as 'idle' | 'loading' | 'playing' | 'paused' | 'error' | 'quota',
    response: null as OpenResponse | null, position: 0, rate: 1, volume: 0.8,
    muted: false, audioTrack: undefined as number | undefined, subtitleUrl: '', error: '', busy: false,
  });
  let gate = new GenerationGate();
  let sequence = 0;
  let session: PlaybackSession | null = null;
  let connecting: Promise<PlaybackSession> | null = null;
  let binding: VideoBinding | null = null;
  let stopped = false;
  let subtitleSequence = 0;
  let subtitleSelection = 'off';
  let needReload = false;

  const save = () => {
    if (!state.path) return;
    host.savePlayback(host.instanceId, state.path, { position: state.position, duration: state.response?.media.duration ?? 0, rate: state.rate, paused: state.phase !== 'playing', volume: state.volume, audioTrack: state.audioTrack });
  };
  const fail = (error: unknown) => {
    state.phase = error instanceof PlayerError && error.code === 'quota' ? 'quota' : 'error';
    state.error = error instanceof Error ? error.message : 'The playback session failed.';
    state.busy = false;
  };
  const clearSubtitle = () => {
    subtitleSequence++;
    if (state.subtitleUrl) URL.revokeObjectURL(state.subtitleUrl);
    state.subtitleUrl = '';
  };
  const ensure = async () => {
    if (session) return session;
    connecting ??= factory.create(host.instanceId);
    try {
      const value = await connecting;
      if (stopped) { await value.close(); throw new Error('Playback view is closed'); }
      session = value;
      return value;
    } finally { connecting = null; }
  };
  const startVideo = async () => {
    const video = getVideo();
    if (!video || session?.demo || stopped) return;
    if (!canPlay() || state.phase !== 'playing') {
      video.pause();
      if (state.phase === 'playing') state.phase = 'paused';
      return;
    }
    video.volume = state.volume;
    video.muted = state.muted;
    video.playbackRate = state.rate;
    try { await video.play(); } catch { if (!stopped) state.phase = 'paused'; }
  };
  const apply = async (response: OpenResponse, ticket: number, play: boolean) => {
    if (stopped || !gate.accept(ticket, response.generation)) return;
    play = play && canPlay();
    binding?.destroy();
    binding = null;
    clearSubtitle();
    state.response = response;
    state.position = response.effectiveStart;
    state.busy = false;
    state.phase = play ? 'playing' : 'paused';
    needReload = false;
    await nextTick();
    if (!gate.isCurrent(ticket) || stopped || !session) return;
    const video = getVideo();
    if (video) {
      let bindingFailed = false;
      binding = bindAuthenticatedHls(video, session, response, (message) => {
        if (gate.isCurrent(ticket) && !stopped) { bindingFailed = true; fail(new PlayerError('unsupported', message)); }
      });
      if (play && !bindingFailed) await startVideo();
    }
    if ((!play || !canPlay() || state.phase === 'paused') && session && !session.demo && gate.isCurrent(ticket)) {
      state.phase = 'paused';
      await session.pause(state.position, true);
      needReload = true;
    }
    if (subtitleSelection !== 'off' && gate.isCurrent(ticket) && !stopped) await subtitles(subtitleSelection);
    save();
  };
  const open = async (path: string, intent: LoadIntent = 'ordinaryOpen', resume = true) => {
    save();
    if (state.path !== path) subtitleSelection = 'off';
    const ticket = gate.begin(); sequence = ticket;
    state.path = path; state.phase = 'loading'; state.busy = true; state.error = '';
    binding?.destroy(); binding = null;
    clearSubtitle();
    const saved = host.loadPlayback(host.instanceId, path);
    state.position = resolveLoadPlan(saved, intent, resume);
    state.rate = saved?.rate ?? state.rate;
    state.volume = saved?.volume ?? state.volume;
    state.audioTrack = saved?.audioTrack;
    try {
      const service = await ensure();
      if (!gate.isCurrent(ticket)) return;
      const response = await service.open(path, { start: state.position, rate: state.rate, ...(state.audioTrack === undefined ? {} : { audioTrack: state.audioTrack }) });
      await apply(response, ticket, true);
    } catch (error) { if (gate.isCurrent(ticket) && !stopped) fail(error); }
  };
  const seek = async (position: number, play = state.phase === 'playing') => {
    if (!session || !state.response || stopped) return;
    const ticket = gate.begin(); sequence = ticket;
    const target = Math.min(Math.max(0, Number.isFinite(position) ? position : 0), state.response.media.duration || Infinity);
    state.busy = true;
    try {
      const response = await session.seek(target, { rate: state.rate, ...(state.audioTrack === undefined ? {} : { audioTrack: state.audioTrack }) });
      await apply(response, ticket, play);
    } catch (error) { if (gate.isCurrent(ticket) && !stopped) fail(error); }
  };
  const pause = async () => {
    if (!session || state.phase === 'idle' || state.phase === 'loading') return;
    state.phase = 'paused';
    if (!session.demo) getVideo()?.pause();
    save();
    try { await session.pause(state.position, true); needReload = true; }
    catch (error) { if (!stopped) fail(error); }
  };
  const play = async () => {
    if (!session || !state.response || stopped) return;
    try {
      if (needReload) { await seek(state.position, true); return; }
      const status = await session.status();
      if (status.needReload) { await seek(state.position, true); return; }
      state.phase = 'playing';
      await startVideo();
    } catch (error) { if (!stopped) fail(error); }
  };
  const progress = async () => {
    save();
    if (!session || !state.response || stopped || state.busy) return;
    try { await session.progress(state.position, state.phase !== 'playing', state.rate); }
    catch (error) { if (!stopped) fail(error); }
  };
  const updateTime = () => {
    const video = getVideo();
    if (!video || !state.response || state.busy || session?.demo) return;
    state.position = globalPosition(state.response.effectiveStart, video.currentTime, state.response.media.duration);
  };
  const subtitles = async (value: string) => {
    subtitleSelection = value;
    clearSubtitle();
    if (!session || !state.response || value === 'off') return;
    const ticket = subtitleSequence;
    const generation = state.response.generation;
    try {
      const path = value.startsWith('track:') ? `/api/subtitle?track=${encodeURIComponent(value.slice(6))}` : await session.selectSubtitle(value);
      if (!path) return;
      const blob = await session.fetchSubtitle(path);
      const source = state.response.effectiveStart > 0 ? await blob.text() : null;
      if (stopped || ticket !== subtitleSequence || state.response.generation !== generation) return;
      const shifted = source === null ? blob : new Blob([offsetVtt(source, state.response.effectiveStart)], { type: 'text/vtt' });
      state.subtitleUrl = URL.createObjectURL(shifted);
    } catch (error) { if (ticket === subtitleSequence) state.error = error instanceof Error ? error.message : 'Subtitle load failed'; }
  };
  const close = async () => {
    if (stopped) return;
    save(); stopped = true; gate.invalidate(); clearSubtitle();
    binding?.destroy(); binding = null;
    if (!session?.demo) getVideo()?.pause();
    const current = session; session = null;
    if (current) { try { await current.close(); } catch { /* Host reaps the view process tree. */ } }
  };
  return {
    state, open, seek, pause, play, save, progress, updateTime, subtitles, close,
    async toggle() { if (state.phase === 'playing') await pause(); else await play(); },
    async setRate(rate: number) { state.rate = Math.min(2, Math.max(0.5, rate)); if (state.response) await seek(state.position); },
    async setAudioTrack(id: number) { state.audioTrack = id; if (state.response) await seek(state.position); },
    setVolume(volume: number) { state.volume = Math.min(1, Math.max(0, volume)); const video = getVideo(); if (video) video.volume = state.volume; save(); },
    toggleMute() { state.muted = !state.muted; const video = getVideo(); if (video) video.muted = state.muted; },
    tickDemo(delta: number) { if (session?.demo && state.phase === 'playing' && state.response) { state.position = Math.min(state.response.media.duration, state.position + delta * state.rate); if (state.position >= state.response.media.duration) { state.phase = 'paused'; save(); } } },
    async retry() {
      const path = state.path;
      gate.invalidate();
      binding?.destroy(); binding = null;
      const current = session; session = null; connecting = null;
      if (current) { try { await current.close(); } catch {} }
      gate = new GenerationGate();
      stopped = false;
      if (path) await open(path, 'resume');
    },
    get demo() { return session?.demo ?? host.kind === 'browser'; },
    get ticket() { return sequence; },
  };
}
