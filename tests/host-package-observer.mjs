// Loaded only into a private copy of the distributed index.html. No production
// API is replaced: this observer sees the real bundled UI and sidecar events.
const config = window.__OTOOLS_INTEGRATION_TEST__;
const api = window.otools;
if (config?.enabled !== true || !api?.instances || !api?.sidecar) throw new Error('Packaged acceptance observer requires the isolated host');
const current = await api.instances.current();
const instanceId = current?.instanceId;
const label = window.__TAURI_INTERNALS__?.metadata?.currentWebview?.label;
let info = current;
let handle;
let servicePid;
let port;
let frames = 0;
let sequence = 0;
let pending = '';
let polling = false;
const report = async entry => {
  const response = await fetch(`${config.collectorUrl}/report`, { method: 'POST', headers: { Authorization: `Bearer ${config.collectorToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'plugin', instanceId, label, timestamp: Date.now(), ...entry }) });
  if (!response.ok) throw new Error('Collector rejected packaged observation');
};
const snapshot = () => {
  const video = document.querySelector('video');
  return { current: info, handle, servicePid, port, pageOrigin: location.origin,
    position: Number(document.querySelector('[data-testid="timeline"]')?.value ?? 0),
    duration: Number(document.querySelector('[data-testid="timeline"]')?.max ?? 0),
    footer: document.querySelector('.media-info')?.textContent?.trim(),
    visibility: document.visibilityState, video: video ? { time: video.currentTime, paused: video.paused, width: video.videoWidth,
      height: video.videoHeight, frames, totalFrames: video.getVideoPlaybackQuality?.().totalVideoFrames ?? null, error: video.error?.code } : null };
};
await api.sidecar.onEvent(async event => {
  if (event.event === 'output' && event.stream === 'stdout') {
    handle = event.handle;
    try { const status = await api.sidecar.status(handle); servicePid = status.pid; } catch {}
    pending += event.data;
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
      try {
        const ready = JSON.parse(line);
        if (ready.event === 'ready' && Number.isInteger(ready.port)) {
          port = ready.port;
          await report({ event: 'sidecar-spawn', handle, pid: servicePid, lifetime: 'view', packaged: true, protocol: ready.protocol });
          await report({ event: 'package-service-ready', port, origin: location.origin });
        }
      } catch {}
    }
  }
});
await api.instances.onActivity(value => { info = { ...info, active: typeof value === 'boolean' ? value : value.active }; void report({ event: 'activity', active: info.active }); });
await report({ event: 'plugin-ready', current, pageOrigin: location.origin, pageScheme: location.protocol, productionDistributedIndex: true,
  tauriInvokePresent: typeof window.__TAURI_INTERNALS__?.invoke === 'function', mediaSource: typeof MediaSource !== 'undefined' });
setInterval(() => {
  const video = document.querySelector('video');
  if (video && !video.dataset.hostObserved) {
    video.dataset.hostObserved = 'true';
    const frame = () => { frames++; video.requestVideoFrameCallback?.(frame); };
    video.requestVideoFrameCallback?.(frame);
  }
  void report({ event: 'heartbeat', sequence: ++sequence, snapshot: snapshot() }).catch(() => {});
}, 500);
setInterval(async () => {
  if (polling) return; polling = true;
  try {
    const response = await fetch(`${config.collectorUrl}/command/${encodeURIComponent(instanceId)}`, { headers: { Authorization: `Bearer ${config.collectorToken}` } });
    const command = await response.json();
    if (command) {
      try {
        let result;
        if (command.action === 'snapshot') result = snapshot();
        else if (command.action === 'play') { if (document.querySelector('video')?.paused) document.querySelector('[data-testid="play-toggle"]').click(); result = snapshot(); }
        else throw new Error('Unknown fixed packaged-page action');
        await report({ event: 'plugin-command', id: command.id, status: 'passed', result });
      } catch { await report({ event: 'plugin-command', id: command.id, status: 'failed' }); }
    }
  } finally { polling = false; }
}, 100);
