import { findYouTubeMatch } from '../lib/youtube.js';
import { findYouTubeViaMusicBrainz } from '../lib/musicbrainz.js';
import { writeAnchor } from '../lib/anchor-store.js';
import { findBpmAndKey } from '../lib/getsongbpm.js';

export const config = { runtime: 'edge' };

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

export default async function handler(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST only' }), { status: 405, headers: CORS_HEADERS });
  }

  const token = process.env.AUDD_API_TOKEN;
  if (!token) {
    return new Response(JSON.stringify({ error: 'AUDD_API_TOKEN not configured' }), { status: 500, headers: CORS_HEADERS });
  }

  let incoming;
  try {
    incoming = await request.formData();
  } catch (err) {
    return new Response(JSON.stringify({ error: 'bad form data' }), { status: 400, headers: CORS_HEADERS });
  }

  const audioFile = incoming.get('audio');
  if (!audioFile) {
    return new Response(JSON.stringify({ error: 'no audio field' }), { status: 400, headers: CORS_HEADERS });
  }

  const clipDurationMs = Number(incoming.get('clipDurationMs')) || 9000;
  const capturedAtRaw = Number(incoming.get('capturedAt'));
  const clientCapturedAt = Number.isFinite(capturedAtRaw) && capturedAtRaw > 0 ? capturedAtRaw : null;
  const latRaw = parseFloat(incoming.get('lat'));
  const lngRaw = parseFloat(incoming.get('lng'));
  const clientLat = isNaN(latRaw) ? null : latRaw;
  const clientLng = isNaN(lngRaw) ? null : lngRaw;
  const localBpmRaw = parseFloat(incoming.get('localBpm'));
  const clientLocalBpm = isNaN(localBpmRaw) ? null : localBpmRaw;
  const silent = incoming.get('silent') === 'true';

  const outgoing = new FormData();
  outgoing.append('api_token', token);
  outgoing.append('file', audioFile, 'clip.webm');
  outgoing.append('return', 'timecode');

  let auddRes;
  try {
    auddRes = await fetch('https://api.audd.io/', { method: 'POST', body: outgoing });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'audd request failed' }), { status: 502, headers: CORS_HEADERS });
  }

  const data = await auddRes.json();

  if (data.status === 'error') {
    const auddMessage = (data.error && data.error.error_message) ? data.error.error_message : 'unknown audd error';
    return new Response(JSON.stringify({ error: 'audd: ' + auddMessage }), { status: 200, headers: CORS_HEADERS });
  }

  if (data.status !== 'success' || !data.result) {
    return new Response(JSON.stringify({ error: 'no match found' }), { status: 200, headers: CORS_HEADERS });
  }

  const result = data.result;
  const offsetSeconds = parseOffset(result.timecode);

  let match = null;
  if (!silent) {
    const cacheKey = 'songsync:ytcache:' + encodeURIComponent((result.title + '|' + result.artist).toLowerCase());
    match = await readCache(cacheKey);
    if (match === null) match = {};
    if (!match.title) { match.title = result.title; match.artist = result.artist; }

    let changed = false;

    if (!match.videoId) {
      let mbResult = null;
      try {
        mbResult = await findYouTubeViaMusicBrainz(result.title, result.artist);
      } catch (err) {
        mbResult = null;
      }
      if (mbResult && mbResult.videoId) {
        match.videoId = mbResult.videoId;
        match.durationSeconds = mbResult.durationSeconds;
        changed = true;
      } else {
        let ytResult = null;
        try {
          ytResult = await findYouTubeMatch(result.title, result.artist);
        } catch (err) {
          ytResult = null;
        }
        if (ytResult) {
          match.videoId = ytResult.videoId;
          match.durationSeconds = ytResult.durationSeconds;
          changed = true;
        }
      }
    }

    if (typeof match.bpm !== 'number') {
      if (clientLocalBpm !== null) {
        match.bpm = clientLocalBpm;
        match.bpmSource = 'local';
        changed = true;
        await indexBpm(cacheKey, clientLocalBpm);
      } else {
        let bpmResult = null;
        try {
          bpmResult = await findBpmAndKey(result.title, result.artist);
        } catch (err) {
          bpmResult = null;
        }
        if (bpmResult) {
          match.bpm = bpmResult.bpm;
          match.key = bpmResult.key;
          match.bpmSource = 'getsongbpm';
          changed = true;
          await indexBpm(cacheKey, bpmResult.bpm);
        }
      }
    }

    if (changed) await writeCache(cacheKey, match);
    if (!match.videoId && !match.bpm && typeof match.cueIn !== 'number') match = null;
  }

  const clipEndAnchorMs = clientCapturedAt !== null ? (clientCapturedAt + clipDurationMs) : Date.now();
  const RESIDUAL_TUNE_MS = 0;
  const epochMs = clipEndAnchorMs + RESIDUAL_TUNE_MS;

  let anchorWritten = false;
  if (offsetSeconds !== null && !silent && clientLat !== null && clientLng !== null) {
    anchorWritten = await writeAnchor({
      title: result.title,
      artist: result.artist,
      offsetSeconds,
      epochMs,
      videoId: match ? match.videoId : null,
      videoDurationSeconds: match ? match.durationSeconds : null,
      lat: clientLat,
      lng: clientLng
    });
    await appendLog({
      title: result.title,
      artist: result.artist,
      videoId: match ? match.videoId : null,
      offsetSeconds,
      lat: clientLat,
      lng: clientLng,
      epochMs
    });
  }

  return new Response(JSON.stringify({
    title: result.title,
    artist: result.artist,
    offsetSeconds,
    epochMs: offsetSeconds !== null ? epochMs : null,
    anchorWritten,
    videoId: match ? match.videoId : null,
    videoDurationSeconds: match ? match.durationSeconds : null,
    bpm: match ? match.bpm : null,
    key: match ? match.key : null,
    raw: result
  }), { status: 200, headers: Object.assign({ 'content-type': 'application/json' }, CORS_HEADERS) });
}

async function indexBpm(cacheKey, bpm) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return false;
  try {
    await fetch(`${url}/zadd/songsync:bpmindex/${bpm}/${encodeURIComponent(cacheKey)}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    return true;
  } catch (err) {
    return false;
  }
}

async function readCache(key) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const res = await fetch(`${url}/get/${key}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await res.json();
    if (!data.result) return null;
    return JSON.parse(data.result);
  } catch (err) {
    return null;
  }
}

async function writeCache(key, value) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return false;
  try {
    await fetch(`${url}/set/${key}?EX=2592000`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(value)
    });
    return true;
  } catch (err) {
    return false;
  }
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
