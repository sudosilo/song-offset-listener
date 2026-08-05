export const config = { runtime: 'edge' };

const LOG_KEY = 'songsync:log';
const MAX_ENTRIES = 20;

function redisHeaders() {
  return {
    Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`
  };
}

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
      const res = await fetch(`${base}/lrange/${LOG_KEY}/0/${MAX_ENTRIES - 1}`, {
        headers: redisHeaders()
      });
      const data = await res.json();
      const entries = (data.result || []).map((raw) => {
        try {
          return JSON.parse(raw);
        } catch {
          return null;
        }
      }).filter(Boolean);
      return new Response(JSON.stringify({ entries }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }

    if (request.method === 'POST') {
      const body = await request.json();
      const entry = {
        title: body.title || '',
        artist: body.artist || '',
        videoId: body.videoId || null,
        offsetSeconds: typeof body.offsetSeconds === 'number' ? body.offsetSeconds : 0,
        lat: typeof body.lat === 'number' ? body.lat : null,
        lng: typeof body.lng === 'number' ? body.lng : null,
        epochMs: body.epochMs || Date.now()
      };
      const payload = JSON.stringify(entry);
      await fetch(`${base}/lpush/${LOG_KEY}/${encodeURIComponent(payload)}`, {
        headers: redisHeaders()
      });
      await fetch(`${base}/ltrim/${LOG_KEY}/0/${MAX_ENTRIES - 1}`, {
        headers: redisHeaders()
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
