<!-- BLUE PHONE: archive notes for Song Offset Listener -->
# Song Offset Listener archive notes

The distilled app is offset-listener-v2.html, served at the site root. Everything that was tried before it is kept whole in offset-listener-v1.html, served at /classic. Nothing was deleted. The server endpoints in api/ are unchanged, so every archived idea can still talk to its backend.

## What v2 keeps

Listen (browser recorder first, WAV from the rolling mic recording as the retry), ear lock, the playback control loop, learned per video offsets, nearby phone sync through regional anchors, search with Play and Broadcast, the heard across all phones feed, nearby broadcasts, live positions, pause and the half second nudges.

## What was archived, where it lives in v1, and why it is still interesting

AudD background recheck. Functions backgroundRecheck and applyDriftCorrection. It re-identified the song every few minutes and blended the new timecode into the old one. It could not beat the whole second resolution of the timecode, and ear lock replaced it. Still useful as a slow safety net for phones that cannot hear their own speaker, such as headset use.

Acoustic self correlation. Functions applyBandFilter, recordAndMeasureLag, runAcousticMeasurement, and the auto twin loop. The mic heard the room and the phone mixed together and looked for the echo between them. It could not tell which copy was ahead, so it nudged, measured again, and flipped on a bad guess, and repetitive songs fooled it. The band filter idea (lows, mids, highs) survived into ear lock.

Beatmatch handoff and cue tagging. Functions fetchBeatmatchCandidate, checkBeatmatchHandoff, the cue point form, and the self loop test switch, with api/beatmatch.js and api/tag-cue.js. When a song reached its cue out point the phone handed off to another cached song with a close tempo. It worked as a demo. It is a DJ feature and can come back as its own mode.

Broadcast nudge. Function applyBroadcastNudge with api/anchor.js. The host shifted the shared anchor so every phone moved at once. Ear lock lets each phone tune itself, so the shared shift is no longer needed. Useful again if phones without microphones ever join.

Countdown start. The old scheduleSyncPlay cued the video, counted down a few seconds, and fired every phone on the same clock tick. The control loop now steers the player continuously instead.

Manual sync details. The matched offset readout, the open on YouTube link, the Watch In Sync button, the nudge reset, and the tune by ear button.

## Elsewhere

Autopilot against catalog preview clips lives in the scope-listener repo, with api/preview.js here. It compares the mic to a short preview of the track. The preview only covers a small window of each song, which is why ear lock won.
