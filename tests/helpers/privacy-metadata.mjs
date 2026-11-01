// Test-only, bounded metadata fixtures and readers. These inspect the named
// TIFF/IPTC/XMP/PNG fields below, not every metadata vocabulary or pixel content.
const ascii = value => new TextEncoder().encode(value);
const text = value => new TextDecoder().decode(value);
const concat = (...parts) => Uint8Array.from(parts.flatMap(part => [...part]));
const be16 = value => [value >>> 8, value & 255];
const be32 = value => [value >>> 24, value >>> 16, value >>> 8, value];
const le16 = value => [value & 255, value >>> 8];
const le32 = value => [value, value >>> 8, value >>> 16, value >>> 24];
export const SYNTHETIC_METADATA = Object.freeze({
  artist: 'ImageCrate synthetic author',
  marker: 'SOURCE_METADATA_SENTINEL',
  keyword: 'ImageCrateSynthetic',
});

function requireRange(bytes, offset, size) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset + size > bytes.length) throw new Error('Truncated synthetic metadata/container');
}
function view(bytes) { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const body = concat(ascii(type), data);
  return concat(be32(data.length), body, be32(crc32(body)));
}
function webpChunk(type, data) { return concat(ascii(type), le32(data.length), data, data.length & 1 ? [0] : []); }
function jpegSegment(marker, data) {
  if (data.length > 65533) throw new Error('Synthetic JPEG segment is too large');
  return concat([255, marker], be16(data.length + 2), data);
}

export function syntheticExif(orientation = 1) {
  if (![1, 6].includes(orientation)) throw new Error('Only normal and clockwise fixture orientations are supported');
  const artist = ascii(SYNTHETIC_METADATA.artist + '\0');
  const artistOffset = 50;
  const gpsOffset = artistOffset + artist.length + (artist.length & 1);
  const rationalOffset = gpsOffset + 2 + 5 * 12 + 4;
  const entry = (tag, type, count, data) => concat(le16(tag), le16(type), le32(count), data);
  const rational = concat(le32(0), le32(1));
  // 0°N/0°E is an explicitly synthetic constant, never a user's location.
  return concat(ascii('II'), le16(42), le32(8), le16(3),
    entry(0x0112, 3, 1, concat(le16(orientation), [0, 0])),
    entry(0x013b, 2, artist.length, le32(artistOffset)),
    entry(0x8825, 4, 1, le32(gpsOffset)), le32(0), artist, artist.length & 1 ? [0] : [],
    le16(5), entry(0, 1, 4, [2, 3, 0, 0]), entry(1, 2, 2, ascii('N\0\0\0')),
    entry(2, 5, 3, le32(rationalOffset)), entry(3, 2, 2, ascii('E\0\0\0')),
    entry(4, 5, 3, le32(rationalOffset + 24)), le32(0),
    rational, rational, rational, rational, rational, rational);
}
function syntheticXmp() {
  return ascii('<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator><rdf:Seq><rdf:li>' + SYNTHETIC_METADATA.artist + '</rdf:li></rdf:Seq></dc:creator><dc:description><rdf:Alt><rdf:li xml:lang="x-default">' + SYNTHETIC_METADATA.marker + '</rdf:li></rdf:Alt></dc:description></rdf:Description></rdf:RDF></x:xmpmeta>');
}
function syntheticIptc() {
  const dataset = (tag, value) => { const bytes = ascii(value); return concat([0x1c, 2, tag], be16(bytes.length), bytes); };
  const iim = concat(dataset(80, SYNTHETIC_METADATA.artist), dataset(120, SYNTHETIC_METADATA.marker));
  // Photoshop Image Resource Block 0x0404 wraps the IPTC IIM datasets.
  return concat(ascii('Photoshop 3.0\0'), ascii('8BIM'), be16(0x0404), [0, 0], be32(iim.length), iim, iim.length & 1 ? [0] : []);
}

