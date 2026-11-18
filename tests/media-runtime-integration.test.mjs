import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { cleanRuntimeEnvironment, inspectMacOSExecutable, verifyMediaRuntime } from '../scripts/verify-media-runtime.mjs';

const root = new URL('..', import.meta.url).pathname;
const directory = join(root, 'resources/ffmpeg/macos');
const verifyScript = join(root, 'scripts/verify-media-runtime.mjs');
const localMac = process.platform === 'darwin' && process.arch === 'arm64';
const run = (tool, args, options = {}) => execFileSync(tool, args, { encoding: 'utf8', timeout: 30_000,
  env: cleanRuntimeEnvironment(), stdio: ['ignore', 'pipe', 'pipe'], ...options });

// A source-only certificate or missing codec/filter must fail the same verification used before installation.
test('installed macOS arm64 runtime has exact source/license hashes and survives real isolated encode/decode/HLS/seek', { skip: !localMac }, async () => {
  const report = await verifyMediaRuntime({ root });
  assert.equal(report.version, '9.0.2');
  assert.equal(report.minimumMacOS, '12.0');
  assert.equal(report.smoke.relocated, true);
  assert.deepEqual(report.smoke.environment, { PATH: '/usr/bin:/bin', toolOverrides: false });
  assert.ok(report.smoke.operations.includes('h264-aac-encode-decode-probe'));
  assert.ok(report.smoke.operations.includes('flac-to-pcm'));
  assert.ok(report.smoke.operations.includes('hls-fmp4-copy-decode'));
  assert.ok(report.smoke.operations.includes('seek-transcode-decode'));
  for (const binary of Object.values(report.binaries)) {
    assert.ok(binary.dependencies.every(path => path.startsWith('/System/Library/') || path.startsWith('/usr/lib/')));
    assert.equal(binary.minimumMacOS, '12.0');
  }
});

// Changing any corresponding-source byte after certification must invalidate a package, not merely its documentation.
test('verifier CLI refuses tampered corresponding source and missing x264 licensing after runtime relocation', { skip: !localMac }, async () => {
  const temp = await mkdtemp(join(tmpdir(), 'uniplayer-runtime-tamper-'));
  try {
    await cp(directory, temp, { recursive: true });
    const metadata = JSON.parse(await readFile(join(temp, 'runtime.json'), 'utf8'));
    const archive = metadata.source?.x264?.archive;
    assert.equal(typeof archive, 'string', 'runtime must include locked x264 corresponding source');
    await writeFile(join(temp, archive), 'altered x264 corresponding source');
    let result = spawnSync(process.execPath, [verifyScript, '--directory', temp], { encoding: 'utf8', timeout: 15_000 });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /SHA256 mismatch/i);
    await copyFile(join(directory, archive), join(temp, archive));
    await rm(join(temp, 'licenses/x264/COPYING'));
    result = spawnSync(process.execPath, [verifyScript, '--directory', temp], { encoding: 'utf8', timeout: 15_000 });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /SHA256|license|runtime file/i);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

async function waitReady(child) {
  const lines = createInterface({ input: child.stdout });
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('relocated service did not become ready')), 8000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`relocated service exited before readiness (${code})`)); });
      lines.once('line', line => {
        clearTimeout(timer);
        try { resolve(JSON.parse(line)); } catch (error) { reject(error); }
      });
    });
  } finally { lines.close(); }
}

async function waitExit(child) {
  if (child.exitCode !== null) return child.exitCode;
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('relocated service did not exit on stdin EOF')); }, 5000);
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
}

