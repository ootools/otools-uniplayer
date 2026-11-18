import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const cleanRuntimeEnvironment = () => ({ PATH: '/usr/bin:/bin', HOME: tmpdir(), TMPDIR: tmpdir(), LC_ALL: 'C' });
const run = (tool, args, options = {}) => execFileSync(tool, args, { encoding: 'utf8', timeout: 30_000,
  maxBuffer: 16 * 1024 * 1024, env: cleanRuntimeEnvironment(), stdio: ['ignore', 'pipe', 'pipe'], ...options });

export function verifyDynamicDependencies(output) {
  const dependencies = new Set();
  for (const line of output.split('\n').slice(1)) {
    if (!line.trim()) continue;
    const path = line.trim().split(' (compatibility version')[0];
    if (!path.startsWith('/System/Library/') && !path.startsWith('/usr/lib/')) {
      throw new Error(`Runtime is not self-contained: non-system dynamic dependency ${path}`);
    }
    dependencies.add(path);
  }
  if (!dependencies.size) throw new Error('Mach-O dynamic dependency inspection returned no dependencies');
  return [...dependencies].sort();
}

export function verifyMinimumMacOS(output, target = '12.0') {
  const versions = output.split(/(?=^Load command \d+)/m).flatMap(block => {
    if (/\bcmd LC_BUILD_VERSION\b/.test(block) && /^\s*platform 1\s*$/m.test(block)) return block.match(/^\s*minos\s+(\d+(?:\.\d+){0,2})\s*$/m)?.[1] ?? [];
    if (/\bcmd LC_VERSION_MIN_MACOSX\b/.test(block)) return block.match(/^\s*version\s+(\d+(?:\.\d+){0,2})\s*$/m)?.[1] ?? [];
    return [];
  });
  if (!versions.length) throw new Error('Mach-O minimum macOS deployment version is missing');
  const numeric = value => value.split('.').reduce((sum, part, index) => sum + Number(part) * 100 ** (2 - index), 0);
  const minimum = versions.sort((a, b) => numeric(b) - numeric(a))[0];
  if (numeric(minimum) > numeric(target)) throw new Error(`Mach-O minimum macOS deployment ${minimum} exceeds target ${target}`);
  return minimum;
}

export async function inspectMacOSExecutable(path, minimumMacOS = '12.0') {
  const bytes = await readFile(path);
  if (bytes.length < 32 || bytes.readUInt32LE(0) !== 0xfeedfacf || bytes.readUInt32LE(4) !== 0x100000c || bytes.readUInt32LE(12) !== 2) {
    throw new Error('Media runtime must be a real arm64 Mach-O executable');
  }
  if (!((await stat(path)).mode & 0o111)) throw new Error('Media runtime file is not executable');
  // Inspect load commands before executing. PATH isolation alone does not stop
  // the loader from finding Homebrew's absolute dylib paths.
  const dependencies = verifyDynamicDependencies(run('/usr/bin/otool', ['-L', path]));
  const minimum = verifyMinimumMacOS(run('/usr/bin/otool', ['-l', path]), minimumMacOS);
  run('/usr/bin/codesign', ['--verify', '--strict', path]);
  const signing = run('/usr/bin/codesign', ['--display', '--verbose=2', path], { stdio: ['ignore', 'pipe', 'pipe'] });
  return { dependencies, minimumMacOS: minimum, sha256: hash(bytes), signing: signing.trim() || 'codesign --verify --strict passed' };
}

export function verifyCapabilityList(output, required, kind) {
  const present = new Set(output.split('\n').flatMap(line => {
    const match = ['demuxer', 'muxer'].includes(kind)
      ? line.match(/^\s*[D E.]{2}(?:d| )?\s+(\S+)/)
      : line.match(/^\s*[A-Z.]{2,6}\s+(\S+)/);
    return match?.[1] ?? [];
  }));
  for (const name of required) if (!present.has(name)) throw new Error(`Required FFmpeg ${kind} unavailable: ${name}`);
}

