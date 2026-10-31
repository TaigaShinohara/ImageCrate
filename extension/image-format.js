const MIME_TYPES = new Map([
  ['image/jpeg', ['jpg', 'image/jpeg']], ['image/jpg', ['jpg', 'image/jpeg']],
  ['image/pjpeg', ['jpg', 'image/jpeg']],
  ['image/png', ['png', 'image/png']], ['image/x-png', ['png', 'image/png']],
  ['image/apng', ['png', 'image/png']], ['image/gif', ['gif', 'image/gif']],
  ['image/webp', ['webp', 'image/webp']], ['image/avif', ['avif', 'image/avif']],
  ['image/svg+xml', ['svg', 'image/svg+xml']],
  ['image/bmp', ['bmp', 'image/bmp']], ['image/x-ms-bmp', ['bmp', 'image/bmp']],
  ['image/x-icon', ['ico', 'image/x-icon']], ['image/vnd.microsoft.icon', ['ico', 'image/x-icon']]
]);

function declaredFormat(mime) {
  if (typeof mime !== 'string') return null;
  return MIME_TYPES.get(mime.split(';')[0].trim().toLowerCase()) || null;
}

export function extensionForMime(mime) { return declaredFormat(mime)?.[0] || ''; }

function prefixView(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value)) return Uint8Array.from(value);
  return new Uint8Array();
}

function formatFromBytes(value) {
  // A small prefix is sufficient for these signatures; never decode or
  // transform the downloaded image to determine its original file suffix.
  const bytes = prefixView(value).subarray(0, 64);
  const starts = signature => signature.every((byte, i) => bytes[i] === byte);
  const textAt = (offset, text) => [...text].every((letter, i) => bytes[offset + i] === letter.charCodeAt(0));
  if (starts([137,80,78,71,13,10,26,10])) return MIME_TYPES.get('image/png');
  if (starts([255,216,255])) return MIME_TYPES.get('image/jpeg');
  if (textAt(0, 'GIF87a') || textAt(0, 'GIF89a')) return MIME_TYPES.get('image/gif');
  if (textAt(0, 'RIFF') && textAt(8, 'WEBP')) return MIME_TYPES.get('image/webp');
  if (bytes.length >= 18 && textAt(0, 'BM')) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const offset = view.getUint32(10, true);
    const headerSize = view.getUint32(14, true);
    if ([12,16,40,52,56,64,108,124].includes(headerSize) && offset >= 14 + headerSize) {
      return MIME_TYPES.get('image/bmp');
    }
  }
  if (bytes.length >= 6 && starts([0,0,1,0]) && (bytes[4] || bytes[5])) return MIME_TYPES.get('image/x-icon');
  if (bytes.length >= 16 && textAt(4, 'ftyp')) {
    const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
    if (size >= 16 && size % 4 === 0) {
      const avifBrand = offset => textAt(offset, 'avif') || textAt(offset, 'avis');
      if (avifBrand(8)) return MIME_TYPES.get('image/avif');
      for (let offset = 16; offset + 4 <= Math.min(size, bytes.length); offset += 4) {
        if (avifBrand(offset)) return MIME_TYPES.get('image/avif');
      }
    }
  }
  // SVG has no reliable short binary signature. Its declared image MIME is
  // accepted, while untyped XML/text remains unknown instead of being guessed.
  return null;
}

export function extensionForBytes(value) {return formatFromBytes(value)?.[0] || '';}

export function resolveImageFilename(filename, mime, prefixBytes) {
  const format = formatFromBytes(prefixBytes) || declaredFormat(mime);
  const extension = format?.[0] || 'img';
  const value = String(filename);
  const dot = value.lastIndexOf('.');
  const separator = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'));
  const hasExtension = dot > separator + 1;
  const previous = hasExtension ? value.slice(dot + 1).toLowerCase() : '';
  const sameFormat = previous === extension || (extension === 'jpg' && previous === 'jpeg');
  return {filename:sameFormat ? value : `${hasExtension ? value.slice(0, dot) : value}.${extension}`,
    known:Boolean(format), mime:format?.[1] || ''};
}
