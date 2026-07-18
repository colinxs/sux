#!/usr/bin/env python3
# Standalone Mac-local iMessage service: chat.db read (threads/messages) +
# AppleScript send. Deliberately its OWN process, not bolted onto mac-render
# (#742 removed mac-render entirely in favor of cf-residential render — this
# spoke never depended on it) — re-scoped 2026-07-17 (#264) to keep the
# smallest possible surface for the Full-Disk-Access-and-Automation-holding
# binary. Same Funnel + HMAC-signed-POST transport mac-render's now-removed
# render_server.py used — the request-verification code below deliberately
# mirrors its h_render, a proven pattern, not reinvented.
#
# Three actions, one POST-per-action shape (POST /imessage/<threads|messages|send>)
# rather than domains.md §2's originally-specced GET-routed REST — reusing the
# exact signed-POST verification h_render already validates was judged safer
# under a single build session than adding a second (GET query-string) HMAC
# scheme untested end-to-end (no physical Mac available to verify here; see #264).
import os, json, hmac, hashlib, sqlite3, subprocess, time
from aiohttp import web

SECRET = os.environ.get("IMESSAGE_SECRET", "").encode()
PORT = int(os.environ.get("PORT", "8791"))
CHAT_DB = os.path.expanduser(os.environ.get("CHAT_DB_PATH", "~/Library/Messages/chat.db"))
# Second gate alongside the worker fn's allow_send:true — defense in depth for
# the one truly irrevocable action this service exposes (an iMessage can't be
# unsent). Both must be true for a send to reach AppleScript.
ALLOW_SEND = os.environ.get("IMESSAGE_ALLOW_SEND", "0") == "1"
# Same replay-window rationale as render_server.py's MAX_TS_SKEW_MS: a captured
# signed request stays HMAC-valid forever unless bounded by age too.
MAX_TS_SKEW_MS = 300_000

# Apple's Mach/Cocoa epoch (2001-01-01) vs. Unix epoch (1970-01-01), in seconds.
# message.date on modern macOS (10.13+) is nanoseconds since the Apple epoch.
APPLE_EPOCH_OFFSET_S = 978307200


def _verify(ts, sig, raw):
    if not sig or not ts:
        return False
    calc = hmac.new(SECRET, (ts + "\n").encode() + raw, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(calc, sig):
        return False
    try:
        age = abs(time.time() * 1000 - int(ts))
    except ValueError:
        return False
    return age <= MAX_TS_SKEW_MS


def _apple_ts_to_iso(ns_or_s):
    if not ns_or_s:
        return None
    # Pre-10.13 dbs store seconds; 10.13+ stores nanoseconds — nanosecond values
    # are ~18 digits, seconds-since-2001 are ~9. Disambiguate by magnitude.
    secs = ns_or_s / 1_000_000_000 if ns_or_s > 10**12 else ns_or_s
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(secs + APPLE_EPOCH_OFFSET_S))


def _decode_text(row):
    # `text` is populated for plain messages; richer messages (reactions, some
    # attachments-with-caption) only have `attributedBody`, a serialized
    # NSAttributedString (typedstream/NSKeyedArchiver blob). Full parsing of that
    # format is its own project (see imessage-exporter's approach) — out of scope
    # for this minimal server; fall back to a best-effort marker rather than
    # silently returning empty text so a caller can tell the difference.
    if row["text"]:
        return row["text"]
    if row["attributedBody"]:
        return "[unparsed rich message]"
    return ""


def _open_ro():
    # Read-only, immutable=0 (chat.db is actively written by Messages.app while
    # this reads it) — see render_server.py's analogous "don't force exclusive
    # mode" note for the same rationale applied to chat.db instead of a browser
    # profile dir.
    uri = f"file:{CHAT_DB}?mode=ro"
    conn = sqlite3.connect(uri, uri=True, timeout=5)
    conn.row_factory = sqlite3.Row
    return conn


