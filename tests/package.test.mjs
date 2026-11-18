import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { validateRuntimeMetadata } from '../scripts/runtime-metadata.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { verifyExecutable, platforms } from '../scripts/package-common.mjs';

const pack = new URL('../scripts/pack-plugin.mjs', import.meta.url);
const verify = new URL('../scripts/verify-plugin.mjs', import.meta.url);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'uniplayer-package-'));
  await mkdir(join(root, 'dist'));
  await mkdir(join(root, 'bin'));
  await writeFile(join(root, 'plugin.json'), JSON.stringify({ uuid: 'otools-uniplayer', packid: 'otools-uniplayer', version: '0.1.0', entry: 'dist/index.html', sidecars: [{ id: 'player', bin: 'player' }] }));
  await writeFile(join(root, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await writeFile(join(root, 'LICENSE'), 'GPL fixture');
  await writeFile(join(root, 'UPSTREAM.md'), 'Corresponding source fixture');
  await writeFile(join(root, 'dist/index.html'), '<h1>fixture</h1>');
  return root;
}

test('development package is local-only and verifies declared binary and checksums', async () => {
  const root = await fixture();
  const suffix = process.platform === 'darwin' ? (process.arch === 'arm64' ? 'macos' : 'macos-intel') : process.platform === 'win32' ? (process.arch === 'arm64' ? 'windows-arm' : 'windows') : (process.arch === 'arm64' ? 'linux-arm' : 'linux');
  const executable = `${suffix}${process.platform === 'win32' ? '.exe' : ''}`;
  const path = join(root, 'bin', `player-${executable}`);
  await writeFile(path, Buffer.from('fixture binary'));
  const result = spawnSync(process.execPath, [pack.pathname, '--root', root, '--dev'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const checked = spawnSync(process.execPath, [verify.pathname, '--root', root, '--dev'], { encoding: 'utf8' });
  assert.equal(checked.status, 0, checked.stderr);
  await writeFile(path, 'tampered');
  const invalid = spawnSync(process.execPath, [verify.pathname, '--root', root, '--dev'], { encoding: 'utf8' });
  assert.notEqual(invalid.status, 0, 'tampered staging must not silently validate');
});

test('repacking never carries removed files from an older ZIP', async () => {
  const root = await fixture();
  const suffix = process.platform === 'darwin' ? (process.arch === 'arm64' ? 'macos' : 'macos-intel') : process.platform === 'win32' ? (process.arch === 'arm64' ? 'windows-arm' : 'windows') : (process.arch === 'arm64' ? 'linux-arm' : 'linux');
  await writeFile(join(root, 'bin', `player-${suffix}${process.platform === 'win32' ? '.exe' : ''}`), 'fixture');
  await writeFile(join(root, 'dist', 'old.js'), 'old');
  assert.equal(spawnSync(process.execPath, [pack.pathname, '--root', root, '--dev']).status, 0);
  const { unlink } = await import('node:fs/promises');
  await unlink(join(root, 'dist', 'old.js'));
  assert.equal(spawnSync(process.execPath, [pack.pathname, '--root', root, '--dev']).status, 0);
  const result = spawnSync(process.execPath, [verify.pathname, '--root', root, '--dev'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('executable validation rejects wrong architectures and dynamic libraries', () => {
  const mac = Buffer.alloc(64); mac.writeUInt32LE(0xfeedfacf, 0); mac.writeUInt32LE(0x100000c, 4); mac.writeUInt32LE(2, 12);
  verifyExecutable(mac, platforms[0]);
  assert.throws(() => verifyExecutable(mac, platforms[1]), /architecture/);
  mac.writeUInt32LE(6, 12);
  assert.throws(() => verifyExecutable(mac, platforms[0]), /executable/);
  const pe = Buffer.alloc(128); pe.write('MZ'); pe.writeUInt32LE(64, 0x3c); pe.write('PE\0\0', 64); pe.writeUInt16LE(0x8664, 68); pe.writeUInt16LE(0x2002, 86);
  assert.throws(() => verifyExecutable(pe, platforms[2]), /DLL/);
});

test('runtime source hashes must match the tools being packaged', async () => {
  const root = await fixture();
  const suffix = process.platform === 'darwin' ? (process.arch === 'arm64' ? 'macos' : 'macos-intel') : process.platform === 'win32' ? (process.arch === 'arm64' ? 'windows-arm' : 'windows') : (process.arch === 'arm64' ? 'linux-arm' : 'linux');
  const extension = process.platform === 'win32' ? '.exe' : '';
  await writeFile(join(root, 'bin', `player-${suffix}${extension}`), 'fixture');
  const runtime = join(root, 'resources', 'ffmpeg', suffix);
  await mkdir(runtime, { recursive: true });
  await writeFile(join(runtime, `ffmpeg${extension}`), 'actual');
  await writeFile(join(runtime, `ffprobe${extension}`), 'actual');
  await writeFile(join(runtime, 'runtime.json'), JSON.stringify({ platform: suffix, source: { url: 'https://example.test/source' }, configure: '--enable-gpl --enable-libx264', license: 'GPL-3.0-or-later', selfContained: true, redistributable: true, dynamicLibraries: [], sha256: { [`ffmpeg${extension}`]: '0'.repeat(64), [`ffprobe${extension}`]: '0'.repeat(64) } }));
  const packed = spawnSync(process.execPath, [pack.pathname, '--root', root, '--dev'], { encoding: 'utf8' });
  assert.notEqual(packed.status, 0, 'valid archive digests must not hide false source-runtime metadata');
  assert.match(packed.stderr, /runtime|hash|checksum/i);
});

test('self-contained redistribution requires corresponding source archives, not only tool hashes', async () => {
  const root = await fixture();
  const target = platforms.find(platform => platform.os === process.platform && platform.arch === process.arch);
  const extension = target.os === 'win32' ? '.exe' : '';
  const directory = join(root, 'resources', 'ffmpeg', target.suffix);
  await mkdir(directory, { recursive: true });
  const bytes = Buffer.from('fixture');
  const hash = createHash('sha256').update(bytes).digest('hex');
  await writeFile(join(directory, `ffmpeg${extension}`), bytes);
  await writeFile(join(directory, `ffprobe${extension}`), bytes);
  await writeFile(join(directory, 'runtime.json'), JSON.stringify({ platform: target.suffix, source: { url: 'https://example.test/source' }, configure: '--enable-gpl --enable-libx264', license: 'GPL-3.0-or-later', selfContained: true, redistributable: true, dynamicLibraries: [], sha256: { [`ffmpeg${extension}`]: hash, [`ffprobe${extension}`]: hash } }));
  await assert.rejects(validateRuntimeMetadata(root, target), /source|archive/i);
});

test('formal packaging rejects missing platforms rather than adding placeholder binaries', async () => {
  const root = await fixture();
  const result = spawnSync(process.execPath, [pack.pathname, '--root', root], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /platform|binary|missing/i);
});
