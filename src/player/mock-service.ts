import type { MediaServiceFactory, OpenResponse, PlaybackSession } from '../host/contracts';
import { fileName } from '../domain/media';
import { PlayerError } from './service';

export function createMockMediaService(options: { quota?: boolean } = {}): MediaServiceFactory {
  return {
    async create() {
      if (options.quota) throw new PlayerError('quota', 'All 8 playback slots are in use');
      let path = '';
      let position = 0;
      let rate = 1;
      let paused = false;
      let generation = 0;
      const response = (): OpenResponse => ({
        generation: ++generation, effectiveStart: position, requestedStart: position,
        seekPrecision: 'exact', playlist: `/media/${generation}/index.m3u8`, mode: path.endsWith('.mkv') ? 'transcode' : 'copy',
        media: { name: fileName(path), duration: path.includes('Coastline') ? 248 : path.includes('City') ? 320 : 192, videoCodec: path.endsWith('.mkv') ? 'hevc' : 'h264', width: 3840, height: 2160, hdr: false, hdrToneMapped: false, audioTracks: [{ id: 1, label: 'Original', language: 'en', codec: 'aac' }, { id: 2, label: 'Stereo', language: 'zh', codec: 'aac' }], subtitleTracks: [{ id: 3, label: 'English', language: 'en' }] },
      });
      const session: PlaybackSession = {
        demo: true,
        async open(value, config = {}) { path = value; position = config.start ?? 0; rate = config.rate ?? 1; paused = false; return response(); },
        async seek(value, config = {}) { position = value; rate = config.rate ?? rate; return response(); },
        async pause(value, isPaused) { position = value; paused = isPaused; },
        async progress(value, isPaused, speed) { position = value; paused = isPaused; rate = speed; },
        async status() { return { generation, position, paused, rate, pipelineState: paused ? 'paused' : 'playing', needReload: false, cacheBytes: 8 * 1024 * 1024 }; },
        async close() {},
        playlistUrl() { return ''; },
        async fetchSubtitle() { return new Blob(['WEBVTT\n\n00:00:03.000 --> 00:00:09.000\nA little space to slow down.\n'], { type: 'text/vtt' }); },
        async selectSubtitle() { return '/api/subtitle?track=3'; },
      };
      return session;
    },
  };
}
