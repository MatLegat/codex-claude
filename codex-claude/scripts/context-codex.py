"""Show context usage of a Codex thread.

Usage: context-codex.py [thread-id] [--session <claude-session-id>] [--json]
Without an id, uses the thread the Codex plugin last used for the current repo,
or the newest Codex session if the plugin has none for this repo.
With --session, only threads started from that Claude Code session count, and
there is no fallback: a session that has not used Codex yet has no thread.
"""
import glob
import json
import os
import subprocess
import sys

HOME = os.path.expanduser("~")


def repo_root():
    try:
        out = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True, check=True)
        return out.stdout.strip()
    except Exception:
        return os.getcwd()


def plugin_thread(root, session=None):
    latest = None
    for path in glob.glob(f"{HOME}/.claude/plugins/data/codex-openai-codex/state/*/state.json"):
        try:
            jobs = json.load(open(path)).get("jobs", [])
        except Exception:
            continue
        for job in jobs:
            if job.get("threadId") and job.get("workspaceRoot") == root and (session is None or job.get("sessionId") == session):
                if latest is None or job.get("createdAt", "") > latest.get("createdAt", ""):
                    latest = job
    return latest.get("threadId") if latest else None


def session_running(session):
    """True while a Codex plugin job started from this Claude session is queued or running."""
    if not session:
        return False
    for path in glob.glob(f"{HOME}/.claude/plugins/data/codex-openai-codex/state/*/state.json"):
        try:
            jobs = json.load(open(path)).get("jobs", [])
        except Exception:
            continue
        if any(j.get("sessionId") == session and j.get("status") in ("queued", "running") for j in jobs):
            return True
    return False


def session_file(thread_id, session=None):
    if thread_id:
        matches = glob.glob(f"{HOME}/.codex/sessions/*/*/*/*{thread_id}.jsonl")
        if not matches:
            raise SystemExit(f"No Codex session found for thread {thread_id}.")
        return matches[0], "given thread"
    root = repo_root()
    tid = plugin_thread(root, session)
    if session and not tid:
        raise SystemExit("No Codex thread in this Claude session yet.")
    if tid:
        matches = glob.glob(f"{HOME}/.codex/sessions/*/*/*/*{tid}.jsonl")
        if matches:
            return matches[0], f"last plugin thread for {os.path.basename(root)}"
    files = glob.glob(f"{HOME}/.codex/sessions/*/*/*/*.jsonl")
    if not files:
        raise SystemExit("No Codex sessions found in ~/.codex/sessions.")
    return max(files, key=os.path.getmtime), "newest Codex session"


args = [a for a in sys.argv[1:] if a.strip()]
as_json = "--json" in args
args = [a for a in args if a != "--json"]
session = None
if "--session" in args:
    i = args.index("--session")
    session = args[i + 1] if i + 1 < len(args) else None
    del args[i:i + 2]
if as_json:
    try:
        path, source = session_file(args[0] if args else None, session)
    except SystemExit as err:
        print(json.dumps({"error": str(err), "running": session_running(session)}))
        raise SystemExit(0)
else:
    path, source = session_file(args[0] if args else None, session)
info = model = effort = thread = None
with open(path) as f:
    for line in f:
        if '"type":"token_count"' in line:
            payload_info = json.loads(line)["payload"].get("info")
            if payload_info:
                info = payload_info
        elif '"type":"turn_context"' in line:
            payload = json.loads(line)["payload"]
            model, effort = payload.get("model"), payload.get("effort")
        elif thread is None and '"type":"session_meta"' in line:
            thread = json.loads(line)["payload"].get("id")

if not info:
    if as_json:
        print(json.dumps({"error": "no token usage recorded yet", "running": session_running(session)}))
        raise SystemExit(0)
    raise SystemExit(f"No token usage recorded yet in {os.path.basename(path)}.")

window = info.get("model_context_window") or 0
used = info["last_token_usage"]["total_tokens"]
total = info["total_token_usage"]
pct = used / window * 100 if window else 0

if as_json:
    print(json.dumps({
        "thread": thread, "source": source, "model": model, "effort": effort,
        "tokens": used, "window": window, "percent": round(pct),
        "updatedAt": int(os.path.getmtime(path) * 1000),
        "running": session_running(session),
    }))
    raise SystemExit(0)

print(f"Thread  {thread} ({source})")
print(f"Model   {model}, effort {effort}")
print(f"Context {used:,} / {window:,} tokens ({pct:.0f}% used, {max(window - used, 0):,} left)")
print(f"Thread total: {total['total_tokens']:,} tokens processed "
      f"({total.get('cached_input_tokens', 0):,} cached input, {total['output_tokens']:,} output)")
