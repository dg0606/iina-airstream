# AirStream — IINA plugin

AirPlay **whatever IINA is playing** to a TV — network streams (debrid / Torrentio links, mkv, HLS, YouTube) and local files — **without downloading it first**. macOS hands the stream to the TV through its own AirPlay stack (like Safari).

- If the TV can play it natively (mp4/HLS, H.264/HEVC) the **TV fetches the URL itself**; nothing passes through the Mac.
- Otherwise (e.g. **mkv**, DTS/Opus audio) `ffmpeg` reads the source live, remuxes it to HLS at playback speed and a tiny local server hands it to the TV. Video is copied when possible (no re-encode); audio the TV can't play is converted to AAC.

## Requirements
`brew install ffmpeg yt-dlp` (+ `deno` or `node` for YouTube) and `python3`. No pip, no pairing.

## Install
IINA → Settings → Plugins → Install from GitHub → `dg0606/iina-airstream`

## Use
Play something → sidebar tab **AirStream** → wait for "Ready" → **AirPlay — choose TV**. IINA pauses; the TV continues from the same second. When you disconnect (pick this Mac in the same picker) IINA seeks to where the TV got to.

## Limits
- Pause/seek from the TV remote. Seeking far ahead on remuxed streams only works up to what has been prepared.
- Subtitles loaded in IINA are not sent to the TV.
- Streams that need custom HTTP headers always go through the Mac.
