import Hls from 'hls.js';
import type { AuthenticatedSession } from './service';
import type { OpenResponse, PlaybackSession } from '../host/contracts';

export interface VideoBinding { destroy(): void }

export function bindAuthenticatedHls(video: HTMLVideoElement, session: PlaybackSession, response: OpenResponse, onError: (message: string) => void): VideoBinding {
  if (session.demo) return { destroy() {} };
  if (!Hls.isSupported()) {
    onError('MSE / HLS.js is not available in this webview. Authenticated native HLS fallback has not been verified.');
    return { destroy() {} };
  }
  const authorize = (session as AuthenticatedSession).authorizeXHR;
  const hls = new Hls({
    startPosition: 0,
    maxBufferLength: 24,
    maxMaxBufferLength: 36,
    backBufferLength: 6,
    maxBufferSize: 40 * 1024 * 1024,
    enableWorker: true,
    xhrSetup(xhr, url) { authorize(xhr, url); },
  });
  hls.on(Hls.Events.ERROR, (_event, data) => {
    if (data.fatal) onError('The video stream could not be played. Try reloading this session.');
  });
  hls.attachMedia(video);
  hls.loadSource(session.playlistUrl(response));
  return { destroy() { hls.destroy(); } };
}
