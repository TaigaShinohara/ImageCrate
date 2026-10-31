// Limits describe data accepted by ImageCrate. They are not a browser RSS or
// network-wire limit: the browser may buffer/decompress data before delivery.
const MiB = 1024 * 1024;
export const MEDIA_POLICY_VERSION = 1;
export const MEDIA_LIMITS = Object.freeze({
  version:MEDIA_POLICY_VERSION,
  idleTimeoutMs:30000,
  original:Object.freeze({maxBytes:128 * MiB, timeoutMs:120000}),
  batch:Object.freeze({maxBytes:512 * MiB, maxOutputBytes:512 * MiB, timeoutMs:15 * 60000, maxAttempts:3}),
  preview:Object.freeze({maxBytes:8 * MiB, timeoutMs:20000, maxPixels:24000000, maxDimension:8192}),
  converter:Object.freeze({maxInputBytes:32 * MiB, maxOutputBytes:64 * MiB,
    maxPixels:24000000, maxDimension:16384, timeoutMs:120000})
});

export class ResourceLimitError extends Error {
  constructor(message, code = 'resource-limit') {
    super(message); this.name = 'ResourceLimitError'; this.code = code;
  }
}
