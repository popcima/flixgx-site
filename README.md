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

## Free temporary Cloudflare test

For a short test, use a [Cloudflare Quick Tunnel](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/). It needs no Cloudflare account or credit card. Install [cloudflared](https://developers.cloudflare.com/tunnel/downloads/) (on macOS: `brew install cloudflared`), then run:

```sh
npm ci
npm run test:cloudflare
```

Open the printed `https://…trycloudflare.com` preview. It runs the site and playback API together, including movies, TV episodes, quality selection and subtitles when supplied by the provider. It automatically uses the tunnel origin for media URLs. Keep `assets/player-config.js` at its default `apiBaseUrl: ''` for this preview. `CLOUDFLARED_BIN` optionally specifies the installed executable's path.

Anyone with this temporary URL can access the preview. Keep the terminal and your Mac running; Ctrl+C stops both the tunnel and test server. The hostname changes on restart, and Cloudflare provides no uptime guarantee. Quick Tunnels allow up to 200 concurrent requests; the API's smaller limits still apply. Video is relayed through your computer and uses its bandwidth.

This is a development preview, not a Workers deployment. It does not change GitHub Pages, DNS or `STREAM_API_ORIGIN`. Use the preview URL for testing and configure a stable API host before connecting the production domain.

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

### Deploy the API on Render

The included `render.yaml` creates one Docker web service with a `/health` check, a generated server-only API key, and CORS for the FlixGX domains. It uses Render's assigned HTTPS URL automatically through [`RENDER_EXTERNAL_URL`](https://render.com/docs/environment-variables); `PUBLIC_BASE_URL` remains an explicit override for a custom API domain. Do not copy the local `.env` file into the service.

1. Connect a Render account and create a Blueprint from this repository on `main`.
2. Wait for its deployment and verify `https://<assigned-service>.onrender.com/health` returns JSON with `ok: true`.
3. Verify a movie and TV playback request with `Origin: https://flixgx.com`, including the returned HLS manifest and segments.
4. Set the GitHub Actions repository variable `STREAM_API_ORIGIN` to that verified HTTPS origin, without a trailing slash or path.
5. Run the **Deploy to GitHub Pages** workflow manually. This rebuild is necessary after changing the variable. Verify the live `assets/player-config.js` contains the API origin, then test movie and episode playback on the public site.

The Blueprint selects the Free compute plan for initial verification. Render's [Free service limits](https://render.com/docs/free) include idle shutdown and restrictions on heavy outbound traffic. Video relaying consumes outbound bandwidth, and overages can be billed when a payment method is present. Choose hosting capacity and a bandwidth budget appropriate to public traffic before a wider launch. Keep one API instance while playback sessions remain in memory.

### Optional outbound proxy

If the video provider rejects the server's connection, test a provider-approved HTTP(S) forward proxy. Set `UPSTREAM_PROXY_URL` privately in Render's Environment settings, then deploy:

```dotenv
UPSTREAM_PROXY_URL=http://username:password@proxy-host:port
```

Use a fixed proxy endpoint. Percent-encode special characters in the username/password. A URL such as `/manifest.mpd?url=...` is a media relay and cannot be used here. Keep credentials out of GitHub, the frontend and screenshots. Leave this variable empty to connect directly.

The API sends source lookups, playlists, media segments and subtitles through the configured proxy, preserving one outgoing connection identity for IP-bound streams. It validates destination DNS and pins the checked public IP in CONNECT, with certificate verification against the original hostname. Proxy failure does not silently switch to a direct connection. `/health` reports only `proxyConfigured: true/false`; it does not prove provider access or disclose the endpoint.

Provider errors include safe `error.upstream` diagnostics (`stage`, HTTP `status`, and whether a Cloudflare challenge header was present). No signed URLs, cookies or response bodies are included. `source_lookup` HTTP 403 means the initial source lookup was rejected; it does not establish an IP block by itself.

[Webshare's free plan](https://help.webshare.io/en/articles/8375287-do-you-offer-proxies-for-free) offers 10 shared datacenter proxies and 1 GB/month as checked on October 22, 2026. It requires an account. Shared addresses can also be blocked, and video quickly uses the allowance. Verify a movie and an episode through Render before relying on a proxy; no free endpoint has been verified for this provider yet.

Services created from a public Git URL require a manual deployment even after a GitHub push. Check that Render's live commit matches the desired repository revision; see [Render's deploy documentation](https://render.com/docs/deploys).

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
