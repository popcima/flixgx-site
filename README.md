# FlixGX with real movie and TV playback

Home, Movies, TV and Search now use one HLS player. Title selection passes the TMDB ID; TV selection also passes the season and episode. The original studio-intro loop, simulated timeline, offer locker, locker assets and locker admin tab have been removed.

The player fills the viewport with a black video canvas and white controls, matching the supplied reference. Its red progress and volume bars, play/pause, ten-second skips and elapsed/total time follow the actual video. Subtitles open over the video; the settings menu includes quality, audio and playback speed. TV shows have a dedicated **Seasons & episodes** button at the top right (**Episodes** on narrow screens), with season, episode and next-episode controls in an in-player panel. Movies hide this button. Fullscreen keeps the custom controls and menus inside the player. Picture-in-picture and casting are offered when the browser supports them.

English subtitles are selected when available; the viewer's language or Off choice is remembered. Subtitle downloads and next-episode playback remain available inside the player. Playback failures show a retry button that requests a fresh stream. Controls hide during playback and reappear on interaction, pause, buffering or when a menu is open.

The catalog layout, existing TMDB catalog configuration, Supabase login and home-section editing are preserved. Legacy intro/override admin tools remain for the existing database, but no longer control public playback. No Supabase data was deleted.

## Run locally

Install Node.js 22 or newer, then run these commands from this folder:

```sh
npm ci
cp .env.example .env
npm start
```

Open http://localhost:8788. The site and its playback server run together. `npm test` runs the automated API and integration checks.

## Deploy the site and server together

Use a host that runs a persistent Node.js service or the included Dockerfile. Set:

```dotenv
HOST=0.0.0.0
PORT=8788
PUBLIC_BASE_URL=https://your-live-site.example
```

Install with `npm ci --omit=dev` and start with `npm start`. Leave `assets/player-config.js` with `apiBaseUrl: ''` for same-origin hosting. Use HTTPS on the public host. `PUBLIC_BASE_URL` must match the externally reachable origin, because the server returns absolute media URLs.

## Keep the frontend on GitHub Pages

GitHub Pages serves static files; it cannot run the playback API. Deploy this Node service separately, then:

1. Set the backend's `PUBLIC_BASE_URL` to its HTTPS address and `HOST=0.0.0.0`.
2. Set backend `CORS_ORIGINS=https://flixgx.com,https://www.flixgx.com` (and any other exact frontend origin).
3. Set the GitHub repository variable `STREAM_API_ORIGIN` to the backend HTTPS origin. The updated Pages workflow inserts it into the frontend config and uploads only static files.

Alternatively, edit `assets/player-config.js` directly to set `apiBaseUrl` to that backend origin. Do not put an API secret in this file. The included CNAME is preserved.

The local preview is functional, but publishing the HTML alone will not make streaming work on the live domain. A reachable playback backend is required.

## Endpoints

These routes are intentionally public for visitors to this website and inherit API validation, CORS and rate limits:

```text
GET /api/playback/movie/98
GET /api/playback/tv/1396/1/1
```

They return JSON containing `sources[0].playbackUrl`, qualities, audio tracks and subtitles. The player uses the relayed playback URL, which handles upstream headers and rewrites HLS variant, segment, key, audio and subtitle URLs.

For other backend integrations, configure `API_KEY` and send `Authorization: Bearer <API_KEY>`:

```text
GET /v1/streams/movie/98
GET /v1/streams/tv/1396/1/1
GET /v1/playlist/movie/98.m3u
GET /v1/playlist/tv/1396/1/1.m3u
```

Without `API_KEY`, the server uses an internal random key; website playback still works. Media and subtitle URLs carry opaque, expiring session IDs and need no authorization header. CORS is a browser restriction, not authentication; the public playback route can be called by non-browser clients. For a members-only site, put your existing login/session check before `/api/playback`.

## Runtime limits

- TMDB supplies catalog metadata and IDs; the separate Vidpro provider supplies the streams. Catalog presence does not guarantee a playable stream.
- This implementation integrates the observed Vidpro provider flow. Upstream availability and formats can change. CDN URLs are discovered only from verified provider playlists and allowed for that playback session. HTTPS, host limits and DNS checks still block private-network access. A redirect to a host absent from those playlists needs verification before adding it to `EXTRA_MEDIA_HOSTS`.
- Subtitle languages, audio and qualities vary by title. HLS subtitles play through the media manifest; VTT download supports the observed single-file subtitle playlists and reports unsupported formats rather than returning broken subtitles.
- Sessions are in memory and expire after at most six hours. A server restart invalidates existing URLs; Retry resolves them again. Multiple instances need sticky routing or a shared session implementation.
- The server allows four concurrent resolutions, 24 media requests and 128 playback sessions. It relays video bytes, so hosting bandwidth matters. API rate limiting is 60 resolutions/minute per connection IP; behind a reverse proxy, visitors may share that limit. Configure suitable edge limits for a larger deployment.
- Chromium playback is verified locally. Native Safari/iOS support is implemented but needs testing on the target devices.

The provider was derived from the earlier repository/site analysis. See the accompanying `autoembed-api` deliverable for that analysis and the standalone API demo.
