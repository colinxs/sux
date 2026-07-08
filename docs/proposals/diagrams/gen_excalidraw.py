#!/usr/bin/env python3
"""Generate .excalidraw scene files for the sux knowledge-core design diagrams.

Hand-authoring Excalidraw JSON is error-prone (bindings, seeds, per-element
bookkeeping), so this builds scenes from a small box/arrow DSL and emits valid
scene JSON that opens in excalidraw.com and the Obsidian Excalidraw plugin.
"""
import json, os, random

random.seed(42)  # deterministic output → stable diffs
STAMP = 1751990400000  # fixed 'updated' so re-runs don't churn the files

def rid():
    return "".join(random.choices("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", k=20))
def nonce():
    return random.randint(1, 2**31 - 1)

FONT_HAND, FONT_NORMAL, FONT_CODE = 1, 2, 3

# palette (excalidraw's own swatches)
INK = "#1e1e1e"
BLUE_S, BLUE_F = "#1971c2", "#a5d8ff"
GREEN_S, GREEN_F = "#2f9e44", "#b2f2bb"
GRAPE_S, GRAPE_F = "#9c36b5", "#eebefa"
ORANGE_S, ORANGE_F = "#e8590c", "#ffd8a8"
GRAY_S, GRAY_F = "#495057", "#e9ecef"
YELLOW_S, YELLOW_F = "#f08c00", "#ffec99"
TRANSPARENT = "transparent"

def _text_el(text, x, y, w, h, font_size, container_id=None, color=INK, align="center", font=FONT_HAND):
    lines = text.split("\n")
    return {
        "type": "text", "id": rid(), "x": x, "y": y, "width": w, "height": h,
        "angle": 0, "strokeColor": color, "backgroundColor": TRANSPARENT,
        "fillStyle": "solid", "strokeWidth": 2, "strokeStyle": "solid",
        "roughness": 1, "opacity": 100, "groupIds": [], "frameId": None,
        "roundness": None, "seed": nonce(), "version": 2, "versionNonce": nonce(),
        "isDeleted": False, "boundElements": [], "updated": STAMP, "link": None,
        "locked": False, "text": text, "fontSize": font_size, "fontFamily": font,
        "textAlign": align, "verticalAlign": "middle", "containerId": container_id,
        "originalText": text, "autoResize": True, "lineHeight": 1.25,
    }