export function inspectCapabilities(ffmpeg) {
  const decoders = run(ffmpeg, ['-hide_banner', '-decoders']);
  const encoders = run(ffmpeg, ['-hide_banner', '-encoders']);
  const demuxers = run(ffmpeg, ['-hide_banner', '-demuxers']);
  const muxers = run(ffmpeg, ['-hide_banner', '-muxers']);
  const filters = run(ffmpeg, ['-hide_banner', '-filters']);
  const protocols = run(ffmpeg, ['-hide_banner', '-protocols']);
  verifyCapabilityList(decoders, ['h264', 'hevc', 'vp8', 'vp9', 'av1', 'aac', 'flac', 'mp3', 'pcm_s16le', 'vorbis', 'opus', 'subrip', 'webvtt'], 'decoder');
  verifyCapabilityList(encoders, ['libx264', 'aac', 'flac', 'pcm_s16le', 'subrip', 'webvtt'], 'encoder');
  // matroska,webm is one demuxer, unlike two distinct output muxers.
  verifyCapabilityList(demuxers, ['mov,mp4,m4a,3gp,3g2,mj2', 'matroska,webm', 'avi', 'mpeg', 'mpegts', 'mp3', 'aac', 'flac', 'wav', 'ogg', 'srt', 'webvtt', 'lavfi'], 'demuxer');
  verifyCapabilityList(muxers, ['hls', 'mp4', 'webvtt', 'null'], 'muxer');
  verifyCapabilityList(filters, ['scale', 'format', 'tonemap', 'testsrc2', 'sine'], 'filter');
  const enabledProtocols = protocols.split('\n').map(line => line.trim());
  for (const name of ['file', 'pipe']) if (!enabledProtocols.includes(name)) throw new Error(`Required local protocol unavailable: ${name}`);
  for (const name of ['http', 'https', 'tcp', 'udp', 'tls', 'ftp', 'srt', 'rtmp']) if (enabledProtocols.includes(name)) throw new Error(`Network protocol must be disabled: ${name}`);
  return { videoDecoders: ['h264', 'hevc', 'vp8', 'vp9'], audioDecoders: ['aac', 'flac', 'mp3', 'pcm_s16le', 'vorbis', 'opus'],
    av1: 'Built-in av1 decoder is hardware-only; software AV1 is not supplied or verified.',
    encoders: ['libx264', 'aac'], filters: ['scale', 'format', 'tonemap'], localProtocols: ['file', 'pipe'], network: false };
}

