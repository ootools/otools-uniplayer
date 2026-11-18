// Real OTools test entry. The UI, adapter, player session and authenticated HLS
// are the production modules; this utility only observes boundaries and drives
// explicit acceptance actions in its own page.
import { createApp } from 'vue';
import App from '/src/App.vue';
import { createHostAdapter } from '/src/host/adapter.ts';
import { createMediaService } from '/src/player/service.ts';
import { installTheme } from '/src/theme.ts';
import '/src/styles.css';

const config = window.__OTOOLS_INTEGRATION_TEST__;
if (config?.enabled !== true || !window.otools?.instances || !window.otools?.sidecar) throw new Error('This entry requires the isolated debug OTools harness');
const id = new URLSearchParams(location.search).get('otoolsInstance');
const label = window.__TAURI_INTERNALS__?.metadata?.currentWebview?.label;
let current;
let opened;
let handle;
let servicePid;
let session;
let frames = 0;
let lastFrameTime;
let delivered = 0;
let polling = false;
let closed = false;
let heartbeatSequence = 0;
const secrets = [];
const safe = value => {
  let text = JSON.stringify(value);
  for (const secret of secrets) text = text.split(secret).join('[redacted]');
  return JSON.parse(text);
};
const report = async entry => {
  const response = await fetch(`${config.collectorUrl}/report`, { method: 'POST',
    headers: { Authorization: `Bearer ${config.collectorToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(safe({ source: 'plugin', instanceId: id, label, timestamp: Date.now(), ...entry })) });
  if (!response.ok) throw new Error('Collector rejected a native playback report');
};
const failure = async (event, error) => report({ event, errorName: error?.name, message: typeof error?.message === 'string' && !secrets.some(secret => error.message.includes(secret)) ? error.message : 'Error details suppressed' });
const api = window.otools;
const observedSidecar = {
  onEvent: async callback => api.sidecar.onEvent(event => {
    if (event.handle === handle) void report({ event: 'sidecar-event', kind: event.event, stream: event.stream, handle: event.handle });
    callback(event);
  }),
  spawn: async (...args) => {
    const result = await api.sidecar.spawn(...args); handle = result.handle; servicePid = result.pid;
    await report({ event: 'sidecar-spawn', handle, pid: servicePid, lifetime: args[2]?.lifetime });
    return result;
  },
  writeStdin: async (target, data) => {
    try { const init = JSON.parse(data); if (typeof init.token === 'string') secrets.push(init.token); } catch {}
    return api.sidecar.writeStdin(target, data);
  },
  kill: (...args) => api.sidecar.kill(...args),
  status: (...args) => api.sidecar.status(...args),
};
const host = createHostAdapter();
const originalReady = host.ready.bind(host);
host.ready = async () => {
  await originalReady(); current = await api.instances.current();
  await report({ event: 'plugin-ready', current, pageOrigin: location.origin, pageScheme: location.protocol, apiVersion: api.version ?? api.apiVersion ?? null,
    tauriInvokePresent: typeof window.__TAURI_INTERNALS__?.invoke === 'function', mediaSource: typeof MediaSource !== 'undefined' });
};
const listenFiles = host.listenFiles.bind(host);
host.listenFiles = async callback => listenFiles(files => {
  delivered += files.length;
  void report({ event: 'file-delivery', paths: files.map(file => file.path), current, delivered });
  callback(files);
});
const listenActivity = host.listenActivity.bind(host);
host.listenActivity = callback => listenActivity(active => {
  current = current ? { ...current, active } : { active };
  void report({ event: 'activity', active }); callback(active);
});
// Only the synthetic subtitle chooser is supplied by the harness. File intake,
// instance open and media data still pass through the real host/service APIs.
host.pickSubtitle = async () => config.subtitlePath;
const beforeClose = host.beforeClose.bind(host);
host.beforeClose = callback => beforeClose(async () => { closed = true; await report({ event: 'before-close' }); await callback(); await report({ event: 'close-ack' }); });
const factory = createMediaService(observedSidecar);
const observedFactory = { async create(...args) {
  session = await factory.create(...args);
  const open = session.open.bind(session);
  const seek = session.seek.bind(session);
  const status = session.status.bind(session);
  const progress = session.progress.bind(session);
  session.open = async (...values) => { opened = await open(...values); await report({ event: 'media-open', response: opened }); return opened; };
  session.seek = async (...values) => { const prior = opened?.generation; opened = await seek(...values); await report({ event: 'media-seek', requested: values[0], previousGeneration: prior, response: opened }); return opened; };
  session.status = async () => { const value = await status(); await report({ event: 'media-status', status: value }); return value; };
  session.progress = async (...values) => { await progress(...values); };
  return session;
} };
installTheme();
createApp(App, { host, service: observedFactory, initialLocale: 'en' }).mount('#app');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function observeVideo() {
  const video = document.querySelector('video');
  if (!video || video.dataset.hostObserved) return;
  video.dataset.hostObserved = 'true';
  const frame = (_now, metadata) => { frames++; lastFrameTime = metadata.mediaTime; if (!closed) video.requestVideoFrameCallback(frame); };
  video.requestVideoFrameCallback?.(frame);
  for (const name of ['playing', 'pause', 'waiting', 'stalled', 'ended', 'error']) video.addEventListener(name, () => void report({ event: 'video-event', name, snapshot: snapshot() }));
}
function snapshot() {
  const video = document.querySelector('video');
  const timeline = document.querySelector('[data-testid="timeline"]');
  return { current, handle, servicePid, generation: opened?.generation, mode: opened?.mode,
    duration: opened?.media.duration, effectiveStart: opened?.effectiveStart, delivered,
    position: timeline ? Number(timeline.value) : null, phase: document.querySelector('[role="alert"]') ? 'error' : undefined,
    visibility: document.visibilityState, video: video ? { time: video.currentTime, paused: video.paused, width: video.videoWidth,
      height: video.videoHeight, readyState: video.readyState, error: video.error?.code, frames, lastFrameTime,
      totalFrames: video.getVideoPlaybackQuality?.().totalVideoFrames ?? null } : null };
}
async function action(command) {
  switch (command.action) {
    case 'snapshot': return snapshot();
    case 'new': return api.instances.open({ files: [current?.documentPath], reuse: 'new' });
    case 'repeat': return api.instances.open({ files: [current?.documentPath], reuse: 'document' });
    case 'play': case 'pause': {
      const video = document.querySelector('video');
      if (!video) throw new Error('Playback UI has no decoded video yet');
      if (video.paused === (command.action === 'play')) document.querySelector('[data-testid="play-toggle"]').click();
      return snapshot();
    }
    case 'seek': {
      const timeline = document.querySelector('[data-testid="timeline"]');
      if (!timeline) throw new Error('Production timeline is unavailable');
      timeline.value = String(command.position); timeline.dispatchEvent(new Event('change', { bubbles: true })); return snapshot();
    }
    case 'subtitle': {
      const select = document.querySelector('select[aria-label="Subtitles"]');
      if (!select) throw new Error('Production subtitles selector is unavailable');
      select.value = 'external'; select.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(1000);
      const track = document.querySelector('track');
      if (!track?.src.startsWith('blob:')) throw new Error('External SRT did not become a local subtitle track');
      const vtt = await (await fetch(track.src)).text();
      if (!vtt.includes('OTools integration subtitle')) throw new Error('Subtitle did not contain the synthetic SRT cue');
      return { subtitleCueLoaded: true, cueCount: document.querySelector('video')?.textTracks?.[0]?.cues?.length ?? null };
    }
    case 'parallel': {
      if (!document.querySelector('.setting-row input[type="checkbox"]')) document.querySelector('[data-testid="settings-toggle"]').click();
      await sleep(50);
      const checkbox = document.querySelector('.setting-row input[type="checkbox"]');
      if (!checkbox) throw new Error('Production parallel setting is unavailable');
      checkbox.checked = command.enabled === true; checkbox.dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector('.settings-dialog header button').click();
      return { parallel: localStorage.getItem('otools-uniplayer:parallel') === 'true' };
    }
    case 'own-status': return api.sidecar.status(handle);
    case 'sibling-status': {
      try { await api.sidecar.status(command.handle); return { forbidden: false }; } catch { return { forbidden: true }; }
    }
    case 'controller-forbidden': {
      try { await window.__TAURI_INTERNALS__.invoke('otools_integration_control', { action: 'exit' }); return { forbidden: false }; } catch { return { forbidden: true }; }
    }
    default: throw new Error('Unknown fixed test-page action');
  }
}
setInterval(() => { observeVideo(); if (!closed) void report({ event: 'heartbeat', sequence: ++heartbeatSequence, snapshot: snapshot() }).catch(() => {}); }, 500);
setInterval(async () => {
  if (polling || closed || !id) return; polling = true;
  try {
    const response = await fetch(`${config.collectorUrl}/command/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${config.collectorToken}` } });
    const command = await response.json();
    if (command) {
      try { await report({ event: 'plugin-command', id: command.id, status: 'passed', result: await action(command) }); }
      catch (error) { await report({ event: 'plugin-command', id: command.id, status: 'failed' }); await failure('command-error', error); }
    }
  } catch (error) { void failure('poll-error', error).catch(() => {}); }
  finally { polling = false; }
}, 100);
window.addEventListener('error', event => void failure('page-error', event.error).catch(() => {}));
window.addEventListener('unhandledrejection', event => void failure('page-rejection', event.reason).catch(() => {}));