class Scene:
    def __init__(self):
        self.elements = []
        self.boxes = {}  # name -> element dict

    def box(self, name, x, y, w, h, label, shape="rectangle",
            stroke=INK, fill=TRANSPARENT, font_size=16, font=FONT_HAND):
        bid = rid()
        rect = {
            "type": shape, "id": bid, "x": x, "y": y, "width": w, "height": h,
            "angle": 0, "strokeColor": stroke, "backgroundColor": fill,
            "fillStyle": "solid", "strokeWidth": 2, "strokeStyle": "solid",
            "roughness": 1, "opacity": 100, "groupIds": [], "frameId": None,
            "roundness": {"type": 3} if shape == "rectangle" else None,
            "seed": nonce(), "version": 2, "versionNonce": nonce(),
            "isDeleted": False, "boundElements": [], "updated": STAMP,
            "link": None, "locked": False,
        }
        lines = label.split("\n")
        tw = min(w - 16, int(max(len(l) for l in lines) * font_size * 0.58) + 8)
        th = int(len(lines) * font_size * 1.25)
        t = _text_el(label, x + (w - tw) / 2, y + (h - th) / 2, tw, th, font_size,
                     container_id=bid, font=font)
        rect["boundElements"].append({"type": "text", "id": t["id"]})
        self.elements += [rect, t]
        self.boxes[name] = rect
        return rect

    def frame(self, x, y, w, h, label, stroke=GRAY_S):
        # a background container rectangle with a top-left label (not bound)
        rect = {
            "type": "rectangle", "id": rid(), "x": x, "y": y, "width": w, "height": h,
            "angle": 0, "strokeColor": stroke, "backgroundColor": TRANSPARENT,
            "fillStyle": "solid", "strokeWidth": 1, "strokeStyle": "dashed",
            "roughness": 1, "opacity": 100, "groupIds": [], "frameId": None,
            "roundness": {"type": 3}, "seed": nonce(), "version": 2,
            "versionNonce": nonce(), "isDeleted": False, "boundElements": [],
            "updated": STAMP, "link": None, "locked": False,
        }
        self.elements.append(rect)
        self.elements.append(_text_el(label, x + 12, y + 8, len(label) * 9, 20, 14,
                                      color=stroke, align="left"))
        return rect

    def _edge_points(self, a, b):
        acx, acy = a["x"] + a["width"] / 2, a["y"] + a["height"] / 2
        bcx, bcy = b["x"] + b["width"] / 2, b["y"] + b["height"] / 2
        dx, dy = bcx - acx, bcy - acy
        if abs(dy) >= abs(dx):  # vertical dominant
            if dy > 0:
                return (acx, a["y"] + a["height"]), (bcx, b["y"])
            return (acx, a["y"]), (bcx, b["y"] + b["height"])
        else:  # horizontal dominant
            if dx > 0:
                return (a["x"] + a["width"], acy), (b["x"], b["y"] + b["height"] / 2)
            return (a["x"], acy), (b["x"] + b["width"], b["y"] + b["height"] / 2)

    def arrow(self, a_name, b_name, label=None, dashed=False, color=INK):
        a, b = self.boxes[a_name], self.boxes[b_name]
        (sx, sy), (ex, ey) = self._edge_points(a, b)
        aid = rid()
        arrow = {
            "type": "arrow", "id": aid, "x": sx, "y": sy,
            "width": abs(ex - sx), "height": abs(ey - sy), "angle": 0,
            "strokeColor": color, "backgroundColor": TRANSPARENT, "fillStyle": "solid",
            "strokeWidth": 2, "strokeStyle": "dashed" if dashed else "solid",
            "roughness": 1, "opacity": 100, "groupIds": [], "frameId": None,
            "roundness": {"type": 2}, "seed": nonce(), "version": 2,
            "versionNonce": nonce(), "isDeleted": False, "boundElements": [],
            "updated": STAMP, "link": None, "locked": False,
            "points": [[0, 0], [ex - sx, ey - sy]],
            "lastCommittedPoint": None,
            "startBinding": {"elementId": a["id"], "focus": 0.0, "gap": 6},
            "endBinding": {"elementId": b["id"], "focus": 0.0, "gap": 6},
            "startArrowhead": None, "endArrowhead": "arrow",
        }
        a["boundElements"].append({"type": "arrow", "id": aid})
        b["boundElements"].append({"type": "arrow", "id": aid})
        self.elements.append(arrow)
        if label:
            mx, my = (sx + ex) / 2, (sy + ey) / 2
            lw = len(label) * 8 + 8
            t = _text_el(label, mx - lw / 2, my - 12, lw, 20, 13, container_id=aid,
                         color=color)
            arrow["boundElements"].append({"type": "text", "id": t["id"]})
            self.elements.append(t)
        return arrow

    def dump(self, path):
        scene = {
            "type": "excalidraw", "version": 2, "source": "sux-mcp/docs",
            "elements": self.elements,
            "appState": {"gridSize": None, "viewBackgroundColor": "#ffffff"},
            "files": {},
        }
        with open(path, "w") as f:
            json.dump(scene, f, indent=2)
        print(f"wrote {path} ({len(self.elements)} elements)")


OUT = os.path.dirname(__file__)


