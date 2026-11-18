import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectMacOSExecutable, verifyMediaRuntime } from './verify-media-runtime.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const command = (tool, args, options = {}) => execFileSync(tool, args, { encoding: 'utf8', timeout: 30_000,
  maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...options });

export async function verifySourceArchive(path, expected) {
  if (!/^[a-f0-9]{64}$/.test(expected ?? '')) throw new Error('Source SHA256 lock is invalid');
  const actual = hash(await readFile(path));
  if (actual !== expected) throw new Error(`Source SHA256 mismatch: ${path}`);
  return actual;
}

export function validateArchiveEntries(names, verbose) {
  const entries = names.split('\n').filter(Boolean);
  if (!entries.length) throw new Error('Empty source archive');
  const roots = new Set();
  for (const path of entries) {
    if (path.startsWith('/') || path.includes('\\') || path.split('/').some(part => part === '..') || /[\x00-\x1f]/.test(path)) {
      throw new Error('Unsafe source archive path traversal or absolute entry');
    }
    roots.add(path.split('/')[0]);
  }
  if (roots.size !== 1 || ![...roots][0]) throw new Error('Source archive must have one top-level directory');
  for (const line of verbose.split('\n').filter(Boolean)) {
    if (!['-', 'd'].includes(line[0])) throw new Error('Unsafe source archive link or special entry');
  }
  return [...roots][0];
}

function validateLock(lock) {
  if (lock.schema !== 1 || lock.target?.platform !== 'macos' || lock.target?.architecture !== 'arm64' || lock.target?.minimumMacOS !== '12.0') {
    throw new Error('Only locked macOS arm64 deployment target 12.0 is supported');
  }
  for (const name of ['ffmpeg', 'x264']) {
    const source = lock.sources?.[name];
    if (!source || !/^https:\/\//.test(source.url) || !/^[a-f0-9]{64}$/.test(source.sha256) || !/^[a-f0-9]{40}$/.test(source.commit) ||
        !/^[a-zA-Z0-9_.-]+\.tar\.(xz|bz2|gz)$/.test(source.archive) || !source.version || !/^GPL-[23]\.0-or-later$/.test(source.license ?? '')) {
      throw new Error(`Invalid corresponding source lock: ${name}`);
    }
  }
}

function options(args) {
  const options = { root: repository, jobs: 8, sourcesOnly: false };
  const paths = { '--root': 'root', '--cache': 'cache', '--ffmpeg-source': 'ffmpegSource', '--x264-source': 'x264Source' };
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (name === '--sources-only') options.sourcesOnly = true;
    else if (paths[name]) {
      if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error('Build option needs a path');
      options[paths[name]] = resolve(args[++index]);
    } else if (name === '--jobs') {
      options.jobs = Number(args[++index]);
      if (!Number.isInteger(options.jobs) || options.jobs < 1 || options.jobs > 8) throw new Error('Build jobs must be between 1 and 8');
    } else throw new Error(`Unknown build option: ${name}`);
  }
  options.cache ??= join(options.root, '.media-runtime-cache');
  return options;
}

async function acquireSource(name, source, supplied, cache) {
  if (supplied) {
    await verifySourceArchive(supplied, source.sha256);
    return supplied;
  }
  const downloads = join(cache, 'downloads');
  await mkdir(downloads, { recursive: true });
  for (const entry of await readdir(downloads, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(`${name}.`)) continue;
    const cached = join(downloads, entry.name, source.archive);
    try { await lstat(cached); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    await verifySourceArchive(cached, source.sha256);
    console.log(`Using SHA256-verified ${name} archive ${cached}`);
    return cached;
  }
  const directory = await mkdtemp(join(downloads, `${name}.`));
  const archive = join(directory, source.archive);
  console.log(`Downloading locked ${name}: ${source.url}`);
  command('/usr/bin/curl', ['--fail', '--location', '--silent', '--show-error', '--proto', '=https', '--proto-redir', '=https',
    '--connect-timeout', '15', '--max-time', '180', '--retry', '1', '--output', archive, source.url], { timeout: 390_000 });
  await verifySourceArchive(archive, source.sha256);
  return archive;
}

async function extractSource(name, archive, cache) {
  const names = command('/usr/bin/tar', ['-tf', archive]);
  const verbose = command('/usr/bin/tar', ['-tvf', archive]);
  const top = validateArchiveEntries(names, verbose);
  const directory = await mkdtemp(join(cache, `${name}-source.`));
  command('/usr/bin/tar', ['-xf', archive, '-C', directory, '--no-same-owner']);
  return join(directory, top);
}

async function runBuild(tool, args, cwd, env, label, log) {
  console.log(`${label}; log ${log}`);
  const { open } = await import('node:fs/promises');
  const file = await open(log, 'w');
  try {
    await new Promise((resolveRun, reject) => {
      const child = spawn(tool, args, { cwd, env, stdio: ['ignore', file.fd, file.fd] });
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolveRun() : reject(new Error(`${label} failed with exit ${code}; inspect ${log}`)));
    });
  } finally { await file.close(); }
}

