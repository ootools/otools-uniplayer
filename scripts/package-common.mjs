import { createHash } from 'node:crypto';
import { readdir, lstat, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const platforms = [
  { suffix: 'macos', os: 'darwin', arch: 'arm64' },
  { suffix: 'macos-intel', os: 'darwin', arch: 'x64' },
  { suffix: 'windows', os: 'win32', arch: 'x64' },
  { suffix: 'windows-arm', os: 'win32', arch: 'arm64' },
  { suffix: 'linux', os: 'linux', arch: 'x64' },
  { suffix: 'linux-arm', os: 'linux', arch: 'arm64' },
];
export function options() {
  const args = process.argv.slice(2);
  const rootAt = args.indexOf('--root');
  return { root: rootAt >= 0 ? resolve(args[rootAt + 1]) : resolve(dirname(fileURLToPath(import.meta.url)), '..'), dev: args.includes('--dev') };
}
export function currentPlatform() {
  const target = platforms.find(platform => platform.os === process.platform && platform.arch === process.arch);
  if (!target) throw new Error('Unsupported local platform');
  return target;
}
export function binaryName(bin, target) { return `${bin}-${target.suffix}${target.os === 'win32' ? '.exe' : ''}`; }
export function digest(buffer) { return createHash('sha256').update(buffer).digest('hex'); }
export async function collect(root, relative) {
  const info = await lstat(resolve(root, relative));
  if (info.isSymbolicLink()) throw new Error(`Symlinks are not allowed: ${relative}`);
  if (info.isFile()) return [relative];
  if (!info.isDirectory()) throw new Error(`Unsupported package entry: ${relative}`);
  const paths = [];
  for (const entry of (await readdir(resolve(root, relative))).sort()) paths.push(...await collect(root, `${relative}/${entry}`));
  return paths;
}
export function verifyExecutable(bytes, target) {
  if (target.os === 'darwin') {
    if (bytes.length < 32 || bytes.readUInt32LE(0) !== 0xfeedfacf) throw new Error(`Invalid Mach-O binary: ${target.suffix}`);
    const cpu = bytes.readUInt32LE(4);
    if (cpu !== (target.arch === 'arm64' ? 0x100000c : 0x1000007)) throw new Error(`Mach-O architecture mismatch: ${target.suffix}`);
    if (bytes.readUInt32LE(12) !== 2) throw new Error(`Mach-O is not an executable: ${target.suffix}`);
  } else if (target.os === 'win32') {
    if (bytes.length < 64 || bytes.subarray(0, 2).toString() !== 'MZ') throw new Error(`Invalid PE binary: ${target.suffix}`);
    const pe = bytes.readUInt32LE(0x3c);
    if (pe + 24 > bytes.length || bytes.subarray(pe, pe + 4).toString('hex') !== '50450000') throw new Error('Invalid PE header');
    if (bytes.readUInt16LE(pe + 4) !== (target.arch === 'arm64' ? 0xaa64 : 0x8664)) throw new Error(`PE architecture mismatch: ${target.suffix}`);
    const flags = bytes.readUInt16LE(pe + 22);
    if (!(flags & 2) || flags & 0x2000) throw new Error('PE file must be an executable, not a DLL');
  } else {
    if (bytes.length < 64 || bytes.subarray(0, 4).toString('hex') !== '7f454c46' || bytes[4] !== 2 || bytes[5] !== 1) throw new Error(`Invalid ELF binary: ${target.suffix}`);
    if (bytes.readUInt16LE(18) !== (target.arch === 'arm64' ? 183 : 62)) throw new Error(`ELF architecture mismatch: ${target.suffix}`);
    if (![2, 3].includes(bytes.readUInt16LE(16))) throw new Error('ELF file must be executable');
  }
}
export async function manifestAt(root) {
  const manifest = JSON.parse(await readFile(resolve(root, 'plugin.json'), 'utf8'));
  if (!/^[a-zA-Z0-9_-]+$/.test(manifest.packid ?? '') || !/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(manifest.version ?? '')) throw new Error('Invalid package id/version');
  if (!Array.isArray(manifest.sidecars) || !manifest.sidecars.length) throw new Error('Missing sidecar declaration');
  for (const entry of manifest.sidecars) if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(entry.bin ?? '') || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(entry.id ?? '')) throw new Error('Invalid sidecar declaration');
  return manifest;
}
