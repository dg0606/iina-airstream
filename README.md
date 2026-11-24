# AirStream — IINA plugin

Cast the **network stream** you're playing in IINA (YouTube, HLS, direct http URLs) to an AirPlay device **without downloading it first**. The device fetches the stream itself.

## Install
IINA → Settings → Plugins → Install from GitHub → `dg0606/iina-airstream`

First use creates a private Python venv and installs [pyatv](https://pyatv.dev) (needs `python3`). For page URLs (YouTube etc.) it needs `yt-dlp` (`brew install yt-dlp`; path configurable in the `ytdlp` preference, default `/opt/homebrew/bin/yt-dlp`).

## Use
Open a URL in IINA → menu **Plugins → AirStream** → *Search devices* → *Cast to …*. *Stop casting* ends it.

## Limits
- Network streams only (no local files).
- No remote control from IINA; pause/seek on the receiving device.
- YouTube: AirPlay takes one URL, so only the muxed 360p stream is available (YouTube no longer serves higher resolutions with audio in one file).
- If the device asks for a PIN, pair it with `atvremote --id <id> --protocol airplay pair`.
