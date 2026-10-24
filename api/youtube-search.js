import { searchYouTube } from '../lib/youtube.js';
import { cacheGet, cacheSet, normQuery } from '../lib/search-cache.js';

export const config = { runtime: 'edge' };

const HEADERS = { 'content-type': 'application/json' };
const THIRTY_DAYS = 2592000;

export default async function handler(request) {
  try {
    const url = new URL(request.url);
    const query = url.searchParams.get('q');
    if (!query) {
      return new Response(JSON.stringify({ error: 'missing q param', results: [] }), { status: 400 });
    }

    const key = 'songsync:search:' + normQuery(query);
    const cached = await cacheGet(key);
    if (cached && Array.isArray(cached.results)) {
      return new Response(JSON.stringify(Object.assign({}, cached, { cached: true })), { status: 200, headers: HEADERS });
    }

    // A visitor can send their own key; if it fails, fall back to the shared one.
    const own = (request.headers.get('x-yt-key') || '').trim();
    const ownOk = /^[A-Za-z0-9_-]{30,60}$/.test(own);
    let outcome = ownOk ? await searchYouTube(query, 8, own) : null;
    if (outcome && !outcome.error) outcome.keyUsed = 'personal';
    if (!outcome || outcome.error) {
      const ownError = outcome && outcome.error;
      outcome = await searchYouTube(query);
      outcome.keyUsed = 'shared';
      if (ownError) outcome.personalKeyError = ownError;
    }
    if (!outcome.error && outcome.results && outcome.results.length) {
      await cacheSet(key, outcome, THIRTY_DAYS);
    }
    return new Response(JSON.stringify(outcome), { status: 200, headers: HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err && err.message || err), results: [] }), {
      status: 200,
      headers: HEADERS
    });
  }
}
