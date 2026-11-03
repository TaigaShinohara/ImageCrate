// Web Share API integration with automatic fallback to Blob download.
// Enables seamless file saving on iOS Safari, Android, and mobile browsers.

export function canShareFiles() {
  if (typeof navigator === 'undefined' || typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function') {
    return false;
  }
  try {
    const testFile = new File([new Uint8Array(1)], 'test.zip', { type: 'application/zip' });
    return navigator.canShare({ files: [testFile] });
  } catch {
    return false;
  }
}

export function downloadBlob(blob, filename) {
  if (typeof document === 'undefined') return;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename || 'ImageCrate.zip';
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  setTimeout(() => {
    try { anchor.remove(); } catch {}
    try { URL.revokeObjectURL(url); } catch {}
  }, 1500);
}

export async function shareOrDownloadZip(blob, filename = 'ImageCrate.zip') {
  if (!(blob instanceof Blob) || blob.size === 0) {
    throw new Error('保存するZIPデータがありません。');
  }

  // Attempt Web Share API first if supported
  if (canShareFiles()) {
    try {
      const file = new File([blob], filename, { type: 'application/zip' });
      await navigator.share({
        files: [file],
        title: filename
      });
      return { ok: true, method: 'share', bytes: blob.size };
    } catch (error) {
      // If the user cancelled/closed the native share sheet, do not trigger fallback download
      if (error && (error.name === 'AbortError' || error.message?.includes('abort') || error.message?.includes('cancel'))) {
        return { ok: false, aborted: true, method: 'share', bytes: blob.size };
      }
      // For other share errors, fall through to browser download fallback
    }
  }

  // Fallback: trigger browser download
  downloadBlob(blob, filename);
  return { ok: true, method: 'download', bytes: blob.size };
}
