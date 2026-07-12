# Router watchdog / self-heal daemon — owl-tegu

**Status:** design only (no deploy, no flash, no router mutation)
**Target:** owl-tegu = Protectli V1210 (N5105, x86_64), OpenWrt 25.12.3, `root@100.98.238.70`
**Role:** home LAN gateway (SACRED — must never destabilize home internet) + sux residential proxy (`/srv/suxproxy`) + DNS (unbound + ctrld/Control D) + Tailscale node.

Guiding taste (house): KISS, 80-20, obvious-good-not-best. The watchdog is **muscle, not brain** — it reasserts known-good state in the safe/reversible direction and phones home; it never makes destructive or attention-reducing moves on its own.

---

## 1. Recommendation

**Custom procd-supervised busybox-sh self-heal loop (`suxwatch`) as the brain, `watchcat` kept only for its dumb-timer reboot, `kmod-itco-wdt` as the hardware floor. Skip `monit`.**

Layered, bottom-up:

| Layer | Tool | Job | Why |
|---|---|---|---|
| L0 hardware | `kmod-itco-wdt` → `/dev/watchdog` | Reboots the box if nothing pets it for N s | Recovers from a kernel hang / total lockup that no userspace daemon can touch. Already in the new image. |
| L1 dumb timer | `watchcat` (period-reboot mode, optional) | Unconditional "reboot if I haven't seen the internet in 30 min" | Zero-logic backstop if `suxwatch` itself dies or wedges. Already in the image. |
| L2 brain | **`suxwatch`** (procd service + busybox sh) | monitor → heal → escalate state machine; pets `/dev/watchdog` | The actual self-heal. One file, no new deps, procd restarts it if it crashes. |
| L3 out-of-band | sux dead-drop + temp WAN-SSH + `efibootmgr` recovery-boot | Human/Worker reach when L2 can't fix it | Already designed (PR #151 / `feat/recovery-deaddrop`). `suxwatch` is the box-side driver. |

### Why not `monit`

`monit` is the tempting "correct" answer — declarative `check process … restart`, resource limits, a tidy control file. But for **this** box it's the wrong 80-20:

- **New dependency on the SACRED gateway.** Another daemon, its own config DSL, its own failure modes, ~MB of userspace — on the one machine we least want surprises. Every dep on the gateway is a liability.
- **The hard parts aren't process-liveness.** `monit` shines at "is pid alive, restart it." Our real logic is *ordered, conditional network reassertion* with an escalation ladder that ends in `efibootmgr` + dead-drop — none of which is `monit`'s model. We'd end up shelling out to scripts from `monit` anyway, so `monit` becomes a fancier cron with extra surface.
- **Watchdog petting + escalation state** (backoff, "how many consecutive fails before I open WAN-SSH") wants a real script with a loop variable, not a stateless `check` DSL.

`monit` would be justified if we had 10+ heterogeneous services to babysit with rich per-service resource rules. We have ~3 services and a network to keep up. That's a script.

### Why `watchcat` alone isn't enough (but we keep it)

`watchcat` is great and already staged, but it is a **dumb periodic ping→(restart iface | reboot)**. It has no notion of "Tailscale down," "unbound dead but WAN up," "suxproxy crashed," ordered heal, or phone-home. It's the perfect **L1 backstop** — leave it configured in reboot mode with a long window (e.g. reboot if no WAN for 30 min) so that even a totally wedged `suxwatch` still gets the box rebooted. Brain = `suxwatch`; watchcat = seatbelt.

### Why a custom script fits the house taste

One POSIX-sh file, deps we already install for the dead-drop (`openssl`, `jq`, `curl`), procd-supervised so it's auto-restarted and logged to `logread`. It reuses the exact allow-list vocabulary already shipped in `recovery.ts` / `recovery-checkin.sh` (`restart-tailscale`, `restart-dns`, `restore-config`, `open-wan-ssh`, `reboot`, `noop`), so the local self-heal and the remote dead-drop dispatch are the **same verbs** — no second mental model.

---

## 2. State machine: monitor → heal → escalate

