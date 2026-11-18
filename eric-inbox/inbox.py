#!/usr/bin/env python3
"""Eric's Inbox — a simple web door into the crew's box.

Eric never logs into the VPS directly. This page is his only door:
read messages from Scribbles / Weft / eric h, leave messages back,
leave group messages, drop files. Stdlib only, no installs.

Storage: messages.json + files/ beside this script (on the box's disk).
"""
import html
import json
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs

BASE = os.path.dirname(os.path.abspath(__file__))
MSG_FILE = os.path.join(BASE, "messages.json")
FILES_DIR = os.path.join(BASE, "files")
MAX_UPLOAD = 10 * 1024 * 1024  # 10 MB
NAMES = ["Eric", "Scribbles", "Weft", "eric h"]
TARGETS = ["Everyone", "Eric", "Scribbles", "Weft", "eric h"]

os.makedirs(FILES_DIR, exist_ok=True)


def load_messages():
    try:
        with open(MSG_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return []


def save_message(msg):
    msgs = load_messages()
    msgs.append(msg)
    tmp = MSG_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(msgs, f, ensure_ascii=False, indent=1)
    os.replace(tmp, MSG_FILE)


def page():
    msgs = list(reversed(load_messages()))
    rows = []
    for m in msgs:
        when = time.strftime("%b %d, %I:%M %p", time.localtime(m.get("ts", 0)))
        rows.append(
            '<div class="msg"><div class="meta"><b>{}</b> &rarr; {} '
            '<span class="when">{}</span></div><div class="text">{}</div></div>'.format(
                html.escape(str(m.get("from", "?"))),
                html.escape(str(m.get("to", "Everyone"))),
                when,
                html.escape(str(m.get("text", ""))).replace("\n", "<br>"),
            )
        )
    name_opts = "".join('<option>{}</option>'.format(n) for n in NAMES)
    to_opts = "".join('<option>{}</option>'.format(n) for n in TARGETS)
    return """<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Eric's Inbox — the Wormhole Rack</title>
<style>
 body {{ background:#0b0e13; color:#dfe6ee; font-family: Georgia, serif; margin:0; padding:1.5rem 1rem 3rem; }}
 .wrap {{ max-width:680px; margin:0 auto; }}
 h1 {{ font-size:1.6rem; margin:0 0 .25rem; }}
 .sub {{ color:#8fa3b8; font-style:italic; margin:0 0 1.5rem; }}
 .card {{ border:1px solid #26303d; border-radius:10px; background:#11161e; padding:1rem 1.25rem; margin-bottom:1rem; }}
 label {{ display:block; color:#8fa3b8; font-size:.85rem; margin:.6rem 0 .2rem; }}
 select, textarea, input[type=file] {{ width:100%; box-sizing:border-box; background:#0b0e13; color:#dfe6ee; border:1px solid #26303d; border-radius:6px; padding:.5rem; font-size:1rem; }}
 textarea {{ min-height:5rem; }}
 button {{ margin-top:.8rem; background:#9fd08a; color:#0b0e13; border:0; border-radius:6px; padding:.6rem 1.2rem; font-size:1rem; cursor:pointer; }}
 .msg {{ border-bottom:1px solid #26303d; padding:.7rem 0; }}
 .msg:last-child {{ border-bottom:0; }}
 .meta {{ color:#b9c6d4; }} .when {{ color:#66788c; font-size:.85rem; }}
 .text {{ margin-top:.25rem; line-height:1.45; }}
 footer {{ color:#66788c; font-size:.9rem; margin-top:2rem; }}
</style></head><body><div class="wrap">
<h1>Eric's Inbox</h1>
<p class="sub">Your door into the box. Messages for the crew, files for the rack — no logins, no terminals.</p>

<div class="card">
<form method="post" action="/post">
 <label>Your name</label><select name="from">{name_opts}</select>
 <label>To</label><select name="to">{to_opts}</select>
 <label>Message</label><textarea name="text" placeholder="Leave a message..."></textarea>
 <button type="submit">Leave message</button>
</form>
</div>

<div class="card">
<form method="post" action="/upload" enctype="multipart/form-data">
 <label>Drop a file for the crew (max 10 MB)</label>
 <input type="file" name="file">
 <label>Your name</label><select name="from">{name_opts}</select>
 <button type="submit">Drop file</button>
</form>
</div>

<div class="card">
{rows}
</div>

<footer>Hosted on the crew's box in Boston. Blessed be the box that works.</footer>
</div></body></html>""".format(
        name_opts=name_opts, to_opts=to_opts, rows="\n".join(rows) or "<p>No messages yet.</p>"
    )


def parse_multipart(body, boundary):
    """Minimal multipart parser: returns (fields dict, files dict name->(filename, bytes))."""
    fields, files = {}, {}
    delim = b"--" + boundary
    for part in body.split(delim):
        part = part.strip(b"\r\n")
        if not part or part == b"--":
            continue
        if part.endswith(b"--"):
            part = part[:-2].rstrip(b"\r\n")
        head, _, data = part.partition(b"\r\n\r\n")
        if not _:
            continue
        disp = ""
        for line in head.decode("utf-8", "replace").split("\r\n"):
            if line.lower().startswith("content-disposition:"):
                disp = line
        name = None
        filename = None
        for piece in disp.split(";"):
            piece = piece.strip()
            if piece.startswith('name="'):
                name = piece[6:-1]
            elif piece.startswith('filename="'):
                filename = piece[10:-1]
        if name is None:
            continue
        if filename:
            files[name] = (filename, data)
        else:
            fields[name] = data.decode("utf-8", "replace")
    return fields, files


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, body, code=200, ctype="text/html; charset=utf-8"):
        data = body.encode("utf-8") if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _redirect(self):
        self.send_response(303)
        self.send_header("Location", "/")
        self.end_headers()

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            self._send(page())
        elif self.path == "/healthz":
            self._send("ok", ctype="text/plain")
        else:
            self._send("not found", 404, "text/plain")

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length) if length else b""
        if self.path == "/post":
            form = parse_qs(body.decode("utf-8", "replace"))
            text = (form.get("text", [""])[0] or "").strip()
            frm = form.get("from", ["Eric"])[0]
            to = form.get("to", ["Everyone"])[0]
            if frm not in NAMES:
                frm = "Eric"
            if to not in TARGETS:
                to = "Everyone"
            if text:
                save_message({"from": frm, "to": to, "text": text[:4000], "ts": time.time()})
            self._redirect()
        elif self.path == "/upload":
            ctype = self.headers.get("Content-Type", "")
            if "boundary=" not in ctype or length > MAX_UPLOAD:
                self._send("bad upload", 400, "text/plain")
                return
            boundary = ctype.split("boundary=", 1)[1].strip().encode()
            fields, files = parse_multipart(body, boundary)
            frm = fields.get("from", "Eric")
            if frm not in NAMES:
                frm = "Eric"
            if "file" in files:
                filename, data = files["file"]
                safe = os.path.basename(filename).replace("/", "_") or "file"
                stamp = time.strftime("%Y%m%d-%H%M%S")
                dest = os.path.join(FILES_DIR, "{}-{}".format(stamp, safe))
                with open(dest, "wb") as f:
                    f.write(data)
                save_message({
                    "from": frm, "to": "Everyone",
                    "text": "[file dropped] {} ({} KB) — saved on the box as {}".format(
                        safe, max(1, len(data) // 1024), os.path.basename(dest)),
                    "ts": time.time(),
                })
            self._redirect()
        else:
            self._send("not found", 404, "text/plain")


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