async function recordFile(directory, relative, bytes, sha256) {
  await mkdir(dirname(join(directory, relative)), { recursive: true });
  await writeFile(join(directory, relative), bytes);
  sha256[relative] = hash(bytes);
}

async function replaceRuntime(root, candidate) {
  const destination = join(root, 'resources/ffmpeg/macos');
  const parent = dirname(destination);
  await mkdir(parent, { recursive: true });
  let exists = false;
  try { exists = (await lstat(destination)).isDirectory(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let backup;
  let old;
  if (exists) {
    // Read the old metadata before keeping the development-only runtime.
    await readFile(join(destination, 'runtime.json'), 'utf8');
    const backups = join(root, '.tempbackups');
    await mkdir(backups, { recursive: true });
    backup = await mkdtemp(join(backups, 'media-runtime-macos.'));
    await cp(destination, join(backup, 'macos'), { recursive: true, errorOnExist: true });
    old = join(parent, `macos.previous-${process.pid}-${Date.now()}`);
    await rename(destination, old);
  }
  try {
    await rename(candidate, destination);
  } catch (error) {
    if (old) await rename(old, destination);
    throw error;
  }
  if (old) await rm(old, { recursive: true });
  return backup;
}

export async function buildMediaRuntime(options) {
  const { root, cache, jobs, sourcesOnly } = options;
  const lockBytes = await readFile(join(root, 'runtime-source-lock.json'));
  const lock = JSON.parse(lockBytes);
  validateLock(lock);
  await mkdir(cache, { recursive: true });
  // Hash-check supplied inputs first; a wrong ffmpeg source never triggers a
  // second download or source extraction and cannot replace the old runtime.
  const archives = {};
  archives.ffmpeg = await acquireSource('ffmpeg', lock.sources.ffmpeg, options.ffmpegSource, cache);
  archives.x264 = await acquireSource('x264', lock.sources.x264, options.x264Source, cache);
  if (sourcesOnly) return { archives, sourceHashesVerified: true };
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Media runtime build currently supports macOS arm64 only');
  const cleanPath = '/usr/bin:/bin:/usr/sbin:/sbin';
  const appleEnv = { PATH: cleanPath, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR ?? '/tmp', LC_ALL: 'C' };
  const clang = command('/usr/bin/xcrun', ['--find', 'clang'], { env: appleEnv }).trim();
  const sdk = command('/usr/bin/xcrun', ['--show-sdk-path'], { env: appleEnv }).trim();
  const minimumMacOS = lock.target.minimumMacOS;
  const prefix = join(await mkdtemp(join(cache, 'x264-prefix.')), 'install');
  await mkdir(prefix, { recursive: true });
  const sources = {};
  for (const name of ['ffmpeg', 'x264']) sources[name] = await extractSource(name, archives[name], cache);
  const builds = {};
  for (const name of ['ffmpeg', 'x264']) builds[name] = await mkdtemp(join(cache, `${name}-build.`));
  // pkg-config is a build-time utility only. Its sole search directory is the
  // private prefix containing our rebuilt static x264, never Homebrew libraries.
  let pkgConfig = '/usr/bin/pkg-config';
  try { await lstat(pkgConfig); } catch {
    pkgConfig = command('/bin/zsh', ['-lc', 'command -v pkg-config']).trim();
  }
  if (!isAbsolute(pkgConfig)) throw new Error('An absolute build-time pkg-config executable is required');
  const flags = `-arch arm64 -isysroot ${sdk} -mmacosx-version-min=${minimumMacOS}`;
  const env = { ...appleEnv, CC: clang, CXX: command('/usr/bin/xcrun', ['--find', 'clang++'], { env: appleEnv }).trim(),
    AR: '/usr/bin/ar', RANLIB: '/usr/bin/ranlib', STRIP: '/usr/bin/strip', SDKROOT: sdk, MACOSX_DEPLOYMENT_TARGET: minimumMacOS,
    CFLAGS: flags, LDFLAGS: flags, PKG_CONFIG: pkgConfig, PKG_CONFIG_PATH: '', PKG_CONFIG_LIBDIR: join(prefix, 'lib/pkgconfig'),
    PKG_CONFIG_SYSROOT_DIR: '' };
  const x264Configure = [`--prefix=${prefix}`, '--host=aarch64-apple-darwin', '--enable-static', '--enable-pic', '--disable-cli',
    '--disable-opencl', '--disable-avs', '--disable-swscale', '--disable-lavf', '--disable-ffms', '--disable-gpac', '--disable-lsmash',
    '--bit-depth=all', `--extra-cflags=${flags}`, `--extra-ldflags=${flags}`];
  const logs = {};
  const x264ConfigLog = join(builds.x264, 'configure-output.log');
  await runBuild('/bin/bash', [join(sources.x264, 'configure'), ...x264Configure], builds.x264, env, 'Configuring locked x264 static 8/10-bit', x264ConfigLog);
  logs.x264 = join(builds.x264, 'make-output.log');
  await runBuild('/usr/bin/make', [`-j${jobs}`, 'install-lib-static'], builds.x264, env, `Compiling/installing x264 with ${jobs} jobs`, logs.x264);
  const libraryFiles = await readdir(join(prefix, 'lib'));
  if (!libraryFiles.includes('libx264.a') || libraryFiles.some(name => /\.(dylib|so)(\.|$)/.test(name))) throw new Error('x264 prefix must contain only our static library');
  const ffmpegPrefix = join(builds.ffmpeg, 'install');
  const ffmpegConfigure = [`--prefix=${ffmpegPrefix}`, '--target-os=darwin', '--arch=aarch64', `--cc=${clang}`, `--cxx=${env.CXX}`,
    '--enable-static', '--disable-shared', '--disable-autodetect', '--enable-gpl', '--enable-version3', '--enable-libx264',
    '--disable-network', '--disable-opencl', '--disable-ffplay', '--disable-doc', '--enable-ffmpeg', '--enable-ffprobe',
    '--enable-videotoolbox', '--enable-audiotoolbox', `--pkg-config=${pkgConfig}`, '--pkg-config-flags=--static',
    `--extra-cflags=${flags} -I${join(prefix, 'include')}`, `--extra-ldflags=${flags} -L${join(prefix, 'lib')}`];
  await runBuild('/bin/sh', [join(sources.ffmpeg, 'configure'), ...ffmpegConfigure], builds.ffmpeg, env, 'Configuring FFmpeg without external autodetection or networking', join(builds.ffmpeg, 'configure-output.log'));
  logs.ffmpeg = join(builds.ffmpeg, 'make-output.log');
  await runBuild('/usr/bin/make', [`-j${jobs}`, 'ffmpeg', 'ffprobe'], builds.ffmpeg, env, `Compiling FFmpeg/ffprobe with ${jobs} jobs`, logs.ffmpeg);
  return finalizeMediaRuntime({ root, lock, lockBytes, archives, sources, builds, prefix, minimumMacOS, clang, sdk, appleEnv, cleanPath, jobs, x264Configure, ffmpegConfigure, logs });
}

export async function finalizeMediaRuntime({ root, lock, lockBytes, archives, sources, builds, prefix, minimumMacOS, clang, sdk, appleEnv, cleanPath, jobs, x264Configure, ffmpegConfigure, logs }) {
  // This stage is also callable after a verification-only failure without
  // recompiling. Recheck source hashes and actual binaries rather than trust
  // cached build directories or a prior candidate's metadata.
  validateLock(lock);
  for (const name of ['ffmpeg', 'x264']) await verifySourceArchive(archives[name], lock.sources[name].sha256);
  const runtimeParent = join(root, 'resources/ffmpeg');
  await mkdir(runtimeParent, { recursive: true });
  const candidate = await mkdtemp(join(runtimeParent, '.macos-candidate.'));
  const sha256 = {};
  const binaries = {};
  for (const name of ['ffmpeg', 'ffprobe']) {
    await copyFile(join(builds.ffmpeg, name), join(candidate, name));
    await chmod(join(candidate, name), 0o755);
    command('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', join(candidate, name)], { env: appleEnv });
    binaries[name] = await inspectMacOSExecutable(join(candidate, name), minimumMacOS);
    sha256[name] = binaries[name].sha256;
  }
  for (const name of ['ffmpeg', 'x264']) {
    await recordFile(candidate, `sources/${lock.sources[name].archive}`, await readFile(archives[name]), sha256);
    for (const filename of lock.sources[name].licenseFiles) {
      await recordFile(candidate, name === 'ffmpeg' ? `licenses/${filename}` : `licenses/x264/${filename}`, await readFile(join(sources[name], filename)), sha256);
    }
  }
  await recordFile(candidate, 'sources/runtime-source-lock.json', lockBytes, sha256);
  await recordFile(candidate, 'sources/build-media-runtime.mjs', await readFile(fileURLToPath(import.meta.url)), sha256);
  await recordFile(candidate, 'sources/verify-media-runtime.mjs', await readFile(join(dirname(fileURLToPath(import.meta.url)), 'verify-media-runtime.mjs')), sha256);
  await recordFile(candidate, 'sources/ffmpeg-config.h', await readFile(join(builds.ffmpeg, 'config.h')), sha256);
  await recordFile(candidate, 'sources/ffmpeg-config.mak', await readFile(join(builds.ffmpeg, 'ffbuild/config.mak')), sha256);
  await recordFile(candidate, 'sources/x264-config.h', await readFile(join(builds.x264, 'config.h')), sha256);
  await recordFile(candidate, 'sources/x264-config.mak', await readFile(join(builds.x264, 'config.mak')), sha256);
  const versionText = command(join(candidate, 'ffmpeg'), ['-version'], { env: appleEnv });
  const version = versionText.match(/^ffmpeg version (\S+)/m)?.[1];
  const configure = versionText.match(/^configuration: (.+)$/m)?.[1];
  if (version !== lock.sources.ffmpeg.version || !configure) throw new Error('Compiled runtime version/configuration does not match source lock');
  const dynamicLibraries = [...new Set(Object.values(binaries).flatMap(binary => binary.dependencies))].sort().map(path => ({ path, system: true }));
  const metadata = { schema: 1, platform: 'macos', architecture: 'arm64', minimumMacOS, version, configure,
    license: 'GPL-3.0-or-later', source: { url: lock.sources.ffmpeg.url, upstream: lock.sources.ffmpeg.upstream, sourceDownloaded: true,
      ffmpeg: { ...lock.sources.ffmpeg, archive: `sources/${lock.sources.ffmpeg.archive}`, configure: ffmpegConfigure, sourceDownloaded: true },
      x264: { ...lock.sources.x264, archive: `sources/${lock.sources.x264.archive}`, configure: x264Configure, sourceDownloaded: true } },
    sourceArchives: ['ffmpeg', 'x264'].map(name => ({ name, path: `sources/${lock.sources[name].archive}`, sha256: lock.sources[name].sha256 })),
    build: { toolchain: command(clang, ['--version'], { env: appleEnv }).trim(), sdk, jobs, minimumMacOS, staticX264: true,
      environment: { PATH: cleanPath, PKG_CONFIG_LIBDIR: join(prefix, 'lib/pkgconfig'), MACOSX_DEPLOYMENT_TARGET: minimumMacOS },
      logs }, sha256, dynamicLibraries, selfContained: false, redistributable: false,
    signing: 'ad-hoc; codesign --verify --strict passed; SHA256 recorded after signing',
    limitation: 'Only macOS arm64 built/verified. Built-in AV1 is hardware-only, software AV1 is not supplied or verified. No other platform runtime is certified.' };
  await writeFile(join(candidate, 'runtime.json'), JSON.stringify(metadata, null, 2) + '\n');
  console.log('Checking candidate signatures, minimum macOS, source/license hashes and real relocated media operations');
  const report = await verifyMediaRuntime({ root, directory: candidate, candidate: true });
  metadata.selfContained = true;
  metadata.redistributable = true;
  metadata.verification = { verifiedAt: new Date().toISOString(), platform: report.platform, architecture: report.architecture,
    minimumMacOS, binaryMinimumMacOS: Object.fromEntries(Object.entries(report.binaries).map(([name, binary]) => [name, binary.minimumMacOS])),
    ...report.smoke };
  await writeFile(join(candidate, 'runtime.json'), JSON.stringify(metadata, null, 2) + '\n');
  // Recheck the distributable metadata itself before touching the existing tree.
  await verifyMediaRuntime({ root, directory: candidate, smoke: false });
  const backup = await replaceRuntime(root, candidate);
  console.log(`Verified self-contained macOS arm64 FFmpeg ${version} installed; old runtime backup ${backup ?? 'none'}`);
  return { directory: join(root, 'resources/ffmpeg/macos'), backup, version, selfContained: true, redistributable: true, logs, verification: metadata.verification };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await buildMediaRuntime(options(process.argv.slice(2))), null, 2)); }
  catch (error) { console.error(`Media runtime build failed: ${error.message}`); process.exitCode = 1; }
}
