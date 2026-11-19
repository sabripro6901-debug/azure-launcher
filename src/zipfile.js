'use strict';
// Reads single entries of a zip file from disk without loading the whole file (AUDIT M10: a 400 MB modpack was read
// into memory twice). Only what is needed is read: the directory at the end of the file, then each wanted entry.
// Plain zip only (stored or deflated); ZIP64 and encrypted entries are refused. Each entry is inflated with a hard
// cap at its declared size, so a file that lies about its size can't blow up memory.
const fs = require('node:fs');
const zlib = require('node:zlib');

class ZipError extends Error {}

const EOCD = 0x06054b50;
const CEN = 0x02014b50;
const LOC = 0x04034b50;

function readAt(fd, pos, len) {
  const b = Buffer.alloc(len);
  let got = 0;
  while (got < len) {
    const n = fs.readSync(fd, b, got, len - got, pos + got);
    if (n === 0) throw new ZipError('Unexpected end of the zip file');
    got += n;
  }
  return b;
}

/** Opens a zip: { entries: [{ name, size, compressedSize }], read(entry) -> Buffer, close() }. */
function openZip(file, { maxEntries = 20000 } = {}) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const tailLen = Math.min(size, 22 + 65535);
    const tail = readAt(fd, size - tailLen, tailLen);
    let e = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === EOCD) { e = i; break; }
    if (e < 0) throw new ZipError('Not a zip file');
    const count = tail.readUInt16LE(e + 10);
    const cdSize = tail.readUInt32LE(e + 12);
    const cdOff = tail.readUInt32LE(e + 16);
    if (count === 0xffff || cdOff === 0xffffffff || cdSize === 0xffffffff) throw new ZipError('ZIP64 is not supported');
    if (count > maxEntries) throw new ZipError('Too many files in the zip');
    if (cdOff + cdSize > size) throw new ZipError('Damaged zip directory');
    const cd = readAt(fd, cdOff, cdSize);
    const entries = [];
    for (let p = 0, k = 0; k < count; k++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== CEN) throw new ZipError('Damaged zip directory');
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const compressedSize = cd.readUInt32LE(p + 20);
      const sz = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const local = cd.readUInt32LE(p + 42);
      const name = cd.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLen);
      entries.push({ name, method, flags, size: sz, compressedSize, local });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return {
      entries,
      read(entry) {
        if (entry.flags & 1) throw new ZipError('Encrypted entry: ' + entry.name);
        const h = readAt(fd, entry.local, 30);
        if (h.readUInt32LE(0) !== LOC) throw new ZipError('Damaged entry: ' + entry.name);
        const start = entry.local + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
        if (start + entry.compressedSize > size) throw new ZipError('Damaged entry: ' + entry.name);
        const raw = readAt(fd, start, entry.compressedSize);
        if (entry.method === 0) {
          if (raw.length !== entry.size) throw new ZipError('Damaged entry: ' + entry.name);
          return raw;
        }
        if (entry.method !== 8) throw new ZipError('Unsupported compression in ' + entry.name);
        let out;
        try {
          out = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.size) });
        } catch {
          throw new ZipError('Damaged or oversized entry: ' + entry.name);
        }
        if (out.length !== entry.size) throw new ZipError('Damaged entry: ' + entry.name);
        return out;
      },
      close() { try { fs.closeSync(fd); } catch { /* already closed */ } },
    };
  } catch (e) {
    fs.closeSync(fd);
    throw e;
  }
}

module.exports = { openZip, ZipError };
