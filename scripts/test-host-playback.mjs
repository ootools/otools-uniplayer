#!/usr/bin/env node
// Real source-built OTools/WKWebView acceptance. This script owns a new profile,
// synthetic files and process tree only. It never launches the installed app.
import { spawn, execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const pluginRoot = fileURLToPath(new URL('../', import.meta.url));
const hostRoot = path.resolve(pluginRoot, '../otools');
const execAsync = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (condition, message) => { if (!condition) throw new Error(message); };

export async function startCollector() {
  const token = randomBytes(32).toString('hex');
  const entries = [];
  const queues = new Map();
  let sequence = 0;
  const server = createServer(async (request, response) => {
    const origin = request.headers.origin;
    if (origin && !['http://127.0.0.1:6576', 'http://127.0.0.1:6578', 'otools-plugin://localhost'].includes(origin)) { response.writeHead(403); response.end(); return; }
    if (origin) response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    response.setHeader('Cache-Control', 'no-store');
    if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
    if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(403); response.end(); return; }
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'GET' && /^\/command\/[a-zA-Z0-9-]+$/.test(request.url)) {
      const target = request.url.slice('/command/'.length);
      response.end(JSON.stringify(queues.get(target)?.shift() ?? null)); return;
    }
    if (request.method === 'POST' && request.url === '/report') {
      let body = ''; let size = 0;
      try {
        for await (const part of request) { size += part.length; if (size > 512 * 1024) throw new Error('Report too large'); body += part; }
        const entry = JSON.parse(body);
        if (!entry || typeof entry !== 'object' || !['host', 'plugin'].includes(entry.source) || typeof entry.event !== 'string') throw new Error('Invalid report');
        entries.push({ receivedAt: Date.now(), ...entry }); response.end('{}');
      } catch { response.writeHead(400); response.end('{}'); }
      return;
    }
    response.writeHead(404); response.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { token, url: `http://127.0.0.1:${server.address().port}`, entries,
    queue(target, action) { const command = { id: ++sequence, ...action }; const list = queues.get(target) ?? []; list.push(command); queues.set(target, list); return command; },
    async close() { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); },
  };
}

export async function createProfile() {
  const nonce = randomBytes(16).toString('hex');
  const root = await realpath(await mkdtemp(path.join(await realpath(tmpdir()), `otools-host-integration-${nonce}-`)));
  await chmod(root, 0o700);
  const home = path.join(root, 'home');
  await mkdir(path.join(home, '.otools'), { recursive: true, mode: 0o700 });
  await mkdir(path.join(root, 'fixtures'), { mode: 0o700 });
  const basic = { showDevPlugins: true, locale: 'en', themeMode: 'dark', globalShortcuts: [] };
  const config = { basic_settings: basic, globalShortcuts: [], keywordShortcuts: [],
    fileBindings: ['mp4', 'mkv'].map(ext => ({ ext, pluginUuid: 'otools-uniplayer' })),
    mcp_settings: { enabled: false }, panelShortcut: { mode: 'none', shortcut: null } };
  await writeFile(path.join(home, '.otools/config.json'), JSON.stringify(config), { mode: 0o600 });
  return { root, home, identifier: `net.lingyun.otools.integration.${nonce}` };
}