def h_threads(body):
    since = body.get("since")
    contact = body.get("contact")
    conn = _open_ro()
    try:
        q = """
            SELECT c.ROWID as id, c.chat_identifier, c.display_name,
                   MAX(m.date) as last_date, COUNT(m.ROWID) as message_count
            FROM chat c
            JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
            JOIN message m ON m.ROWID = cmj.message_id
        """
        params = []
        where = []
        if contact:
            where.append("c.chat_identifier LIKE ?")
            params.append(f"%{contact}%")
        if where:
            q += " WHERE " + " AND ".join(where)
        q += " GROUP BY c.ROWID ORDER BY last_date DESC LIMIT 100"
        rows = conn.execute(q, params).fetchall()
        threads = []
        for r in rows:
            last_iso = _apple_ts_to_iso(r["last_date"])
            if since and last_iso and last_iso < since:
                continue
            threads.append({
                "id": r["id"],
                "contact": r["chat_identifier"],
                "name": r["display_name"] or None,
                "last_message_at": last_iso,
                "message_count": r["message_count"],
            })
        return {"threads": threads}
    finally:
        conn.close()


def h_messages(body):
    thread = body.get("thread")
    if not thread:
        return {"error": "missing_thread"}
    limit = min(int(body.get("limit") or 50), 500)
    conn = _open_ro()
    try:
        rows = conn.execute(
            """
            SELECT m.ROWID as id, m.text, m.attributedBody, m.date, m.is_from_me,
                   h.id as handle
            FROM message m
            JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
            LEFT JOIN handle h ON h.ROWID = m.handle_id
            WHERE cmj.chat_id = ?
            ORDER BY m.date DESC LIMIT ?
            """,
            (thread, limit),
        ).fetchall()
        messages = [
            {
                "id": r["id"],
                "from_me": bool(r["is_from_me"]),
                "handle": r["handle"],
                "text": _decode_text(r),
                "at": _apple_ts_to_iso(r["date"]),
            }
            for r in rows
        ]
        messages.reverse()
        return {"messages": messages}
    finally:
        conn.close()


def _as_literal(s):
    # AppleScript string literals only understand `\"` and `\\` as escapes —
    # there's no `\uXXXX` unicode-escape syntax, so json.dumps() (ensure_ascii)
    # would compile non-ASCII text (emoji, accented letters) into literal garbage
    # instead of escaping it. Escape only what AppleScript needs and pass the
    # actual UTF-8 text through untouched.
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def h_send(body):
    if not ALLOW_SEND:
        return {"error": "send disabled on this node (IMESSAGE_ALLOW_SEND!=1)"}
    to = body.get("to")
    text = body.get("text")
    if not to or not text:
        return {"error": "missing_to_or_text"}
    # Target the iMessage service explicitly (not generic buddy resolution,
    # which is the send path that broke post-Big Sur) — matches the AppleScript
    # pattern the issue's research settled on.
    script = f'''
    tell application "Messages"
        set targetService to 1st service whose service type = iMessage
        set targetBuddy to buddy {_as_literal(to)} of targetService
        send {_as_literal(text)} to targetBuddy
    end tell
    '''
    try:
        subprocess.run(["osascript", "-e", script], check=True, capture_output=True, timeout=15)
    except subprocess.CalledProcessError as e:
        return {"error": f"osascript failed: {e.stderr.decode(errors='replace')[:300]}"}
    except subprocess.TimeoutExpired:
        return {"error": "osascript timed out"}
    return {"ok": True, "to": to}


ACTIONS = {"threads": h_threads, "messages": h_messages, "send": h_send}


async def h_action(req):
    action = req.match_info["action"]
    if action not in ACTIONS:
        return web.json_response({"error": "unknown_action"}, status=404)
    ts = req.query.get("ts", "")
    sig = req.query.get("sig", "")
    raw = await req.read()
    if not _verify(ts, sig, raw):
        return web.json_response({"error": "unauthorized"}, status=401)
    try:
        body = json.loads(raw) if raw else {}
    except Exception:
        return web.json_response({"error": "bad_json"}, status=400)
    try:
        return web.json_response(ACTIONS[action](body))
    except Exception as e:
        return web.json_response({"error": str(e)[:300]}, status=502)


async def h_health(req):
    try:
        conn = _open_ro()
        conn.execute("SELECT 1").fetchone()
        conn.close()
    except Exception as e:
        return web.json_response({"status": "error", "error": str(e)[:200]}, status=503)
    return web.json_response({"status": "ok", "allow_send": ALLOW_SEND})


def main():
    app = web.Application(client_max_size=512 * 1024)
    app.router.add_post("/imessage/{action}", h_action)
    app.router.add_get("/health", h_health)
    print(f"imessage service on 127.0.0.1:{PORT} allow_send={ALLOW_SEND}")
    web.run_app(app, host="127.0.0.1", port=PORT)


if __name__ == "__main__":
    main()
