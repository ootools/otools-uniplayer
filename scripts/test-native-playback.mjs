#!/usr/bin/env node
// macOS-only, code-level integration test. No browser automation or OTools window control.
// node scripts/test-native-playback.mjs [--probe] [--service /absolute/path/to/service]
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { configuredMediaTool } from '../tests/support/media-tools.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const pageURL = 'http://127.0.0.1:6576/tests/native-playback.html';
const probeOnly = process.argv.includes('--probe');
const visibility = process.argv.includes('--foreground') ? 'foreground' : 'background';
const serviceIndex = process.argv.indexOf('--service');
const serviceBinary = serviceIndex >= 0 ? process.argv[serviceIndex + 1] :
  process.env.UNIPLAYER_MEDIA_SERVICE ?? path.join(root, 'service/target/debug/otools-media-service');
const ffmpeg = configuredMediaTool('ffmpeg');
const ffprobe = configuredMediaTool('ffprobe');
const children = new Set();
const childStates = new Map();
const ownedWorkers = new Set();
const execFileAsync = promisify(execFile);
const services = [];
const secretValues = [];
const reports = [];
const orchestrationStartedAt = Date.now();
let outputDirectory;
let cleanupRunning;
let overallTimer;
let workerTimer;
let workerSample;
let workerSampleError;
let serviceDiagnosticTimer;
let serviceDiagnosticBusy = false;
let nativeLastPageStage = 'navigation';
let nativeProcessStartedAt;

