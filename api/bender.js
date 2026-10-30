import { cacheGet, cacheSet } from '../lib/search-cache.js';

export const config = { runtime: 'edge' };

// Relay from Smash Director to Smash Bender. Frankfurt cannot fetch from YouTube, so a phone does it:
//   POST {action:'queue', project, song_one, song_two, seconds, inst, aca}   queues a job, returns {id}
//   GET  ?id=ID                                                              the job's status
//   GET  ?next=1                                                             a phone takes the next job
//   POST {action:'result', id, ok, job, project, open, error}                the phone reports back
const HEADERS = { 'content-type': 'application/json', 'Access-Control-Allow-Origin': '*' };
const VID = /^[A-Za-z0-9_-]{11}$/;
const DAY2 = 172800;

export default async function handler(request) {
  try { return await run(request); } catch (err) { return reply({ error: String(err && err.message || err).slice(0, 300) }); }
}

async function run(request) {
  const url = process.env.UPSTASH_REDIS_REST_URL, token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return reply({ error: 'redis not configured' }, 500);
  const r = (args) => redis(url, token, args);
  const txt = (v, n) => String(v || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);

  if (request.method === 'POST') {
    let b = null;
    try { b = await request.json(); } catch (e) {}
    if (!b) return reply({ error: 'bad body' }, 400);
    if (b.action === 'queue') {
      if (!VID.test(b.inst || '') || !VID.test(b.aca || '')) return reply({ error: 'need both video ids' }, 400);
      const id = Math.random().toString(36).slice(2, 10);
      const job = { id, status: 'queued', project: txt(b.project, 60), song_one: txt(b.song_one, 120), song_two: txt(b.song_two, 120),
        seconds: Math.max(10, Math.min(240, parseInt(b.seconds, 10) || 45)), inst: b.inst, aca: b.aca, at: Date.now() };
      await cacheSet('songsync:bender:' + id, job, DAY2);
      await r(['RPUSH', 'songsync:benderq', id]);
      return reply({ id, waiting: (await r(['LLEN', 'songsync:benderq'])) || 1 });
    }
    if (b.action === 'result') {
      const job = await cacheGet('songsync:bender:' + txt(b.id, 20));
      if (!job) return reply({ error: 'no such job' }, 404);
      Object.assign(job, b.ok ? { status: 'sent', job: txt(b.job, 40), slug: txt(b.project, 60), open: txt(b.open, 300) } : { status: 'failed', error: txt(b.error, 200) }, { done: Date.now() });
      await cacheSet('songsync:bender:' + job.id, job, DAY2);
      return reply({ ok: true });
    }
    return reply({ error: 'unknown action' }, 400);
  }

  const p = new URL(request.url).searchParams;
  if (p.get('next') === '1') {
    for (let k = 0; k < 5; k++) {
      const id = await r(['LPOP', 'songsync:benderq']);
      if (!id) return reply({ job: null });
      const job = await cacheGet('songsync:bender:' + id);
      if (!job) continue;
      job.status = 'downloading'; job.taken = Date.now();
      await cacheSet('songsync:bender:' + id, job, DAY2);
      return reply({ job });
    }
    return reply({ job: null });
  }
  const id = txt(p.get('id'), 20);
  const job = id ? await cacheGet('songsync:bender:' + id) : null;
  if (!job) return reply({ error: 'no such job' }, 404);
  const ahead = job.status === 'queued' ? ((await r(['LPOS', 'songsync:benderq', id])) ?? 0) : 0;
  return reply(Object.assign({}, job, { ahead }));
}

async function redis(url, token, args) {
  const res = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(args) });
  const d = await res.json();
  return d ? d.result : null;
}
function reply(body, status) { return new Response(JSON.stringify(body), { status: status || 200, headers: HEADERS }); }
