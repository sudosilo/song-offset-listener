const GETSONGBPM_BASE = 'https://api.getsongbpm.com';

export async function findBpmAndKey(title, artist) {
  const apiKey = process.env.GETSONGBPM_API_KEY;
  if (!apiKey) return null;

  try {
    const lookup = encodeURIComponent(`song:${title} artist:${artist}`);
    const searchUrl = `${GETSONGBPM_BASE}/search/?api_key=${apiKey}&type=song&lookup=${lookup}`;
    const res = await fetch(searchUrl);
    if (!res.ok) return null;
    const data = await res.json();
    const match = data.search && data.search[0];
    if (!match || !match.tempo) return null;

    const bpm = parseFloat(match.tempo);
    if (!bpm || isNaN(bpm)) return null;

    return {
      bpm,
      key: match.key_of || null
    };
  } catch (err) {
    return null;
  }
}
