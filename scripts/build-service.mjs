import { execFileSync } from 'node:child_process';
import { chmod, copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const rootAt = args.indexOf('--root');
const root = rootAt >= 0 ? resolve(args[rootAt + 1]) : resolve(dirname(fileURLToPath(import.meta.url)), '..');
const debug = args.includes('--debug');

try {
  const suffix = process.platform === 'darwin' ? (process.arch === 'arm64' ? 'macos' : process.arch === 'x64' ? 'macos-intel' : null)
    : process.platform === 'win32' ? (process.arch === 'arm64' ? 'windows-arm' : process.arch === 'x64' ? 'windows' : null)
      : process.platform === 'linux' ? (process.arch === 'arm64' ? 'linux-arm' : process.arch === 'x64' ? 'linux' : null) : null;
  if (!suffix) throw new Error('Unsupported local service target');
  const build = ['build', '--locked', '--manifest-path', join(root, 'service/Cargo.toml')];
  if (!debug) build.push('--release');
  execFileSync(process.env.CARGO_PATH ?? 'cargo', build, { cwd: root, stdio: 'inherit', timeout: 600_000 });
  const extension = process.platform === 'win32' ? '.exe' : '';
  const artifact = join(root, 'service/target', debug ? 'debug' : 'release', `otools-media-service${extension}`);
  const bytes = await readFile(artifact);
  if (bytes.length < 64 * 1024) throw new Error('Missing service executable');
  const output = join(root, 'bin', `player-${suffix}${extension}`);
  await mkdir(dirname(output), { recursive: true });
  await copyFile(artifact, output);
  await chmod(output, 0o755);
  if (process.platform === 'darwin') {
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', output], { stdio: 'inherit', timeout: 30_000 });
    execFileSync('/usr/bin/codesign', ['--verify', '--strict', output], { stdio: 'inherit', timeout: 30_000 });
  }
  console.log(`Built local ${debug ? 'debug' : 'release'} service: ${output}`);
} catch {
  console.error('Local service build failed; no placeholder binary was generated.');
  process.exitCode = 1;
}
