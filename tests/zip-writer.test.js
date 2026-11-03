import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32, computeBlobCrc32, ZipArchive } from '../extension/zip-writer.js';

test('crc32 produces correct standard checksums', () => {
  const encoder = new TextEncoder();
  assert.equal(crc32(encoder.encode('')).toString(16), '0');
  // Known test vector: "123456789" -> 0xcbf43926
  assert.equal(crc32(encoder.encode('123456789')).toString(16), 'cbf43926');
  // "The quick brown fox jumps over the lazy dog" -> 0x414fa339
  assert.equal(crc32(encoder.encode('The quick brown fox jumps over the lazy dog')).toString(16), '414fa339');
});

test('ZipArchive generates a valid PKZIP 2.0 archive with multiple files and UTF-8 names', async () => {
  const archive = new ZipArchive();
  const file1Content = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG header
  const file2Text = 'こんにちは世界！Hello World!';
  const file2Blob = new Blob([file2Text], { type: 'text/plain;charset=utf-8' });

  await archive.addFile('images/test1.png', file1Content);
  await archive.addFile('テキスト/メモ.txt', file2Blob);

  const zipBlob = archive.generate();
  assert.equal(zipBlob.type, 'application/zip');
  assert.ok(zipBlob.size > file1Content.length + file2Blob.size);

  const buffer = await zipBlob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  // First local file header check (PK\x03\x04)
  assert.equal(view.getUint32(0, true), 0x04034b50);
  assert.equal(view.getUint16(4, true), 20); // version 2.0
  assert.equal(view.getUint16(6, true), 0x0800); // UTF-8 flag
  assert.equal(view.getUint16(8, true), 0); // Store method
  assert.equal(view.getUint32(14, true), crc32(file1Content)); // crc32
  assert.equal(view.getUint32(18, true), file1Content.length); // compressed
  assert.equal(view.getUint32(22, true), file1Content.length); // uncompressed

  const name1Len = view.getUint16(26, true);
  const name1 = new TextDecoder().decode(bytes.subarray(30, 30 + name1Len));
  assert.equal(name1, 'images/test1.png');

  // Verify end of central directory (EOCD: PK\x05\x06) exists at the end
  const eocdSig = view.getUint32(bytes.length - 22, true);
  assert.equal(eocdSig, 0x06054b50);
  assert.equal(view.getUint16(bytes.length - 14, true), 2); // 2 total entries
  assert.equal(view.getUint16(bytes.length - 12, true), 2); // 2 entries in CD

  // Test decompression using Node's child_process with OS unzip if available
  const { execFile } = await import('node:child_process');
  const { writeFile, unlink } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');

  const tmpZip = join(tmpdir(), `test-${Date.now()}.zip`);
  await writeFile(tmpZip, Buffer.from(buffer));
  try {
    await new Promise((resolve, reject) => {
      execFile('unzip', ['-t', tmpZip], (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      });
    });
  } finally {
    await unlink(tmpZip).catch(() => {});
  }
});
