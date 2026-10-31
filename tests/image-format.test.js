import test from 'node:test';
import assert from 'node:assert/strict';
import {extensionForMime, resolveImageFilename} from '../extension/image-format.js';

const bytes = text => Uint8Array.from([...text].map(letter => letter.charCodeAt(0)));
const avif = (brand = 'avif', compatible = '') => {
  const result = new Uint8Array(16 + compatible.length);
  new DataView(result.buffer).setUint32(0, result.length);
  result.set(bytes('ftyp'), 4); result.set(bytes(brand), 8); result.set(bytes(compatible), 16);
  return result;
};

test('only known image MIME types provide an extension', () => {
  for (const [mime, extension] of [
    [' IMAGE/PNG; charset=binary ', 'png'], ['image/apng', 'png'], ['image/pjpeg', 'jpg'],
    ['image/jpeg', 'jpg'], ['image/gif', 'gif'], ['image/webp', 'webp'],
    ['image/avif', 'avif'], ['image/svg+xml', 'svg'], ['image/x-ms-bmp', 'bmp'],
    ['image/vnd.microsoft.icon', 'ico']
  ]) assert.equal(extensionForMime(mime), extension);
  for (const mime of [undefined, null, '', 'constructor', '__proto__', 'image/*',
    'image/unknown', 'application/octet-stream', 'text/html', 'image/png;fake=image/jpeg']) {
    assert.equal(extensionForMime(mime), mime === 'image/png;fake=image/jpeg' ? 'png' : '');
  }
});

test('filename resolution changes only the suffix and keeps an equivalent original suffix', () => {
  assert.deepEqual(resolveImageFilename('001_旅の写真.img', 'image/png'),
    {filename:'001_旅の写真.png', known:true, mime:'image/png'});
  assert.equal(resolveImageFilename('ImageCrate/作品/001_photo.img', 'image/jpeg').filename,
    'ImageCrate/作品/001_photo.jpg');
  assert.equal(resolveImageFilename('photo.JPEG', 'image/jpeg').filename, 'photo.JPEG');
  assert.equal(resolveImageFilename('photo', 'image/gif').filename, 'photo.gif');
  assert.equal(resolveImageFilename('.hidden', 'image/png').filename, '.hidden.png');
  assert.equal(resolveImageFilename('version.2.photo.jpg', 'image/webp').filename, 'version.2.photo.webp');
  assert.deepEqual(resolveImageFilename('photo.png', 'application/octet-stream'),
    {filename:'photo.img', known:false, mime:''});
});

test('untyped binary prefixes resolve supported image formats without changing data', () => {
  const bmp = new Uint8Array(18); bmp.set(bytes('BM'));
  new DataView(bmp.buffer).setUint32(10, 54, true);
  new DataView(bmp.buffer).setUint32(14, 40, true);
  const fixtures = [
    [Uint8Array.from([137,80,78,71,13,10,26,10]), 'png'],
    [Uint8Array.from([255,216,255,224]), 'jpg'],
    [bytes('GIF87a'), 'gif'], [bytes('GIF89a'), 'gif'],
    [bytes('RIFF1234WEBP'), 'webp'], [avif(), 'avif'], [avif('mif1', 'miafavif'), 'avif'],
    [bmp, 'bmp'], [Uint8Array.from([0,0,1,0,1,0]), 'ico']
  ];
  for (const [prefix, extension] of fixtures) {
    const original = [...prefix];
    const result = resolveImageFilename('photo.img', 'application/octet-stream', prefix);
    assert.equal(result.filename, `photo.${extension}`); assert.equal(result.known, true);
    assert.deepEqual([...prefix], original);
  }
  assert.equal(resolveImageFilename('photo.img', '', avif('avis')).filename, 'photo.avif');
  assert.equal(resolveImageFilename('photo.img', 'image/jpeg', fixtures[0][0]).filename, 'photo.png',
    'a known binary signature takes priority over an inconsistent header');
});

test('short, unrelated and untyped text prefixes stay explicitly unknown', () => {
  for (const prefix of [[], [137,80,78], bytes('RIFF1234WAVE'), avif('heic'),
    bytes('<svg xmlns="http://www.w3.org/2000/svg"/>'), bytes('BM not a bitmap'),
    Uint8Array.from([0,0,1,0,0,0])]) {
    assert.deepEqual(resolveImageFilename('photo.img', '', prefix), {filename:'photo.img', known:false, mime:''});
  }
  const backing = Uint8Array.from([9,9,255,216,255,9]);
  assert.equal(resolveImageFilename('photo.img', '', new DataView(backing.buffer, 2, 3)).filename, 'photo.jpg');
});
