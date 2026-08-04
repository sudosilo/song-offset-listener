// Local seed catalog. No external API calls needed to use these.
// videoId values here were returned by live YouTube API lookups and are known good.
// mbid is left null until enriched from MusicBrainz; nothing depends on it yet.

export const CATALOG = [
  {
    slug: 'never-gonna-give-you-up',
    title: 'Never Gonna Give You Up',
    artist: 'Rick Astley',
    videoId: 'dQw4w9WgXcQ',
    durationSeconds: 213,
    mbid: null
  },
  {
    slug: 'together-forever',
    title: 'Together Forever',
    artist: 'Rick Astley',
    videoId: 'yPYZpwSpKmA',
    durationSeconds: 205,
    mbid: null
  },
  {
    slug: 'squabble-up',
    title: 'squabble up',
    artist: 'Kendrick Lamar',
    videoId: 'U0KTVVMvcc4',
    durationSeconds: 158,
    mbid: null
  },
  {
    slug: 'tv-off',
    title: 'tv off (feat. Lefty Gunplay)',
    artist: 'Kendrick Lamar',
    videoId: 'XIwrwOEx5i8',
    durationSeconds: 220,
    mbid: null
  },
  {
    slug: 'ooh-lala',
    title: 'Ooh LaLa (feat. DJ Premier & Greg Nice)',
    artist: 'Run The Jewels',
    videoId: 'Sff7Kc77QAY',
    durationSeconds: 232,
    mbid: null
  }
];

export function findBySlug(slug) {
  return CATALOG.find(entry => entry.slug === slug) || null;
}
