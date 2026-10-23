// Public provider metadata only. No credentials, scraping, arbitrary proxy or persistent cache.
// Shared by Worker and client so both enforce the same URL allowlist.
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const TIKTOK_POST = /^\/@([A-Za-z0-9._]{2,32})\/video\/(\d{8,30})\/?$/;
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be']);
const TIKTOK_HOSTS = new Set(['tiktok.com', 'www.tiktok.com', 'm.tiktok.com']);
const MAX_RESULT_BYTES = 65536;

function fail(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

export function identifySocialMediaUrl(input) {
  if (typeof input !== 'string' || input.length > 2048) return null;
  let url;
  try { url = new URL(input); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  if (YOUTUBE_HOSTS.has(host)) {
    const segments = url.pathname.split('/').filter(Boolean);
    let id = '';
    if (host === 'youtu.be' && segments.length === 1) id = segments[0];
    else if (segments.length === 1 && segments[0] === 'watch') id = url.searchParams.get('v') || '';
    else if (segments.length === 2 && ['shorts', 'live', 'embed'].includes(segments[0])) id = segments[1];
    if (!VIDEO_ID.test(id)) return null;
    return { provider: 'youtube', id, canonicalUrl: `https://www.youtube.com/watch?v=${id}`,
      endpoint: 'https://www.youtube.com/oembed' };
  }
  if (TIKTOK_HOSTS.has(host)) {
    const match = TIKTOK_POST.exec(url.pathname);
    if (!match) return null;
    // Preserve the canonical creator and numeric video identity, discarding tracking params.
    return { provider: 'tiktok', id: match[2],
      canonicalUrl: `https://www.tiktok.com/@${match[1]}/video/${match[2]}`,
      endpoint: 'https://www.tiktok.com/oembed' };
  }
  return null;
}

function allowedThumbnail(value, provider) {
  if (typeof value !== 'string' || value.length > 2048) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return '';
    const host = url.hostname.toLowerCase();
    if (provider === 'youtube' && (host === 'i.ytimg.com' || host === 'img.youtube.com')) return url.href;
    if (provider === 'tiktok' && (host === 'tiktokcdn.com' || host.endsWith('.tiktokcdn.com'))) return url.href;
  } catch { /* invalid URL */ }
  return '';
}

async function boundedJson(response) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_RESULT_BYTES) throw fail(502, 'social_response_too_large', '來源回應超過大小限制');
  if (!response.body) throw fail(502, 'social_invalid_response', '來源沒有可讀取的資料');
  const reader = response.body.getReader();
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESULT_BYTES) throw fail(502, 'social_response_too_large', '來源回應超過大小限制');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw fail(502, 'social_invalid_response', '來源沒有提供有效的公開資訊'); }
}

export async function fetchSocialMediaMetadata(input, { fetchImpl = fetch, timeoutMs = 6000 } = {}) {
  const parsed = identifySocialMediaUrl(input);
  if (!parsed) throw fail(400, 'unsupported_social_url', '只支援公開的 YouTube 影片／Shorts 及 TikTok 影片網址');
  const query = new URL(parsed.endpoint);
  query.searchParams.set('url', parsed.canonicalUrl);
  query.searchParams.set('format', 'json');
  let response;
  try {
    response = await fetchImpl(query.href, {
      method: 'GET', headers: { Accept: 'application/json' },
      credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(timeoutMs)
    });
  } catch {
    throw fail(503, 'social_unavailable', '公開來源暫時無法讀取；仍可收藏網址');
  }
  if (response.status === 404 || response.status === 401 || response.status === 403)
    throw fail(422, 'social_not_public', '此內容可能不公開、已下架或不支援嵌入；仍可收藏網址');
  if (!response.ok) throw fail(503, 'social_unavailable', '公開來源暫時無法讀取；仍可收藏網址');
  if (!(response.headers.get('content-type') || '').toLowerCase().includes('application/json'))
    throw fail(502, 'social_invalid_response', '來源回應格式無效');
  const data = await boundedJson(response);
  const expected = parsed.provider === 'youtube' ? 'youtube' : 'tiktok';
  if (!data || typeof data.title !== 'string' || !data.title.trim() ||
      String(data.provider_name || '').toLowerCase() !== expected)
    throw fail(502, 'social_invalid_response', '來源沒有提供可驗證的標題');
  return {
    provider: parsed.provider,
    canonicalUrl: parsed.canonicalUrl,
    title: data.title.trim().slice(0, 160),
    author: typeof data.author_name === 'string' ? data.author_name.trim().slice(0, 100) : '',
    thumbnailUrl: allowedThumbnail(data.thumbnail_url, parsed.provider),
    evidence: 'provider-oembed',
    contentRead: false
  };
}
