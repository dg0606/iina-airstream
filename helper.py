#!/usr/bin/env python3
"""AirPlay helper:
  scan
  pair <device-id> <pinfile> <credfile>
  play <device-id> <url> [position-seconds] [pidfile] [credfile]"""
import asyncio, json, os, signal, sys, time
import pyatv
from pyatv.const import Protocol

def out(**kw):
    print(json.dumps(kw), flush=True)

async def scan(loop):
    res = await pyatv.scan(loop, timeout=5, protocol={Protocol.AirPlay})
    out(event="devices", devices=[
        {"id": d.identifier, "name": d.name, "address": str(d.address),
         "model": str(d.device_info.model.name)} for d in res])

def load_creds(credfile):
    try:
        return json.load(open(credfile))
    except Exception:
        return {}

async def pair(loop, dev_id, pinfile, credfile):
    res = await pyatv.scan(loop, identifier=dev_id, timeout=5)
    if not res:
        return out(event="error", msg="device not found")
    if os.path.exists(pinfile):
        os.remove(pinfile)
    p = await pyatv.pair(res[0], Protocol.AirPlay, loop)
    try:
        await p.begin()
        out(event="pin", msg="enter the PIN shown on the TV")
        deadline = time.time() + 180
        while time.time() < deadline and not os.path.exists(pinfile):
            await asyncio.sleep(0.5)
        if not os.path.exists(pinfile):
            return out(event="error", msg="pairing timed out (no PIN entered)")
        p.pin(open(pinfile).read().strip())
        os.remove(pinfile)
        await p.finish()
        if not p.has_paired:
            return out(event="error", msg="pairing failed (wrong PIN?)")
        creds = load_creds(credfile)
        creds[dev_id] = p.service.credentials
        with open(credfile, "w") as f:
            json.dump(creds, f)
        os.chmod(credfile, 0o600)
        out(event="paired")
    finally:
        await p.close()

async def play(loop, dev_id, url, pos, pidfile, credfile=None):
    if pidfile:
        open(pidfile, "w").write(str(os.getpid()))
    res = await pyatv.scan(loop, identifier=dev_id, timeout=5)
    if not res:
        return out(event="error", msg="device not found")
    cred = load_creds(credfile).get(dev_id) if credfile else None
    if cred:
        res[0].set_credentials(Protocol.AirPlay, cred)
    try:
        atv = await pyatv.connect(res[0], loop)
    except Exception as e:
        return out(event="error", msg="cannot connect: %s: %s" % (type(e).__name__, e))
    stop = asyncio.Event()
    loop.add_signal_handler(signal.SIGTERM, stop.set)
    loop.add_signal_handler(signal.SIGINT, stop.set)
    try:
        out(event="starting")
        task = asyncio.ensure_future(atv.stream.play_url(url, position=pos))
        waiter = asyncio.ensure_future(stop.wait())
        out(event="playing")
        done, _ = await asyncio.wait({task, waiter}, return_when=asyncio.FIRST_COMPLETED)
        if task in done and task.exception():
            out(event="error", msg=str(task.exception()))
        for t in (task, waiter):
            t.cancel()
        try:
            await atv.remote_control.stop()
        except Exception:
            pass
    finally:
        await asyncio.gather(*atv.close(), return_exceptions=True)
        if pidfile and os.path.exists(pidfile):
            os.remove(pidfile)
        out(event="stopped")

def main():
    if len(sys.argv) < 2:
        return out(event="error", msg="usage: helper.py scan | play <id> <url> [pos] [pidfile]")
    cmd, loop = sys.argv[1], asyncio.new_event_loop()
    try:
        if cmd == "scan":
            loop.run_until_complete(scan(loop))
        elif cmd == "play":
            a = sys.argv
            if len(a) < 4:
                return out(event="error", msg="play needs <id> <url>")
            loop.run_until_complete(play(loop, a[2], a[3], float(a[4]) if len(a) > 4 else 0,
                                         a[5] if len(a) > 5 else None,
                                         a[6] if len(a) > 6 else None))
        elif cmd == "pair":
            a = sys.argv
            if len(a) < 5:
                return out(event="error", msg="pair needs <id> <pinfile> <credfile>")
            loop.run_until_complete(pair(loop, a[2], a[3], a[4]))
        else:
            out(event="error", msg="unknown command " + cmd)
    except Exception as e:
        out(event="error", msg="%s: %s" % (type(e).__name__, e))
        sys.exit(1)

main()
