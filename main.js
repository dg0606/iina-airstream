// AirStream — cast the current network stream to an AirPlay TV without
// downloading it. The sidebar page holds a hidden <video x-webkit-airplay>;
// macOS' own AirPlay stack hands the URL to the TV (the TV fetches it itself),
// the same way Safari does. This script only resolves the URL (yt-dlp) and
// keeps IINA in sync. `var` + iina.X on purpose (see git history: const-
// destructuring `console` can kill the script load).

var core = iina.core, mpv = iina.mpv, menu = iina.menu, sidebar = iina.sidebar,
    utils = iina.utils, file = iina.file, event = iina.event,
    preferences = iina.preferences, log = iina.console;

var DIRECT = /\.(m3u8|mp4|m4v|mov|mp3|m4a|aac)(\?|$)/i; // what AVFoundation can play
var st = { status: "idle", msg: "Open a network stream (URL) in IINA.", url: "", pos: 0, title: "" };
var tvActive = false, lastTvPos = 0, gen = 0;

function exists(p) { try { return !!file.exists(p); } catch (e) { return false; } }
function tail(s) { var l = String(s || "").trim().split("\n").filter(Boolean); return l.length ? l[l.length - 1] : ""; }
function set(status, msg) { st.status = status; st.msg = msg || ""; if (msg) log.log("[" + status + "] " + msg); }

async function findYtdlp() {
  var pref = ""; try { pref = preferences.get("ytdlp") || ""; } catch (e) {}
  var c = [pref, "/opt/homebrew/bin/yt-dlp", "/usr/local/bin/yt-dlp", "/Applications/IINA.app/Contents/MacOS/youtube-dl"];
  for (var i = 0; i < c.length; i++) if (c[i] && exists(c[i])) return c[i];
  return null;
}

// AirPlay takes ONE url, so we need a muxed audio+video stream. YouTube only
// offers those via web_embedded (HLS up to 1080p) / android (360p mp4) — their
// URLs work without yt-dlp's chunked downloading; other sites ignore
// that option, so try it first and fall back to the default client.
async function resolveUrl(src) {
  if (DIRECT.test(src)) return src;
  var bin = await findYtdlp();
  if (!bin) return src;
  var fmt = "b[protocol^=m3u8]/b[ext=mp4][vcodec^=avc1]/b[ext=mp4]/b";
  var base = ["-g", "--no-playlist", "--no-warnings", "-f", fmt];
  var yt = ["--extractor-args", "youtube:player_client=web_embedded,android,tv_simply"];
  // IINA runs us with an empty PATH, so yt-dlp can't find the JS runtime it
  // needs for YouTube's challenge (it silently falls back to 360p). Pass it.
  var js = [];
  [["deno", "/opt/homebrew/bin/deno"], ["deno", "/usr/local/bin/deno"],
   ["node", "/opt/homebrew/bin/node"], ["node", "/usr/local/bin/node"]].forEach(function (c) {
    if (!js.length && exists(c[1])) js = ["--js-runtimes", c[0] + ":" + c[1]];
  });
  var tries = [base.concat(js, yt, [src]), base.concat(yt, [src]), base.concat([src])];
  var url = "", last = "";
  for (var i = 0; i < tries.length && !url; i++) {
    var r = await utils.exec(bin, tries[i]);
    url = r.status === 0 ? r.stdout.trim().split("\n")[0] : "";
    if (!url) last = tail(r.stderr);
  }
  if (!url) { log.log("yt-dlp failed: " + last); return src; }
  return url;
}

async function prepare() {
  var me = ++gen;
  try {
    var src = mpv.getString("path") || "";
    st.title = mpv.getString("media-title") || "";
    st.pos = mpv.getNumber("time-pos") || 0;
    if (!/^https?:\/\//i.test(src)) { st.url = ""; return set("idle", "Only network streams (URLs) can be cast, not local files."); }
    set("resolving", "Resolving stream...");
    var url = await resolveUrl(src);
    if (me !== gen) return; // a newer file was opened meanwhile
    st.url = url;
    set("ready", "Ready. Press AirPlay and choose your TV.");
  } catch (e) {
    if (me === gen) set("error", e.message);
  }
}

function backToIina() {
  if (!tvActive) return;
  tvActive = false;
  try { core.seekTo(lastTvPos); } catch (e) { try { mpv.set("time-pos", lastTvPos); } catch (e2) {} }
  set("idle", "Back in IINA at " + Math.floor(lastTvPos / 60) + ":" + ("0" + Math.floor(lastTvPos % 60)).slice(-2));
}

function loadSidebar() {
  try { sidebar.loadFile("sidebar.html"); } catch (e) { return; } // no window yet
  sidebar.onMessage("getState", function () { sidebar.postMessage("state", st); });
  sidebar.onMessage("reload", function () { prepare(); });
  sidebar.onMessage("tv", function (d) {
    d = d || {};
    lastTvPos = Number(d.t) || lastTvPos;
    if (d.onTV && !tvActive) { tvActive = true; try { mpv.set("pause", true); } catch (e) {} set("casting", "Playing on the TV"); }
    else if (!d.onTV) backToIina();
  });
}

var root = menu.item("AirStream");
root.addSubMenuItem(menu.item("Open panel", function () { try { sidebar.show(); } catch (e) {} }));
root.addSubMenuItem(menu.item("Reload stream", function () { prepare(); }));
menu.addItem(root);

loadSidebar();
event.on("iina.window-loaded", loadSidebar);
event.on("iina.file-loaded", function () { tvActive = false; prepare(); });
log.log("AirStream loaded");
prepare();
