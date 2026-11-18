import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const build = new URL('../scripts/build-media-runtime.mjs', import.meta.url).pathname;
const loadBuilder = () => import('../scripts/build-media-runtime.mjs').catch(() => ({}));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// Removing checksum validation would let this archive reach extraction/configure.
test('a cached source archive with the wrong SHA256 is refused before extraction or replacement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uniplayer-source-mismatch-'));
  try {
    const runtime = join(root, 'resources/ffmpeg/macos');
    await mkdir(runtime, { recursive: true });
    await writeFile(join(runtime, 'runtime.json'), 'previous runtime\n');
    const archive = join(root, 'ffmpeg.tar.xz');
    await writeFile(archive, 'not the locked source archive');
    const lock = { schema: 1, target: { platform: 'macos', architecture: 'arm64', minimumMacOS: '12.0' }, sources: {
      ffmpeg: { version: '9.0.2', commit: '946fcce07b6dcd0331c8cc609192aeff5e1924f8', license: 'GPL-2.0-or-later',
        url: 'https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz', archive: 'ffmpeg-9.0.2.tar.xz', sha256: '8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e' },
      x264: { version: 'r3222', commit: 'b35605ace3ddf7c1a5d67a2eb553f034aef41d55', license: 'GPL-2.0-or-later',
        url: 'https://code.videolan.org/videolan/x264/-/archive/b35605ace3ddf7c1a5d67a2eb553f034aef41d55/x264.tar.bz2', archive: 'x264.tar.bz2', sha256: 'b'.repeat(64) },
    } };
    await writeFile(join(root, 'runtime-source-lock.json'), JSON.stringify(lock));
    const result = spawnSync(process.execPath, [build, '--root', root, '--ffmpeg-source', archive, '--sources-only'], {
      encoding: 'utf8', timeout: 15_000,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /SHA256 mismatch/i);
    assert.equal(await readFile(join(runtime, 'runtime.json'), 'utf8'), 'previous runtime\n');
  } finally { await rm(root, { recursive: true, force: true }); }
});

// A checksum helper that compares against the wrong source would accept mismatched bytes.
test('source checksum validation accepts exact locked bytes and rejects altered bytes', async () => {
  const { verifySourceArchive } = await loadBuilder();
  assert.equal(typeof verifySourceArchive, 'function', 'builder must expose source checksum validation');
  const dir = await mkdtemp(join(tmpdir(), 'uniplayer-source-hash-'));
  try {
    const archive = join(dir, 'source.tar.xz');
    const bytes = Buffer.from('locked fixture source');
    await writeFile(archive, bytes);
    assert.equal(await verifySourceArchive(archive, sha256(bytes)), sha256(bytes));
    await assert.rejects(verifySourceArchive(archive, 'a'.repeat(64)), /SHA256 mismatch/i);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// Without extraction validation an archive could overwrite scripts outside its own empty source directory.
test('source extraction rejects path traversal and links without writing outside its fresh destination', async () => {
  const { validateArchiveEntries } = await loadBuilder();
  assert.equal(typeof validateArchiveEntries, 'function', 'builder must validate archive paths before extraction');
  assert.doesNotThrow(() => validateArchiveEntries('source/\nsource/configure\nsource/lib/file.c\n', 'drwxr-xr-x root/root 0 source/\n-rw-r--r-- root/root 4 source/configure\n-rw-r--r-- root/root 4 source/lib/file.c\n'));
  assert.throws(() => validateArchiveEntries('source/../../scripts/configure\n', '-rw-r--r-- root/root 4 source/../../scripts/configure\n'), /unsafe|traversal/i);
  assert.throws(() => validateArchiveEntries('/tmp/outside\n', '-rw-r--r-- root/root 4 /tmp/outside\n'), /unsafe|absolute/i);
  assert.throws(() => validateArchiveEntries('source/link\n', 'lrwxrwxrwx root/root 0 source/link -> ../../scripts\n'), /link|unsafe/i);
});
