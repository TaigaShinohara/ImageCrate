// Zero-dependency streaming ZIP file builder using Web standard APIs.
// Conforms to PKZIP 2.0 specification with UTF-8 filename support.

const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[i] = c >>> 0;
}

export function crc32(bytes, previous = 0) {
  let crc = (previous ^ -1) >>> 0;
  const len = bytes.length;
  for (let i = 0; i < len; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

export async function computeBlobCrc32(blob) {
  const buffer = await blob.arrayBuffer();
  return crc32(new Uint8Array(buffer));
}

const encoder = new TextEncoder();

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = Math.floor(date.getSeconds() / 2);

  const dosTime = (hours << 11) | (minutes << 5) | seconds;
  const dosDate = ((year - 1980) << 9) | (month << 5) | day;
  return { time: dosTime, date: dosDate };
}

export class ZipArchive {
  constructor() {
    this.entries = [];
    this.chunks = [];
    this.offset = 0;
  }

  /**
   * Add a file to the archive.
   * @param {string} filename - UTF-8 relative filename
   * @param {Uint8Array|Blob} data - file content
   * @param {Object} [options]
   */
  async addFile(filename, data, options = {}) {
    const cleanName = filename.replace(/\\/g, '/').replace(/^\/+/, '');
    const nameBytes = encoder.encode(cleanName);
    const size = data instanceof Blob ? data.size : data.byteLength;
    const crc = options.crc !== undefined ? options.crc : (
      data instanceof Blob ? await computeBlobCrc32(data) : crc32(data)
    );

    const { time, date } = dosDateTime(options.date);
    const localHeaderOffset = this.offset;

    // Local file header (30 bytes + filename)
    // 0x04034b50 (4)
    // version needed (2) = 20 (2.0)
    // bit flag (2) = 0x0800 (UTF-8)
    // method (2) = 0 (Store)
    // mod time (2), mod date (2)
    // crc32 (4)
    // compressed size (4)
    // uncompressed size (4)
    // filename length (2)
    // extra field length (2) = 0
    const localHeader = new Uint8Array(30 + nameBytes.length);
    const view = new DataView(localHeader.buffer);

    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 0x0800, true); // UTF-8
    view.setUint16(8, 0, true);      // Store
    view.setUint16(10, time, true);
    view.setUint16(12, date, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, size, true);  // compressed size
    view.setUint32(22, size, true);  // uncompressed size
    view.setUint16(26, nameBytes.length, true);
    view.setUint16(28, 0, true);     // extra length

    localHeader.set(nameBytes, 30);

    this.chunks.push(localHeader);
    this.chunks.push(data);
    this.offset += localHeader.length + size;

    this.entries.push({
      nameBytes,
      crc,
      size,
      time,
      date,
      offset: localHeaderOffset
    });
  }

  /**
   * Finalize the archive and return a Blob.
   * @returns {Blob}
   */
  generate() {
    const centralDirOffset = this.offset;
    let centralDirSize = 0;

    // Central Directory Headers
    for (const entry of this.entries) {
      // 46 bytes + filename length
      const cdHeader = new Uint8Array(46 + entry.nameBytes.length);
      const view = new DataView(cdHeader.buffer);

      view.setUint32(0, 0x02014b50, true); // central header signature
      view.setUint16(4, 20, true);         // version made by (DOS/FAT 2.0)
      view.setUint16(6, 20, true);         // version needed
      view.setUint16(8, 0x0800, true);     // bit flag (UTF-8)
      view.setUint16(10, 0, true);         // compression method (Store)
      view.setUint16(12, entry.time, true);
      view.setUint16(14, entry.date, true);
      view.setUint32(16, entry.crc, true);
      view.setUint32(20, entry.size, true); // compressed size
      view.setUint32(24, entry.size, true); // uncompressed size
      view.setUint16(28, entry.nameBytes.length, true);
      view.setUint16(30, 0, true);         // extra field length
      view.setUint16(32, 0, true);         // comment length
      view.setUint16(34, 0, true);         // disk number start
      view.setUint16(36, 0, true);         // internal attributes
      view.setUint32(38, 0, true);         // external attributes
      view.setUint32(42, entry.offset, true); // relative offset of local header

      cdHeader.set(entry.nameBytes, 46);

      this.chunks.push(cdHeader);
      centralDirSize += cdHeader.length;
    }

    // End of Central Directory Record (22 bytes)
    const eocd = new Uint8Array(22);
    const eocdView = new DataView(eocd.buffer);

    eocdView.setUint32(0, 0x06054b50, true); // EOCD signature
    eocdView.setUint16(4, 0, true);          // disk number
    eocdView.setUint16(6, 0, true);          // disk with central dir
    eocdView.setUint16(8, this.entries.length, true);  // entries on this disk
    eocdView.setUint16(10, this.entries.length, true); // total entries
    eocdView.setUint32(12, centralDirSize, true);       // size of central dir
    eocdView.setUint32(16, centralDirOffset, true);     // offset of central dir
    eocdView.setUint16(20, 0, true);          // comment length

    this.chunks.push(eocd);

    return new Blob(this.chunks, { type: 'application/zip' });
  }
}
