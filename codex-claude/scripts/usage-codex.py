"""Print Codex usage limits.

Asks the Codex app-server for live numbers (read-only `account/rateLimits/read`).
Falls back to the newest Codex session log if that fails.
"""
import datetime
import glob
import json
import os
import subprocess
import sys
import threading


def fmt(ts):
    return datetime.datetime.fromtimestamp(ts).strftime("%a %d %b %H:%M")


def read_live(timeout=20):
    proc = subprocess.Popen(
        ["codex", "app-server"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        text=True, bufsize=1,
    )
    timer = threading.Timer(timeout, proc.kill)
    timer.start()
    try:
        for msg in (
            {"jsonrpc": "2.0", "id": 1, "method": "initialize",
             "params": {"clientInfo": {"name": "usage-codex", "version": "1.0"}}},
            {"jsonrpc": "2.0", "method": "initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "account/rateLimits/read", "params": None},
        ):
            proc.stdin.write(json.dumps(msg) + "\n")
        proc.stdin.flush()
        for line in proc.stdout:
            msg = json.loads(line)
            if msg.get("id") == 2:
                return msg.get("result")
    finally:
        timer.cancel()
        proc.kill()
    return None


def from_live(result):
    limits = result["rateLimits"]
    rows = [
        (name, limits[key]["usedPercent"], limits[key]["resetsAt"])
        for name, key in (("5h", "primary"), ("Weekly", "secondary"))
        if limits.get(key)
    ]
    credits = limits.get("credits") or {}
    return rows, limits.get("planType"), credits, "live"


def from_log():
    files = glob.glob(os.path.expanduser("~/.codex/sessions/*/*/*/*.jsonl"))
    if not files:
        raise SystemExit("No live data and no Codex sessions in ~/.codex/sessions.")
    latest = max(files, key=os.path.getmtime)
    limits = None
    with open(latest) as f:
        for line in f:
            if '"rate_limits":{' in line:
                limits = json.loads(line)["payload"]["rate_limits"]
    if limits is None:
        raise SystemExit("No usage data available. Run Codex once and try again.")
    rows = [
        (name, limits[key]["used_percent"], limits[key]["resets_at"])
        for name, key in (("5h", "primary"), ("Weekly", "secondary"))
        if limits.get(key)
    ]
    raw = limits.get("credits") or {}
    credits = {"hasCredits": raw.get("has_credits"), "balance": raw.get("balance")}
    return rows, None, credits, f"from last Codex run, {fmt(os.path.getmtime(latest))}"


try:
    result = read_live()
    data = from_live(result) if result else from_log()
except Exception:
    data = from_log()

rows, plan, credits, source = data

if "--json" in sys.argv[1:]:
    print(json.dumps({
        "windows": [{"name": n, "percent": round(u), "resetsAt": int(r * 1000)} for n, u, r in rows],
        "plan": plan,
        "isLive": source == "live",
    }))
    raise SystemExit(0)

for name, used, resets_at in rows:
    print(f"{name:<7} {used:.0f}% used, resets {fmt(resets_at)}")
if credits.get("hasCredits"):
    print(f"Credits {credits.get('balance')}")
print(f"Plan: {plan}, {source}" if plan else source)
