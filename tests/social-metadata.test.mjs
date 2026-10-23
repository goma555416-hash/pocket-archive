import test from 'node:test';
import assert from 'node:assert/strict';
import { identifySocialMediaUrl, identifySocialPlatform, fetchSocialMediaMetadata } from '../social-metadata.mjs';

const YT_ID = 'dQw4w9WgXcQ';
const TT_ID = '6718335390845095173';

test('only real HTTPS video URLs match strict YouTube and TikTok providers', () => {
  const accepted = [
    ['https://youtu.be/dQw4w9WgXcQ?t=12', 'youtube', YT_ID],
    ['https://m.youtube.com/shorts/dQw4w9WgXcQ?feature=share', 'youtube', YT_ID],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=foo', 'youtube', YT_ID],
    ['https://www.youtube.com/live/dQw4w9WgXcQ', 'youtube', YT_ID],
    ['https://www.tiktok.com/@scout2015/video/6718335390845095173?utm_source=x', 'tiktok', TT_ID]
  ];
  for (const [url, provider, id] of accepted) {
    const parsed = identifySocialMediaUrl(url);
    assert.equal(parsed?.provider, provider, url);
    assert.equal(parsed?.id, id, url);
    assert.equal(parsed.canonicalUrl.includes('?utm_'), false);
  }
  const blocked = [
    'http://youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ',
    'https://evil.com/?q=https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://user:pass@youtube.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com:444/watch?v=dQw4w9WgXcQ',
    'https://youtu.be/%2e%2e%2fprivate',
    'https://www.youtube.com/@creator',
    'https://www.youtube.com/playlist?list=abcd',
    'https://www.tiktok.com/@user',
    'https://www.tiktok.com/@user/video/not-a-number',
    'https://vt.tiktok.com/abc/',
    'https://www.threads.com/@someone/post/abc',
    'https://www.instagram.com/p/abc',
    'file:///etc/passwd',
    'https://127.0.0.1/video'
  ];
  for (const url of blocked) assert.equal(identifySocialMediaUrl(url), null, url);
});

test('fixed oEmbed endpoint returns bounded trusted metadata without HTML or captions', async () => {
  const seen = [];
  const result = await fetchSocialMediaMetadata('https://youtu.be/dQw4w9WgXcQ?track=foo', {
    fetchImpl: async (url, options) => {
      seen.push({ url: new URL(url), options });
      return Response.json({
        provider_name: 'YouTube', title: 'Official video',
        author_name: 'Creator',
        thumbnail_url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
        html: '<script>ignored</script>',
        description: 'Do not treat as transcription'
      });
    }
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url.origin, 'https://www.youtube.com');
  assert.equal(seen[0].url.pathname, '/oembed');
  assert.equal(seen[0].url.searchParams.get('url'), `https://www.youtube.com/watch?v=${YT_ID}`);
  assert.equal(seen[0].options.credentials, 'omit');
  assert.equal(seen[0].options.redirect, 'error');
  assert.deepEqual(result, { provider: 'youtube', canonicalUrl: `https://www.youtube.com/watch?v=${YT_ID}`,
    title: 'Official video', author: 'Creator',
    thumbnailUrl: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
    evidence: 'provider-oembed', contentRead: false });
  assert.equal(Object.hasOwn(result, 'html'), false);
  assert.equal(Object.hasOwn(result, 'description'), false);
});

test('TikTok embeds can return public title without allowing untrusted thumbnail hosts', async () => {
  const result = await fetchSocialMediaMetadata(`https://www.tiktok.com/@scout2015/video/${TT_ID}`, {
    fetchImpl: async url => {
      assert.equal(new URL(url).origin, 'https://www.tiktok.com');
      return Response.json({ provider_name: 'TikTok', title: 'Public clip',
        author_name: 'Author', thumbnail_url: 'https://evil.example/track.jpg' });
    }
  });
  assert.equal(result.provider, 'tiktok');
  assert.equal(result.thumbnailUrl, '');
});

test('private/removed results and oversized or spoofed responses fail closed', async () => {
  const url = `https://youtu.be/${YT_ID}`;
  await assert.rejects(fetchSocialMediaMetadata(url, {
    fetchImpl: async () => Response.json({}, { status: 404 })
  }), error => error.code === 'social_not_public');
  await assert.rejects(fetchSocialMediaMetadata(url, {
    fetchImpl: async () => new Response('not json', { headers: { 'Content-Type': 'text/html' } })
  }), error => error.code === 'social_invalid_response');
  await assert.rejects(fetchSocialMediaMetadata(url, {
    fetchImpl: async () => Response.json({ provider_name: 'TikTok', title: 'spoofed' })
  }), error => error.code === 'social_invalid_response');
  await assert.rejects(fetchSocialMediaMetadata(url, {
    fetchImpl: async () => new Response(' '.repeat(65537), { headers: { 'Content-Type': 'application/json' } })
  }), error => error.code === 'social_response_too_large');
  await assert.rejects(fetchSocialMediaMetadata(url, {
    fetchImpl: async () => { throw new Error('DNS/timeout'); }
  }), error => error.code === 'social_unavailable');
  await assert.rejects(fetchSocialMediaMetadata('https://threads.com/@a/post/123', {
    fetchImpl: async () => { throw new Error('must not fetch'); }
  }), error => error.code === 'unsupported_social_url');
});

test('known social URLs without supported oEmbed are identified before CORS fallback', () => {
  const examples = [
    ['https://youtube.com/playlist?list=PL123', 'YouTube'],
    ['https://youtu.be/dQw4w9WgXcQ', 'YouTube'],
    ['https://vt.tiktok.com/short-id/', 'TikTok'],
    ['https://www.tiktok.com/@user', 'TikTok'],
    ['https://www.instagram.com/p/example/', 'Instagram'],
    ['https://www.threads.com/@someone/post/xyz', 'Threads'],
    ['https://x.com/creator/status/123', 'X'],
    ['https://www.pinterest.com/pin/1234/', 'Pinterest']
  ];
  for (const [url, provider] of examples) assert.equal(identifySocialPlatform(url), provider, url);
  for (const url of [
    'https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ',
    'https://evil.test/?redirect=https://x.com',
    'https://example.com/article'
  ]) assert.equal(identifySocialPlatform(url), '', url);
});
