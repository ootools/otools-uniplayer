import { mkdir, readFile, writeFile, cp, lstat, readdir, rename } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { options, platforms, currentPlatform, binaryName, digest, collect, manifestAt, verifyExecutable } from './package-common.mjs';
import { validateRuntimeMetadata } from './runtime-metadata.mjs';

const { root, dev } = options();
try {
  const manifest = await manifestAt(root);
  const targets = dev ? [currentPlatform()] : platforms;
  const files = ['plugin.json', 'logo.svg', 'LICENSE', 'UPSTREAM.md', ...await collect(root, 'dist')];
  const allowed = new Set(manifest.sidecars.flatMap(entry => platforms.map(target => binaryName(entry.bin, target))));
  for (const name of await readdir(resolve(root, 'bin'))) if (!allowed.has(name)) throw new Error(`Undeclared binary in bin/: ${name}`);
  for (const target of targets) for (const declaration of manifest.sidecars) {
    const relative = `bin/${binaryName(declaration.bin, target)}`;
    const info = await lstat(resolve(root, relative)).catch(() => { throw new Error(`Missing platform binary: ${relative}`); });
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Invalid binary: ${relative}`);
    const bytes = await readFile(resolve(root, relative));
    if (!dev) verifyExecutable(bytes, target);
    files.push(relative);
  }
  if (!dev) {
    for (const target of targets) {
      const directory = `resources/ffmpeg/${target.suffix}`;
      const resourceFiles = await collect(root, directory).catch(() => { throw new Error(`Missing platform runtime: ${directory}`); });
      const executable = target.os === 'win32' ? '.exe' : '';
      for (const tool of ['ffmpeg', 'ffprobe']) if (!resourceFiles.includes(`${directory}/${tool}${executable}`)) throw new Error(`Missing ${tool} binary: ${directory}`);
      await validateRuntimeMetadata(root, target, { formal: true });
      files.push(...resourceFiles);
    }
  } else {
    const resource = resolve(root, 'resources/ffmpeg', currentPlatform().suffix);
    if (await lstat(resource).catch(() => null)) {
      await validateRuntimeMetadata(root, currentPlatform());
      files.push(...await collect(root, `resources/ffmpeg/${currentPlatform().suffix}`));
    }
  }
  const outputRoot = resolve(root, 'dist-pack');
  await mkdir(outputRoot, { recursive: true });
  const buildId = `stage-${Date.now()}-${process.pid}`;
  const staging = resolve(outputRoot, buildId);
  await mkdir(staging);
  const hashes = {};
  for (const file of [...new Set(files)].sort()) {
    const data = await readFile(resolve(root, file));
    hashes[file] = digest(data);
    await mkdir(dirname(resolve(staging, file)), { recursive: true });
    await cp(resolve(root, file), resolve(staging, file));
  }
  const checksums = Object.entries(hashes).map(([file, hash]) => `${hash}  ${file}`).join('\n') + '\n';
  await writeFile(resolve(staging, 'SHA256SUMS'), checksums);
  const filename = `${manifest.packid}-${manifest.version}${dev ? '-dev-' + currentPlatform().suffix : ''}.oplg`;
  const output = resolve(outputRoot, filename);
  const temporary = resolve(outputRoot, `${buildId}.oplg`);
  const zipped = spawnSync('zip', ['-q', '-X', '-r', temporary, ...Object.keys(hashes), 'SHA256SUMS'], { cwd: staging, encoding: 'utf8' });
  if (zipped.status !== 0) throw new Error(zipped.stderr || 'ZIP packaging failed');
  await rename(temporary, output);
  const meta = { output: filename, mode: dev ? 'development' : 'formal', platforms: targets.map(target => target.suffix), stage: buildId, files: hashes, packageSha256: digest(await readFile(output)) };
  await writeFile(resolve(outputRoot, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
  console.log(`${dev ? 'Development-only' : 'Formal'} package: ${output}`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
