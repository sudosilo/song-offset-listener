import { cacheGet, cacheSet } from '../lib/search-cache.js';

export const config = { runtime: 'edge' };

const MB = 'https://musicbrainz.org/ws/2';
const UA = { 'User-Agent': 'LyricSmash/1.0 ( no-contact-configured )', Accept: 'application/json' };
const HEADERS = { 'content-type': 'application/json' };
const ID = /^[0-9a-f-]{36}$/;

// Album panel data: cover, release date and track list for one release group.
export default async function handler(request) {
  const id = new URL(request.url).searchParams.get('id') || '';
  if (!ID.test(id)) return reply({ error: 'bad album id' }, 400);

  const cacheKey = 'songsync:album:' + id;
  const hit = await cacheGet(cacheKey);
  if (hit && hit.tracks) return reply(Object.assign({}, hit, { cached: true }));

  const rg = await mb('/release-group/' + id + '?fmt=json&inc=releases+artist-credits');
  if (!rg) return reply({ error: 'musicbrainz did not answer, try again in a few seconds' });

  const releases = (rg.releases || []).filter(r => r.status === 'Official' || !r.status)
    .sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'));
  const pickRel = releases.find(r => r.country === 'US') || releases.find(r => r.country === 'XW') || releases[0];
  if (!pickRel) return reply({ error: 'no releases for this album' });

  await wait(1100);
  const rel = await mb('/release/' + pickRel.id + '?fmt=json&inc=recordings');
  if (!rel) return reply({ error: 'musicbrainz did not answer, try again in a few seconds' });

  const tracks = [];
  (rel.media || []).forEach((m, mi) => {
    (m.tracks || []).forEach(t => tracks.push({
      disc: (rel.media || []).length > 1 ? mi + 1 : null,
      n: t.position,
      title: t.title,
      lengthSeconds: t.length ? Math.round(t.length / 1000) : null
    }));
  });

  const out = {
    id,
    title: rg.title,
    artist: (rg['artist-credit'] || []).map(x => x.name + (x.joinphrase || '')).join('') || null,
    released: rg['first-release-date'] || pickRel.date || null,
    cover: 'https://coverartarchive.org/release-group/' + id + '/front-250',
    tracks
  };
  await cacheSet(cacheKey, out, 0);
  return reply(out);
}

async function mb(path) {
  for (let tryNo = 0; tryNo < 3; tryNo++) {
    try {
      const res = await fetch(MB + path, { headers: UA });
      if (res.status === 503) { await wait(1500); continue; }
      if (!res.ok) return null;
      return await res.json();
    } catch (err) {
      await wait(1000);
    }
  }
  return null;
}
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
function reply(body, status) { return new Response(JSON.stringify(body), { status: status || 200, headers: HEADERS }); }
