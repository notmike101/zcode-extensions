import {deflateRawSync} from "node:zlib";
import {readFile, readdir, stat, writeFile} from "node:fs/promises";
import path from "node:path";

const FORMAT_VERSION = 20;
const DEFLATE = 8;
const UTF8_NAME_FLAG = 0x0800;
const DOS_TIME = ((12 * 60 + 0) * 32 + 0) * 2;
const DOS_DATE = ((2026 - 1980) * 512) + (7 * 32) + 22;
const UNIX_REGULAR_FILE = (0o100644 << 16) >>> 0;
const UNIX_DIRECTORY = (0o40755 << 16) >>> 0;

type ArchiveEntry = {name: string; bytes: Buffer; directory: boolean};

export async function writeZipFromDirectory(source: string, destination: string): Promise<void> {
  const root = path.basename(path.resolve(source));
  const entries = await collectEntries(source, root);
  await writeFile(destination, buildZip(entries));
}

async function collectEntries(source: string, name: string): Promise<ArchiveEntry[]> {
  const info = await stat(source);
  if (!info.isDirectory()) return [{name, bytes: await readFile(source), directory: false}];
  const entries: ArchiveEntry[] = [{name: `${name}/`, bytes: Buffer.alloc(0), directory: true}];
  const children = (await readdir(source, {withFileTypes: true})).sort((left, right) => left.name.localeCompare(right.name));
  for (const child of children) {
    if (child.isSymbolicLink()) throw new Error(`Test archive fixtures may not contain links: ${path.join(source, child.name)}`);
    if (!child.isDirectory() && !child.isFile()) throw new Error(`Unsupported archive fixture entry: ${path.join(source, child.name)}`);
    entries.push(...await collectEntries(path.join(source, child.name), `${name}/${child.name}`));
  }
  return entries;
}

function buildZip(entries: ArchiveEntry[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const compressed = entry.directory ? entry.bytes : deflateRawSync(entry.bytes);
    const uncompressed = entry.directory || compressed.length >= entry.bytes.length;
    const method = uncompressed ? 0 : DEFLATE;
    const payload = uncompressed ? entry.bytes : compressed;
    const crc = crc32(entry.bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(FORMAT_VERSION, 4);
    local.writeUInt16LE(UTF8_NAME_FLAG, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    chunks.push(local, name, payload);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(FORMAT_VERSION | 0x0300, 4);
    header.writeUInt16LE(FORMAT_VERSION, 6);
    header.writeUInt16LE(UTF8_NAME_FLAG, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt16LE(DOS_TIME, 12);
    header.writeUInt16LE(DOS_DATE, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(payload.length, 20);
    header.writeUInt32LE(entry.bytes.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(entry.directory ? UNIX_DIRECTORY : UNIX_REGULAR_FILE, 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);
    offset += local.length + name.length + payload.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, directory, end]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? (0xedb88320 ^ (value >>> 1)) >>> 0 : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)) >>> 0;
  return (crc ^ 0xffffffff) >>> 0;
}