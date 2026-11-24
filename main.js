// AirStream — send whatever IINA is playing (network stream or file) to an
// AirPlay TV. The sidebar page holds a hidden <video x-webkit-airplay>; macOS'
// own AirPlay stack does the hand-off (same as Safari).
//  * If the TV can play the stream natively (mp4/HLS, h264/hevc) the TV fetches
//    the URL itself — nothing passes through the Mac.
//  * Otherwise (mkv, DTS/EAC3-less players, ...) ffmpeg reads the source live,
//    remuxes to HLS at playback speed and a tiny local server hands it to the TV.
// IINA runs plugins with an EMPTY environment: every binary is called by
// absolute path, and files are checked with /bin/test (no file API).
// `var` + iina.X on purpose (const-destructuring `console` can kill the load).

var core = iina.core, mpv = iina.mpv, menu = iina.menu, sidebar = iina.sidebar,
    utils = iina.utils, event = iina.event, preferences = iina.preferences, log = iina.console;

function clean(p) { return String(p || "").replace(/\/+$/, ""); }
var DATA = clean(utils.resolvePath("@data/"));
var ID = "io.github.dg0606.iina-airstream";
var HLS = DATA + "/hls", FFPID = DATA + "/ffmpeg.pid", SRVPID = DATA + "/server.pid", PORTFILE = DATA + "/server.port";

var st = { status: "idle", msg: "Play something in IINA.", url: "", pos: 0, offset: 0, title: "", info: "" };
var tvActive = false, lastTvPos = 0, gen = 0, ffState = { running: false, tail: "" };

function set(status, msg) { st.status = status; st.msg = msg || ""; if (msg) log.log("[" + status + "] " + msg); }
function tail(s) { var l = String(s || "").trim().split("\n").filter(Boolean); return l.length ? l[l.length - 1] : ""; }
function sleep(sec) { return utils.exec("/bin/sleep", [String(sec)]); }

async function sh(cmd, args) {
  try { return await utils.exec(cmd, args); } catch (e) { return { status: -1, stdout: "", stderr: String(e) }; }
}
async function test(flag, p) { return (await sh("/bin/test", [flag, p])).status === 0; }
async function firstExe(list) { for (var i = 0; i < list.length; i++) if (list[i] && await test("-x", list[i])) return list[i]; return null; }
async function cat(p) { var r = await sh("/bin/cat", [p]); return r.status === 0 ? r.stdout : ""; }

function pref(k) { try { return preferences.get(k) || ""; } catch (e) { return ""; } }

// ---- process management (wrapper writes its own pid, then execs) ----

function spawn(pidfile, bin, args, onExit) {
  var p = utils.exec("/bin/sh", ["-c", 'echo $$ > "$1"; shift; exec "$@"', "sh", pidfile, bin].concat(args));
  p.then(function (r) { if (onExit) onExit(r); }, function (e) { if (onExit) onExit({ status: -1, stderr: String(e) }); });
}
async function killPid(pidfile) {
  var pid = (await cat(pidfile)).trim();
  if (/^\d+$/.test(pid)) await sh("/bin/kill", [pid]);
  await sh("/bin/rm", ["-f", pidfile]);
}
async function stopAll() { await killPid(FFPID); await killPid(SRVPID); await sh("/bin/rm", ["-rf", HLS, PORTFILE]); }

// ---- probing ----

async function tools() {
  return {
    ffmpeg: await firstExe([pref("ffmpeg"), "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"]),
    ffprobe: await firstExe([pref("ffprobe"), "/opt/homebrew/bin/ffprobe", "/usr/local/bin/ffprobe"]),
    ytdlp: await firstExe([pref("ytdlp"), "/opt/homebrew/bin/yt-dlp", "/usr/local/bin/yt-dlp", "/Applications/IINA.app/Contents/MacOS/youtube-dl"]),
    python: await firstExe(["/opt/homebrew/bin/python3", "/usr/local/bin/python3",
      "/Library/Frameworks/Python.framework/Versions/Current/bin/python3", "/usr/bin/python3"]),
    deno: await firstExe(["/opt/homebrew/bin/deno", "/usr/local/bin/deno"]),
    node: await firstExe(["/opt/homebrew/bin/node", "/usr/local/bin/node"])
  };
}

function headerString() {
  var h = ""; try { h = mpv.getString("http-header-fields") || ""; } catch (e) {}
  return h.split(",").map(function (x) { return x.trim(); }).filter(Boolean).join("\r\n");
}

