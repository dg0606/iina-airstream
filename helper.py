#!/usr/bin/env python3
"""AirPlay helper: scan | play <device-id> <url> [position-seconds] [pidfile]"""
import asyncio, json, os, signal, sys
import pyatv
from pyatv.const import Protocol

def out(**kw):
    print(json.dumps(kw), flush=True)

async def scan(loop):
    res = await pyatv.scan(loop, timeout=5, protocol={Protocol.AirPlay})
    out(event="devices", devices=[
        {"id": d.identifier, "name": d.name, "address": str(d.address),
         "model": str(d.device_info.model.name)} for d in res])

async def play(loop, dev_id, url, pos, pidfile):
    if pidfile:
        open(pidfile, "w").write(str(os.getpid()))
    res = await pyatv.scan(loop, identifier=dev_id, timeout=5)
    if not res:
        return out(event="error", msg="device not found")
    atv = await pyatv.connect(res[0], loop)
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
        atv.close()
        if pidfile and os.path.exists(pidfile):
            os.remove(pidfile)
        out(event="stopped")

def main():
    cmd, loop = sys.argv[1], asyncio.new_event_loop()
    if cmd == "scan":
        loop.run_until_complete(scan(loop))
    elif cmd == "play":
        a = sys.argv
        loop.run_until_complete(play(loop, a[2], a[3], float(a[4]) if len(a) > 4 else 0,
                                     a[5] if len(a) > 5 else None))

main()
