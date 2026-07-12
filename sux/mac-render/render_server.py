#!/usr/bin/env python3
import os, json, hmac, hashlib, base64, asyncio, time
from aiohttp import web
from patchright.async_api import async_playwright

SECRET = os.environ.get("RENDER_SECRET", "").encode()
PORT = int(os.environ.get("PORT", "8790"))
CONC = int(os.environ.get("CONCURRENCY", "4"))
# The Worker signs `${ts}\n${body}` with ts = Date.now() (epoch MILLISECONDS). The
# HMAC proves the ts wasn't forged, but a *captured* signed request stays valid
# forever unless we also bound its age — so reject anything whose ts is more than
# MAX_TS_SKEW_MS old (or that far in the future, for clock drift). Kills replay of a
# sniffed /render call.
MAX_TS_SKEW_MS = 300_000
BLOCK = {"image", "media", "font", "stylesheet"}

def _read_key():
    try:
        with open(os.path.expanduser("~/.sux-capsolver.key")) as f:
            return f.read().strip()
    except OSError:
        return ""

CAPSOLVER_KEY = _read_key()

BLOCK_MARKERS = (
    "px-captcha", "_pxhd", "perimeterx", "captcha-delivery", "datadome",
    "g-recaptcha", "h-captcha", "cf-turnstile", "awswaf", "press & hold",
    "access denied", "request unsuccessful", "unusual traffic",
    "are you a robot", "verify you are a human", "enable javascript and cookies",
    "robot or human", "activate and hold", "hold the button",
)

pw = None
ctx = None
solver_ctx = None
sem = asyncio.Semaphore(CONC)
solver_sem = asyncio.Semaphore(int(os.environ.get("SOLVER_CONCURRENCY", "1")))

def looks_blocked(status, body):
    if status in (401, 403, 429, 503) and len(body) < 6000:
        return True
    low = body.lower()
    return any(m in low for m in BLOCK_MARKERS)