export function tagPrivacyMetadata(value, format, {orientation = 1, width = 16, height = 12} = {}) {
  const bytes = Uint8Array.from(value), exif = syntheticExif(orientation);
  if (format === 'png') {
    if (text(bytes.subarray(1, 4)) !== 'PNG') throw new Error('Expected PNG fixture');
    // eXIf belongs before IDAT. tEXt is a separate, named text-field assertion.
    return concat(bytes.slice(0, 33), pngChunk('eXIf', exif),
      pngChunk('tEXt', concat(ascii(SYNTHETIC_METADATA.keyword + '\0'), ascii(SYNTHETIC_METADATA.marker))), bytes.slice(33));
  }
  if (format === 'jpg') {
    if (bytes[0] !== 255 || bytes[1] !== 216) throw new Error('Expected JPEG fixture');
    return concat(bytes.slice(0, 2), jpegSegment(0xe1, concat(ascii('Exif\0\0'), exif)),
      jpegSegment(0xed, syntheticIptc()),
      jpegSegment(0xe1, concat(ascii('http://ns.adobe.com/xap/1.0/\0'), syntheticXmp())), bytes.slice(2));
  }
  if (format === 'webp') {
    if (text(bytes.subarray(0, 4)) !== 'RIFF' || text(bytes.subarray(8, 12)) !== 'WEBP') throw new Error('Expected WebP fixture');
    let body = bytes.slice(12);
    if (text(body.subarray(0, 4)) === 'VP8X') { body = body.slice(); body[8] |= 0x0c; }
    else {
      const alpha = text(body.subarray(0, 4)) === 'VP8L' && Boolean(body[12] & 16);
      const u24 = value => [value, value >>> 8, value >>> 16];
      body = concat(webpChunk('VP8X', concat([0x0c | (alpha ? 0x10 : 0), 0, 0, 0], u24(width - 1), u24(height - 1))), body);
    }
    body = concat(ascii('WEBP'), body, webpChunk('EXIF', exif), webpChunk('XMP ', syntheticXmp()));
    return concat(ascii('RIFF'), le32(body.length), body);
  }
  throw new Error('Unknown synthetic metadata format');
}

function readExif(bytes) {
  requireRange(bytes, 0, 8);
  const data = view(bytes), little = text(bytes.subarray(0, 2)) === 'II';
  if ((!little && text(bytes.subarray(0, 2)) !== 'MM') || data.getUint16(2, little) !== 42) throw new Error('Invalid TIFF header');
  const entries = offset => {
    requireRange(bytes, offset, 2); const count = data.getUint16(offset, little);
    if (count > 256) throw new Error('TIFF fixture has too many entries');
    requireRange(bytes, offset + 2, count * 12 + 4);
    const result = new Map();
    for (let index = 0; index < count; index++) {
      const at = offset + 2 + index * 12, tag = data.getUint16(at, little), type = data.getUint16(at + 2, little), count = data.getUint32(at + 4, little);
      const unit = ({1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8})[type];
      if (!unit || count > 65536) throw new Error('Unsupported TIFF fixture entry');
      const size = unit * count, start = size <= 4 ? at + 8 : data.getUint32(at + 8, little); requireRange(bytes, start, size);
      let value;
      if (type === 2) value = text(bytes.subarray(start, start + size)).replace(/\0+$/, '');
      else if ((type === 3 || type === 4) && count === 1) value = type === 3 ? data.getUint16(start, little) : data.getUint32(start, little);
      else if (type === 5) value = Array.from({length: count}, (_, i) => { const denominator = data.getUint32(start + i * 8 + 4, little); if (!denominator) throw new Error('Invalid TIFF rational'); return data.getUint32(start + i * 8, little) / denominator; });
      result.set(tag, value);
    }
    return result;
  };
  const root = entries(data.getUint32(4, little));
  const result = {orientation: root.get(0x112) ?? 1};
  if (root.has(0x13b)) result.artist = root.get(0x13b);
  if (root.has(0x8825)) {
    const gps = entries(root.get(0x8825));
    result.gps = {latitudeRef: gps.get(1), latitude: gps.get(2), longitudeRef: gps.get(3), longitude: gps.get(4)};
  }
  return result;
}
function readXmp(bytes) {
  const xml = text(bytes);
  if (!/<(?:\w+:)?xmpmeta\b/.test(xml) || !/<rdf:RDF\b/.test(xml) || !/<rdf:Description\b/.test(xml) || !/<\/rdf:RDF>/.test(xml)) throw new Error('Invalid XMP fixture packet');
  const list = tag => {
    const body = (new RegExp(`<dc:${tag}\\b[^>]*>([\\s\\S]*?)<\\/dc:${tag}>`, 'g')).exec(xml)?.[1] || '';
    return [...body.matchAll(/<rdf:li\b[^>]*>([^<]*)<\/rdf:li>/g)].map(match => match[1]);
  };
  return {creators: list('creator'), descriptions: list('description')};
}
function readIptc(bytes) {
  const prefix = ascii('Photoshop 3.0\0');
  if (text(bytes.subarray(0, prefix.length)) !== text(prefix)) return [];
  const data = view(bytes), datasets = []; let pos = prefix.length;
  while (pos < bytes.length) {
    requireRange(bytes, pos, 7); if (text(bytes.subarray(pos, pos + 4)) !== '8BIM') throw new Error('Invalid Photoshop resource');
    const id = data.getUint16(pos + 4), nameLength = bytes[pos + 6]; pos += 6 + 1 + nameLength + ((1 + nameLength) & 1);
    requireRange(bytes, pos, 4); const length = data.getUint32(pos); pos += 4; requireRange(bytes, pos, length);
    const end = pos + length;
    if (id === 0x0404) while (pos < end) {
      requireRange(bytes, pos, 5); if (bytes[pos] !== 0x1c) throw new Error('Invalid IPTC dataset');
      const length = data.getUint16(pos + 3); if (length & 0x8000 || pos + 5 + length > end) throw new Error('Invalid IPTC length');
      datasets.push({record: bytes[pos + 1], dataset: bytes[pos + 2], value: text(bytes.subarray(pos + 5, pos + 5 + length))}); pos += 5 + length;
    }
    pos = end + (length & 1);
  }
  return datasets;
}

