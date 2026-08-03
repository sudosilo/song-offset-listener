export const config = { runtime: 'edge' };

const KEY = 'songsync:positions';

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
      const res = await fetch(`${base}/hgetall/${KEY}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      const flat = data.result || [];
      const devices = [];
      for (let i = 0; i < flat.length; i += 2) {
        try { devices.push(JSON.parse(flat[i + 1])); } catch { /* skip unreadable entry */ }
      }
      return new Response(JSON.stringify({ devices }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }

    if (request.method === 'POST') {
      const body = await request.json();
      const deviceId = body.deviceId || 'unknown';
      const entry = {
        deviceId,
        title: body.title || '',
        videoId: body.videoId || null,
        position: typeof body.position === 'number' ? body.position : null,
        paused: !!body.paused,
        nudgeMs: typeof body.nudgeMs === 'number' ? body.nudgeMs : 0,
        updatedAtEpochMs: Date.now()
      };
      const payload = JSON.stringify(entry);
      await fetch(`${base}/hset/${KEY}/${encodeURIComponent(deviceId)}/${encodeURIComponent(payload)}`, {
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