async def try_solve_px(page):
    try:
        html = await page.content()
    except Exception:
        return
    if "px-captcha" not in html.lower():
        return
    for _ in range(2):
        el = await page.query_selector("#px-captcha")
        if not el:
            return
        try:
            await el.scroll_into_view_if_needed(timeout=3000)
        except Exception:
            pass
        box = await el.bounding_box()
        if not box:
            await page.wait_for_timeout(1000)
            continue
        cx = box["x"] + box["width"] / 2
        cy = box["y"] + box["height"] / 2
        await page.mouse.move(cx - 30, cy, steps=6)
        await page.mouse.move(cx, cy, steps=6)
        await page.mouse.down()
        held = 0
        while held < 12000:
            await page.wait_for_timeout(200)
            held += 200
            try:
                await page.mouse.move(cx + ((held // 200) % 3 - 1), cy + ((held // 400) % 2), steps=1)
                gone = not await page.evaluate("(function(){var e=document.getElementById('px-captcha');return !!(e&&e.offsetHeight>0);})()")
            except Exception:
                gone = False
            if gone and held > 2500:
                break
        await page.mouse.up()
        try:
            await page.wait_for_load_state("networkidle", timeout=8000)
        except Exception:
            await page.wait_for_timeout(3000)
        try:
            if "px-captcha" not in (await page.content()).lower():
                return
        except Exception:
            return

async def render_on(context, spec, interactive=False):
    as_ = spec.get("as", "html")
    page = await context.new_page()
    try:
        if spec.get("block_resources"):
            async def _route(r):
                if r.request.resource_type in BLOCK:
                    await r.abort()
                else:
                    await r.continue_()
            await page.route("**/*", _route)
        resp = await page.goto(spec["url"], wait_until=spec.get("wait_until", "domcontentloaded"), timeout=int(spec.get("timeout_ms", 45000)))
        status = resp.status if resp else 200
        if spec.get("wait_ms"):
            await page.wait_for_timeout(int(spec["wait_ms"]))
        if interactive:
            await try_solve_px(page)
        if as_ == "screenshot":
            data = await page.screenshot(full_page=bool(spec.get("full_page")))
            return {"status": status, "content_type": "image/png", "bodyEncoding": "base64", "body": base64.b64encode(data).decode()}, ""
        if as_ == "pdf":
            data = await page.pdf()
            return {"status": status, "content_type": "application/pdf", "bodyEncoding": "base64", "body": base64.b64encode(data).decode()}, ""
        if as_ == "text":
            txt = await page.evaluate("document.body ? document.body.innerText : ''")
            return {"status": status, "content_type": "text/plain", "body": txt}, txt
        html = await page.content()
        return {"status": status, "content_type": "text/html", "body": html}, html
    finally:
        await page.close()

async def do_render(spec):
    async with sem:
        out, body = await render_on(ctx, spec)
    if solver_ctx is None or spec.get("as", "html") not in ("html", "text"):
        return out
    if not (spec.get("solve") or looks_blocked(out.get("status", 200), body)):
        return out
    try:
        sspec = dict(spec)
        sspec["block_resources"] = False
        sspec["wait_ms"] = int(spec.get("solve_wait_ms", 15000))
        async with solver_sem:
            sout, _ = await render_on(solver_ctx, sspec, interactive=True)
        sout["solver"] = True
        return sout
    except Exception as e:
        out["solver_error"] = str(e)[:200]
        return out

async def h_render(req):
    ts = req.query.get("ts", ""); sig = req.query.get("sig", "")
    raw = await req.read()
    calc = hmac.new(SECRET, (ts + "\n").encode() + raw, hashlib.sha256).hexdigest()
    if not sig or not hmac.compare_digest(calc, sig):
        return web.json_response({"error": "unauthorized"}, status=401)
    try:
        age = abs(time.time() * 1000 - int(ts))
    except ValueError:
        return web.json_response({"error": "unauthorized"}, status=401)
    if age > MAX_TS_SKEW_MS:
        return web.json_response({"error": "stale_timestamp"}, status=401)
    try:
        spec = json.loads(raw)
    except Exception:
        return web.json_response({"error": "bad_json"}, status=400)
    if not spec.get("url"):
        return web.json_response({"error": "missing_url"}, status=400)
    try:
        return web.json_response(await do_render(spec))
    except Exception as e:
        return web.json_response({"error": str(e)[:300]}, status=502)

async def h_health(req):
    return web.json_response({"status": "ok", "concurrency": CONC, "solver": solver_ctx is not None})

async def start_solver():
    global solver_ctx
    if not CAPSOLVER_KEY:
        return
    try:
        from capsolver_extension_python import Capsolver
        ext = Capsolver(api_key=CAPSOLVER_KEY).load(with_command_line_option=False)
        solver_ctx = await pw.chromium.launch_persistent_context(
            user_data_dir=os.path.expanduser("~/.sux-solver-profile"),
            headless=False, viewport={"width": 1280, "height": 800},
            args=["--disable-extensions-except=" + ext, "--load-extension=" + ext])
        print("capsolver solver context enabled")
    except Exception as e:
        solver_ctx = None
        print("solver disabled:", str(e)[:200])

async def main():
    global pw, ctx
    pw = await async_playwright().start()
    ctx = await pw.chromium.launch_persistent_context(
        user_data_dir=os.path.expanduser("~/.sux-render-profile"),
        headless=True, viewport={"width": 1280, "height": 800})
    await start_solver()
    app = web.Application(client_max_size=2 * 1024 * 1024)
    app.router.add_post("/render", h_render)
    app.router.add_get("/health", h_health)
    runner = web.AppRunner(app); await runner.setup()
    await web.TCPSite(runner, "127.0.0.1", PORT).start()
    print(f"async render service on 127.0.0.1:{PORT} conc={CONC} solver={solver_ctx is not None}")
    await asyncio.Event().wait()

if __name__ == "__main__":
    if len(SECRET) < 16:
        raise SystemExit("set RENDER_SECRET (>=16 chars)")
    asyncio.run(main())
