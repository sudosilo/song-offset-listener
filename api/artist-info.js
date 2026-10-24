import { cacheGet, cacheSet } from '../lib/search-cache.js';

export const config = { runtime: 'edge' };

const MB = 'https://musicbrainz.org/ws/2';
const UA = { 'User-Agent': 'LyricSmash/1.0 ( no-contact-configured )', Accept: 'application/json' };
const HEADERS = { 'content-type': 'application/json' };

export default async function handler(request) {
  const params = new URL(request.url).searchParams;
  const artist = clean(params.get('artist'));
  const title = clean(params.get('title'));
  if (!artist) return reply({ error: 'missing artist' }, 400);
  const cacheKey = 'songsync:artistinfo:' + norm(artist) + '|' + norm(title);
  if (!params.get('fresh')) {
    const hit = await cacheGet(cacheKey);
    if (hit && hit.artist) return reply(Object.assign({}, hit, { cached: true }));
  }

  let artistId = null, song = null;

  const found = await mb('/artist/?fmt=json&limit=5&query=' + encodeURIComponent('artist:"' + q(artist) + '"'));
  const cands = (found && found.artists) || [];
  const pick = cands.find(x => norm(x.name) === norm(artist)) || cands[0];
  if (!pick) return reply({ error: 'artist not found' });
  artistId = pick.id;
  await wait(1100);

  const a = await mb('/artist/' + artistId + '?fmt=json&inc=genres+artist-rels+release-groups');
  if (!a) return reply({ error: 'musicbrainz did not answer, try again in a few seconds', song });


  const group = a.type === 'Group';
  const people = (a.relations || [])
    .filter(r => r.type === 'member of band' && r.artist)
    .filter(r => group ? r.direction === 'backward' : r.direction === 'forward')
    .map(r => ({
      name: r.artist.name,
      years: span(r.begin, r.end, r.ended),
      role: (r.attributes || []).filter(x => x !== 'original').join(', ')
    }));

  const albums = (a['release-groups'] || [])
    .filter(g => g['primary-type'] === 'Album' && !(g['secondary-types'] || []).length)
    .sort((x, y) => (x['first-release-date'] || '9999').localeCompare(y['first-release-date'] || '9999'))
    .map(g => ({ id: g.id, title: g.title, year: (g['first-release-date'] || '').slice(0, 4) || null }));

  if (title) {
    await wait(1100);
    const wantT = norm(title);
    const ownAlbumIds = new Set(albums.map(x => x.id));
    const studio = r => r.status === 'Official' && r['release-group'] && ownAlbumIds.has(r['release-group'].id);
    const rec = await mb('/recording/?fmt=json&limit=100&query=' + encodeURIComponent('arid:' + artistId + ' AND recording:"' + q(title) + '"'));
    const all = ((rec && rec.recordings) || []).filter(r => norm(r.title) === wantT);
    let best = null;
    for (const recn of all) {
      for (const rel of recn.releases || []) {
        if (!studio(rel) || !rel.date) continue;
        if (!best || rel.date < best.rel.date) best = { recn, rel };
      }
    }
    const pool = all.filter(r => r['first-release-date']).sort((x, y) => x['first-release-date'].localeCompare(y['first-release-date']));
    const hit = best ? best.recn : pool[0];
    if (hit) {
      const lengths = all.map(r => r.length).filter(Boolean).sort((x, y) => x - y);
      song = {
        title: hit.title,
        firstReleased: [best && best.rel.date, pool[0] && pool[0]['first-release-date']].filter(Boolean).sort()[0] || null,
        album: best ? best.rel.title : null,
        lengthSeconds: hit.length ? Math.round(hit.length / 1000) : (lengths.length ? Math.round(lengths[Math.floor(lengths.length / 2)] / 1000) : null)
      };
    }
  }

  const out = {
    artist: {
      name: a.name,
      type: a.type || null,
      country: a.country || null,
      area: a.area ? a.area.name : null,
      hometown: a['begin-area'] ? a['begin-area'].name : null,
      years: span(a['life-span'] && a['life-span'].begin, a['life-span'] && a['life-span'].end, a['life-span'] && a['life-span'].ended),
      about: a.disambiguation || null,
      genres: (a.genres || []).sort((x, y) => (y.count || 0) - (x.count || 0)).slice(0, 6).map(g => g.name),
      members: group ? people : [],
      memberOf: group ? [] : people,
      albums
    },
    song
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

function span(begin, end, ended) {
  const b = (begin || '').slice(0, 4), e = (end || '').slice(0, 4);
  if (!b && !e) return null;
  return (b || '?') + ' to ' + (e || (ended ? '?' : 'now'));
}
function norm(s) { return (s || '').toLowerCase().replace(/\(.*?\)|\[.*?\]/g, '').replace(/[^a-z0-9]/g, ''); }
function q(s) { return s.replace(/["\\]/g, ' '); }
function clean(s) { return (s || '').replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120); }
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
function reply(body, status) { return new Response(JSON.stringify(body), { status: status || 200, headers: HEADERS }); }
