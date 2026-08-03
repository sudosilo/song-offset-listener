export const config = { runtime: 'edge' };

const KEY = 'songsync:nudgelog';
const MAX_ENTRIES = 50;

export default async function handler(request) {
  const base = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!base || !token) {
    return new Response(JSON.stringify({ error: 'redis not configured' }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }

  try {
    if (request.method === 'GET') {
      const res = await fetch(`${base}/lrange/${KEY}/0/${MAX_ENTRIES - 1}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      const entries = (data.result || []).map((raw) => {
        try { return JSON.parse(raw); } catch { return null; }
      }).filter(Boolean);
      return new Response(JSON.stringify({ entries }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }

    if (request.method === 'POST') {
      const body = await request.json();
      const entry = {
        nudgeMs: Number(body.nudgeMs) || 0,
        loggedAt: Date.now(),
        note: body.note || ''
      };
      const payload = JSON.stringify(entry);
      await fetch(`${base}/lpush/${KEY}/${encodeURIComponent(payload)}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      await fetch(`${base}/ltrim/${KEY}/0/${MAX_ENTRIES - 1}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({ error: 'method not allowed' }), {
      status: 405,
      headers: { 'content-type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'redis request failed' }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }
}