`suxwatch` runs one loop every `TICK` (default 30 s). Each tick: probe everything cheaply, heal what's safe, pet the watchdog **iff the box is healthy enough to be worth keeping alive**, and track a per-subsystem consecutive-failure counter that drives escalation.

```
                 ┌─────────────────────────── every TICK (30s) ───────────────────────────┐
                 │                                                                          │
   ┌─────────┐   │   ┌──────────┐      pass       ┌──────────────┐    pass    ┌──────────┐  │
   │  PROBE  │───┼──▶│ evaluate │───── all ok ────▶│  pet /dev/   │───────────▶│  sleep   │──┘
   │ (cheap) │   │   │ subsystem│                  │  watchdog    │            │  TICK    │
   └─────────┘   │   └────┬─────┘                  └──────────────┘            └──────────┘
                 │        │ some subsystem failing
                 │        ▼
                 │   ┌──────────┐   heal is safe/reversible    ┌──────────┐
                 │   │   HEAL   │──── (restart / re-up /  ─────▶│ re-probe │─ ok ─▶ pet + sleep
                 │   │ (ladder) │      renew / reassert)        └────┬─────┘
                 │   └──────────┘                                    │ still failing
                 │                                                   ▼
                 │                              fails++ ; if fails[x] >= THRESH[x]:
                 │                                                   ▼
                 │   ┌───────────────────────────── ESCALATE ──────────────────────────────┐
                 │   │ 1. phone home (dead-drop checkin, always)                            │
                 │   │ 2. open temp WAN-SSH (key-only, alt port, auto-close-when-healthy)   │
                 │   │ 3. LAST RESORT: efibootmgr --bootnext <NVMe-recovery> ; reboot       │
                 │   └──────────────────────────────────────────────────────────────────────┘
```

### Monitor — the probes (all cheap, non-hanging, best-effort)

| Subsystem | Probe | Heal (safe direction) | Escalation threshold |
|---|---|---|---|
| WAN reachability | `ping -c1 -W2 1.1.1.1` (and 9.9.9.9 as 2nd) | `ifup wan` → `udhcpc`/DHCP renew on wan iface | 6 ticks (~3 min) → escalate |
| DNS resolving | `nslookup cloudflare.com 127.0.0.1` | `/etc/init.d/unbound restart`; then `/etc/init.d/ctrld restart` | 4 ticks |
| LAN up + DHCP | `ip addr show br-lan` has `192.168.1.1`; dnsmasq/odhcpd pid alive; lease file fresh | reassert `uci` LAN addr 192.168.1.1 + `/etc/init.d/dnsmasq restart` (and odhcpd) | 4 ticks — **conservative** (LAN is the sacred bit) |
| Tailscale | `tailscale status --json` reachable + `BackendState==Running` | `/etc/init.d/tailscale restart`; then `tailscale up` (baked identity, no key) | 4 ticks |
| suxproxy | `/etc/init.d/suxproxy` pid alive + `curl -s localhost:<port>/health` | `/etc/init.d/suxproxy restart` | 6 ticks (non-critical to home internet) |
| ctrld | pid alive + local DNS answers | `/etc/init.d/ctrld restart` | folded into DNS |
| resources | `/proc/loadavg`, `free`, `df /overlay /mnt/nvme`, `cat /sys/class/thermal/thermal_zone*/temp` | log + phone home; **no auto-reboot** on soft pressure (avoid flapping the gateway) | temp > crit for 6 ticks → phone home only |