async function probe(T, src, headers) {
  if (!T.ffprobe) return null;
  var a = ["-v", "error", "-print_format", "json", "-show_format", "-show_streams"];
  if (/^https?:/i.test(src)) a.push("-rw_timeout", "15000000");
  if (headers) a.push("-headers", headers + "\r\n");
  var r = await sh(T.ffprobe, a.concat([src]));
  if (r.status !== 0) { log.log("ffprobe failed: " + tail(r.stderr)); return null; }
  try {
    var j = JSON.parse(r.stdout), v = null, aud = [];
    (j.streams || []).forEach(function (s) {
      if (s.codec_type === "video" && !v && !(s.disposition && s.disposition.attached_pic)) v = s;
      if (s.codec_type === "audio") aud.push(s);
    });
    return { format: (j.format && j.format.format_name) || "", v: v, audio: aud };
  } catch (e) { return null; }
}

// Can the TV (AVFoundation) play this as is?
function tvNative(p, headers) {
  if (headers || !p || !p.v) return false;
  var cont = /(^|,)(mov|mp4|m4a|hls|applehttp)(,|$)/.test(p.format);
  var v = p.v.codec_name, pf = p.v.pix_fmt || "";
  var vok = (v === "h264" && /yuv420p$/.test(pf) && pf.indexOf("10") < 0) || v === "hevc";
  var aok = !p.audio.length || /^(aac|ac3|eac3|mp3|alac)$/.test(p.audio[0].codec_name);
  return cont && vok && aok;
}

// ---- yt-dlp (page URLs such as YouTube) ----

async function ytdlpUrl(T, src) {
  if (!T.ytdlp) return null;
  var base = ["-g", "--no-playlist", "--no-warnings", "-f", "b[protocol^=m3u8]/b[ext=mp4][vcodec^=avc1]/b[ext=mp4]/b"];
  var yt = ["--extractor-args", "youtube:player_client=web_embedded,android,tv_simply"];
  // empty PATH => yt-dlp can't find its JS runtime for YouTube and drops to 360p
  var js = T.deno ? ["--js-runtimes", "deno:" + T.deno] : T.node ? ["--js-runtimes", "node:" + T.node] : [];
  var tries = [base.concat(js, yt, [src]), base.concat(yt, [src]), base.concat([src])];
  for (var i = 0; i < tries.length; i++) {
    var r = await sh(T.ytdlp, tries[i]);
    var u = r.status === 0 ? r.stdout.trim().split("\n")[0] : "";
    if (u) return u;
  }
  return null;
}

// ---- LAN address ----

