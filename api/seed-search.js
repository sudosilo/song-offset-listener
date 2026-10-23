import { cacheGet, cacheSet, normQuery } from '../lib/search-cache.js';

export const config = { runtime: 'edge' };

const HEADERS = { 'content-type': 'application/json' };
const THIRTY_DAYS = 2592000;
const ID = /^[A-Za-z0-9_-]{11}$/;

// Takes search results gathered outside the API (yt-dlp on the phone) and stores them
// under the same key the search route reads, so those searches cost no quota.
export default async function handler(request) {
  if (request.method !== 'POST') return reply({ error: 'POST only' }, 405);

  let body;
  try { body = await request.json(); } catch (err) { return reply({ error: 'bad json' }, 400); }

  const query = typeof body.query === 'string' ? body.query.trim() : '';
  if (!query || query.length > 200) return reply({ error: 'bad query' }, 400);

  const key = 'songsync:search:' + normQuery(query);
  const existing = await cacheGet(key);
  if (existing && Array.isArray(existing.results) && existing.results.length && !body.replace) {
    return reply({ stored: false, reason: 'already cached', count: existing.results.length });
  }

  const incoming = Array.isArray(body.results) ? body.results.slice(0, 12) : [];
  const results = [];
  for (const r of incoming) {
    if (!r || !ID.test(r.videoId || '')) continue;
    const check = await oembed(r.videoId);
    if (!check) continue;
    results.push({
      videoId: r.videoId,
      title: check.title,
      channel: check.author || r.channel || '',
      thumbnail: 'https://i.ytimg.com/vi/' + r.videoId + '/default.jpg'
    });
  }

  if (!results.length) return reply({ stored: false, reason: 'no playable videos' });
  await cacheSet(key, { error: null, results, seeded: true }, THIRTY_DAYS);
  return reply({ stored: true, count: results.length });
}

async function oembed(videoId) {
  try {
    const res = await fetch('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + videoId));
    if (!res.ok) return null;
    const data = await res.json();
    return { title: data.title || '', author: data.author_name || '' };
  } catch (err) {
    return null;
  }
}

function reply(body, status) {
  return new Response(JSON.stringify(body), { status: status || 200, headers: HEADERS });
}
