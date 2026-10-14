export const config = { runtime: 'edge' };

const KEY = 'songsync:syncsamples';
const MAX_ENTRIES = 1000;
const MAX_BYTES = 60000;

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

async function redis(base, token, commands) {
  const res = await fetch(`${base}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(commands)
  });
  return res.json();
}

export default async function handler(request) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  const base = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!base || !token) return json({ error: 'redis not configured' }, 500);

  try {
    if (request.method === 'POST') {
      const body = await request.json();
      const payload = JSON.stringify(Object.assign({ receivedAt: Date.now() }, body));
      if (payload.length > MAX_BYTES) return json({ error: 'sample too large' }, 413);
      await redis(base, token, [
        ['LPUSH', KEY, payload],
        ['LTRIM', KEY, '0', String(MAX_ENTRIES - 1)]
      ]);
      return json({ ok: true });
    }

    if (request.method === 'GET') {
      const params = new URL(request.url).searchParams;
      const n = Math.max(1, Math.min(MAX_ENTRIES, parseInt(params.get('n') || '200', 10) || 200));
      const out = await redis(base, token, [['LRANGE', KEY, '0', String(n - 1)]]);
      const rows = (out && out[0] && out[0].result) || [];
      const samples = rows.map(r => { try { return JSON.parse(r); } catch (e) { return null; } }).filter(Boolean);
      return json({ count: samples.length, samples });
    }

    return json({ error: 'method not allowed' }, 405);
  } catch (err) {
    return json({ error: 'redis request failed' }, 502);
  }
}