export function readPrivacyMetadata(value, format) {
  const bytes = Uint8Array.from(value); if (bytes.length > 1024 * 1024) throw new Error('Test metadata reader accepts fixtures below 1 MiB');
  const data = view(bytes), result = {exif: [], iptc: [], xmp: [], text: []};
  if (format === 'png') {
    requireRange(bytes, 0, 8); if (text(bytes.subarray(1, 4)) !== 'PNG') throw new Error('Expected PNG');
    let pos = 8, ended = false;
    while (pos < bytes.length) {
      requireRange(bytes, pos, 12); const length = data.getUint32(pos), type = text(bytes.subarray(pos + 4, pos + 8)); requireRange(bytes, pos + 8, length + 4);
      if (crc32(bytes.subarray(pos + 4, pos + 8 + length)) !== data.getUint32(pos + 8 + length)) throw new Error('Invalid PNG CRC');
      const body = bytes.subarray(pos + 8, pos + 8 + length);
      if (type === 'eXIf') result.exif.push(readExif(body));
      if (type === 'tEXt') { const end = body.indexOf(0); if (end < 1) throw new Error('Invalid PNG text keyword'); result.text.push({keyword: text(body.subarray(0, end)), value: text(body.subarray(end + 1))}); }
      pos += 12 + length; if (type === 'IEND') { if (pos !== bytes.length) throw new Error('PNG trailing bytes'); ended = true; break; }
    }
    if (!ended) throw new Error('Missing PNG end');
  } else if (format === 'jpg') {
    requireRange(bytes, 0, 2); if (bytes[0] !== 255 || bytes[1] !== 216) throw new Error('Expected JPEG'); let pos = 2, ended = false;
    while (pos < bytes.length) {
      if (bytes[pos++] !== 255) throw new Error('Invalid JPEG marker'); while (bytes[pos] === 255) pos++;
      requireRange(bytes, pos, 1); const marker = bytes[pos++]; if (marker === 0xd9) { ended = true; if (pos !== bytes.length) throw new Error('JPEG trailing bytes'); break; }
      requireRange(bytes, pos, 2); const length = data.getUint16(pos); if (length < 2) throw new Error('Invalid JPEG segment'); requireRange(bytes, pos, length);
      const body = bytes.subarray(pos + 2, pos + length);
      if (marker === 0xe1 && text(body.subarray(0, 6)) === 'Exif\0\0') result.exif.push(readExif(body.subarray(6)));
      const xmpHeader = 'http://ns.adobe.com/xap/1.0/\0';
      if (marker === 0xe1 && text(body.subarray(0, xmpHeader.length)) === xmpHeader) result.xmp.push(readXmp(body.subarray(xmpHeader.length)));
      if (marker === 0xed) result.iptc.push(...readIptc(body));
      pos += length;
      if (marker === 0xda) while (pos < bytes.length) {
        if (bytes[pos] !== 255) { pos++; continue; }
        requireRange(bytes, pos, 2); const next = bytes[pos + 1]; if (next === 0 || next >= 0xd0 && next <= 0xd7) pos += 2; else break;
      }
    }
    if (!ended) throw new Error('Missing JPEG end');
  } else if (format === 'webp') {
    requireRange(bytes, 0, 12); if (text(bytes.subarray(0, 4)) !== 'RIFF' || text(bytes.subarray(8, 12)) !== 'WEBP' || data.getUint32(4, true) + 8 !== bytes.length) throw new Error('Invalid WebP fixture');
    let pos = 12;
    while (pos < bytes.length) {
      requireRange(bytes, pos, 8); const type = text(bytes.subarray(pos, pos + 4)), length = data.getUint32(pos + 4, true); requireRange(bytes, pos + 8, length + (length & 1));
      const body = bytes.subarray(pos + 8, pos + 8 + length);
      if (type === 'EXIF') result.exif.push(readExif(body)); if (type === 'XMP ') result.xmp.push(readXmp(body)); pos += 8 + length + (length & 1);
    }
  } else throw new Error('Unknown privacy metadata format');
  return result;
}
