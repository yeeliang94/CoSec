import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';
import { DomainError } from '../../domain/access';

/**
 * A zip package read so that it can be written back with every untouched part byte-identical.
 * mTool workbooks carry activeX, VML and external-link parts that must survive unchanged, so the
 * builder edits single XML parts and leaves the rest as stored.
 */
export type ZipEntry = {
  name: string;
  method: number;
  crc: number;
  size: number;
  /** The stored (compressed) bytes, written back unchanged unless `data` was replaced. */
  raw: Buffer;
  /** Replacement content, set by `setText`/`setBytes`; null keeps `raw`. */
  data: Buffer | null;
  time: number;
  date: number;
  flags: number;
};
export type ZipPackage = { entries: ZipEntry[] };

/** Declared uncompressed size of the whole package; mTool's own blank is about 2 MB. */
const MAX_TOTAL = 64 * 1024 * 1024;
/** One XML part read as text; the largest sheet in mTool's blank is well under 1 MiB. */
export const MAX_PART_BYTES = 16 * 1024 * 1024;
const damaged = () => new DomainError('The workbook is damaged. Save a fresh blank from mTool.');

export function readPackage(bytes: Buffer): ZipPackage {
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--)
    if (bytes.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  if (end < 0) throw new Error('Not a zip package.');
  const count = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16);
  let total = 0;
  const entries: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error('Corrupt zip directory.');
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const time = bytes.readUInt16LE(offset + 12);
    const date = bytes.readUInt16LE(offset + 14);
    const crc = bytes.readUInt32LE(offset + 16);
    const compressed = bytes.readUInt32LE(offset + 20);
    const size = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extra = bytes.readUInt16LE(offset + 30);
    const comment = bytes.readUInt16LE(offset + 32);
    const local = bytes.readUInt32LE(offset + 42);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (method !== 0 && method !== 8) throw new Error(`Unsupported zip compression in ${name}.`);
    if (flags & 1) throw new Error('Encrypted workbooks are not supported.');
    total += size;
    if (total > MAX_TOTAL) throw new Error('The workbook is too large.');
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    entries.push({
      name,
      method,
      crc,
      size,
      raw: Buffer.from(bytes.subarray(start, start + compressed)),
      data: null,
      time,
      date,
      // Sizes are written in the local header, so no data descriptor follows.
      flags: flags & ~0x08 & 0xffff,
    });
    offset += 46 + nameLength + extra + comment;
  }
  return { entries };
}

/**
 * An entry's content. Inflating is capped at the size the directory declares (itself capped by
 * MAX_TOTAL), so a crafted entry cannot expand without limit, and any other length is refused.
 */
export function entryBytes(entry: ZipEntry): Buffer {
  if (entry.data) return entry.data;
  if (entry.size > MAX_TOTAL) throw new DomainError('The workbook is too large.');
  let out: Buffer;
  if (entry.method === 0) out = entry.raw;
  else
    try {
      out = inflateRawSync(entry.raw, { maxOutputLength: Math.max(1, entry.size) });
    } catch {
      throw damaged();
    }
  if (out.length !== entry.size) throw damaged();
  return out;
}
export function hasPart(pkg: ZipPackage, name: string) {
  return pkg.entries.some((e) => e.name === name);
}
export function readText(pkg: ZipPackage, name: string): string {
  const entry = pkg.entries.find((e) => e.name === name);
  if (!entry) throw new Error(`The workbook has no ${name}.`);
  if ((entry.data?.length ?? entry.size) > MAX_PART_BYTES)
    throw new DomainError(`The workbook part ${name} is too large (over 16 MiB).`);
  return entryBytes(entry).toString('utf8');
}
export function setText(pkg: ZipPackage, name: string, text: string) {
  const entry = pkg.entries.find((e) => e.name === name);
  if (!entry) throw new Error(`The workbook has no ${name}.`);
  entry.data = Buffer.from(text, 'utf8');
}
export function removePart(pkg: ZipPackage, name: string) {
  pkg.entries = pkg.entries.filter((e) => e.name !== name);
}

/** Writes the package; untouched entries keep their stored bytes and checksums. */
export function writePackage(pkg: ZipPackage): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of pkg.entries) {
    let { raw, crc, size, method } = entry;
    if (entry.data) {
      size = entry.data.length;
      crc = crc32(entry.data) >>> 0;
      method = 8;
      raw = deflateRawSync(entry.data);
    }
    const name = Buffer.from(entry.name, 'utf8');
    const flags = entry.flags | (/[^\x00-\x7f]/.test(entry.name) ? 0x800 : 0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(entry.time, 10);
    local.writeUInt16LE(entry.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(raw.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(entry.time, 12);
    central.writeUInt16LE(entry.date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(raw.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, raw);
    centrals.push(central, name);
    offset += local.length + name.length + raw.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(pkg.entries.length, 8);
  end.writeUInt16LE(pkg.entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
