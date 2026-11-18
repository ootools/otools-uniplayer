import { readFile, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { options, digest, platforms } from './package-common.mjs';
import { validateRuntimeMetadata } from './runtime-metadata.mjs';

const { root, dev } = options();
try {
  const outputRoot = resolve(root, 'dist-pack');
  const meta = JSON.parse(await readFile(resolve(outputRoot, 'meta.json'), 'utf8'));
  if (meta.mode === 'development' && !dev) throw new Error('Development package is not a formal six-platform release');
  if (!/^[a-zA-Z0-9._-]+\.oplg$/.test(meta.output) || !/^stage-[a-zA-Z0-9-]+$/.test(meta.stage)) throw new Error('Invalid package metadata');
  const packageBytes = await readFile(resolve(outputRoot, meta.output));
  if (digest(packageBytes) !== meta.packageSha256) throw new Error('Package checksum mismatch');
  const list = spawnSync('unzip', ['-Z1', resolve(outputRoot, meta.output)], { encoding: 'utf8' });
  if (list.status !== 0) throw new Error('Invalid ZIP package');
  const entries = list.stdout.trim().split('\n').filter(Boolean);
  if (entries.some(path => path.startsWith('/') || path.split('/').includes('..') || path.includes('\\'))) throw new Error('Unsafe package entry');
  const actual = entries.filter(path => !path.endsWith('/'));
  const expected = [...Object.keys(meta.files), 'SHA256SUMS'].sort();
  if (JSON.stringify([...actual].sort()) !== JSON.stringify(expected)) throw new Error('Package entry list mismatch');
  for (const [file, expectedHash] of Object.entries(meta.files)) {
    const source = resolve(root, file);
    const info = await lstat(source);
    if (!info.isFile() || info.isSymbolicLink() || digest(await readFile(source)) !== expectedHash) throw new Error(`Source checksum mismatch: ${file}`);
    const archived = spawnSync('unzip', ['-p', resolve(outputRoot, meta.output), file], { maxBuffer: 512 * 1024 * 1024 });
    if (archived.status !== 0 || digest(archived.stdout) !== expectedHash) throw new Error(`Archive checksum mismatch: ${file}`);
  }
  const checksums = spawnSync('unzip', ['-p', resolve(outputRoot, meta.output), 'SHA256SUMS'], { encoding: 'utf8' });
  for (const [file, hash] of Object.entries(meta.files)) if (!checksums.stdout.includes(`${hash}  ${file}\n`)) throw new Error(`Missing checksum entry: ${file}`);
  if (meta.mode === 'formal' && meta.platforms.length !== 6) throw new Error('Formal release must contain six platform binaries');
  for (const suffix of meta.platforms) {
    const target = platforms.find(platform => platform.suffix === suffix);
    if (!target) throw new Error('Unknown platform in package metadata');
    if (Object.keys(meta.files).some(file => file === `resources/ffmpeg/${suffix}/runtime.json`)) {
      await validateRuntimeMetadata(root, target, { formal: meta.mode === 'formal' });
    } else if (meta.mode === 'formal') throw new Error('Formal package is missing media runtime metadata');
  }
  console.log(`Verified ${meta.mode} package (${Object.keys(meta.files).length} files): ${meta.output}`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
