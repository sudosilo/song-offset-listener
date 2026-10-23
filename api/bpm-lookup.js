import { findBpmAndKey } from '../lib/getsongbpm.js';

export const config = { runtime: 'edge' };

const HEADERS = {
  'content-type': 'application/json',
  'Access-Control-Allow-Origin': '*'
};

export default async function handler(request) {
  const params = new URL(request.url).searchParams;
  const title = cleanTitle(params.get('title') || '');
  const artist = (params.get('artist') || '').trim();

  if (!title) return reply({ error: 'missing title', bpm: null }, 400);

  let found = null;
  try { found = await findBpmAndKey(title, artist); } catch (err) { found = null; }

  return reply({
    title,
    artist,
    bpm: found ? found.bpm : null,
    key: found ? found.key : null,
    source: found ? 'getsongbpm' : null,
    error: found ? null : 'no bpm found'
  });
}

function cleanTitle(raw) {
  return raw
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/\b(instrumental|official|audio|video|lyrics?|hd|hq|remaster(ed)?|beat|prod\.?.*)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function reply(body, status) {
  return new Response(JSON.stringify(body), { status: status || 200, headers: HEADERS });
}