// No FFMPEG_PATH/FFPROBE_PATH means this exercises the actual exe-relative service runtime contract.
test('relocated --stdio service resolves bundled tools without overrides and publishes copy/transcode HLS with real seek/subtitles', { skip: !localMac, timeout: 60_000 }, async () => {
  const temp = await mkdtemp(join(tmpdir(), 'uniplayer-runtime-stdio-'));
  let child;
  try {
    const bin = join(temp, 'bin');
    const runtime = join(temp, 'resources/ffmpeg/macos');
    await mkdir(bin, { recursive: true });
    await mkdir(runtime, { recursive: true });
    for (const name of ['ffmpeg', 'ffprobe']) {
      await inspectMacOSExecutable(join(directory, name), '12.0');
      await copyFile(join(directory, name), join(runtime, name));
      await chmod(join(runtime, name), 0o755);
    }
    await copyFile(join(root, 'bin/player-macos'), join(bin, 'player-macos'));
    await chmod(join(bin, 'player-macos'), 0o755);
    const ffmpeg = join(runtime, 'ffmpeg');
    const sample = join(temp, 'sample with spaces.mp4');
    const mkv = join(temp, 'audio-subtitles.mkv');
    const subtitle = join(temp, 'sample.srt');
    await writeFile(subtitle, '1\n00:00:01,200 --> 00:00:04,000\nHello bundled runtime\n');
    run(ffmpeg, ['-v', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=24',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '6', '-c:v', 'libx264', '-preset', 'ultrafast',
      '-pix_fmt', 'yuv420p', '-g', '48', '-sc_threshold', '0', '-threads', '2', '-c:a', 'aac', sample], { cwd: temp });
    run(ffmpeg, ['-v', 'error', '-nostdin', '-y', '-i', sample, '-i', subtitle, '-map', '0:v:0', '-map', '0:a:0', '-map', '1:s:0',
      '-c:v', 'copy', '-c:a', 'flac', '-c:s', 'subrip', mkv], { cwd: temp });
    const env = { ...cleanRuntimeEnvironment(), HOME: temp };
    assert.equal(env.FFMPEG_PATH, undefined);
    assert.equal(env.FFPROBE_PATH, undefined);
    const token = randomBytes(32).toString('hex');
    const origin = 'http://localhost:6576';
    child = spawn(join(bin, 'player-macos'), ['--stdio'], { cwd: temp, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', bytes => { stderr += bytes.toString(); });
    const readyPromise = waitReady(child);
    child.stdin.write(JSON.stringify({ type: 'init', token, origin }) + '\n');
    const ready = await readyPromise;
    assert.equal(ready.event, 'ready');
    assert.equal(ready.protocol, 1);
    assert.ok(ready.port > 0);
    const base = `http://127.0.0.1:${ready.port}`;
    const request = async (path, body) => fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { Origin: origin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    const control = async (path, body) => {
      const response = await request(path, body);
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    };
    const decodePlaylist = async open => {
      const response = await request(open.playlist);
      assert.equal(response.status, 200);
      const playlist = await response.text();
      assert.match(playlist, /#EXT-X-MAP:URI="init.mp4"/);
      const fragments = [];
      const init = await request(`/media/${open.generation}/init.mp4`);
      assert.equal(init.status, 200);
      fragments.push(Buffer.from(await init.arrayBuffer()));
      assert.ok(fragments[0].includes(Buffer.from('ftyp')));
      const names = playlist.split('\n').filter(line => line && !line.startsWith('#'));
      assert.ok(names.length > 0);
      for (const name of names.slice(0, 2)) {
        assert.match(name, /^segment\d{6}\.m4s$/);
        const response = await request(`/media/${open.generation}/${name}`);
        assert.equal(response.status, 200);
        const fragment = Buffer.from(await response.arrayBuffer());
        assert.ok(fragment.includes(Buffer.from('moof')));
        fragments.push(fragment);
      }
      const recovered = join(temp, `recovered-${open.generation}.mp4`);
      await writeFile(recovered, Buffer.concat(fragments));
      run(ffmpeg, ['-v', 'error', '-nostdin', '-xerror', '-i', recovered, '-t', '1', '-f', 'null', '-'], { cwd: temp });
    };
    const opened = await control('/api/open', { path: sample });
    assert.equal(opened.mode, 'copy');
    assert.equal(opened.media.videoCodec, 'h264');
    await decodePlaylist(opened);
    const sought = await control('/api/seek', { position: 3.3, rate: 1.5 });
    assert.ok(sought.generation > opened.generation);
    assert.equal(sought.seekPrecision, 'keyframe');
    assert.ok(Math.abs(sought.effectiveStart - 2) < 0.1);
    assert.equal((await request(opened.playlist)).status, 410);
    await decodePlaylist(sought);
    await control('/api/close', {});
    const transcoded = await control('/api/open', { path: mkv, audioTrack: 1, start: 2.5 });
    assert.equal(transcoded.mode, 'transcode');
    assert.equal(transcoded.seekPrecision, 'exact');
    assert.equal(transcoded.effectiveStart, 2.5);
    assert.equal(transcoded.media.audioTracks[0].codec, 'flac');
    await decodePlaylist(transcoded);
    const track = transcoded.media.subtitleTracks[0].id;
    const captions = await request(`/api/subtitle?track=${track}`);
    assert.equal(captions.status, 200);
    const text = await captions.text();
    assert.match(text, /^WEBVTT/);
    assert.match(text, /Hello bundled runtime/);
    await control('/api/close', {});
    child.stdin.end();
    assert.equal(await waitExit(child), 0, stderr);
    assert.doesNotMatch(stderr, new RegExp(token));
  } finally {
    if (child && child.exitCode === null) { child.stdin.end(); child.kill('SIGTERM'); await waitExit(child).catch(() => {}); }
    await rm(temp, { recursive: true, force: true });
  }
});
