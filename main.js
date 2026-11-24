// AirStream — cast the current network stream to an AirPlay device without
// downloading it. IINA runs this in JavaScriptCore; utils.exec wipes the
// environment (no HOME, no PATH), so every binary is called by absolute path.
// NOTE: `var` + iina.X on purpose: `const { console } = iina` collides with the
// engine's global console and kills the whole script (no menu, blank sidebar).

var core = iina.core, mpv = iina.mpv, menu = iina.menu, sidebar = iina.sidebar,
    utils = iina.utils, file = iina.file, event = iina.event,
    preferences = iina.preferences, log = iina.console;

function clean(p) { return String(p || "").replace(/\/+$/, ""); }

var DATA = clean(utils.resolvePath("@data/"));
var ID = "io.github.dg0606.iina-airstream";
// Where this plugin's files live: try @plugin/, then derive from @data
// (<plugins>/.data/<id>) and check helper.py is really there.
function findRoot() {
  var c = [];
  try { c.push(clean(utils.resolvePath("@plugin/"))); } catch (e) {}
  var i = DATA.lastIndexOf("/.data/");
  if (i > -1) {
    var pd = DATA.slice(0, i);
    c.push(pd + "/" + ID + ".iinaplugin", pd + "/" + ID + ".iinaplugin-dev", pd + "/airstream.iinaplugin-dev");
  }
  for (var k = 0; k < c.length; k++) if (c[k] && exists(c[k] + "/helper.py")) return c[k];
  return c[0] || "";
}
var ROOT = null, HELPER = null;
var VENV = DATA + "/venv";
var PY = VENV + "/bin/python3";
var PIDFILE = DATA + "/cast.pid";
var PINFILE = DATA + "/pair.pin";
var CREDFILE = DATA + "/credentials.json";
var pairingDev = null;
var DIRECT = /\.(m3u8|mp4|mkv|webm|mov|mp3|flac|aac|m4a)(\?|$)/i;

var devices = [];
var status = "idle";   // idle | setup | scanning | resolving | casting | pairing | error
var message = "";
var sidebarReady = false;
var setupPromise = null;

function note(st, m) {
  status = st; message = m || "";
  if (m) { try { core.osd("AirStream: " + m); } catch (e) {} log.log("[state] " + st + ": " + m); }
}

function exists(p) { try { return !!file.exists(p); } catch (e) { return false; } }
ROOT = findRoot(); HELPER = ROOT + "/helper.py";
if (!exists(HELPER)) log.log("WARNING helper.py not found under " + ROOT);

function parseLines(s) {
  return String(s || "").split("\n").filter(Boolean).map(function (l) {
    try { return JSON.parse(l); } catch (e) { return null; }
  }).filter(Boolean);
}

function tail(s) {
  var l = String(s || "").trim().split("\n").filter(Boolean);
  return l.length ? l[l.length - 1] : "";
}

// ---- python / venv bootstrap (once; cached in @data) ----

async function pickPython() {
  var cands = ["/opt/homebrew/bin/python3", "/usr/local/bin/python3",
    "/Library/Frameworks/Python.framework/Versions/Current/bin/python3",
    "/usr/bin/python3"];
  for (var i = 0; i < cands.length; i++) {
    if (!exists(cands[i])) continue;
    try {
      var r = await utils.exec(cands[i], ["-c", "import sys;print(int(sys.version_info>=(3,9)))"]);
      if (r.status === 0 && r.stdout.trim() === "1") return cands[i];
    } catch (e) {}
  }
  return null;
}

async function pyatvOk() {
  if (!exists(PY)) return false;
  // srptools>=2 breaks pyatv 0.18 pairing (keyword-only arg), so require 1.x
  var chk = "import pyatv,srptools;from importlib.metadata import version as v;import sys;sys.exit(0 if int(v('srptools').split('.')[0])<2 else 1)";
  try { return (await utils.exec(PY, ["-c", chk])).status === 0; } catch (e) { return false; }
}

function ensureVenv() {
  if (!setupPromise) {
    setupPromise = (async function () {
      if (await pyatvOk()) return;
      note("setup", "first run: installing pyatv (about 1 minute)...");
      var sys = await pickPython();
      if (!sys) throw new Error("Python 3.9+ not found. Install it: brew install python");
      var r = await utils.exec(sys, ["-m", "venv", "--clear", VENV]);
      if (r.status !== 0) throw new Error("venv failed: " + tail(r.stderr));
      r = await utils.exec(PY, ["-m", "pip", "install", "--disable-pip-version-check", "-q", "pyatv", "srptools<2"]);
      if (r.status !== 0) throw new Error("pip install failed: " + tail(r.stderr));
      if (!(await pyatvOk())) throw new Error("pyatv installed but cannot be imported");
      note("idle", "setup done");
    })();
    setupPromise.catch(function () { setupPromise = null; }); // allow retry
  }
  return setupPromise;
}

// ---- stream URL resolution ----

async function findYtdlp() {
  var pref = "";
  try { pref = preferences.get("ytdlp") || ""; } catch (e) {}
  var cands = [pref, "/opt/homebrew/bin/yt-dlp", "/usr/local/bin/yt-dlp",
    "/Applications/IINA.app/Contents/MacOS/youtube-dl"];
  for (var i = 0; i < cands.length; i++) if (cands[i] && exists(cands[i])) return cands[i];
  return null;
}