**Watchdog petting is conditional.** `suxwatch` opens `/dev/watchdog` once at start and writes a keepalive each tick **only while the box is in a state worth keeping** (kernel responsive, loop making progress). If `suxwatch` itself hangs or the box locks, the ITCO watchdog fires a hardware reboot — the true floor. We do **not** stop petting merely because WAN is down (that's L2's job to fix / L1's job to reboot on a long window); we stop petting only on conditions where a hard reboot is strictly better than the current state (loop wedged). Default watchdog timeout ~60–120 s (comfortably > TICK).

### Heal — safe/reversible ONLY

Every heal is **restart / re-up / renew / reassert-known-good** — attention-increasing, non-destructive, idempotent. Explicitly **forbidden** to `suxwatch` (these are human-gated, per `safe-direction-autonomy`):

- No `firstboot`/`jffs2reset`, no `sysupgrade` flashing, no partition/fs writes beyond config.
- No deleting leases, no flushing Tailscale state, no `tailscale logout`.
- No firewall-opening except the one narrowly-scoped temp WAN-SSH rule (which auto-closes).
- `restore-config` (from the NVMe last-good bundle) is **escalation-gated**, not a routine heal — it only runs on a Worker-signed `restore-config` command or as a late rung, because reasserting a whole snapshot is heavier than a service restart.

**Heal backoff:** a subsystem that just got a heal is given a grace period (skip re-heal for 2 ticks) so we don't hammer `ifup`/restart in a tight loop while an iface renegotiates. Consecutive heals of the same subsystem are rate-limited (e.g. ≤3 in 10 min) before it's declared "heal didn't work" → escalate.

### Escalate — out-of-band, ordered, reversible-first

1. **Phone home (always, every tick during trouble).** POST the health snapshot to the sux dead-drop and pull any Worker-signed commands. This is the cheap, reversible, outbound-only channel — NAT/broken-inbound-proof. Colin (or a Worker rule) sees the box is sick and can enqueue `open-wan-ssh` / `restart-*` / `restore-config` / `reboot` remotely. `suxwatch` verifies each command's HMAC (reusing `recovery-checkin.sh`'s verify+dispatch) before acting.
2. **Open temp WAN-SSH** (only if WAN is actually reachable outbound but the box is otherwise sick and hasn't self-healed): add a narrow firewall rule — key-only, non-standard port, source-limited if possible — and arm an **auto-close**: close it the moment the box is healthy again OR after a hard timeout (e.g. 60 min), whichever first. This gives a human a shell without waiting on the dead-drop loop.
3. **LAST RESORT — recovery-boot.** Only after the ladder is exhausted and the box is persistently unhealthy (e.g. WAN + DNS + Tailscale all down > 15 min AND heals failed AND dead-drop unreachable): `efibootmgr --bootnext <NVMe-recovery-entry>` then `reboot`. `--bootnext` is one-shot (not `--bootorder`), so a single clean boot into the NVMe recovery image is attempted; if that image is healthy it phones home, and normal boot resumes next cycle. This is the software analog of A/B: eMMC = primary, NVMe recovery image = the B side.

Escalation is **monotonic within an incident and self-reversing across incidents**: once healthy for K consecutive ticks, close WAN-SSH, reset all fail counters, drop back to plain monitoring.

---

## 3. Config / script sketches

### 3.1 procd service — `/etc/init.d/suxwatch`

```sh
#!/bin/sh /etc/rc.common
# suxwatch — monitor→heal→escalate self-heal loop for owl-tegu. procd-supervised:
# if the loop crashes, procd respawns it; the ITCO hardware watchdog covers a hang.
START=99
USE_PROCD=1

start_service() {
    procd_open_instance
    procd_set_param command /usr/sbin/suxwatch
    procd_set_param respawn 30 5 0     # respawn: threshold 30s, timeout 5s, unlimited retries
    procd_set_param stdout 1           # → logread
    procd_set_param stderr 1
    procd_set_param pidfile /var/run/suxwatch.pid
    procd_close_instance
}
```

### 3.2 the loop — `/usr/sbin/suxwatch` (skeleton)

```sh
#!/bin/sh
# POSIX/busybox only. Sources config + the dead-drop client's verify+dispatch helpers.
set -u
. /etc/sux-recovery.env            # SUX_RECOVERY_URL, RECOVERY_HMAC_SECRET, RECOVERY_NODE_ID, ...
: "${TICK:=30}" "${WDOG:=/dev/watchdog}"

# thresholds: consecutive failing ticks before that subsystem escalates
THRESH_wan=6 THRESH_dns=4 THRESH_lan=4 THRESH_ts=4 THRESH_proxy=6
fail_wan=0 fail_dns=0 fail_lan=0 fail_ts=0 fail_proxy=0
healthy_streak=0

# open the hardware watchdog once; keep the fd and write a keepalive each healthy tick
exec 9>"$WDOG" 2>/dev/null || true
pet() { echo 1 >&9 2>/dev/null || true; }

probe_wan()  { ping -c1 -W2 1.1.1.1 >/dev/null 2>&1 || ping -c1 -W2 9.9.9.9 >/dev/null 2>&1; }
probe_dns()  { nslookup cloudflare.com 127.0.0.1 >/dev/null 2>&1; }
probe_lan()  { ip addr show br-lan 2>/dev/null | grep -q '192\.168\.1\.1' && pgrep -x dnsmasq >/dev/null; }
probe_ts()   { tailscale status --json 2>/dev/null | grep -q '"BackendState":"Running"'; }
probe_proxy(){ pgrep -f suxproxy >/dev/null 2>&1; }

heal_wan()   { ifup wan; }
heal_dns()   { /etc/init.d/unbound restart; /etc/init.d/ctrld restart; }
heal_lan()   { uci set network.lan.ipaddr='192.168.1.1'; uci commit network; /etc/init.d/dnsmasq restart; /etc/init.d/odhcpd restart; }
heal_ts()    { /etc/init.d/tailscale restart; sleep 3; tailscale up 2>/dev/null; }
heal_proxy() { /etc/init.d/suxproxy restart; }

check() { # $1 name  $2 threshold-var  $3 probe  $4 heal
    name=$1; thr=$(eval echo \$THRESH_$1); fvar=fail_$1
    if $3; then eval $fvar=0; return 0; fi
    n=$(eval echo \$$fvar); n=$((n+1)); eval $fvar=$n
    logger -t suxwatch "$name DOWN (fail $n/$thr)"
    $4                                    # attempt the safe heal
    [ "$n" -ge "$thr" ] && return 2       # persistent → caller escalates
    return 1
}

escalate() { # $1 = which subsystem tipped over
    logger -t suxwatch "ESCALATE ($1)"
    /usr/sbin/recovery-checkin.sh || true          # phone home + pull signed cmds (verify+dispatch)
    # open temp WAN-SSH only if we can still reach the internet outbound
    probe_wan && open_wan_ssh_temp
    # last resort handled by a separate persistent-outage guard (see below)
}

open_wan_ssh_temp() { … uci firewall rule (key-only, alt port) + arm auto-close … ; }
close_wan_ssh()     { … remove the rule … ; }

# persistent total-outage guard → recovery-boot
outage_start=0
maybe_recovery_boot() {
    if ! probe_wan && ! probe_dns && ! probe_ts; then
        [ "$outage_start" = 0 ] && outage_start=$(date +%s)
        down=$(( $(date +%s) - outage_start ))
        if [ "$down" -ge 900 ]; then                 # 15 min all-down + heals failed
            logger -t suxwatch "LAST RESORT: bootnext NVMe recovery + reboot"
            efibootmgr --bootnext "$RECOVERY_BOOT_NUM"   # one-shot, not bootorder
            sync; reboot
        fi
    else outage_start=0; fi
}

while :; do
    esc=0
    check wan   THRESH_wan   probe_wan   heal_wan   || [ $? -eq 2 ] && esc="$esc wan"
    check dns   THRESH_dns   probe_dns   heal_dns   || [ $? -eq 2 ] && esc="$esc dns"
    check lan   THRESH_lan   probe_lan   heal_lan   || [ $? -eq 2 ] && esc="$esc lan"
    check ts    THRESH_ts    probe_ts    heal_ts    || [ $? -eq 2 ] && esc="$esc ts"
    check proxy THRESH_proxy probe_proxy heal_proxy || [ $? -eq 2 ] && esc="$esc proxy"

    if [ -n "${esc# }" ]; then
        healthy_streak=0
        for s in $esc; do escalate "$s"; done
        maybe_recovery_boot
    else
        healthy_streak=$((healthy_streak+1))
        [ "$healthy_streak" -ge 4 ] && { close_wan_ssh; outage_start=0; }
        pet                                    # only pet the HW watchdog when healthy
    fi
    sleep "$TICK"
done
```

*(Skeleton — the `check`/`||`/`$?` composition needs the usual careful busybox rewrite so `set -e` and the `|| [ $? -eq 2 ]` idiom behave; shown here for shape, not to paste. `resource`/temp probes and the WAN-SSH auto-close arming are elided.)*

### 3.3 watchcat (L1 backstop) — `/etc/config/system`

```
config watchcat
    option period      '30m'          # reboot if no reachability for 30 min
    option mode        'ping_reboot'
    option pinghosts   '1.1.1.1'
    option pingperiod  '60s'
    option force_delay '30'
```

Long window on purpose: `suxwatch` (L2) owns fast, surgical heals; watchcat only fires if the whole userspace path is wedged for half an hour. `luci-app-watchcat` lets Colin see/tune it.

### 3.4 hardware watchdog

`kmod-itco-wdt` loads `iTCO_wdt` → `/dev/watchdog`. **Disable `procd`'s own watchdog takeover** for this device (or let `suxwatch` be the sole writer) so there's exactly one petting owner. Timeout ~90 s. If `suxwatch` dies, procd respawns it (fast path); if the whole box hangs, ITCO reboots it (slow floor).

---

## 4. Composition with the existing recovery harness

`suxwatch` is the **box-side driver** that ties together the three lifelines already designed in the upgrade plan and PR #151:

- **Dead-drop (PR #151 / `feat/recovery-deaddrop`).** `suxwatch`'s `escalate` step just calls `recovery-checkin.sh`, which already does HMAC checkin + verify-and-dispatch of the Worker-signed allow-list (`open-wan-ssh`, `close-wan-ssh`, `restart-tailscale`, `restart-dns`, `restore-config`, `reboot`, `noop`). **We fill in the currently-no-op dispatch stubs** in that script with the same `heal_*` / `open_wan_ssh_temp` / `efibootmgr` functions `suxwatch` uses — one implementation, two callers (local autonomous heal + remote signed command). The Worker (`recovery.ts`) stays a dead-drop: it only stores health and vends signed intents; the box decides and acts.
- **Temp WAN-SSH.** Both the local escalation and a remote `open-wan-ssh` command converge on the same narrow, auto-closing firewall rule. Auto-close on `healthy_streak >= 4` guarantees it doesn't linger.
- **A/B recovery-boot.** `efibootmgr --bootnext` is the one-shot jump to the NVMe recovery image; primary boot resumes automatically after. The NVMe recovery image itself runs its own `suxwatch` + dead-drop, so even the B side phones home.
- **HW watchdog** is strictly below all of this — it doesn't know about services, only "is the box alive."

Escalation direction respects `safe-direction-autonomy`: everything `suxwatch` does autonomously is attention-increasing / reversible (restart, re-up, open-a-shell-for-a-human, one-shot-boot-into-known-good). The genuinely destructive moves (flash, reset) are never in its vocabulary — they require Colin at the console or the USB image.

---

## 5. Surviving an eMMC reflash

A sysupgrade or fresh USB install **wipes eMMC**. Persistence has three tiers (mirrors the upgrade plan's "bake-in + restore-from-NVMe"):

### 5.1 In the image / preserved by `sysupgrade.conf`
Add these to `/etc/sysupgrade.conf` (which already preserves `/etc/tailscale/`, `/opt/curl-impersonate*`, `/usr/sbin/ctrld`, `/etc/controld/ctrld.toml`, `/etc/init.d/{ctrld,suxproxy}`, `/srv/suxproxy`):

```
/usr/sbin/suxwatch
/etc/init.d/suxwatch
/usr/sbin/recovery-checkin.sh
/etc/sux-recovery.env          # 0600 — HMAC secrets, node id, Worker URL, RECOVERY_BOOT_NUM
/etc/config/watchcat           # (or the watchcat block in /etc/config/system)
```

For the **USB combined-EFI install image**, bake all of the above directly into the rootfs overlay so a clean install boots already self-healing (no first-boot window where the box is naked). `kmod-itco-wdt`, `watchcat`, `luci-app-watchcat`, `openssl-util`, `jq`, `curl` are baked package selections.

### 5.2 First-run bring-up — `/etc/uci-defaults/99-suxwatch`
Idempotent uci-defaults script (runs once on first boot after flash), so even a bare image self-configures:

```sh
# enable + start the self-heal service and its backstops
/etc/init.d/suxwatch enable  ; /etc/init.d/suxwatch start
uci -q get system.@watchcat[0] >/dev/null || { …seed watchcat block… ; uci commit system; }
# ensure the ITCO watchdog module is loaded on boot
grep -q iTCO_wdt /etc/modules.d/* 2>/dev/null || echo iTCO_wdt >> /etc/modules.d/99-watchdog
# if secrets/config are missing (fresh image), pull the last-good bundle from NVMe
[ -f /etc/sux-recovery.env ] || /usr/sbin/suxwatch-restore-from-nvme
exit 0
```

### 5.3 NVMe restore bundle (the belt to sysupgrade.conf's suspenders)
NVMe (`/mnt/nvme`) survives an eMMC wipe. Keep a versioned **last-good bundle** there so a *fresh* image (which gets no `sysupgrade.conf` carry-over) can self-restore:

```
/mnt/nvme/recovery/
├── suxwatch/                     # suxwatch + init + recovery-checkin.sh
├── sux-recovery.env             # 0600 secrets (NVMe is not in git, never leaves the box)
├── last-good-config.tar.gz      # `sysupgrade -b` snapshot = the restore-config target
├── payload/                     # curl-impersonate, ctrld, cloudflared, connector token
└── tailscale/                   # tailscaled.state + certs → same node id, no re-auth
```

A tiny `suxwatch-restore-from-nvme` helper (called from uci-defaults, and mapped to the dead-drop `restore-config` action) copies these into place and restarts services. This is exactly the `restore-config` rung of the escalation ladder — reflash-restore and mid-incident restore are the same code path. **Refresh the bundle whenever config changes** (a cron `sysupgrade -b /mnt/nvme/recovery/last-good-config.tar.gz` + rsync of the scripts, e.g. daily or post-deploy).

### 5.4 Persistence summary

| Artifact | eMMC (OS) | `sysupgrade.conf` (survives sysupgrade) | Baked in USB image | NVMe bundle (survives full wipe) |
|---|---|---|---|---|
| `suxwatch` + init | ✓ live | ✓ | ✓ | ✓ |
| `recovery-checkin.sh` | ✓ live | ✓ | ✓ | ✓ |
| `sux-recovery.env` (secrets) | ✓ live 0600 | ✓ | ✓ | ✓ (0600) |
| watchcat config | ✓ | ✓ | ✓ | via last-good-config |
| `iTCO_wdt` load | modules.d | ✓ | ✓ | uci-defaults reasserts |
| last-good config snapshot | — | — | — | ✓ (`restore-config` source) |
| Tailscale identity | `/etc/tailscale/` | ✓ | ✓ | ✓ |

Net: **sysupgrade** keeps everything via `sysupgrade.conf`; a **fresh USB install** boots with it baked in; a **catastrophic wipe with a naked image** self-restores from the NVMe bundle on first boot. Three independent ways the watchdog comes back.

---

## 6. Build order (when we implement — not now)

1. `suxwatch` script + `/etc/init.d/suxwatch` + config env; test each `probe_`/`heal_` in isolation on the box (probe-only, heals stubbed to `logger`).
2. Wire `heal_*` and the dead-drop dispatch stubs (`recovery-checkin.sh` currently no-ops) to the shared functions.
3. Arm `watchcat` (long window) + confirm `/dev/watchdog` exists and only `suxwatch` pets it.
4. Escalation ladder: dead-drop checkin (verify against live Worker), temp WAN-SSH open/auto-close, `efibootmgr --bootnext` (verify the NVMe recovery entry number first — **reproduce before theorize**: read `efibootmgr` output on the actual box).
5. Persistence: `sysupgrade.conf` additions, uci-defaults, NVMe bundle + refresh cron; verify by a test sysupgrade in the gated upgrade flow.

**Gate (per upgrade plan):** none of this flashes or reboots the box until the go/no-go gates pass and Colin confirms physical reach. Design + doc only for now.
