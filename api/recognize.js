import { findYouTubeMatch } from '../lib/youtube.js';
import { writeAnchor } from '../lib/anchor-store.js';

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
  const capturedAtRaw = Number(incoming.get('capturedAt'));
  const clientCapturedAt = Number.isFinite(capturedAtRaw) && capturedAtRaw > 0 ? capturedAtRaw : null;

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

  let match = null;
  try {
    match = await findYouTubeMatch(result.title, result.artist);
  } catch (err) {
    match = null;
  }

  let anchorWritten = false;
  if (offsetSeconds !== null) {
    const epochMs = clientCapturedAt !== null ? clientCapturedAt : Date.now() - clipDurationMs;
    anchorWritten = await writeAnchor({
      title: result.title,
      artist: result.artist,
      offsetSeconds,
      epochMs,
      videoId: match ? match.videoId : null,
      videoDurationSeconds: match ? match.durationSeconds : null
    });
    await appendLog({
      title: result.title,
      artist: result.artist,
      videoId: match ? match.videoId : null,
      offsetSeconds,
      epochMs
    });
  }

  return new Response(JSON.stringify({
    title: result.title,
    artist: result.artist,
    offsetSeconds,
    epochMs: offsetSeconds !== null ? (clientCapturedAt !== null ? clientCapturedAt : Date.now() - clipDurationMs) : null,
    anchorWritten,
    videoId: match ? match.videoId : null,
    videoDurationSeconds: match ? match.durationSeconds : null,
    raw: result
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

async function appendLog(entry) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return false;

  try {
    const payload = JSON.stringify(entry);
    await fetch(`${url}/lpush/songsync:log/${encodeURIComponent(payload)}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    await fetch(`${url}/ltrim/songsync:log/0/19`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    return true;
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