async function resolveUrl(src) {
  if (!/^https?:\/\//i.test(src || ""))
    throw new Error("only network streams (URLs) can be cast, not local files");
  if (DIRECT.test(src)) return src;
  var bin = await findYtdlp();
  if (!bin) { log.log("yt-dlp not found; using the URL as is"); return src; }
  // AirPlay takes ONE url, so we need a muxed (audio+video) format. YouTube only
  // offers those (360p mp4) through the mweb/android_vr clients; other sites
  // ignore that option, so try it first and fall back to the default client.
  var fmt = "b[protocol^=m3u8]/b[ext=mp4][vcodec^=avc1]/b[ext=mp4]/b";
  var base = ["-g", "--no-playlist", "--no-warnings", "-f", fmt];
  var attempts = [base.concat(["--extractor-args", "youtube:player_client=mweb,android_vr", src]),
                  base.concat([src])];
  var url = "", last = "";
  for (var i = 0; i < attempts.length && !url; i++) {
    var r = await utils.exec(bin, attempts[i]);
    url = r.status === 0 ? r.stdout.trim().split("\n")[0] : "";
    if (!url) last = tail(r.stderr);
  }
  if (!url) {
    log.log("yt-dlp failed: " + last + " — using the URL as is");
    return src;
  }
  return url;
}

// ---- actions ----

async function scan() {
  try {
    await ensureVenv();
    note("scanning", "searching devices...");
    var r = await utils.exec(PY, [HELPER, "scan"]);
    var ev = parseLines(r.stdout).filter(function (e) { return e.event === "devices"; })[0];
    if (!ev) throw new Error(tail(r.stderr) || "scan failed");
    devices = ev.devices;
    note("idle", devices.length ? "found: " + devices.map(function (d) { return d.name; }).join(", ")
                                : "no devices found");
    refreshMenu();
  } catch (e) {
    note("error", e.message);
  }
}

async function stop() {
  try {
    if (exists(PIDFILE)) {
      var pid = String(file.read(PIDFILE) || "").trim();
      if (/^\d+$/.test(pid)) await utils.exec("/bin/kill", [pid]);
    }
  } catch (e) { log.log("stop: " + e); }
}

async function cast(dev) {
  try {
    await ensureVenv();
    note("resolving", "resolving stream...");
    var url = await resolveUrl(mpv.getString("path"));
    var pos = mpv.getNumber("time-pos") || 0;
    await stop();
    mpv.set("pause", true);
    note("casting", "casting to " + dev.name);
    var r = await utils.exec(PY, [HELPER, "play", dev.id, url, String(pos), PIDFILE, CREDFILE]);
    var err = parseLines(r.stdout).filter(function (e) { return e.event === "error"; })[0];
    if (err && /not authenticated/i.test(err.msg)) {
      mpv.set("pause", false);
      note("error", "this TV needs pairing (one time)...");
      return pairDevice(dev);
    }
    if (err) { mpv.set("pause", false); note("error", err.msg); }
    else if (r.status !== 0) note("error", tail(r.stderr) || "helper exited with " + r.status);
    else note("idle", "stopped");
  } catch (e) {
    note("error", e.message);
  }
}

async function pairDevice(dev) {
  if (status === "pairing") return;
  try {
    await ensureVenv();
    pairingDev = dev;
    note("pairing", "look at the TV: enter the PIN it shows in the box below");
    var r = await utils.exec(PY, [HELPER, "pair", dev.id, PINFILE, CREDFILE]);
    var evs = parseLines(r.stdout);
    var err = evs.filter(function (e) { return e.event === "error"; })[0];
    if (err) note("error", err.msg);
    else if (evs.some(function (e) { return e.event === "paired"; })) {
      note("idle", "paired with " + dev.name + ". Now press Cast again.");
    } else note("error", tail(r.stderr) || "pairing failed");
  } catch (e) {
    note("error", e.message);
  } finally {
    pairingDev = null;
  }
}

function submitPin(pin) {
  pin = String(pin || "").replace(/\D/g, "");
  if (status !== "pairing" || !pin) return;
  try { file.write(PINFILE, pin); note("pairing", "checking PIN..."); status = "pairing"; }
  catch (e) { note("error", "cannot write PIN: " + e.message); }
}

async function stopCast() { await stop(); note("idle", "stopped"); }

// ---- menu ----

var root = menu.item("AirStream");
var added = {};
root.addSubMenuItem(menu.item("Search devices", function () { scan(); }));
root.addSubMenuItem(menu.item("Stop casting", function () { stopCast(); }));
root.addSubMenuItem(menu.separator());
menu.addItem(root);

function refreshMenu() {
  devices.forEach(function (d) {
    if (added[d.id]) return;
    added[d.id] = true;
    root.addSubMenuItem(menu.item("Cast to " + d.name, function () { cast(d); }));
    root.addSubMenuItem(menu.item("Pair with " + d.name + " (PIN in sidebar)", function () { pairDevice(d); }));
  });
  try { if (menu.forceUpdate) menu.forceUpdate(); } catch (e) {}
}

// ---- sidebar (page polls "getState"; sidebar.* only from main-thread handlers) ----

function loadSidebar() {
  try { sidebar.loadFile("sidebar.html"); } catch (e) { return; } // no window yet
  sidebar.onMessage("getState", function () {
    sidebar.postMessage("state", { devices: devices, status: status, msg: message });
  });
  sidebar.onMessage("scan", function () { scan(); });
  sidebar.onMessage("stop", function () { stopCast(); });
  sidebar.onMessage("pin", function (d) { submitPin(d && d.pin); });
  sidebar.onMessage("cast", function (d) {
    var dev = devices.filter(function (x) { return x.id === (d && d.id); })[0];
    if (dev) cast(dev);
  });
  sidebarReady = true;
}

loadSidebar();
event.on("iina.window-loaded", loadSidebar);
log.log("AirStream loaded; data=" + DATA + " plugin=" + ROOT);
scan();
