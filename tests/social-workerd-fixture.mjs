// Synthetic workerd fixture. Never fetches real YouTube/TikTok or user data.
import { fetchSocialMediaMetadata } from '../social-metadata.mjs';

export default {
  async fetch(request) {
    const shouldRedirect = new URL(request.url).pathname === '/redirect';
    const syntheticFetch = async (endpoint, options) => {
      const upstream = new Request(endpoint, options);
      if (upstream.redirect !== 'manual') throw new Error('Expected Worker-compatible manual redirect');
      if (new URL(upstream.url).origin !== 'https://www.youtube.com') throw new Error('Unexpected upstream host');
      if (shouldRedirect) {
        return new Response(null, { status: 302, headers: { Location: 'https://untrusted.example/redirect' } });
      }
      return Response.json({
        provider_name: 'YouTube', title: 'Synthetic Video', author_name: 'Fixture Author',
        thumbnail_url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg'
      });
    };
    try {
      const metadata = await fetchSocialMediaMetadata(
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        { fetchImpl: syntheticFetch }
      );
      return Response.json({ ok: true, metadata });
    } catch (error) {
      return Response.json({ ok: false, code: error.code || '', message: error.message },
        { status: Number(error.status || 500) });
    }
  }
};