# ── Diagram 1 — system topology (hub & spoke) ───────────────────────────────
s = Scene()
s.frame(40, 30, 360, 120, "Clients — one assistant surface")
s.box("lc", 70, 70, 150, 60, "Local Claude", fill=BLUE_F, stroke=BLUE_S)
s.box("cc", 240, 70, 140, 60, "Cloud / Mobile\nClaude", fill=BLUE_F, stroke=BLUE_S)

s.frame(420, 30, 400, 260, "sux Worker — Cloudflare edge")
s.box("fns", 470, 70, 300, 46, "dispatch  ·  91 fns", fill=GRAY_F, stroke=GRAY_S)
s.box("obs", 450, 150, 180, 56, "obsidian · ingest", fill=GREEN_F, stroke=GREEN_S)
s.box("dbx", 660, 150, 130, 56, "dropbox", fill=GREEN_F, stroke=GREEN_S)
s.box("kv", 470, 230, 180, 46, "Workers KV\ncache:vault:*", shape="ellipse", fill=YELLOW_F, stroke=YELLOW_S, font_size=13)

s.frame(420, 330, 400, 150, "Mac node — Tailscale Funnel")
s.box("rest", 470, 370, 300, 46, "Obsidian Local REST API", fill=GRAPE_F, stroke=GRAPE_S)
s.box("vault", 470, 430, 300, 40, "Live vault", shape="ellipse", fill=GRAPE_F, stroke=GRAPE_S, font_size=13)

s.box("gh", 900, 150, 210, 70, "GitHub · colinxs/vault\nSOURCE OF TRUTH", shape="ellipse", fill=ORANGE_F, stroke=ORANGE_S, font_size=13)
s.box("drop", 900, 260, 210, 60, "Dropbox /Apps/sux\nhuman-facing blobs", shape="ellipse", fill=ORANGE_F, stroke=ORANGE_S, font_size=13)
s.box("r2", 900, 350, 210, 56, "R2\nmachine-facing blobs", shape="ellipse", fill=ORANGE_F, stroke=ORANGE_S, font_size=13)
s.box("web", 900, 60, 210, 56, "Open web", shape="ellipse", fill=GRAY_F, stroke=GRAY_S)

s.arrow("lc", "rest", "Tailscale · near surface", color=BLUE_S)
s.arrow("cc", "fns", "MCP", color=BLUE_S)
s.arrow("fns", "obs")
s.arrow("fns", "dbx")
s.arrow("obs", "gh", "git backend", color=GREEN_S)
s.arrow("obs", "rest", "remote · Funnel", color=GREEN_S)
s.arrow("obs", "kv", "read-through", color=GREEN_S)
s.arrow("obs", "web", "web capture", dashed=True, color=GREEN_S)
s.arrow("dbx", "drop")
s.arrow("obs", "r2", "blob fallback", dashed=True, color=GREEN_S)
s.arrow("rest", "vault")
s.arrow("vault", "gh", "obsidian-git backup", color=GRAPE_S)
s.dump(os.path.join(OUT, "architecture-1-topology.excalidraw"))

# ── Diagram 2 — storage read path (git = truth, KV = cache) ─────────────────
s = Scene()
s.box("a", 300, 20, 220, 50, "read(path)", fill=BLUE_F, stroke=BLUE_S)
s.box("b", 300, 110, 220, 60, "KV head fresh?\n(< 60s)", shape="diamond", fill=YELLOW_F, stroke=YELLOW_S)
s.box("d", 300, 220, 220, 56, "GET /git/ref\n→ HEAD sha", fill=GRAY_F, stroke=GRAY_S)
s.box("f", 300, 320, 220, 60, "cached sha\n< 10 min old?", shape="diamond", fill=YELLOW_F, stroke=YELLOW_S)
s.box("g", 60, 330, 190, 50, "head = null\n(bypass cache)", fill=ORANGE_F, stroke=ORANGE_S, font_size=13)
s.box("c", 600, 130, 200, 50, "use HEAD sha", fill=GRAY_F, stroke=GRAY_S)
s.box("h", 600, 220, 200, 60, "KV note hit AND\nsha == HEAD?", shape="diamond", fill=YELLOW_F, stroke=YELLOW_S)
s.box("i", 600, 330, 200, 50, "serve cached body", fill=GREEN_F, stroke=GREEN_S)
s.box("j", 300, 430, 220, 50, "GET /contents", fill=GRAY_F, stroke=GRAY_S)
s.box("k", 300, 520, 220, 60, "empty AND size > 0?\n(> 1 MB file)", shape="diamond", fill=YELLOW_F, stroke=YELLOW_S)
s.box("l", 60, 530, 190, 50, "raw refetch", fill=GRAY_F, stroke=GRAY_S)
s.box("n", 600, 520, 200, 56, "warm gitNoteKey\n{body, sha:HEAD}", fill=ORANGE_F, stroke=ORANGE_S, font_size=13)