function redact(value) {
  let text = String(value);
  for (const secret of secretValues) {
    text = text.split(secret).join('[redacted]');
    text = text.split(JSON.stringify(secret).slice(1, -1)).join('[redacted]');
  }
  return text.replace(/Bearer\s+[0-9a-f]{64}/gi, 'Bearer [redacted]');
}
function report(entry) {
  const sanitized = JSON.parse(redact(JSON.stringify({ orchestrationElapsedSeconds: Number(((Date.now() - orchestrationStartedAt) / 1000).toFixed(3)),
    orchestrationTimestampUTC: new Date().toISOString(), ...entry })));
  reports.push(sanitized);
  process.stdout.write(`${JSON.stringify(sanitized)}\n`);
}
function fail(message) { throw new Error(message); }
function assert(condition, message) { if (!condition) fail(message); }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function start(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: outputDirectory, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env }, ...options,
  });
  children.add(child);
  const state = { child, stdout: '', stderr: '', exited: false, error: null };
  childStates.set(child, state);
  child.stdout.on('data', (data) => { state.stdout = (state.stdout + data).slice(-256 * 1024); });
  child.stderr.on('data', (data) => { state.stderr = (state.stderr + data).slice(-256 * 1024); });
  state.exit = new Promise((resolve) => {
    child.once('error', (error) => { state.error = error; state.exited = true; resolve({ code: null, signal: 'spawn-error' }); });
    child.once('exit', (code, signal) => { state.exited = true; resolve({ code, signal }); });
  });
  child.stdin.on('error', () => {});
  return state;
}
function signalGroup(child, signal) {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
}
async function run(command, args, timeoutMs, options = {}) {
  const state = start(command, args, options);
  state.child.stdin.end();
  const timer = setTimeout(() => { signalGroup(state.child, 'SIGTERM'); setTimeout(() => signalGroup(state.child, 'SIGKILL'), 1000).unref(); }, timeoutMs);
  const result = await state.exit;
  clearTimeout(timer);
  assert(result.code === 0, `${path.basename(command)} failed (${result.signal ?? result.code}): ${redact(state.stderr).slice(-2500)}`);
  return state;
}
async function waitFor(check, timeoutMs, message) {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    assert(Date.now() < end, message);
    await delay(40);
  }
}
async function ensurePage() {
  const response = await fetch(pageURL, { signal: AbortSignal.timeout(5000), redirect: 'error' });
  assert(response.status === 200 && (await response.text()).includes('UniPlayer native playback integration'), 'Vite must serve the real native test page on port 6576; start pnpm dev first.');
}
async function createFixture(index) {
  const directory = await mkdtemp(path.join(outputDirectory, `fixture-${index + 1}-`));
  const filename = path.join(directory, index === 0 ? 'copy.mp4' : 'transcode.mkv');
  secretValues.push(filename);
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24',
    '-f', 'lavfi', '-i', `sine=frequency=${index === 0 ? 440 : 660}:sample_rate=48000`,
    '-t', '18', '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '2',
    '-pix_fmt', 'yuv420p', '-profile:v', 'baseline', '-g', '48', '-keyint_min', '48', '-sc_threshold', '0',
    '-c:a', index === 0 ? 'aac' : 'flac'];
  if (index === 0) args.push('-movflags', '+faststart');
  args.push(filename);
  await run(ffmpeg, args, 15_000);
  const probe = await run(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filename], 5000);
  const media = JSON.parse(probe.stdout);
  assert(Number(media.format.duration) >= 17, 'FFmpeg synthetic media duration is too short.');
  const video = media.streams.find((stream) => stream.codec_type === 'video');
  const audio = media.streams.find((stream) => stream.codec_type === 'audio');
  assert(video?.codec_name === 'h264' && audio?.codec_name === (index === 0 ? 'aac' : 'flac'), 'Synthetic fixture codecs do not match the independent expected copy/transcode modes.');
  report({ event: 'fixture', video: index + 1, duration: Number(media.format.duration), videoCodec: video.codec_name, audioCodec: audio.codec_name });
  return filename;
}
async function launchService(filename, index) {
  const temp = await mkdtemp(path.join(outputDirectory, `service-${index + 1}-`));
  const token = randomBytes(32).toString('hex');
  secretValues.push(token);
  const state = start(serviceBinary, ['--stdio'], { env: { ...process.env, FFMPEG_PATH: ffmpeg, FFPROBE_PATH: ffprobe, TMPDIR: temp, TMP: temp, TEMP: temp } });
  state.child.stdin.write(`${JSON.stringify({ type: 'init', token, origin: new URL(pageURL).origin })}\n`);
  await waitFor(() => state.stdout.includes('\n') || state.exited, 6000, 'Media service did not send its first-line ready handshake.');
  assert(!state.exited, 'Media service stopped before its ready handshake.');
  const line = state.stdout.split('\n')[0];
  assert(!line.includes(token) && !line.includes(filename), 'The media service ready handshake exposed a secret.');
  const ready = JSON.parse(line);
  assert(ready.event === 'ready' && Number.isInteger(ready.port) && ready.port > 0 && ready.port <= 65535, 'Media service returned an invalid first-line ready port.');
  const service = Object.assign(state, { origin: `http://127.0.0.1:${ready.port}`, token, path: filename });
  services.push(service);
  report({ event: 'service-ready', video: index + 1, protocol: ready.protocol ?? null, loopback: true });
  // A real negative control ensures the media pipeline is not an unauthenticated
  // success path. The WebKit page then exercises exact-Origin CORS + Bearer itself.
  const unauthorized = await fetch(`${service.origin}/api/status`, { headers: { Origin: new URL(pageURL).origin }, signal: AbortSignal.timeout(2000) });
  assert(unauthorized.status === 401 || unauthorized.status === 403, 'The service accepted a request without its Bearer token.');
  const crossOrigin = await fetch(`${service.origin}/api/status`, {
    headers: { Authorization: `Bearer ${token}`, Origin: 'http://127.0.0.1:6577' }, signal: AbortSignal.timeout(2000),
  });
  assert(crossOrigin.status === 403, 'The service accepted an unrelated HTTP Origin.');
  report({ event: 'auth-negative-controls', video: index + 1, missingBearerStatus: unauthorized.status, wrongOriginStatus: crossOrigin.status });
  return service;
}
async function serviceDiagnostic() {
  if (serviceDiagnosticBusy || cleanupRunning) return;
  serviceDiagnosticBusy = true;
  try {
    await Promise.all(services.map(async (service, index) => {
      if (service.exited) return;
      const began = Date.now();
      try {
        const response = await fetch(`${service.origin}/api/status`, {
          headers: { Origin: new URL(pageURL).origin, Authorization: `Bearer ${service.token}` },
          signal: AbortSignal.timeout(2000),
        });
        const state = response.ok ? await response.json() : null;
        report({ event: 'native-service-probe', video: index + 1, lastPageStage: nativeLastPageStage,
          nativeProcessElapsedSeconds: Number(((Date.now() - nativeProcessStartedAt) / 1000).toFixed(3)),
          durationSeconds: Number(((Date.now() - began) / 1000).toFixed(3)), status: response.status,
          state: state && { generation: state.generation, paused: state.paused, pipelineState: state.pipelineState, position: state.position, needReload: state.needReload } });
      } catch (error) {
        report({ event: 'native-service-probe', video: index + 1, lastPageStage: nativeLastPageStage,
          durationSeconds: Number(((Date.now() - began) / 1000).toFixed(3)), errorName: error.name });
      }
    }));
  } finally { serviceDiagnosticBusy = false; }
}
function processExists(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
async function sampleWorkers() {
  if (workerSample) return workerSample;
  workerSample = (async () => {
    const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'pid=,ppid='], { timeout: 2000 });
    const rows = stdout.trim().split('\n').map((line) => line.trim().split(/\s+/).map(Number));
    const descendants = new Set(services.filter((service) => !service.exited).map((service) => service.child.pid));
    for (let pass = 0; pass < 5; pass++) {
      for (const [pid, parent] of rows) {
        if (descendants.has(parent) && !descendants.has(pid)) { descendants.add(pid); ownedWorkers.add(pid); }
      }
    }
  })().finally(() => { workerSample = undefined; });
  return workerSample;
}
async function cleanup() {
  if (cleanupRunning) return cleanupRunning;
  cleanupRunning = (async () => {
    clearTimeout(overallTimer);
    clearInterval(workerTimer);
    clearInterval(serviceDiagnosticTimer);
    await workerSample?.catch(() => {});
    if (services.length) await sampleWorkers().catch((error) => { workerSampleError = error; });
    await Promise.allSettled(services.map(async (service) => {
      if (service.exited) return;
      await fetch(`${service.origin}/api/close`, {
        method: 'POST', headers: { Origin: new URL(pageURL).origin, Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' },
        body: '{}', signal: AbortSignal.timeout(2000),
      });
    }));
    for (const child of children) child.stdin.end();
    await Promise.race([Promise.all(services.map((service) => service.exit)), delay(2500)]);
    const workersRemainingAfterServiceExit = [...ownedWorkers].filter(processExists);
    for (const child of children) signalGroup(child, 'SIGTERM');
    await delay(200);
    for (const child of children) signalGroup(child, 'SIGKILL');
    await Promise.race([Promise.all([...childStates.values()].map((state) => state.exit)), delay(1000)]);
    const alive = [];
    for (const child of children) {
      if (!child.pid) continue;
      try { process.kill(-child.pid, 0); alive.push(child.pid); } catch (error) { if (error.code !== 'ESRCH') alive.push(child.pid); }
    }
    const workersRemaining = [...ownedWorkers].filter(processExists);
    for (const pid of workersRemaining) {
      try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    report({ event: 'cleanup', serviceRootsExited: services.filter((service) => service.exited).length, serviceRoots: services.length,
      observedServiceWorkers: ownedWorkers.size, serviceWorkersRemainingAfterExit: workersRemainingAfterServiceExit.length,
      ownedProcessGroupsRemaining: alive.length, serviceWorkersRemaining: workersRemaining.length });
    assert(alive.length === 0 && workersRemainingAfterServiceExit.length === 0 && workersRemaining.length === 0, 'Native test left an owned service/worker process running.');
    assert(!workerSampleError, 'Unable to verify native-test worker cleanup.');
    for (let index = 0; index < services.length; index++) {
      await writeFile(path.join(outputDirectory, `service-${index + 1}.stderr.log`), redact(services[index].stderr), { mode: 0o600 });
    }
  })();
  return cleanupRunning;
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  void cleanup().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
});

async function main() {
  assert(process.platform === 'darwin', 'This integration test requires macOS AppKit/WKWebView and xcrun Swift.');
  assert(typeof serviceBinary === 'string' && path.isAbsolute(serviceBinary), 'Use an absolute --service executable path.');
  outputDirectory = await mkdtemp('/tmp/otools-uniplayer-native-');
  await chmod(outputDirectory, 0o700);
  report({ event: 'artifacts', directory: outputDirectory, probeOnly, scope: 'Standalone WKWebView; installed OTools is not controlled or tested' });
  overallTimer = setTimeout(() => { report({ event: 'failure', message: 'Native integration orchestration exceeded 95 seconds.' }); void cleanup().finally(() => process.exit(1)); }, 95_000);
  await ensurePage();
  const executable = path.join(outputDirectory, 'native-webview');
  await run('/usr/bin/xcrun', ['swiftc', '-swift-version', '6', '-parse-as-library', path.join(root, 'tests/native-webview.swift'), '-o', executable], 20_000);
  report({ event: 'swift-compile', status: 'passed', swiftLanguageVersion: 6 });
  if (!probeOnly) {
    const fixtures = await Promise.all([0, 1].map(createFixture));
    await Promise.all(fixtures.map(launchService));
    // Keep service ordering aligned with the independently verified fixtures.
    services.sort((a, b) => fixtures.indexOf(a.path) - fixtures.indexOf(b.path));
    workerTimer = setInterval(() => { void sampleWorkers().catch((error) => { workerSampleError = error; }); }, 150);
  }
  const state = start(executable, []);
  nativeProcessStartedAt = Date.now();
  if (!probeOnly) serviceDiagnosticTimer = setInterval(() => { void serviceDiagnostic(); }, 8000);
  const config = { pageURL, probeOnly, visibility, services: services.map((service) => ({ origin: service.origin, token: service.token, path: service.path })) };
  state.child.stdin.end(`${JSON.stringify(config)}\n`);
  let pending = '';
  const nativeReports = [];
  state.child.stdout.on('data', (chunk) => {
    pending += chunk;
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
      try {
        const entry = JSON.parse(redact(line));
        if (typeof entry.stage === 'string') nativeLastPageStage = entry.stage;
        nativeReports.push(entry); report(entry);
      } catch { report({ event: 'runner-non-json-output', suppressed: true }); }
    }
  });
  const timer = setTimeout(() => signalGroup(state.child, 'SIGTERM'), 53_000);
  const result = await state.exit;
  clearTimeout(timer);
  clearInterval(serviceDiagnosticTimer);
  await writeFile(path.join(outputDirectory, 'native.stderr.log'), redact(state.stderr), { mode: 0o600 });
  assert(result.code === 0 && nativeReports.some((entry) => entry.event === 'result' && entry.status === 'passed'), 'Native WKWebView integration did not produce a passing result.');
  if (!probeOnly) {
    for (const event of ['advancing', 'seek-advancing', 'pause-isolation']) assert(nativeReports.some((entry) => entry.event === event), `Missing real native playback evidence: ${event}.`);
  }
}

let failed = false;
try { await main(); }
catch (error) { failed = true; report({ event: 'failure', message: redact(error.message) }); }
finally {
  try { await cleanup(); } catch (error) { failed = true; report({ event: 'cleanup-failure', message: redact(error.message) }); }
  if (outputDirectory) await writeFile(path.join(outputDirectory, 'report.json'), `${JSON.stringify(reports, null, 2)}\n`, { mode: 0o600 });
}
process.exitCode = failed ? 1 : 0;
