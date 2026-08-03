export async function searchYouTube(query, maxResults = 8) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) return { error: 'YOUTUBE_API_KEY not configured', results: [] };
  if (!query) return { error: 'no query provided', results: [] };

  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&videoCategoryId=10&maxResults=${maxResults}&key=${apiKey}`;

  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    return { error: 'network error reaching youtube api', results: [] };
  }

  const data = await res.json();

  if (data.error) {
    return { error: data.error.message || 'youtube api rejected the request', results: [] };
  }

  const items = data.items || [];
  const results = items.map(item => ({
    videoId: item.id.videoId,
    title: item.snippet.title,
    channel: item.snippet.channelTitle,
    thumbnail: item.snippet.thumbnails && item.snippet.thumbnails.default
      ? item.snippet.thumbnails.default.url
      : null
  }));

  return { error: null, results };
}

export async function findYouTubeMatch(title, artist) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey || !title) return null;

  const query = encodeURIComponent(`${artist || ''} ${title}`.trim());
  const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${query}&type=video&videoCategoryId=10&maxResults=5&key=${apiKey}`;

  let searchRes;
  try {
    searchRes = await fetch(searchUrl);
  } catch (err) {
    return null;
  }
  const searchData = await searchRes.json();
  if (searchData.error) return null;
  const items = searchData.items || [];
  if (items.length === 0) return null;

  const banned = /live|remix|cover|reaction|karaoke|8d audio|slowed|sped up/i;
  const ranked = items
    .filter(item => !banned.test(item.snippet.title))
    .concat(items);

  const chosen = ranked[0];
  const videoId = chosen.id.videoId;

  const durationSeconds = await fetchDuration(videoId, apiKey);

  return {
    videoId,
    videoTitle: chosen.snippet.title,
    durationSeconds
  };
}

async function fetchDuration(videoId, apiKey) {
  const url = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${videoId}&key=${apiKey}`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    const iso = data.items && data.items[0] && data.items[0].contentDetails.duration;
    return iso ? parseIsoDuration(iso) : null;
  } catch (err) {
    return null;
  }
}

function parseIsoDuration(iso) {
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return null;
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  return hours * 3600 + minutes * 60 + seconds;
}