s.arrow("a", "b")
s.arrow("b", "c", "yes", color=GREEN_S)
s.arrow("b", "d", "no", color=ORANGE_S)
s.arrow("d", "c", "ok", color=GREEN_S)
s.arrow("d", "f", "GitHub down", color=ORANGE_S)
s.arrow("f", "c", "yes", color=GREEN_S)
s.arrow("f", "g", "no", color=ORANGE_S)
s.arrow("c", "h")
s.arrow("h", "i", "hit", color=GREEN_S)
s.arrow("h", "j", "miss", color=ORANGE_S)
s.arrow("g", "j")
s.arrow("j", "k")
s.arrow("k", "l", "> 1 MB", color=ORANGE_S)
s.arrow("k", "n", "no")
s.arrow("l", "n")
s.arrow("n", "i")
s.dump(os.path.join(OUT, "architecture-2-storage-read.excalidraw"))

# ── Diagram 3 — ingest dataflow ─────────────────────────────────────────────
s = Scene()
s.box("in", 320, 20, 260, 50, "ingest(url | text | query)", fill=BLUE_F, stroke=BLUE_S, font_size=15)
s.box("one", 340, 110, 220, 60, "exactly one\nsource?", shape="diamond", fill=YELLOW_F, stroke=YELLOW_S)
s.box("u", 120, 220, 170, 50, "loadBytes · 32 MB", fill=GRAY_F, stroke=GRAY_S, font_size=13)
s.box("tx", 400, 220, 130, 50, "verbatim body", fill=GRAY_F, stroke=GRAY_S, font_size=13)
s.box("q", 620, 220, 180, 50, "search fn → results", fill=GRAY_F, stroke=GRAY_S, font_size=13)
s.box("ct", 100, 310, 210, 60, "content-type?", shape="diamond", fill=YELLOW_F, stroke=YELLOW_S)
s.box("hm", 40, 420, 120, 46, "htmlToMd", fill=GRAY_F, stroke=GRAY_S, font_size=13)
s.box("tv", 175, 420, 110, 46, "verbatim", fill=GRAY_F, stroke=GRAY_S, font_size=13)
s.box("blob", 300, 415, 210, 60, "size / blobs flag", shape="diamond", fill=YELLOW_F, stroke=YELLOW_S)
s.box("v", 300, 520, 220, 56, "commit into vault\nAttachments/", fill=GREEN_F, stroke=GREEN_S, font_size=13)
s.box("dbx", 560, 500, 210, 56, "Dropbox app folder\n→ public link", fill=GRAPE_F, stroke=GRAPE_S, font_size=13)
s.box("r2", 560, 590, 210, 46, "R2 fallback link", fill=ORANGE_F, stroke=ORANGE_S, font_size=13)
s.box("body", 620, 320, 150, 46, "body", shape="ellipse", fill=BLUE_F, stroke=BLUE_S)
s.box("pass", 590, 410, 220, 60, "summarize /\ncompress?", shape="diamond", fill=YELLOW_F, stroke=YELLOW_S)
s.box("note", 860, 430, 230, 56, "buildNote\nprovenance frontmatter", fill=GREEN_F, stroke=GREEN_S, font_size=13)
s.box("put", 860, 530, 230, 56, "vaultPut → Inbox/\ncollision-safe", fill=GREEN_F, stroke=GREEN_S, font_size=13)
s.box("commit", 860, 620, 230, 46, "git commit + KV warm", fill=ORANGE_F, stroke=ORANGE_S, font_size=13)