async function lanIP() {
  var ifs = ["en0", "en1", "en2", "en3", "en4"];
  for (var i = 0; i < ifs.length; i++) {
    var r = await sh("/usr/sbin/ipconfig", ["getifaddr", ifs[i]]);
    var ip = r.stdout.trim();
    if (r.status === 0 && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip;
  }
  return null;
}

// ---- the HLS pipeline ----

function ffmpegArgs(src, p, headers, startAt) {
  var a = ["-hide_banner", "-loglevel", "warning", "-nostdin"];
  if (headers) a.push("-headers", headers + "\r\n");
  a.push("-re");
  if (startAt > 1) a.push("-ss", String(startAt));
  a.push("-i", src, "-map", "0:v:0");
  var aid = 0; try { aid = Math.max(0, (mpv.getNumber("aid") || 1) - 1); } catch (e) {}
  if (aid >= p.audio.length) aid = 0;
  var ac = p.audio.length ? p.audio[aid].codec_name : "";
  if (p.audio.length) a.push("-map", "0:a:" + aid);
  var v = p.v.codec_name, pf = p.v.pix_fmt || "";
  var vcopy = (v === "h264" && /yuv420p$/.test(pf) && pf.indexOf("10") < 0) || v === "hevc";
  if (vcopy) a.push("-c:v", "copy"); else a.push("-c:v", "h264_videotoolbox", "-b:v", "8M", "-pix_fmt", "yuv420p");
  if (v === "hevc") a.push("-tag:v", "hvc1");
  if (p.audio.length) {
    if (/^(aac|ac3|eac3)$/.test(ac)) a.push("-c:a", "copy"); else a.push("-c:a", "aac", "-b:a", "192k", "-ac", "2");
  }
  a.push("-sn", "-dn", "-f", "hls", "-hls_time", "4", "-hls_list_size", "0", "-hls_playlist_type", "event",
    "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4",
    "-hls_segment_filename", HLS + "/seg%05d.m4s", HLS + "/index.m3u8");
  return { args: a, desc: (vcopy ? "video copy" : "video → H.264") + ", " + (!p.audio.length ? "no audio" : /^(aac|ac3|eac3)$/.test(ac) ? "audio copy" : "audio " + ac + " → AAC") };
}

async function startPipeline(T, src, p, headers, startAt, me) {
  if (!T.ffmpeg || !T.python) throw new Error("This stream needs ffmpeg and python3 (brew install ffmpeg python).");
  var ip = await lanIP();
  if (!ip) throw new Error("Could not find this Mac's Wi-Fi/LAN address.");
  await stopAll();
  await sh("/bin/mkdir", ["-p", HLS]);
  var f = ffmpegArgs(src, p, headers, startAt);
  ffState = { running: true, tail: "" };
  spawn(FFPID, T.ffmpeg, f.args, function (r) { ffState.running = false; ffState.tail = tail(r.stderr); log.log("ffmpeg exited: " + r.status + " " + ffState.tail); });
  spawn(SRVPID, T.python, [DATA_SERVE(), HLS, PORTFILE, FFPID]);
  for (var i = 0; i < 120; i++) { // up to ~84 s
    if (me !== gen) return null;
    if (!ffState.running && !(await test("-e", HLS + "/index.m3u8"))) throw new Error("ffmpeg stopped: " + (ffState.tail || "could not open the stream"));
    if ((await test("-e", HLS + "/index.m3u8")) && (await test("-e", PORTFILE))) {
      var pl = await cat(HLS + "/index.m3u8"), port = (await cat(PORTFILE)).trim();
      if (/#EXTINF/.test(pl) && /^\d+$/.test(port)) return { url: "http://" + ip + ":" + port + "/index.m3u8", desc: f.desc };
    }
    await sleep(0.7);
  }
  throw new Error("Timed out preparing the stream.");
}

var SERVE = null;
function DATA_SERVE() { return SERVE; }

async function findPluginFile(name) {
  var i = DATA.lastIndexOf("/.data/"), c = [];
  try { c.push(clean(utils.resolvePath("@plugin/")) + "/" + name); } catch (e) {}
  if (i > -1) { var pd = DATA.slice(0, i); c.push(pd + "/" + ID + ".iinaplugin/" + name, pd + "/" + ID + ".iinaplugin-dev/" + name); }
  return await firstExeOrFile(c);
}
async function firstExeOrFile(list) { for (var i = 0; i < list.length; i++) if (await test("-e", list[i])) return list[i]; return null; }

// ---- main entry: decide what to hand to the TV ----

async function prepare() {
  var me = ++gen;
  try {
    var src = mpv.getString("path") || "";
    st.title = mpv.getString("media-title") || "";
    st.pos = mpv.getNumber("time-pos") || 0;
    st.url = ""; st.info = ""; st.offset = 0;
    if (!src) return set("idle", "Play something in IINA.");
    set("resolving", "Analyzing stream...");
    var T = await tools(), net = /^https?:\/\//i.test(src), headers = net ? headerString() : "";
    var p = await probe(T, src, headers);
    if (me !== gen) return;
    if (!p && net) { // maybe a web page (YouTube, ...)
      var u = await ytdlpUrl(T, src);
      if (me !== gen) return;
      if (u) { src = u; headers = ""; p = await probe(T, src, headers); }
    }
    if (me !== gen) return;
    if (!p) {
      if (net && !T.ffprobe) { st.url = src; st.info = "direct (ffprobe not found)"; return set("ready", "Ready (not analyzed). Press AirPlay."); }
      return set("error", "Could not read this stream" + (T.ffprobe ? "." : " (install ffmpeg: brew install ffmpeg)."));
    }
    if (!p.v) return set("error", "No video track found.");
    if (net && tvNative(p, headers)) {
      st.url = src; st.info = "Direct: the TV fetches the stream itself.";
      return set("ready", "Ready. Press AirPlay and choose your TV.");
    }
    SERVE = await findPluginFile("serve.py");
    if (!SERVE) throw new Error("serve.py not found in the plugin folder.");
    set("resolving", "Preparing stream for the TV (remuxing via this Mac)...");
    var startAt = st.pos;
    var res = await startPipeline(T, src, p, headers, startAt, me);
    if (!res || me !== gen) return;
    st.url = res.url; st.offset = startAt; st.pos = 0; st.info = "Via this Mac (" + res.desc + ").";
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
    lastTvPos = (Number(d.t) || 0) + (st.offset || 0);
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
event.on("iina.window-will-close", function () { stopAll(); });
event.on("iina.file-loaded", function () { tvActive = false; prepare(); });
log.log("AirStream loaded");
stopAll().then(function () { prepare(); });
