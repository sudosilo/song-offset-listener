export const config = { runtime: 'edge' };

export default async function handler(request) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST only' }), { status: 405 });
  }

  const token = process.env.AUDD_API_TOKEN;
  if (!token) {
    return new Response(JSON.stringify({ error: 'AUDD_API_TOKEN not configured' }), { status: 500 });
  }

  let incoming;
  try {
    incoming = await request.formData();
  } catch (err) {
    return new Response(JSON.stringify({ error: 'bad form data' }), { status: 400 });
  }

  const audioFile = incoming.get('audio');
  if (!audioFile) {
    return new Response(JSON.stringify({ error: 'no audio field' }), { status: 400 });
  }

  const clipDurationMs = Number(incoming.get('clipDurationMs')) || 9000;

  const outgoing = new FormData();
  outgoing.append('api_token', token);
  outgoing.append('file', audioFile, 'clip.webm');
  outgoing.append('return', 'timecode');

  let auddRes;
  try {
    auddRes = await fetch('https://api.audd.io/', { method: 'POST', body: outgoing });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'audd request failed' }), { status: 502 });
  }

  const data = await auddRes.json();

  if (data.status !== 'success' || !data.result) {
    return new Response(JSON.stringify({ error: 'no match found' }), { status: 200 });
  }

  const result = data.result;
  const offsetSeconds = parseOffset(result.timecode);

  let anchorWritten = false;
  if (offsetSeconds !== null) {
    const epochMs = Date.now() - clipDurationMs;
    anchorWritten = await writeAnchor({
      title: result.title,
      artist: result.artist,
      offsetSeconds,
      epochMs
    });
  }

  return new Response(JSON.stringify({
    title: result.title,
    artist: result.artist,
    offsetSeconds,
    anchorWritten,
    raw: result
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

async function writeAnchor(anchor) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return false;

  try {
    const res = await fetch(`${url}/set/songsync:anchor`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(anchor)
    });
    return res.ok;
  } catch (err) {
    return false;
  }
}

function parseOffset(timecode) {
  if (!timecode) return null;
  const parts = String(timecode).split(':').map(Number);
  if (parts.some(isNaN)) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}
