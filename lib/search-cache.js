// Shared Redis cache for paid lookups, on the same Upstash store as the song cache and BPM index.
function creds() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : null;
}

export async function cacheGet(key) {
  const c = creds();
  if (!c) return null;
  try {
    const res = await fetch(`${c.url}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${c.token}` } });
    const data = await res.json();
    return data && data.result ? JSON.parse(data.result) : null;
  } catch (err) {
    return null;
  }
}

export async function cacheSet(key, value, seconds) {
  const c = creds();
  if (!c) return false;
  try {
    await fetch(`${c.url}/set/${encodeURIComponent(key)}${seconds ? '?EX=' + seconds : ''}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${c.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(value)
    });
    return true;
  } catch (err) {
    return false;
  }
}

export async function indexBpm(member, bpm) {
  const c = creds();
  if (!c) return false;
  try {
    await fetch(`${c.url}/zadd/songsync:bpmindex/${bpm}/${encodeURIComponent(member)}`, { headers: { Authorization: `Bearer ${c.token}` } });
    return true;
  } catch (err) {
    return false;
  }
}

export function normQuery(s) {
  return (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}
