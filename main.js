const { core, mpv, menu, utils, preferences, console, file } = iina;

const DIR = utils.resolvePath("@data/");
const ROOT = utils.resolvePath("@plugin/");
const VENV = DIR + "/venv";
const PY = VENV + "/bin/python3";
const HELPER = ROOT + "/helper.py";
const PIDFILE = "/tmp/iina-airplay-stream.pid";
const DIRECT = /\.(m3u8|mp4|mkv|webm|mov|mp3|flac)(\?|$)/i;

let devices = [];
let casting = false;

const osd = (m) => core.osd("AirPlay: " + m);
const json = (s) => s.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);

async function resolveUrl(src) {
  if (!/^https?:\/\//i.test(src)) throw new Error("not a network stream (local files are not supported)");
  if (DIRECT.test(src)) return src;
  const r = await utils.exec(preferences.get("ytdlp"),
    ["-g", "-f", "b[protocol^=m3u8]/b[ext=mp4]/b", "--no-playlist", src]);
  const url = r.stdout.trim().split("\n")[0];
  if (r.status !== 0 || !url) { console.log("yt-dlp failed: " + r.stderr); return src; }
  return url;
}

// First run: create a private venv in the plugin data folder and install pyatv.
async function ensureVenv() {
  if (file.exists(PY)) return;
  const sys = ["/opt/homebrew/bin/python3", "/usr/local/bin/python3",
    "/Library/Frameworks/Python.framework/Versions/Current/bin/python3", "/usr/bin/python3"]
    .find((p) => file.exists(p));
  if (!sys) throw new Error("python3 not found; install it (brew install python)");
  osd("first run: installing pyatv (1 min)...");
  let r = await utils.exec(sys, ["-m", "venv", VENV]);
  if (r.status !== 0) throw new Error("venv failed: " + r.stderr);
  r = await utils.exec(PY, ["-m", "pip", "install", "-q", "pyatv"]);
  if (r.status !== 0) throw new Error("pip failed: " + r.stderr.split("\n").slice(-2)[0]);
}

async function scan() {
  try { await ensureVenv(); } catch (e) { return osd(e.message); }
  osd("searching devices...");
  const r = await utils.exec(PY, [HELPER, "scan"]);
  const ev = json(r.stdout).find((e) => e.event === "devices");
  devices = ev ? ev.devices : [];
  osd(devices.length ? devices.map((d) => d.name).join(", ") : "no devices found");
  buildMenu();
}

async function stop() {
  await utils.exec("/bin/sh", ["-c", `[ -f ${PIDFILE} ] && kill $(cat ${PIDFILE})`]);
  casting = false;
}

async function cast(dev) {
  try {
    await ensureVenv();
    const src = mpv.getString("path");
    osd("resolving stream...");
    const url = await resolveUrl(src);
    const pos = mpv.getNumber("time-pos") || 0;
    await stop();
    mpv.set("pause", true);
    osd("casting to " + dev.name);
    casting = true;
    const r = await utils.exec(PY, [HELPER, "play", dev.id, url, String(pos), PIDFILE]);
    const err = json(r.stdout).find((e) => e.event === "error");
    if (err) osd("error: " + err.msg);
    else if (r.status !== 0) osd("error: " + r.stderr.split("\n").slice(-2)[0]);
  } catch (e) {
    osd("error: " + e.message);
  } finally {
    casting = false;
  }
}

const root = menu.item("AirPlay Stream");
const added = new Set();
function buildMenu() {
  devices.forEach((d) => {
    if (added.has(d.id)) return;
    added.add(d.id);
    root.addSubMenuItem(menu.item("Cast to " + d.name, () => cast(d)));
  });
  menu.forceUpdate();
}

root.addSubMenuItem(menu.item("Search devices", scan));
root.addSubMenuItem(menu.item("Stop casting", async () => { await stop(); osd("stopped"); }));
root.addSubMenuItem(menu.separator());
menu.addItem(root);
scan();
