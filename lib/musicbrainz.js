const MB_USER_AGENT = 'SongOffsetListener/1.0 ( no-contact-configured )';

export async function findYouTubeViaMusicBrainz(title, artist) {
  try {
    const query = encodeURIComponent(`recording:"${title}" AND artist:"${artist}"`);
    const searchUrl = `https://musicbrainz.org/ws/2/recording/?query=${query}&fmt=json&limit=1`;
    const searchRes = await fetch(searchUrl, { headers: { 'User-Agent': MB_USER_AGENT } });
    if (!searchRes.ok) return null;
    const searchData = await searchRes.json();
    const recording = searchData.recordings && searchData.recordings[0];
    if (!recording || !recording.id) return null;
    const mbid = recording.id;

    const relRes = await fetch(`https://musicbrainz.org/ws/2/recording/${mbid}?inc=url-rels&fmt=json`, {
      headers: { 'User-Agent': MB_USER_AGENT }
    });
    if (!relRes.ok) return { mbid, videoId: null, durationSeconds: null };
    const relData = await relRes.json();
    const relations = relData.relations || [];
    const youtubeRel = relations.find(r =>
      r.url && r.url.resource && r.url.resource.indexOf('youtube.com/watch') !== -1
    );

    const durationMs = recording.length;
    const durationSeconds = typeof durationMs === 'number' ? Math.round(durationMs / 1000) : null;

    if (!youtubeRel) return { mbid, videoId: null, durationSeconds };

    let videoId = null;
    try {
      videoId = new URL(youtubeRel.url.resource).searchParams.get('v');
    } catch (err) {
      videoId = null;
    }

    return { mbid, videoId, durationSeconds };
  } catch (err) {
    return null;
  }
}