export async function smokeTestRuntime(directory) {
  const temporary = await mkdtemp(join(tmpdir(), 'uniplayer-media-relocated-'));
  try {
    for (const tool of ['ffmpeg', 'ffprobe']) {
      await copyFile(join(directory, tool), join(temporary, tool));
      await chmod(join(temporary, tool), 0o755);
    }
    const ffmpeg = join(temporary, 'ffmpeg');
    const ffprobe = join(temporary, 'ffprobe');
    const versions = {};
    for (const tool of ['ffmpeg', 'ffprobe']) {
      const output = run(join(temporary, tool), ['-version'], { cwd: temporary });
      versions[tool] = output.match(new RegExp(`^${tool} version (\\S+)`, 'm'))?.[1];
      if (!versions[tool]) throw new Error('Relocated FFmpeg/ffprobe did not report a version');
      run(join(temporary, tool), ['-hide_banner', '-h'], { cwd: temporary });
    }
    if (versions.ffmpeg !== versions.ffprobe) throw new Error('FFmpeg and ffprobe versions differ');
    const capabilities = inspectCapabilities(ffmpeg);
    const sample = join(temporary, 'sample.mp4');
    run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=24',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '6', '-c:v', 'libx264', '-preset', 'ultrafast',
      '-pix_fmt', 'yuv420p', '-g', '48', '-sc_threshold', '0', '-threads', '2', '-c:a', 'aac', sample], { cwd: temporary });
    const info = JSON.parse(run(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', sample], { cwd: temporary }));
    if (!info.streams.some(stream => stream.codec_name === 'h264') || !info.streams.some(stream => stream.codec_name === 'aac') || Math.abs(Number(info.format.duration) - 6) > 0.15) {
      throw new Error('Real H264/AAC fixture failed probe verification');
    }
    run(ffmpeg, ['-v', 'error', '-nostdin', '-xerror', '-i', sample, '-t', '1', '-f', 'null', '-'], { cwd: temporary });
    const flac = join(temporary, 'sample.flac');
    run(ffmpeg, ['-v', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000', '-t', '1', '-c:a', 'flac', flac], { cwd: temporary });
    const pcm = run(ffmpeg, ['-v', 'error', '-nostdin', '-xerror', '-i', flac, '-f', 's16le', '-acodec', 'pcm_s16le', '-'], { encoding: null, cwd: temporary });
    if (pcm.length < 48_000) throw new Error('Real FLAC decoding produced insufficient PCM');
    const hls = join(temporary, 'hls');
    await mkdir(hls);
    run(ffmpeg, ['-v', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file', '-i', sample, '-c:v', 'copy', '-c:a', 'copy',
      '-f', 'hls', '-hls_time', '2', '-hls_segment_type', 'fmp4', '-hls_list_size', '0', '-hls_playlist_type', 'event',
      '-hls_flags', 'temp_file+independent_segments', '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', join(hls, 'segment%06d.m4s'), join(hls, 'index.m3u8')], { cwd: temporary });
    const playlist = await readFile(join(hls, 'index.m3u8'), 'utf8');
    const names = playlist.split('\n').filter(line => line && !line.startsWith('#'));
    if (!playlist.includes('#EXT-X-MAP:URI="init.mp4"') || names.length !== 3) throw new Error('fMP4 HLS fixture failed publication');
    const recovered = join(temporary, 'recovered.mp4');
    const fragments = [await readFile(join(hls, 'init.mp4'))];
    for (const name of names) {
      if (!/^segment\d{6}\.m4s$/.test(name)) throw new Error('Unsafe HLS fixture segment name');
      const fragment = await readFile(join(hls, name));
      if (!fragment.includes(Buffer.from('moof'))) throw new Error('HLS segment is not a real fMP4 fragment');
      fragments.push(fragment);
    }
    await writeFile(recovered, Buffer.concat(fragments));
    run(ffmpeg, ['-v', 'error', '-nostdin', '-xerror', '-i', recovered, '-t', '1', '-f', 'null', '-'], { cwd: temporary });
    const seek = join(temporary, 'seek.mp4');
    run(ffmpeg, ['-v', 'error', '-nostdin', '-y', '-ss', '2.5', '-i', sample, '-t', '1', '-c:v', 'libx264', '-preset', 'ultrafast',
      '-pix_fmt', 'yuv420p', '-threads', '2', '-c:a', 'aac', seek], { cwd: temporary });
    const sought = JSON.parse(run(ffprobe, ['-v', 'error', '-show_format', '-of', 'json', seek], { cwd: temporary }));
    if (Math.abs(Number(sought.format.duration) - 1) > 0.15) throw new Error('Exact seek/transcode fixture duration incorrect');
    run(ffmpeg, ['-v', 'error', '-nostdin', '-xerror', '-i', seek, '-f', 'null', '-'], { cwd: temporary });
    return { versions, capabilities, relocated: true, environment: { PATH: '/usr/bin:/bin', toolOverrides: false },
      operations: ['version', 'help', 'h264-aac-encode-decode-probe', 'flac-to-pcm', 'hls-fmp4-copy-decode', 'seek-transcode-decode'] };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

async function runtimeFiles(directory, relative = '') {
  const files = [];
  for (const name of (await readdir(join(directory, relative))).sort()) {
    const path = relative ? `${relative}/${name}` : name;
    const info = await lstat(join(directory, path));
    if (info.isSymbolicLink()) throw new Error(`Runtime symlink is not allowed: ${path}`);
    if (info.isDirectory()) files.push(...await runtimeFiles(directory, path));
    else if (info.isFile()) { if (path !== 'runtime.json') files.push(path); }
    else throw new Error('Unsupported runtime entry');
  }
  return files;
}

export async function verifyMediaRuntime({ root = repository, directory = join(root, 'resources/ffmpeg/macos'), candidate = false, smoke = true } = {}) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Runtime verification currently supports macOS arm64 only');
  const metadata = JSON.parse(await readFile(join(directory, 'runtime.json'), 'utf8'));
  if (metadata.schema !== 1 || metadata.platform !== 'macos' || metadata.architecture !== 'arm64') throw new Error('Runtime metadata target is invalid');
  if (!candidate && (metadata.selfContained !== true || metadata.redistributable !== true)) throw new Error('Runtime is development-only, not a verified self-contained distribution');
  if (!metadata.configure.includes('--enable-gpl') || !metadata.configure.includes('--enable-libx264') ||
      !metadata.configure.includes('--disable-shared') || !metadata.configure.includes('--disable-autodetect') ||
      !metadata.configure.includes('--disable-network') || metadata.configure.includes('--enable-nonfree')) throw new Error('Unsafe or incomplete FFmpeg build configuration');
  if (metadata.license !== 'GPL-3.0-or-later') throw new Error('Runtime must match the plugin GPL-3.0-or-later distribution');
  const files = await runtimeFiles(directory);
  if (files.length !== Object.keys(metadata.sha256 ?? {}).length) throw new Error('Every runtime file must be covered by a SHA256 digest');
  for (const path of files) if (metadata.sha256[path] !== hash(await readFile(join(directory, path)))) throw new Error(`Runtime SHA256 mismatch: ${path}`);
  const lock = JSON.parse(await readFile(join(directory, 'sources/runtime-source-lock.json'), 'utf8'));
  for (const name of ['ffmpeg', 'x264']) {
    const source = metadata.source?.[name];
    const locked = lock.sources?.[name];
    if (!source || !locked || source.sha256 !== locked.sha256 || source.commit !== locked.commit || source.url !== locked.url ||
        source.version !== locked.version || source.license !== locked.license || !Array.isArray(source.configure)) throw new Error(`Corresponding source lock is incomplete: ${name}`);
    if (source.archive !== `sources/${locked.archive}` || metadata.sha256[source.archive] !== locked.sha256) throw new Error(`Corresponding source archive digest is missing: ${name}`);
    for (const filename of locked.licenseFiles) {
      const path = name === 'ffmpeg' ? `licenses/${filename}` : `licenses/x264/${filename}`;
      if (!metadata.sha256[path]) throw new Error(`Corresponding source license missing: ${name}`);
    }
  }
  const minimumMacOS = lock.target?.minimumMacOS;
  if (metadata.minimumMacOS !== minimumMacOS || minimumMacOS !== '12.0') throw new Error('Runtime deployment target differs from source lock');
  const binaries = {};
  const dependencies = new Set();
  for (const name of ['ffmpeg', 'ffprobe']) {
    binaries[name] = await inspectMacOSExecutable(join(directory, name), minimumMacOS);
    for (const path of binaries[name].dependencies) dependencies.add(path);
  }
  const listed = [...dependencies].sort();
  if (JSON.stringify(metadata.dynamicLibraries) !== JSON.stringify(listed.map(path => ({ path, system: true })))) throw new Error('Runtime dynamic dependency metadata does not match real Mach-O binaries');
  const actualConfiguration = run(join(directory, 'ffmpeg'), ['-version']).match(/^configuration: (.+)$/m)?.[1];
  if (actualConfiguration !== metadata.configure) throw new Error('Runtime configuration metadata does not match executable');
  const operations = smoke ? await smokeTestRuntime(directory) : undefined;
  if (operations && operations.versions.ffmpeg !== metadata.version) throw new Error('Runtime version does not match executable');
  return { platform: 'macos', architecture: 'arm64', version: metadata.version, minimumMacOS, binaries, smoke: operations };
}

function options(args) {
  let root = repository;
  let directory;
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (name !== '--root' && name !== '--directory') throw new Error(`Unknown verifier option: ${name}`);
    if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error('Verifier option needs a path');
    if (name === '--root') root = resolve(args[++index]);
    else directory = resolve(args[++index]);
  }
  return { root, directory: directory ?? join(root, 'resources/ffmpeg/macos') };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await verifyMediaRuntime(options(process.argv.slice(2)));
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(`Media runtime verification failed: ${error.message}`);
    process.exitCode = 1;
  }
}
