// BLUE PHONE: learned per video correction between the recognizer's position and the real video position
export const config = { runtime: 'edge' };

const KEY = 'songsync:videooffset';
const KEEP = 9;
const MAX_ABS_MS = 30000;

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
  const res = await fetch(process.env.UPSTASH_REDIS_REST_URL + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.UPSTASH_REDIS_REST_TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify(commands)
  });
  const out = await res.json();
  return out.map(r => (r ? r.result : null));
}

function median(list) {
  const s = list.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function okId(v) { return typeof v === 'string' && /^[A-Za-z0-9_-]{6,20}$/.test(v); }

export default async function handler(request) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) return json({ error: 'redis not configured' }, 500);

  try {
    if (request.method === 'GET') {
      const v = new URL(request.url).searchParams.get('v');
      if (!okId(v)) return json({ error: 'missing video id' }, 400);
      const [raw] = await redis([['HGET', KEY, v]]);
      let rec = null;
      try { rec = raw ? JSON.parse(raw) : null; } catch (e) { rec = null; }
      if (!rec || !rec.values || !rec.values.length) return json({ videoId: v, offsetMs: null, n: 0 });
      return json({ videoId: v, offsetMs: Math.round(median(rec.values)), n: rec.values.length, updatedAt: rec.updatedAt || null });
    }

    if (request.method === 'POST') {
      const b = await request.json();
      const ms = Number(b.offsetMs);
      if (!okId(b.videoId) || !isFinite(ms) || Math.abs(ms) > MAX_ABS_MS) return json({ error: 'bad video id or offset' }, 400);
      const [raw] = await redis([['HGET', KEY, b.videoId]]);
      let rec = null;
      try { rec = raw ? JSON.parse(raw) : null; } catch (e) { rec = null; }
      if (!rec || !Array.isArray(rec.values)) rec = { values: [] };
      rec.values.unshift(Math.round(ms));
      rec.values = rec.values.slice(0, KEEP);
      rec.updatedAt = Date.now();
      rec.title = b.title ? String(b.title).slice(0, 120) : rec.title || null;
      await redis([['HSET', KEY, b.videoId, JSON.stringify(rec)]]);
      return json({ ok: true, videoId: b.videoId, offsetMs: Math.round(median(rec.values)), n: rec.values.length });
    }

    return json({ error: 'method not allowed' }, 405);
  } catch (err) {
    return json({ error: 'redis request failed' }, 502);
  }
}