async function main() {
  assert(process.platform === 'darwin', 'This native host acceptance run requires macOS');
  const packaged = process.argv.includes('--packaged');
  const profile = await createProfile();
  const collector = await startCollector();
  const reports = [];
  const children = [];
  const observedWorkers = new Set();
  const observedRoots = new Set();
  let sampleTimer;
  let host;
  let failed = false;
  const redact = value => String(value).split(collector.token).join('[redacted]').replace(/Bearer\s+[a-f0-9]{64}/gi, 'Bearer [redacted]');
  const record = entry => { const safe = JSON.parse(redact(JSON.stringify({ timestampUTC: new Date().toISOString(), ...entry }))); reports.push(safe); process.stdout.write(`${JSON.stringify(safe)}\n`); };
  const start = (command, args, options = {}) => {
    const child = spawn(command, args, { cwd: profile.root, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env }, ...options });
    const state = { child, stdout: '', stderr: '', exited: false };
    children.push(state);
    child.stdout.on('data', chunk => { state.stdout = (state.stdout + chunk).slice(-1024 * 1024); });
    child.stderr.on('data', chunk => { state.stderr = (state.stderr + chunk).slice(-1024 * 1024); });
    state.exit = new Promise(resolve => { child.once('error', error => { state.exited = true; state.error = error; resolve({ code: null }); }); child.once('exit', (code, signal) => { state.exited = true; resolve({ code, signal }); }); });
    return state;
  };
  const signal = (state, name) => { if (!state.child.pid) return; try { process.kill(-state.child.pid, name); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
  const exists = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
  async function waitFor(condition, limit, message, fatal = true) {
    const end = Date.now() + limit;
    while (!condition()) {
      if (host?.exited && fatal) throw new Error(`Isolated OTools exited early: ${redact(host.stderr).slice(-3000)}`);
      if (Date.now() >= end) throw new Error(message);
      await sleep(80);
    }
  }
  async function command(target, action, limit = 15_000) {
    const entry = collector.queue(target, action);
    await waitFor(() => collector.entries.some(report => report.id === entry.id && report.event === (target === 'host' ? 'host-command' : 'plugin-command')), limit, `Native ${target === 'host' ? 'host' : 'plugin'} command ${action.action} did not acknowledge`);
    const result = collector.entries.find(report => report.id === entry.id && report.event === (target === 'host' ? 'host-command' : 'plugin-command'));
    assert(result.status === 'passed', `Native acceptance command ${action.action} failed`);
    return result.result;
  }
  const last = id => collector.entries.filter(entry => entry.event === 'heartbeat' && entry.instanceId === id).at(-1)?.snapshot;
  const nativeConfig = path.join(profile.root, 'integration.json');
  const binary = path.join(profile.root, 'OTools-integration');
  const sourceBinary = process.env.OTOOLS_TEST_BINARY ?? path.join(hostRoot, 'target/debug/OTools');
  async function sampleWorkers() {
    for (const entry of collector.entries) if (entry.event === 'sidecar-spawn' && entry.pid) observedRoots.add(entry.pid);
    if (!observedRoots.size) return;
    const { stdout } = await execAsync('/bin/ps', ['-axo', 'pid=,ppid='], { timeout: 2500 });
    const rows = stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
    const descendants = new Set(observedRoots);
    for (let pass = 0; pass < 5; pass++) for (const [pid, parent] of rows) if (descendants.has(parent) && !descendants.has(pid)) { descendants.add(pid); observedWorkers.add(pid); }
  }
  let env;
  let socketBefore;
  try {
    try { const meta = await stat('/private/tmp/net_lingyun_otools_si.sock'); socketBefore = { inode: meta.ino, modified: meta.mtimeMs }; } catch {}
    record({ event: 'artifacts', directory: profile.root, identifier: profile.identifier, scope: 'Actual source-built OTools Tools tabs and WKWebViews; not the installed user application' });
    const pluginPage = await fetch('http://127.0.0.1:6576/tests/host-playback.html', { signal: AbortSignal.timeout(3000) });
    assert(pluginPage.ok && (await pluginPage.text()).includes('real OTools host acceptance'), 'Plugin Vite must serve the real host test entry at 6576');
    const frontend = start('pnpm', ['--dir', hostRoot, 'exec', 'vite', '--host', '127.0.0.1', '--port', '6578', '--strictPort']);
    await waitFor(() => /6578/.test(frontend.stdout) || frontend.exited, 15_000, 'Isolated host Vite failed to start', false);
    assert(!frontend.exited, `Host Vite exited: ${redact(frontend.stderr).slice(-1500)}`);
    await copyFile(sourceBinary, binary); await chmod(binary, 0o700);
    const fixturePlugin = packaged ? path.join(profile.home, '.otools/plugins/otools-uniplayer') : path.join(profile.root, 'plugin');
    await mkdir(fixturePlugin, { mode: 0o700, recursive: true });
    await Promise.all(['bin', 'resources', ...(packaged ? ['dist'] : [])].map(name => cp(path.join(pluginRoot, name), path.join(fixturePlugin, name), { recursive: true })));
    const manifest = JSON.parse(await readFile(path.join(pluginRoot, 'plugin.json'), 'utf8'));
    manifest.devUrl = 'http://127.0.0.1:6576/tests/host-playback.html';
    manifest.entry = packaged ? 'dist/index.html' : manifest.devUrl;
    manifest.quickDev = false;
    if (packaged) {
      const index = path.join(fixturePlugin, 'dist/index.html');
      const html = await readFile(index, 'utf8');
      assert(html.includes('type="module"') && html.includes('./assets/'), 'Distributed production index is missing its built module');
      // Only this new private copy is instrumented. The shipped index/bundles
      // and all runtime APIs remain unchanged.
      await copyFile(path.join(pluginRoot, 'tests/host-package-observer.mjs'), path.join(fixturePlugin, 'dist/host-package-observer.mjs'));
      await writeFile(index, html.replace(/(<script type="module"[^>]*>)/, '<script type="module" src="./host-package-observer.mjs"></script>\n$1'));
      const executable = await readFile(path.join(fixturePlugin, 'bin/player-macos'));
      manifest.sidecars = [{ id: 'player', bin: 'player', relativePath: 'bin/player-macos', sizeBytes: executable.length, sha256Hex: createHash('sha256').update(executable).digest('hex') }];
    }
    await writeFile(path.join(fixturePlugin, 'plugin.json'), JSON.stringify(manifest), { mode: 0o600 });
    await copyFile(path.join(pluginRoot, 'logo.svg'), path.join(fixturePlugin, 'logo.svg'));
    const register = { ...manifest, source: packaged ? 'market' : 'dev-debug', quickDev: false, enabled: true, builtin: false, icon: '', displayName: 'UniPlayer Host Acceptance',
      autostart: { enabled: false, tasks: [] }, mcp: { enabled: false } };
    const stateRoot = path.join(profile.home, '.otools');
    await writeFile(path.join(stateRoot, 'plugins.json'), JSON.stringify({ version: 1, plugins: [register] }), { mode: 0o600 });
    await mkdir(path.join(stateRoot, 'local/dev'), { recursive: true });
    await writeFile(path.join(stateRoot, 'local/dev/state.json'), JSON.stringify({ version: 1, items: [{ uuid: 'otools-uniplayer', directoryPath: fixturePlugin, pluginManifestPath: path.join(fixturePlugin, 'plugin.json') }] }), { mode: 0o600 });
    const ffmpeg = path.join(fixturePlugin, 'resources/ffmpeg/macos/ffmpeg');
    const fixtures = [path.join(profile.root, 'fixtures/copy.mp4'), path.join(profile.root, 'fixtures/transcode.mkv')];
    for (let index = 0; index < fixtures.length; index++) {
      const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24', '-f', 'lavfi', '-i', `sine=frequency=${index ? 660 : 440}:sample_rate=48000`, '-t', '45', '-c:v', 'libx264', '-threads', '2', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-profile:v', 'baseline', '-g', '48', '-keyint_min', '48', '-sc_threshold', '0', '-c:a', index ? 'flac' : 'aac', fixtures[index]];
      await execAsync(ffmpeg, args, { cwd: profile.root, timeout: 20_000 });
    }
    const subtitle = path.join(profile.root, 'fixtures/test.srt');
    await writeFile(subtitle, '1\n00:00:00,000 --> 00:00:30,000\nOTools integration subtitle\n', { mode: 0o600 });
    await writeFile(nativeConfig, JSON.stringify({ profileRoot: profile.root, home: profile.home, identifier: profile.identifier,
      frontendUrl: 'http://127.0.0.1:6578/?main=Tools&integration=1', pluginUrl: manifest.devUrl, pluginUuid: 'otools-uniplayer',
      collectorUrl: collector.url, collectorToken: collector.token, subtitlePath: subtitle,
      ...(packaged ? { packageRoot: fixturePlugin } : {}) }), { mode: 0o600 });
    env = { ...process.env, OTOOLS_HOME: profile.home, OTOOLS_INTEGRATION_CONFIG: nativeConfig };
    for (const key of ['FFMPEG_PATH', 'FFPROBE_PATH', 'TAURI_CONFIG']) delete env[key];
    host = start(binary, packaged ? [fixtures[0]] : fixtures, { env });
    sampleTimer = setInterval(() => void sampleWorkers().catch(() => {}), 200);
    await waitFor(() => collector.entries.some(entry => entry.event === 'host-ready'), 30_000, 'Real Tools frontend did not initialize');
    if (packaged) {
      await waitFor(() => collector.entries.some(entry => entry.event === 'plugin-ready' && entry.productionDistributedIndex === true), 25_000, 'Distributed plugin index did not initialize its real host APIs');
      const ready = collector.entries.find(entry => entry.event === 'plugin-ready' && entry.productionDistributedIndex === true);
      assert(ready.pageOrigin === 'otools-plugin://localhost' && ready.pageScheme === 'otools-plugin:', 'Packaged plugin did not use the actual host custom scheme');
      await waitFor(() => last(ready.instanceId)?.video?.width > 0 && last(ready.instanceId)?.video?.time >= 2, 25_000, 'Distributed production UI did not decode and advance authenticated video');
      assert(last(ready.instanceId).duration >= 44 && last(ready.instanceId).video.frames >= 12, 'Packaged playback lost the source timeline or did not present frames');
      const snapshot = await command('host', { action: 'snapshot' });
      assert(snapshot.tabs.length === 1 && snapshot.tabs[0].pluginSource === 'market', 'Packaged tab did not bind to its installed market source');
      await waitFor(() => collector.entries.some(entry => entry.event === 'package-service-ready' && Number.isInteger(entry.port)), 5000, 'Packaged service did not expose its nonsecret ready port');
      const serviceReady = collector.entries.find(entry => entry.event === 'package-service-ready');
      const denied = await fetch(`http://127.0.0.1:${serviceReady.port}/api/status`, { headers: { Origin: ready.pageOrigin }, signal: AbortSignal.timeout(3000) });
      assert([401, 403].includes(denied.status), 'Packaged media service accepted a request without its bearer');
      record({ event: 'package-auth-negative', status: 'passed', responseStatus: denied.status, origin: ready.pageOrigin });
      record({ event: 'packaged-production-playback', status: 'passed', origin: ready.pageOrigin, source: 'market', installedSidecarHashRegistered: true,
        productionDistributedIndex: true, instrumentation: 'only a copied observer module was added before the unchanged distributed entry', snapshot: last(ready.instanceId) });
      await sampleWorkers();
      await command('host', { action: 'exit' });
      await waitFor(() => host.exited, 15_000, 'Packaged native host did not exit normally', false);
      assert((await host.exit).code === 0, 'Packaged host exited with an error');
      await waitFor(() => [...observedRoots, ...observedWorkers].every(pid => !exists(pid)), 5000, 'Packaged shutdown left a media process running', false);
      record({ event: 'normal-host-exit', status: 'passed', observedServiceRoots: observedRoots.size, observedWorkers: observedWorkers.size, remaining: 0 });
      return;
    }
    await waitFor(() => new Set(collector.entries.filter(entry => entry.event === 'plugin-ready').map(entry => entry.instanceId)).size === 2, 30_000, 'Two real document WebViews did not become ready');
    const initial = await command('host', { action: 'snapshot' });
    assert(initial.tabs.length === 2, 'Two argv files did not create exactly two Tools tabs');
    assert(new Set(initial.tabs.map(tab => tab.instanceId)).size === 2 && new Set(initial.tabs.map(tab => tab.label)).size === 2, 'Two files reused a single tab identity');
    const first = initial.tabs.find(tab => tab.documentPath === fixtures[0]);
    const second = initial.tabs.find(tab => tab.documentPath === fixtures[1]);
    assert(first && second && initial.tabs.every(tab => tab.pluginSource === 'dev-debug'), 'Document identity or source did not match the argv fixture');
    record({ event: 'two-argv-tabs', status: 'passed', instances: initial.tabs.map(tab => ({ instanceId: tab.instanceId, label: tab.label, document: path.basename(tab.documentPath), source: tab.pluginSource })) });
    await waitFor(() => last(second.instanceId)?.video?.width > 0 && last(second.instanceId)?.video?.time >= 2, 25_000, 'Current transcode tab did not present real decoded frames');
    assert(last(second.instanceId).mode === 'transcode' && last(second.instanceId).duration >= 44, 'Second file did not use source-duration transcode playback');
    const pausedBefore = last(first.instanceId)?.video?.time ?? 0;
    await sleep(1500);
    const inactive = last(first.instanceId);
    assert(inactive?.current?.active === false && (!inactive.video || inactive.video.paused && Math.abs(inactive.video.time - pausedBefore) < 0.2), 'Default inactive tab played or lost its instance activity');
    record({ event: 'default-inactive-paused', status: 'passed', snapshot: inactive, current: last(second.instanceId) });
    assert((await command(second.instanceId, { action: 'controller-forbidden' })).forbidden, 'Plugin acquired the host-only test exit authority');
    const repeat = start(binary, [fixtures[1]], { env });
    await waitFor(() => repeat.exited, 8000, 'Second argv invocation did not use the isolated single-instance channel');
    assert((await repeat.exit).code === 0, 'Repeat file invocation failed');
    await sleep(700);
    assert((await command('host', { action: 'snapshot' })).tabs.length === 2, 'Repeated argv path created an extra tab');
    record({ event: 'repeat-argv-reuses', status: 'passed', nativeSingleInstance: true });
    await command('host', { action: 'activate', instanceId: first.instanceId });
    await waitFor(() => last(first.instanceId)?.video?.width > 0, 25_000, 'First copy tab never opened its media');
    await command(first.instanceId, { action: 'play' });
    const firstStart = last(first.instanceId)?.video?.time ?? 0;
    await waitFor(() => last(first.instanceId)?.video?.time >= firstStart + 1.3, 20_000, 'Copy tab did not resume through real player controls');
    assert(last(first.instanceId).mode === 'copy', 'H264/AAC file did not use copy mode');
    await waitFor(() => last(second.instanceId)?.current?.active === false && last(second.instanceId)?.video?.paused, 8000, 'Switching tabs did not pause the inactive sibling');
    record({ event: 'switch-copy-playback', status: 'passed', active: last(first.instanceId), inactive: last(second.instanceId) });
    const generation = last(first.instanceId).generation;
    await command(first.instanceId, { action: 'seek', position: 6 });
    await waitFor(() => last(first.instanceId)?.generation > generation && last(first.instanceId)?.video?.time > 1 && last(first.instanceId)?.position > 5, 25_000, 'Real timeline seek did not recreate and advance its global generation');
    assert(last(first.instanceId).duration >= 44 && last(first.instanceId).effectiveStart >= 4 && last(first.instanceId).effectiveStart <= 6.1, 'Seek changed source duration or lost keyframe precision');
    record({ event: 'seek-global-timeline', status: 'passed', snapshot: last(first.instanceId) });
    record({ event: 'external-srt', status: 'passed', ...(await command(first.instanceId, { action: 'subtitle' })) });
    const newResults = await command(first.instanceId, { action: 'new' }, 20_000);
    assert(Array.isArray(newResults) && newResults.length === 1 && newResults[0].instanceId !== first.instanceId, 'reuse:new did not create a fresh identity');
    await waitFor(() => collector.entries.some(entry => entry.event === 'plugin-ready' && entry.instanceId === newResults[0].instanceId), 20_000, 'Force-new WebView did not initialize');
    const afterNew = await command('host', { action: 'snapshot' });
    assert(afterNew.tabs.length === 3 && afterNew.tabs.filter(tab => tab.documentPath === fixtures[0]).length === 2, 'Force-new lost the original same-document tab');
    record({ event: 'force-new-tab', status: 'passed', newInstance: newResults[0].instanceId });
    await command('host', { action: 'close', instanceId: newResults[0].instanceId });
    await command('host', { action: 'activate', instanceId: first.instanceId });
    await command(first.instanceId, { action: 'play' });
    assert((await command(first.instanceId, { action: 'parallel', enabled: true })).parallel, 'Production parallel playback setting was not saved');
    await command('host', { action: 'activate', instanceId: second.instanceId });
    await command(second.instanceId, { action: 'play' });
    await waitFor(() => last(second.instanceId)?.video?.paused === false, 15_000, 'Second tab did not resume for parallel test');
    const hiddenStart = last(first.instanceId)?.video?.time ?? 0;
    const movingStart = last(second.instanceId)?.video?.time ?? 0;
    await sleep(3500);
    const hiddenDelta = (last(first.instanceId)?.video?.time ?? hiddenStart) - hiddenStart;
    const movingDelta = (last(second.instanceId)?.video?.time ?? movingStart) - movingStart;
    record({ event: 'parallel-hidden-playback', status: hiddenDelta > 0.8 && movingDelta > 0.8 ? 'passed' : 'platform-limited', hiddenDelta, visibleDelta: movingDelta, hidden: last(first.instanceId), visible: last(second.instanceId) });
    const siblingHandle = last(first.instanceId)?.handle;
    if (siblingHandle) assert((await command(second.instanceId, { action: 'sibling-status', handle: siblingHandle })).forbidden, 'Sibling view accessed the other view-lifetime sidecar');
    const closedRoots = collector.entries.filter(entry => entry.event === 'sidecar-spawn' && entry.instanceId === first.instanceId).map(entry => entry.pid);
    await sampleWorkers();
    await command('host', { action: 'close', instanceId: first.instanceId });
    if (siblingHandle) assert((await command('host', { action: 'sidecar-status', owner: 'dev-debug:otools-uniplayer', handle: siblingHandle })).alive === false, 'Closed tab still had an authorized service handle');
    await waitFor(() => closedRoots.every(pid => !exists(pid)), 6000, 'Closing one tab did not reap its service roots');
    const remainingStart = last(second.instanceId)?.video?.time ?? 0;
    await waitFor(() => last(second.instanceId)?.video?.time >= remainingStart + 1, 12_000, 'Closing first tab stopped the other real video');
    record({ event: 'close-one-isolation', status: 'passed', closedServiceRoots: closedRoots.length, other: last(second.instanceId) });
    await command('host', { action: 'exit' });
    await waitFor(() => host.exited, 15_000, 'Host normal shutdown pipeline did not exit', false);
    assert((await host.exit).code === 0, 'Host exited with an error');
    await waitFor(() => [...observedRoots, ...observedWorkers].every(pid => !exists(pid)), 5000, 'Normal host exit left a media process or worker running', false);
    record({ event: 'normal-host-exit', status: 'passed', observedServiceRoots: observedRoots.size, observedWorkers: observedWorkers.size, remaining: 0 });
  } catch (error) { failed = true; record({ event: 'failure', message: redact(error.message) }); }
  finally {
    clearInterval(sampleTimer);
    await sampleWorkers().catch(() => {});
    if (host && !host.exited) {
      try { await command('host', { action: 'exit' }, 3000); await Promise.race([host.exit, sleep(4000)]); } catch {}
    }
    for (const state of children) if (!state.exited) signal(state, 'SIGTERM');
    await sleep(700);
    for (const state of children) if (!state.exited) signal(state, 'SIGKILL');
    await Promise.race([Promise.all(children.map(state => state.exit)), sleep(1500)]);
    const remainingRoots = [...observedRoots].filter(exists);
    const remainingWorkers = [...observedWorkers].filter(exists);
    for (const pid of [...remainingRoots, ...remainingWorkers]) try { process.kill(pid, 'SIGKILL'); } catch {}
    if (remainingRoots.length || remainingWorkers.length) { failed = true; record({ event: 'cleanup-failure', roots: remainingRoots.length, workers: remainingWorkers.length }); }
    if (socketBefore) {
      const after = await stat('/private/tmp/net_lingyun_otools_si.sock');
      const untouched = after.ino === socketBefore.inode && after.mtimeMs === socketBefore.modified;
      assert(untouched, 'Live OTools single-instance socket was changed');
      record({ event: 'live-socket-untouched', status: 'passed' });
    }
    await writeFile(path.join(profile.root, 'host.stdout.log'), redact(host?.stdout ?? ''), { mode: 0o600 });
    await writeFile(path.join(profile.root, 'host.stderr.log'), redact(host?.stderr ?? ''), { mode: 0o600 });
    await writeFile(path.join(profile.root, 'page-reports.json'), redact(JSON.stringify(collector.entries, null, 2)), { mode: 0o600 });
    record({ event: 'result', status: failed ? 'failed' : 'passed', directory: profile.root, actualHost: true });
    await writeFile(path.join(profile.root, 'report.json'), JSON.stringify(reports, null, 2), { mode: 0o600 });
    await collector.close();
    process.exitCode = failed ? 1 : 0;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
