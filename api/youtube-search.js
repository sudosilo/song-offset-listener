import { searchYouTube } from '../lib/youtube.js';

export const config = { runtime: 'edge' };

export default async function handler(request) {
  try {
    const url = new URL(request.url);
    const query = url.searchParams.get('q');
    if (!query) {
      return new Response(JSON.stringify({ error: 'missing q param', results: [] }), { status: 400 });
    }

    const outcome = await searchYouTube(query);
    return new Response(JSON.stringify(outcome), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err && err.message || err), results: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }
}