s.arrow("in", "one")
s.arrow("one", "u", "url", color=BLUE_S)
s.arrow("one", "tx", "text", color=BLUE_S)
s.arrow("one", "q", "query", color=BLUE_S)
s.arrow("u", "ct")
s.arrow("ct", "hm", "html", color=GREEN_S)
s.arrow("ct", "tv", "text/*", color=GREEN_S)
s.arrow("ct", "blob", "binary", color=GRAPE_S)
s.arrow("blob", "v", "<= 1 MB", color=GREEN_S)
s.arrow("blob", "dbx", "> 1 MB", color=GRAPE_S)
s.arrow("dbx", "r2", "no token", dashed=True, color=ORANGE_S)
s.arrow("hm", "body")
s.arrow("tv", "body")
s.arrow("tx", "body")
s.arrow("q", "body")
s.arrow("body", "pass")
s.arrow("pass", "note", "distill / verbatim", color=GREEN_S)
s.arrow("v", "note")
s.arrow("dbx", "note")
s.arrow("note", "put")
s.arrow("put", "commit")
s.dump(os.path.join(OUT, "architecture-3-ingest.excalidraw"))

# ── Diagram 4 — two-transport routing & degrade ─────────────────────────────
s = Scene()
s.frame(40, 30, 360, 150, "Local session — near surface")
s.box("l1", 80, 80, 130, 56, "Claude", fill=BLUE_F, stroke=BLUE_S)
s.box("lr", 240, 80, 130, 56, "Local REST\nlive vault", fill=GRAPE_F, stroke=GRAPE_S, font_size=13)

s.frame(40, 220, 620, 240, "Cloud / mobile session")
s.box("c1", 80, 300, 120, 56, "Claude", fill=BLUE_F, stroke=BLUE_S)
s.box("c2", 240, 300, 140, 56, "sux Worker", fill=GRAY_F, stroke=GRAY_S)
s.box("fun", 440, 250, 180, 56, "Funnel → Local REST", shape="diamond", fill=GRAPE_F, stroke=GRAPE_S, font_size=13)
s.box("git", 440, 350, 180, 46, "GitHub vault", shape="ellipse", fill=ORANGE_F, stroke=ORANGE_S, font_size=13)
s.box("kv", 440, 410, 180, 42, "KV cache", shape="ellipse", fill=YELLOW_F, stroke=YELLOW_S, font_size=13)
s.box("ok", 720, 250, 190, 50, "live read / write", fill=GREEN_F, stroke=GREEN_S, font_size=13)
s.box("fb", 720, 360, 210, 56, "serve KV copy,\nelse try git", fill=ORANGE_F, stroke=ORANGE_S, font_size=13)

s.arrow("l1", "lr", "Tailscale direct", color=BLUE_S)
s.arrow("c1", "c2")
s.arrow("c2", "fun", "remote", color=GRAPE_S)
s.arrow("c2", "git", "git", color=ORANGE_S)
s.arrow("c2", "kv", "read-through", color=YELLOW_S)
s.arrow("fun", "ok", "Mac awake", color=GREEN_S)
s.arrow("fun", "fb", "throws / 5xx", color=ORANGE_S)
s.arrow("kv", "fb", dashed=True, color=YELLOW_S)
s.arrow("git", "fb", dashed=True, color=ORANGE_S)
s.dump(os.path.join(OUT, "architecture-4-transport.excalidraw"))

print("done")
