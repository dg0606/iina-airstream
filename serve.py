#!/usr/bin/env python3
"""Tiny HLS file server: serve.py <dir> <portfile> [ffmpeg-pidfile].
Picks a free port, writes it to <portfile>. Exits (and stops ffmpeg) if IINA dies."""
import functools, http.server, os, signal, sys, threading, time

class H(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
        ".m3u8": "application/vnd.apple.mpegurl", ".m4s": "video/iso.segment",
        ".mp4": "video/mp4", ".ts": "video/mp2t", "": "application/octet-stream"}
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()
    def log_message(self, *a):
        pass

srv = http.server.ThreadingHTTPServer(("0.0.0.0", 0), functools.partial(H, directory=sys.argv[1]))
with open(sys.argv[2], "w") as f:
    f.write(str(srv.server_address[1]))
def watchdog():
    while True:
        time.sleep(5)
        if os.getppid() == 1:  # parent (IINA) is gone
            try:
                os.kill(int(open(sys.argv[3]).read().strip()), signal.SIGTERM)
            except Exception:
                pass
            os._exit(0)

threading.Thread(target=watchdog, daemon=True).start()
srv.serve_forever()
