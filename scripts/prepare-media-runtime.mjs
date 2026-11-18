import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, copyFile, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const rootAt = args.indexOf('--root');
const root = rootAt >= 0 ? resolve(args[rootAt + 1]) : resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const run = (executable, parameters) => execFileSync(executable, parameters, { encoding: 'utf8', timeout: 15_000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });

try {
  // This is a local development preparation step, not a six-platform supplier
  // or a self-contained binary distribution. Shared libraries stay installed
  // on this machine and all dependency paths are retained as evidence.
  if (process.platform !== 'darwin') throw new Error('Local runtime preparation currently supports macOS only');
  const suffix = process.arch === 'arm64' ? 'macos' : process.arch === 'x64' ? 'macos-intel' : null;
  if (!suffix) throw new Error('Unsupported local architecture');
  const sources = {};
  for (const name of ['ffmpeg', 'ffprobe']) {
    const input = process.env[name === 'ffmpeg' ? 'FFMPEG_PATH' : 'FFPROBE_PATH'] ?? `/opt/homebrew/bin/${name}`;
    if (!isAbsolute(input)) throw new Error('Development tool path must be absolute');
    sources[name] = await realpath(input);
    if (!(await stat(sources[name])).isFile()) throw new Error('Development tool must be a regular executable file');
  }
  const versionText = run(sources.ffmpeg, ['-version']);
  const version = versionText.match(/^ffmpeg version (\S+)/m)?.[1];
  const configure = versionText.match(/^configuration: (.+)$/m)?.[1];
  if (!version || !configure) throw new Error('FFmpeg version/configuration unavailable');
  if (/(?:^|\s)--enable-nonfree(?:\s|$)/.test(configure)) throw new Error('Nonfree FFmpeg builds are not allowed');
  if (!/(?:^|\s)--enable-gpl(?:\s|$)/.test(configure) || !/(?:^|\s)--enable-libx264(?:\s|$)/.test(configure)) {
    throw new Error('FFmpeg must include GPL libx264 for the service transcode fallback');
  }
  const probeVersion = run(sources.ffprobe, ['-version']).match(/^ffprobe version (\S+)/m)?.[1];
  if (probeVersion !== version) throw new Error('FFmpeg and ffprobe versions must match');
  const licenseNames = ['LICENSE.md', 'COPYING.GPLv3', 'COPYING.GPLv2', 'COPYING.LGPLv3', 'COPYING.LGPLv2.1'];
  const licenseRoot = dirname(dirname(sources.ffmpeg));
  const licenses = new Map();
  for (const name of licenseNames) licenses.set(name, await readFile(join(licenseRoot, name)));

  const seen = new Set();
  const dynamicLibraries = [];
  const inspect = async executable => {
    const listed = run('/usr/bin/otool', ['-L', executable]);
    for (const line of listed.split('\n').slice(1)) {
      const path = line.trim().split(' (compatibility version')[0];
      if (!path || seen.has(path) || path === executable) continue;
      seen.add(path);
      const system = path.startsWith('/System/') || path.startsWith('/usr/lib/');
      const entry = { path, system };
      if (!system) {
        if (!isAbsolute(path)) { entry.resolved = false; }
        else {
          entry.resolved = true;
          entry.sha256 = hash(await readFile(path));
          dynamicLibraries.push(entry);
          await inspect(path);
          continue;
        }
      }
      dynamicLibraries.push(entry);
    }
  };
  await inspect(sources.ffmpeg);
  await inspect(sources.ffprobe);
  const directory = join(root, 'resources/ffmpeg', suffix);
  await mkdir(join(directory, 'licenses'), { recursive: true });
  const sha256 = {};
  for (const name of ['ffmpeg', 'ffprobe']) {
    const output = join(directory, name);
    await copyFile(sources[name], output);
    await chmod(output, 0o755);
    run('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', output]);
    run('/usr/bin/codesign', ['--verify', '--strict', output]);
    sha256[name] = hash(await readFile(output));
  }
  for (const [name, bytes] of licenses) {
    await writeFile(join(directory, 'licenses', name), bytes);
    sha256[`licenses/${name}`] = hash(bytes);
  }
  const metadata = {
    schema: 1,
    platform: suffix,
    architecture: process.arch,
    version,
    configure,
    license: /--enable-version3/.test(configure) ? 'GPL-3.0-or-later' : 'GPL-2.0-or-later',
    source: { url: `https://ffmpeg.org/releases/ffmpeg-${version.replace(/-.*/, '')}.tar.xz`,
      upstream: 'https://git.ffmpeg.org/ffmpeg.git', localInstallation: licenseRoot,
      homebrewFormula: 'ffmpeg', installedRevision: licenseRoot.split('/').at(-1), sourceDownloaded: false },
    originals: sources,
    sha256,
    dynamicLibraries: dynamicLibraries.sort((a, b) => a.path.localeCompare(b.path)),
    redistributable: false,
    selfContained: false,
    signing: 'ad-hoc; hashes recorded after signing',
    limitation: 'Development-only. Tools retain absolute Homebrew dylib dependencies. Dependencies and corresponding source/licenses must be supplied and verified before redistribution; these records do not certify a formal package.',
  };
  await writeFile(join(directory, 'runtime.json'), JSON.stringify(metadata, null, 2) + '\n');
  console.log(`Prepared development-only ${suffix} FFmpeg ${version}; not self-contained (${dynamicLibraries.filter(entry => !entry.system).length} non-system dylibs).`);
} catch {
  // Child errors can include user-provided paths or environment details. Keep
  // the output fixed and never dump captured diagnostics or secrets.
  console.error('Local media runtime preparation failed; check installed FFmpeg/ffprobe paths, matching GPL libx264 builds and license files.');
  process.exitCode = 1;
}
