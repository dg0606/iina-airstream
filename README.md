# AirStream — IINA plugin

Cast the **network stream** you're playing in IINA (YouTube, HLS, direct http URLs) to an AirPlay TV **without downloading it first**. macOS hands the URL to the TV through its own AirPlay stack (like Safari); the TV fetches the stream itself.

## Install
IINA → Settings → Plugins → Install from GitHub → `dg0606/iina-airstream`

For page URLs (YouTube etc.) it needs `yt-dlp` (`brew install yt-dlp`; path configurable via the `ytdlp` preference) and, for YouTube, a JS runtime (`brew install deno` or `node`). No Python, no pairing step.

## Use
Open a URL in IINA → sidebar tab **AirStream** → wait for "Ready" → **AirPlay — choose TV**. IINA pauses; the TV plays from the same second. When you disconnect (pick this Mac in the same picker) IINA seeks to where the TV got to.

## Limits
- Network streams only (no local files).
- Control playback (pause/seek) from the TV remote.
- Subtitles loaded in IINA are not sent to the TV.
- If the TV needs a code the first time, it shows it on screen (handled by macOS).
