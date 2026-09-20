const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function writeU16(buf, offset, value) {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >>> 8) & 0xff;
}

function writeU32(buf, offset, value) {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >>> 8) & 0xff;
  buf[offset + 2] = (value >>> 16) & 0xff;
  buf[offset + 3] = (value >>> 24) & 0xff;
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

export async function zipFolderFiles(folderFiles) {
  const cleaned = [];
  for (const f of folderFiles) {
    let path = String(f.relativePath || f.name).replace(/\\/g, '/');
    while (path.startsWith('/')) path = path.slice(1);
    if (!path) continue;
    const bytes = new Uint8Array(await f.arrayBuffer());
    const mtime = new Date(f.lastModified || Date.now());
    cleaned.push({ path, bytes, mtime });
  }
  if (!cleaned.length) return null;

  const dirSet = new Set();
  for (const c of cleaned) {
    const parts = c.path.split('/');
    parts.pop();
    let acc = '';
    for (const p of parts) {
      acc = acc ? acc + '/' + p : p;
      dirSet.add(acc + '/');
    }
  }

  const seen = new Set();
  const entries = [];
  for (const d of [...dirSet].sort()) entries.push({ name: d, bytes: new Uint8Array(0), mtime: new Date() });
  for (const c of cleaned) {
    if (!seen.has(c.path)) {
      seen.add(c.path);
      entries.push({ name: c.path, bytes: c.bytes, mtime: c.mtime });
    }
  }

  const encoder = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const nameU8 = encoder.encode(entry.name);
    const crc = crc32(entry.bytes);
    const { time, day } = dosDateTime(entry.mtime);

    const local = new Uint8Array(30 + nameU8.length);
    writeU32(local, 0, 0x04034b50);
    writeU16(local, 4, 20);
    writeU16(local, 6, 0x0800);
    writeU16(local, 8, 0);
    writeU16(local, 10, time);
    writeU16(local, 12, day);
    writeU32(local, 14, crc);
    writeU32(local, 18, entry.bytes.length);
    writeU32(local, 22, entry.bytes.length);
    writeU16(local, 26, nameU8.length);
    local.set(nameU8, 30);
    parts.push(local);
    if (entry.bytes.length) parts.push(entry.bytes);

    const cd = new Uint8Array(46 + nameU8.length);
    writeU32(cd, 0, 0x02014b50);
    writeU16(cd, 4, 0x0314);
    writeU16(cd, 6, 20);
    writeU16(cd, 8, 0x0800);
    writeU16(cd, 10, 0);
    writeU16(cd, 12, time);
    writeU16(cd, 14, day);
    writeU32(cd, 16, crc);
    writeU32(cd, 20, entry.bytes.length);
    writeU32(cd, 24, entry.bytes.length);
    writeU16(cd, 28, nameU8.length);
    writeU32(cd, 42, offset);
    cd.set(nameU8, 46);
    central.push(cd);

    offset += local.length + entry.bytes.length;
  }

  const cdSize = central.reduce((a, c) => a + c.length, 0);
  for (const cd of central) parts.push(cd);

  const eocd = new Uint8Array(22);
  writeU32(eocd, 0, 0x06054b50);
  writeU16(eocd, 4, 0);
  writeU16(eocd, 6, 0);
  writeU16(eocd, 8, entries.length);
  writeU16(eocd, 10, entries.length);
  writeU32(eocd, 12, cdSize);
  writeU32(eocd, 16, offset);
  parts.push(eocd);

  const blob = new Blob(parts, { type: 'application/zip' });
  const root = cleaned[0].path.split('/')[0] || 'folder';
  const safe = root.replace(/[\\/:*?"<>|]/g, '_');
  return new File([blob], safe + '.zip', { type: 'application/zip', lastModified: Date.now() });
}