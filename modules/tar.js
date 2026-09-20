// Pure in-memory uncompressed TAR package builder (POSIX ustar standard)
// Zero compression: stores files verbatim with directory hierarchies.
export class TarPackage {
  constructor(rootName = 'folder') {
    this.rootName = (rootName || 'folder').replace(/[\\/]/g, '_');
    this.files = [];
    this.encoder = new TextEncoder();
  }

  addFile(relativePath, uint8Array) {
    this.files.push({
      path: String(relativePath).replace(/\\/g, '/'),
      data: uint8Array instanceof Uint8Array ? uint8Array : new Uint8Array(uint8Array)
    });
  }

  buildBlob() {
    const chunks = [];
    const encoder = this.encoder;

    function writeString(buf, str, offset, length) {
      const bytes = encoder.encode(str);
      buf.set(bytes.subarray(0, length), offset);
    }

    function writeOctal(buf, num, offset, length) {
      const str = num.toString(8).padStart(length - 1, '0');
      writeString(buf, str + ' ', offset, length);
    }

    for (const file of this.files) {
      const header = new Uint8Array(512);
      let name = file.path;
      let prefix = '';
      if (name.length > 100) {
        const idx = name.lastIndexOf('/', 155);
        if (idx > 0) {
          prefix = name.slice(0, idx);
          name = name.slice(idx + 1);
        }
      }
      writeString(header, name, 0, 100);
      writeOctal(header, 0o644, 100, 8); // permissions
      writeOctal(header, 0, 108, 8);     // uid
      writeOctal(header, 0, 116, 8);     // gid
      writeOctal(header, file.data.byteLength, 124, 12); // size
      writeOctal(header, Math.floor(Date.now() / 1000), 136, 12); // mtime
      header.fill(32, 148, 156);         // 8 spaces placeholder for checksum
      header[156] = 48;                 // '0' = normal file
      writeString(header, 'ustar', 257, 6);
      writeString(header, '00', 263, 2);
      if (prefix) writeString(header, prefix, 345, 155);

      let checksum = 0;
      for (let i = 0; i < 512; i++) checksum += header[i];
      const chkStr = checksum.toString(8).padStart(6, '0') + '\0 ';
      writeString(header, chkStr, 148, 8);

      chunks.push(header);
      chunks.push(file.data);

      const pad = (512 - (file.data.byteLength % 512)) % 512;
      if (pad > 0) chunks.push(new Uint8Array(pad));
    }

    // End of archive marker (1024 zero bytes)
    chunks.push(new Uint8Array(1024));
    return new Blob(chunks, { type: 'application/x-tar' });
  }
}


export async function writeToDirectory(dirHandle, relativePath, blob) {
  const parts = String(relativePath).replace(/\\/g, '/').split('/').filter(Boolean);
  const filename = parts.pop();
  let currentDir = dirHandle;
  for (const part of parts) {
    currentDir = await currentDir.getDirectoryHandle(part, { create: true });
  }
  const fileHandle = await currentDir.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();
}
