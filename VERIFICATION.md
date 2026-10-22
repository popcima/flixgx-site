# Verification — 22 October 2026

## Automated checks

Node.js v24.19.0: **13 tests passed, 0 failed**.

Coverage includes movie/episode validation, manifest parsing and rewriting, ranges, HLS encryption-key relay, authenticated API access, CORS, session expiry and capacity, private-address rejection, CDN discovery scoped to individual playback sessions, subtitle selection and VTT export. The site integration test checks all four public pages and verifies that server files, environment files and removed locker files cannot be served.

The standalone API deliverable was updated with the same CDN fix and passed its 12 tests.

## Live Chromium checks

The actual updated website ran at `http://localhost:8788`. Real provider streams were used for these checks; only the final error-handling test used a simulated upstream failure.

| Page / flow | Result |
| --- | --- |
| Home → Gladiator (TMDB 98) → Play | Decoded video, advancing time, real duration 9,300.83 seconds |
| Movies → Gladiator → Play | Decoded video and English subtitles |
| TV → Breaking Bad (TMDB 1396), season 1 episode 1 | Decoded video, real duration 3,500.08 seconds, correct episode IDs |
| Next episode → season 1 episode 2 | Fresh stream resolved and playback advanced |
| Search → Gladiator → Play | Correct TMDB ID reached the player and video decoded |
| Home hero after selecting another title | Fresh metadata; no stale season/episode inherited |
| Movie subtitles | 1,782 English cues; visible caption after seeking to first cue |
| TV subtitles | 824 English cues for episode 1 |
| Subtitle download | HTTP 200, valid WebVTT |
| Subtitles Off → reopen | Choice retained |
| Quality selection | Auto plus 480p, 720p, 1080p; 480p playback verified |
| Close / Escape | Media stopped and source removed; catalog scrolling restored |
| Mobile 390 × 844 | Player fits without horizontal overflow |
| Simulated upstream failure | Error and Retry displayed; Escape closed it |

No JavaScript page errors or locker/studio-intro requests were recorded during the browser run. All inline page scripts also passed Node syntax checks. The static Pages build completed and contains only the selected frontend files.

The second-episode check exposed a different CDN. The relay now learns HTTPS media hosts from already verified provider playlists for that session, with a host limit and private-address/DNS checks, rather than requiring a fixed list for every title.

These checks establish that the tested movies, episodes and browser work. Provider catalog coverage, continuous availability, every language, native Safari/iOS and public deployment have not been exhaustively verified. The live domain has not been deployed in this task; GitHub Pages needs a separately hosted playback backend.

## Reference player redesign

The later screenshot-based iteration replaces the card layout and native control bar with full-viewport custom controls. Both the played progress and volume use red (`#ed1b24`). Settings and subtitles open over the video; the whole overlay enters fullscreen.

Live Chromium checks passed for:

- Real movie playback, pause/resume, ten-second skips, seeking, volume/mute and accurate elapsed/total duration.
- In-player quality (Auto, 480p, 720p, 1080p), two audio choices, playback speed, subtitle Off/English and WebVTT download.
- Menus inside fullscreen; Escape closes menus and exits fullscreen before closing the player.
- Controls hiding during uninterrupted playback and reappearing on interaction or pause.
- Portrait 390×844 and landscape 844×390 layouts with contained settings menus and no horizontal overflow.
- TV season/episode controls and Next playback, plus the shared player on Home, Movies and Search.
- Keyboard K/M/arrows, keyboard focus into and out of settings, visible focus restoration on close, and entering/exiting picture-in-picture.
- Error state stops the spinner and closing releases the media source. No JavaScript page errors were recorded.

The existing 13 server/API tests still pass. The visual check caught native captions beneath the bottom gradient; the caption area now moves above the measured control bar while it is visible, with native placement restored for hidden controls and picture-in-picture. Desktop, portrait and landscape screenshots were checked with actual subtitle cues. Casting requires a compatible available receiver and was not tested against physical hardware; native Safari/iOS still needs device testing.

## Top seasons and episodes button

TV playback now has a dedicated **Seasons & episodes** button at the top of the video (shortened to **Episodes** on narrow screens). The season, episode and Next episode controls open in an anchored panel; quality, audio and speed remain in Settings. The button is hidden for movies.

Live Chromium checks passed for desktop 1440×950, portrait 390×844 and landscape 844×390; the panel stays below its trigger and within the viewport. Keyboard focus and Escape, outside-click dismissal, one menu open at a time, and opening the panel inside fullscreen all passed. All four public page mounts show the TV control and hide it when switching to a movie. No JavaScript page errors were recorded.

Actual Breaking Bad playback was verified from season 1 episode 1 through the top menu to season 2 episode 1, then episode 2, then Next episode 3. Each selection requested the matching playback endpoint and decoded video with advancing time. The 13 existing server/API tests passed again.
