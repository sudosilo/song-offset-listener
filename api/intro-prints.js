// BLUE PHONE: intro archive, a sound print of each song opening so a phone can name the next song from its first seconds
export const config = { runtime: 'edge' };

const KEY = 'songsync:intros';
const COUNT = 'songsync:introcount';
const MAX_TOP = 300;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type'
};

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({ 'content-type': 'application/json' }, CORS_HEADERS)
  });
}

async function redis(commands) {
  if (!commands.length) return [];
  const res = await fetch(process.env.UPSTASH_REDIS_REST_URL + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.UPSTASH_REDIS_REST_TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify(commands)
  });
  const out = await res.json();
  return out.map(r => (r ? r.result : null));
}

function okId(v) { return typeof v === 'string' && /^[A-Za-z0-9_-]{6,20}$/.test(v); }
function okBand(s) { return typeof s === 'string' && /^[0-9a-z]{100,1000}$/.test(s); }
function parse(raw, id) {
  try { const p = JSON.parse(raw); p.videoId = id; return p; } catch (e) { return null; }
}

export default async function handler(request) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) return json({ error: 'redis not configured' }, 500);

  try {
    if (request.method === 'GET') {
      const p = new URL(request.url).searchParams;
      let ids = [];
      if (p.get('keys')) ids = p.get('keys').split(',').filter(okId).slice(0, MAX_TOP);
      else {
        const n = Math.max(1, Math.min(MAX_TOP, parseInt(p.get('top') || '150', 10) || 150));
        const [top] = await redis([['ZREVRANGE', COUNT, '0', String(n - 1)]]);
        ids = (top || []).filter(okId);
      }
      if (!ids.length) return json({ prints: [] });
      const [raws] = await redis([['HMGET', KEY].concat(ids)]);
      const prints = [];
      (raws || []).forEach((raw, i) => { const x = raw ? parse(raw, ids[i]) : null; if (x) prints.push(x); });
      return json({ prints });
    }

    if (request.method === 'POST') {
      const b = await request.json();
      if (!okId(b.videoId) || !Array.isArray(b.bands) || b.bands.length !== 3 || !b.bands.every(okBand)) return json({ error: 'bad print' }, 400);
      const hop = Number(b.hop);
      if (!(hop > 0 && hop < 0.1)) return json({ error: 'bad hop' }, 400);
      const rec = JSON.stringify({
        title: String(b.title || '').slice(0, 120),
        artist: String(b.artist || '').slice(0, 120),
        hop, from: Number(b.from) || 1, bands: b.bands, at: Date.now()
      });
      const [added, count] = await redis([['HSETNX', KEY, b.videoId, rec], ['ZINCRBY', COUNT, '1', b.videoId]]);
      return json({ ok: true, videoId: b.videoId, stored: added === 1, heard: Number(count) || 1 });
    }

    return json({ error: 'method not allowed' }, 405);
  } catch (err) {
    return json({ error: 'redis request failed' }, 502);
  }
}
