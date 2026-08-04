import { CATALOG, findBySlug } from '../lib/catalog.js';
import { writeAnchor } from '../lib/anchor-store.js';

export const config = { runtime: 'edge' };

export default async function handler(request) {
  if (request.method === 'GET') {
    return new Response(JSON.stringify({
      catalog: CATALOG.map(e => ({
        slug: e.slug,
        title: e.title,
        artist: e.artist,
        durationSeconds: e.durationSeconds
      }))
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'GET to list catalog, POST to seed an anchor' }), {
      status: 405,
      headers: { 'content-type': 'application/json' }
    });
  }

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return new Response(JSON.stringify({ error: 'bad json body' }), {
      status: 400,
      headers: { 'content-type': 'application/json' }
    });
  }

  const entry = findBySlug(body.slug);
  if (!entry) {
    return new Response(JSON.stringify({
      error: 'unknown slug',
      available: CATALOG.map(e => e.slug)
    }), { status: 400, headers: { 'content-type': 'application/json' } });
  }

  const offsetSeconds = typeof body.offsetSeconds === 'number' ? body.offsetSeconds : 0;
  if (offsetSeconds < 0) {
    return new Response(JSON.stringify({ error: 'offsetSeconds must be zero or greater' }), {
      status: 400,
      headers: { 'content-type': 'application/json' }
    });
  }

  const epochMs = Date.now();
  const ok = await writeAnchor({
    title: entry.title,
    artist: entry.artist,
    offsetSeconds,
    epochMs,
    videoId: entry.videoId,
    videoDurationSeconds: entry.durationSeconds
  });

  if (!ok) {
    return new Response(JSON.stringify({ error: 'failed to write anchor' }), {
      status: 502,
      headers: { 'content-type': 'application/json' }
    });
  }

  await appendLog({
    title: entry.title,
    artist: entry.artist,
    videoId: entry.videoId,
    offsetSeconds,
    epochMs
  });

  return new Response(JSON.stringify({
    ok: true,
    seeded: {
      title: entry.title,
      artist: entry.artist,
      videoId: entry.videoId,
      offsetSeconds,
      epochMs
    }
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
