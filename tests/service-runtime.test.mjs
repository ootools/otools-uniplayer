import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const prepare = new URL('../scripts/prepare-media-runtime.mjs', import.meta.url).pathname;
const build = new URL('../scripts/build-service.mjs', import.meta.url).pathname;
const repository = new URL('..', import.meta.url).pathname;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

function run(script, args = [], env = {}) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, FFMPEG_PATH: '/opt/homebrew/bin/ffmpeg', FFPROBE_PATH: '/opt/homebrew/bin/ffprobe', ...env } });
}

test('local runtime copies executable tools and records final hashes, GPL provenance and non-self-contained dylibs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniplayer-runtime-'));
  try {
    const result = run(prepare, ['--root', root]);
    assert.equal(result.status, 0, result.stderr);
    const dir = join(root, 'resources/ffmpeg/macos');
    const metadata = JSON.parse(await readFile(join(dir, 'runtime.json'), 'utf8'));
    assert.equal(metadata.redistributable, false);
    assert.equal(metadata.selfContained, false);
    assert.match(metadata.version, /^9\./);
    assert.match(metadata.configure, /--enable-gpl/);
    assert.doesNotMatch(metadata.configure, /--enable-nonfree/);
    assert.match(metadata.license, /GPL.*3/);
    assert.match(metadata.source.url, /ffmpeg/);
    assert.ok(metadata.dynamicLibraries.some(entry => entry.path.startsWith('/opt/homebrew/')));
    for (const tool of ['ffmpeg', 'ffprobe']) {
      const bytes = await readFile(join(dir, tool));
      assert.equal(metadata.sha256[tool], sha(bytes));
      assert.ok((await stat(join(dir, tool))).mode & 0o111);
      const output = spawnSync(join(dir, tool), ['-version'], { encoding: 'utf8' });
      assert.equal(output.status, 0, output.stderr);
      assert.match(output.stdout, /version 9\./);
    }
    assert.match(await readFile(join(dir, 'licenses/COPYING.GPLv3'), 'utf8'), /GNU GENERAL PUBLIC LICENSE/);
    assert.match(result.stdout, /development|not self-contained/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('runtime preparation fails closed for missing development tools', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniplayer-runtime-invalid-'));
  try {
    const result = run(prepare, ['--root', root], { FFMPEG_PATH: '/nonexistent/ffmpeg' });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stderr, /xy_pat_|Bearer /);
    await assert.rejects(readFile(join(root, 'resources/ffmpeg/macos/runtime.json')));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('build script signs a real local service executable, not a placeholder or library', async () => {
  const result = run(build, ['--debug']);
  assert.equal(result.status, 0, result.stderr);
  const executable = join(repository, 'bin/player-macos');
  const bytes = await readFile(executable);
  assert.equal(bytes.readUInt32LE(0), 0xfeedfacf);
  assert.equal(bytes.readUInt32LE(4), 0x100000c);
  assert.equal(bytes.readUInt32LE(12), 2);
  assert.equal(spawnSync('/usr/bin/codesign', ['--verify', '--strict', executable], { encoding: 'utf8' }).status, 0);
  const output = spawnSync(executable, ['--stdio'], { input: JSON.stringify({ type: 'init', token: 'c'.repeat(64), origin: 'http://localhost:6574' }) + '\n',
    encoding: 'utf8', timeout: 8000, env: { ...process.env, FFMPEG_PATH: '/opt/homebrew/bin/ffmpeg', FFPROBE_PATH: '/opt/homebrew/bin/ffprobe' } });
  assert.equal(output.status, 0, output.stderr);
  const ready = JSON.parse(output.stdout.trim());
  assert.equal(ready.event, 'ready');
  assert.equal(ready.protocol, 1);
  assert.ok(ready.port > 0);
  assert.doesNotMatch(output.stdout, /c{64}/);
});
