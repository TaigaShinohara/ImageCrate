export function sanitizePart(value, fallback = 'untitled') {
  const clean = String(value ?? '').normalize('NFKC')
    .replace(/[\x00-\x1f\x7f<>:"/\\|?*\u202a-\u202e\u2066-\u2069]/g, '_')
    .replace(/\s+/g, ' ').trim().replace(/^\.+|[. ]+$/g, '');
  // Leave room for a file extension, sequence number and conflict suffix on
  // filesystems whose component limit is measured in UTF-8 bytes.
  const candidate = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(clean) ? `_${clean}` : clean;
  let safe = ''; let bytes = 0; let count = 0;
  for (const character of candidate) {
    const size = new TextEncoder().encode(character).length;
    if (bytes + size > 160 || count >= 90) break;
    safe += character; bytes += size; count++;
  }
  safe = safe.replace(/[. ]+$/g, '') || fallback;
  return safe;
}
export function saveSettings(input = {}, title = 'ページ') {
  return {destination: input.destination === 'directory' ? 'directory' : 'downloads',
    folderName: sanitizePart(String(input.folderName || '').trim() || title, 'ページ'),
    directoryName: String(input.directoryName || '').slice(0, 512),
    format: ['jpg','png','webp'].includes(input.format) ? input.format : 'original'};
}
export function requiresWorkspace(settings = {}) {
  return settings.destination === 'directory' || ['jpg','png','webp'].includes(settings.format);
}
export function formatLabel(format) {
  const labels={jpg:'JPEG (.jpg)',png:'PNG (.png)',webp:'WebP (.webp)'};
  return Object.hasOwn(labels,format) ? labels[format] : '元の形式';
}
export function destinationLabel(settings) {
  return settings.destination === 'directory'
    ? `選択した「${settings.directoryName || 'フォルダ'}」 / ${settings.folderName}`
    : `Chromeのダウンロード先 / ImageCrate / ${settings.folderName}`;
}
export function permissionOrigins(urls) {
  return [...new Set(urls.flatMap(value => {
    try { const url = new URL(value); return /^https?:$/.test(url.protocol) && url.hostname && !url.hostname.includes('*') ? [`${url.protocol}//${url.hostname}/*`] : []; }
    catch { return []; }
  }))];
}
export function mediaType(url, mime = '') {
  if (/mpegurl|dash\+xml/i.test(mime)) return 'stream';
  let path = ''; try { path = new URL(url).pathname.toLowerCase(); } catch { return 'unknown'; }
  if (/\.(m3u8|mpd)$/.test(path)) return 'stream';
  if (/^blob:/i.test(url)) return 'blob';
  if (/\.(mp4|webm|mov|m4v|ogv|ogg)$/.test(path) || /^video\//i.test(mime)) return 'direct';
  return 'unknown';
}
export function allowedURL(value, kind) {
  try {
    const u = new URL(value);
    if (u.username || u.password) return false;
    if (u.protocol === 'http:' || u.protocol === 'https:') return !u.hostname.includes('*');
    return kind === 'images' && /^data:image\/(png|jpe?g|gif|webp|avif|svg\+xml|bmp|x-icon);/i.test(value)
      && value.length <= 131072;
  } catch { return false; }
}
export function extensionOf(url, kind) {
  const d = /^data:image\/([\w+.-]+)/i.exec(url);
  if (d) return ({'svg+xml':'svg', jpeg:'jpg', 'x-icon':'ico'})[d[1]] || d[1];
  try {
    const m = /\.([a-z0-9]{2,5})$/i.exec(new URL(url).pathname);
    const good = kind === 'images' ? ['jpg','jpeg','png','gif','webp','avif','svg','bmp','ico'] : ['mp4','webm','mov','m4v','ogv','ogg'];
    if (m && good.includes(m[1].toLowerCase())) return m[1].toLowerCase();
  } catch { /* use a neutral suffix for URLs without format information */ }
  return kind === 'images' ? 'img' : 'video';
}
export function isDetectedImageFormat(value) {
  return ['png','jpeg','gif','webp','bmp','ico','svg'].includes(value);
}
export function fileLabel(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'data:') return '埋め込み画像';
    if (u.protocol === 'blob:') return 'ページ内の動画データ';
    return decodeURIComponent(u.pathname.split('/').pop() || u.hostname).slice(0, 120);
  } catch { return 'メディア'; }
}
export function downloadName(item, title, index, kind, format = 'original') {
  const ext = kind === 'images' && ['jpg','png','webp'].includes(format) ? format : extensionOf(item.url, kind);
  const raw = fileLabel(item.url).replace(/\.[a-z0-9]{2,5}$/i, '');
  return `${kind === 'images' ? 'ImageCrate' : 'VideoHarbor'}/${sanitizePart(title)}/${String(index + 1).padStart(3,'0')}_${sanitizePart(raw, 'media')}.${ext}`;
}
export function matchesImage(item, filters) {
  const q = (filters.query || '').toLocaleLowerCase();
  return (!q || `${fileLabel(item.url)} ${item.alt || ''} ${item.url}`.toLocaleLowerCase().includes(q))
    && (!filters.width || item.width >= filters.width)
    && (!filters.height || item.height >= filters.height)
    && (!filters.type || extensionOf(item.url, 'images') === filters.type);
}
export function mergeItems(previous, incoming) {
  const map = new Map(previous.map(i => [i.url, i]));
  for (const item of incoming) map.set(item.url, {...map.get(item.url), ...item});
  return [...map.values()];
}
export function summarizeJobs(jobs = []) {
  const count = {total:jobs.length, complete:0, interrupted:0, active:0};
  for (const job of jobs) {
    if (job.status === 'complete') count.complete++;
    else if (job.status === 'interrupted') count.interrupted++;
    else count.active++;
  }
  return count;
}
export function formatBytes(n = 0) {
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MiB` : `${Math.round(n / 1024)} KiB`;
}
export function publicError(error) {
  const name = error?.name || '';
  if (name === 'NotAllowedError' || name === 'AbortError') return '操作がキャンセルされたか、許可されませんでした。';
  if (name === 'NotFoundError') return '対象が見つかりません。元のページを開き直してください。';
  // Browser errors may contain signed media URLs. Keep those out of UI reports.
  return String(error?.message || error || '処理に失敗しました。').replace(/(?:https?|blob|data):\S+/g,'[URL]').slice(0,180);
}
