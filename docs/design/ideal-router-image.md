---
title: The ideal owl-tegu router image — master reference spec
status: designed
cluster: infrastructure
type: reference
summary: "Umbrella reference spec for the owl-tegu router image — the clean-image build, LuCI apps, Grafana observability, and watchdog workstreams that implement against it. Design/reference only; sux-tailscale + sux-cloudflare LuCI apps already built and merged."
tags: [sux, infrastructure, router]
updated: 2026-07-12
---

# The ideal owl-tegu router image — MASTER reference spec

**Status:** design only. No config changes on the box; no flash. This is the umbrella
spec that four downstream workstreams implement against:

1. the **clean image build** (`/etc/apk/world` + `sysupgrade.conf` + first-boot restore),
2. the separate **LuCI-apps** session (§3 is its build order) → **repo `colinxs/owl-tegu-luci`**; `sux-tailscale` + `sux-cloudflare` already built/merged/verified,
3. the **Grafana observability** design (`docs/design/observability-grafana.md`, §4),
4. the **DNS rework** (§2.1 is its spec).

Everything below is grounded against the **live box** (`root@100.98.238.70`, reproduced
2026-07-12), per [[reproduce-before-theorize]]. Taste is [[sux-engineering-taste]] (KISS,
80-20, obvious-good-not-best) and [[sux-design-verdict-2026-07]] (don't build the
framework). Guiding invariant from [[router-host-upgrade-plan]]: **the gateway role is
SACRED — compute/NAS/proxy must never destabilize home internet.**

---

## 0. The box (ground truth)

| | |
|---|---|
| Hardware | Protectli V1210 — Intel Celeron **N5105** (4c/4t), **3.7 GB** RAM, no swap |
| Storage | **29 GB eMMC** (`/dev/mmcblk0`, OS + `/dev/root` overlay) + **233 GB NVMe** (`/dev/nvme0n1p1`, ext4, UUID `d1e33113-8446-4217-a3c4-b247ebc1d44f`, mounted `/mnt/nvme`) |
| OS | OpenWrt **25.12.3** r32912, x86/64, kernel 6.12.85, apk pkg manager |
| Boot | legacy/CSM (BIOS), grub2-bios-setup; serial `ttyS0,115200n8` live |
| NICs | multi-port; `kmod-igc` (2.5GbE i225/226) + e1000e/igb/ixgbe/r8169/tg3 all in world |
| Roles live | gateway (`br-lan` 192.168.1.1/24 over eth0; wan=eth1 dhcp) · DNS · residential proxy (`/srv/suxproxy` S95) · Tailscale (exit node + subnet router, offering `0.0.0.0/0` + `192.168.1.0/24`) · cloudflared (tunnel `ac6f75fa…`, remotely-managed) · Docker 27.3.1 (root **still on eMMC** `/opt/docker`) · ksmbd (globals only, **0 shares**) · watchcat |

**Current package reality:** `/etc/apk/world` = 88 explicit pkgs, **294 installed**. The
box is a **parity superset** of what we want — it still carries crowdsec, samba4, nextdns,
adblock-fast, darkstat, collectd/luci_statistics, kadnode, einat, librespeed-go,
netspeedtest, filemanager, internet-detector, sqm, lldpd, nmap-full, and a redundant
`unbound`. The ideal image is **stock generic defaults + deliberate adds**, and most of
that list is a **deliberate drop** (§1.3).

---

## 1. Package set by role

Legend: **[O]** official OpenWrt feed (`apk add`) · **[C]** community feed (packages.o.o /
custom feed, still `apk add`) · **[P]** non-apk payload (baked into rootfs / restored from
NVMe, never an apk package).

Build the image from `/etc/apk/world`, **not** prose — snapshot lives at
`/mnt/nvme/recovery/apk-world.snapshot`. The list below is the curated *target* world.

### 1.1 Keep — the deliberate role set

**Base / stock generic (unchanged from default):**
`base-files kernel libc firewall4 fstools netifd procd-ujail dropbear uci mtd urngd
urandom-seed logd ppp ppp-mod-pppoe odhcp6c` — **[O]**. Plus the default NIC kmods
(`kmod-igc kmod-dwmac-intel kmod-e1000e kmod-igb kmod-ixgbe kmod-r8169 kmod-tg3
kmod-e1000 kmod-forcedeth`) — **[O]**, keep all (image must boot on any port).

| Role | Packages | Feed | Notes |
|---|---|---|---|
| **DNS** | `dnsmasq-full` · `odhcpd` | [O] | dnsmasq-full = DHCPv4 + local/home.arpa auth + conditional forward; odhcpd = DHCPv6 + RA/SLAAC. **Replaces the stock `dnsmasq`** (`-dnsmasq dnsmasq-full`). |
| | `ctrld` (Control D daemon) | [P] | `/usr/sbin/ctrld` + `/etc/controld/ctrld.toml`. Front `:53` resolver (§2.1). Baked payload; not in feeds. |
| | `ip6neigh` (+ `luci-app-ip6neigh` if it lands) | [P] | v6→MAC→hostname naming so v4+v6 share one device name (§2.3). **Verified NOT in 25.12.3 feeds** — vendored shell payload; re-check feeds each build. |
| **Mesh / reach** | `tailscale` · `luci-app-sux-tailscale` | [O]/[C] | subnet router + exit node. Identity is `/etc/tailscale/` (§4/persistence). **App BUILT** (owl-tegu-luci) — replaces `luci-app-tailscale-community`. |
| | `cloudflared` · `luci-app-sux-cloudflare` | [O]/[C] | `cloudflared` **is** an official pkg (`net/cloudflared`). Render data-plane + OOB. Token is [P] (out of git). **App BUILT** (owl-tegu-luci) — replaces `luci-app-cloudflared`. |
| **Web / mgmt** | `luci` · `luci-ssl` · `luci-app-firewall` · `luci-app-attendedsysupgrade` | [O] | luci-ssl (currently missing — box serves plain uhttpd); attendedsysupgrade drives the ASU image build. |
| **NAS** | `ksmbd-server` · `luci-app-ksmbd` | [O] | kernel SMB3 server on the NVMe (§2.2). **Replaces samba4.** |
| **NAT-PMP/PCP/UPnP** | `miniupnpd-nftables` · `luci-app-upnp` | [O] | **KEEP** (already live, S94, fw4-native). **Needed for Tailscale NAT traversal** — the gateway offering NAT-PMP/PCP lets LAN tailnet peers (iPhone, MacBook) obtain port mappings and establish **direct** connections instead of relaying through DERP. (Corrects the earlier drop; Colin, 2026-07-12: "we need pmp for tailscale nat.") Optional hardening: restrict to NAT-PMP/PCP + disable UPnP-IGD's arbitrary LAN port-punching if desired. |
| **Console** | `ttyd` · `luci-app-ttyd` | [O] | browser shell (currently config present, app not in world — add the LuCI app). |
| **Watchdog** | `watchcat` · `luci-app-watchcat` · `kmod-itco-wdt` | [O] | L1 dumb-timer + HW `/dev/watchdog` floor. Brain = `suxwatch` [P] (router-watchdog.md). |
| **Docker host** | `docker` · `dockerd` · `docker-compose` · `containerd` | [O] | + `kmod-veth kmod-br-netfilter kmod-nf-nat kmod-nft-offload` for container networking. data-root → NVMe (§2.4). |
| **Storage** | `parted partx-utils` · `f2fs-tools mkf2fs` · `e2fsprogs resize2fs` · `kmod-fs-ext4` · `blkid losetup blkid` · `nvme-cli` | [O] | manage/grow the NVMe; `nvme-cli` (**add** — currently absent) for SMART/health. ext4 is the live NVMe fs; keep f2fs tools for flexibility. |
| **Perf** | `kmod-tcp-bbr` · `irqbalance luci-app-irqbalance` · `intel-microcode` · `cpu-perf luci-app-cpu-perf` | [O] | BBR (**add** — not in world; pairs with SQM/2.5GbE), irqbalance across the 4 cores, microcode, cpufreq governor. |
| **Tools** | `curl wget-ssl ca-bundle jq bash openssl-util ip-full ethtool tcpdump bind-dig coreutils gawk grep sed findutils` | [O] | the shell/diagnostic floor `suxwatch` + dead-drop rely on. |
| **Proxy** | `curl-impersonate` + `suxproxy` | [P] | `/opt/curl-impersonate*` + `/srv/suxproxy` + `/etc/init.d/suxproxy`. Residential-IP data plane. |

### 1.2 Conditional adds (only if a downstream design pulls them)

- **`collectd` + `luci-statistics` (+ the collectd-mod-* probes)** [O] — **only** if the
  Grafana design (§4) elects the collectd→Prometheus path. Default is the pull model
  (node_exporter-style / textfile), so **collectd stays OUT** unless
  `observability-grafana.md` says otherwise. One source of truth for that decision lives
  there, not here.
- **`sqm-scripts` + `luci-app-sqm`** [O] — keep only if bufferbloat on the WAN is real;
  it's live today. Low-cost, defensible. Tag **keep-if-used**, else drop.
- **`lldpd` + `luci-app-lldpd`** [O] — neighbor discovery; nice-to-have, not core. Drop
  unless the NAS/switch topology work wants it.

### 1.3 EXCLUDE — the dropped cruft (explicit)

These are on the live box and **must not** be in the ideal world. Each is redundant with a
kept component or a toy:

| Dropped | Why |
|---|---|
| **`unbound` / `unbound-control` / `luci-app-unbound`** | **The DNS rework kills it (§2.1).** Redundant recursion; today it's the front `:53` resolver with **four competing `.` forward-zones** (google `fwd_google`, adguard `fwd_adguardpersonal`, nextdns `fws_nextdns`, cloudflare-ZT `fwd_cfzt`) — incoherent cruft. ctrld+dnsmasq subsume it. |
| **`nextdns`** (+ config) | Superseded by Control D (`ctrld`). One upstream filtering provider, not two. |
| **`adblock-fast`** | ctrld/Control D does the blocking upstream. No on-box blocklist engine. |
| **`crowdsec`** | Heavy IDS/agent on the SACRED gateway — attack surface + RAM for near-zero benefit on a 1-user LAN. Drop. |
| **`einat`** (+ config) | eim/full-cone NAT helper; drop the extra NAT hack — miniupnpd's NAT-PMP/PCP covers the port-mapping needs (incl. Tailscale). |
| **`kadnode`** (+ config, S95) | DHT/DNS-over-Kademlia toy. Not a role. Drop. |
| **`samba4`** (+ config) | **Replaced by `ksmbd`** (kernel SMB3, faster on the 2.5GbE NVMe path, far lighter). Never run both. |
| **`darkstat`** | Ancient traffic-accounting toy; Grafana/vnstat is the answer if we want traffic history. Drop. |
| **`collectd` / `luci_statistics`** | Drop **unless** §4 elects it (see §1.2). Not committed by default. |
| **`librespeed-go` / `netspeedtest` / `luci-app-netspeedtest`** | Speedtest toys. Run a speedtest ad-hoc; don't ship a daemon. Drop. |
| **`filemanager` / `luci-app-filemanager`** | ttyd + SMB cover file access. Drop the web file browser. |
| **`internet-detector` / `luci-app-internet-detector`** | `suxwatch` (router-watchdog.md) owns reachability detection. One detector, not two. Drop. |
| **`nmap-full`** | 20 MB scanner; install ad-hoc when needed, not baked. Drop. |
| **`luci-app-commands` / `luci-app-ipinfo` / `luci-app-log-viewer` / `luci-app-cpu-perf`(app)** | Keep only ones a §3 surface actually uses; the rest are LuCI clutter. `log-viewer` is defensible; `commands`/`ipinfo` drop. |

**Net:** ~88 explicit → target ~55-60 explicit. The image gets *smaller and more
coherent*, not bigger.

---

## 2. Config architecture (the real design work)

### 2.1 DNS REWORK — ctrld front, dnsmasq DHCP+local, odhcpd v6, DROP unbound

**The structural tension (Colin, 2026-07-12):** he wants the Control D **Clients** feature
(per-device reporting) *and* likes unbound's caching / prefetch / serve-stale. These fight:

- **Clients needs ctrld as the front `:53` resolver** so it sees each client's real source
  IP (ctrld maps IP→device and tags the query to Control D). unbound-in-front → ctrld sees
  only `127.0.0.1` → per-device dies. unbound-behind-ctrld → ctrld's upstream is unbound,
  not Control D → the client tag never reaches Control D. **Mutually exclusive.**
- **Any cache hit (ctrld's or unbound's) never reaches Control D** — the maintainer is
  explicit: records served from ctrld cache do **not** appear in Control D Analytics.
  Filtering/verdicts still apply (cached), but heavy caching **thins per-device
  reporting**. Caching and complete reporting are inherently in tension, whichever resolver
  caches.

**Verified ctrld cache capability** (ctrld `docs/config.md`, `[service]` block — grounded
via the repo, not assumed):

| Option | Effect | vs unbound |
|---|---|---|
| `cache_enable = true` | turn the in-proc cache on | = unbound cache |
| `cache_size = N` (records) | ≥4096 recommended; invalid value silently disables cache | = unbound `msg-cache` |
| `cache_ttl_override = S` | force all TTLs to S seconds (raise cache hit rate) | ≈ unbound `cache-min-ttl` |
| `cache_serve_stale = true` | serve stale records **only when upstream is unreachable** | weaker than unbound `serve-expired` (unbound serves stale *proactively* while it refreshes) |
| — **no prefetch** — | ctrld has **no** active prefetch/refetch option | **the one genuine loss vs unbound** |

So ctrld can get *close* to unbound (large cache + ttl_override + serve-stale-on-failure)
but **cannot** do unbound's *active prefetch* (refresh popular records before they expire so
users never wait). That is the only real caching capability lost.

**RECOMMENDED (primary) — ctrld front, drop unbound.** Per-device reporting is the feature
Colin *definitely* wants; prefetch is a latency nicety. Take Clients; tune ctrld's cache as
hard as it allows; accept the loss of active prefetch and the caching↔reporting tradeoff.

**Cache tuning stance under the recommended path:** don't crank `cache_ttl_override` high —
that *maximizes* cache hits and therefore *minimizes* per-device reporting, defeating the
reason we chose ctrld-front. Keep caching modest (`cache_enable=true`, `cache_size=8192`,
**no** aggressive `cache_ttl_override`, `cache_serve_stale=true` purely as an
upstream-outage resilience net). Reporting completeness > cache hit rate here, by design.

**EXPLICIT ALTERNATIVE (Colin's either/or) — unbound front, coarse reporting.** If rich
caching + active prefetch matters more than *complete* per-device reporting: keep
unbound-front (recursion + prefetch + proactive serve-stale) and let Control D see only
router-level, aggregated queries via ctrld as unbound's forwarding upstream. You still get
Control D *filtering* and coarse analytics, just not per-device attribution. This is a real
either/or — **Colin's call**; the recommended path assumes he prioritizes Clients.

**Colin action (not a code change):** the Clients feature must also be **enabled in the
Control D dashboard** (Profile → Clients / device-level analytics) — the `ctrld` side is
necessary but not sufficient. Flag this as a manual step before per-device data appears.
ctrld's `discover_refresh_interval` (default 120s) governs how fast it learns new
client→device mappings; lower it if new devices should appear faster.

**Current (broken/incoherent) chain — reproduced live:**
```
:53   unbound      ← front resolver, recurses, with 4 conflicting `.` forward-zones
:1053 dnsmasq-full ← DHCPv4 + home.arpa local + authoritative
:5354 ctrld        ← Control D DoH client, NOT in the client resolution path
:53?  odhcpd       ← DHCPv6/RA (maindhcp=1)
```
ctrld runs but nothing points at it → **Control D per-device reporting is effectively off**
and there are four upstreams fighting for `.`. This is the mess the rework fixes.

**Target chain:**
```
                       ┌──────────────────────────────────────────────┐
 LAN clients ──:53──▶  │ ctrld  (listener 0.0.0.0:53)                  │
 (DHCP hands out       │  • Control D upstream (DoH dns.controld.com/  │
  192.168.1.1 as the   │    l554pnhobf) → per-device reporting via the │
  only resolver)       │    Clients feature (learns client IP/MAC)     │
                       │  • captive-portal policy = pass-through       │
                       │    (the 46 SSID/portal domains, unchanged)    │
                       │  • split: home.arpa + PTR/RA names ──────────┐│
                       └──────────────────────────────────────────────┘│
                                                          forwards local│
                       ┌──────────────────────────────────────────────┼┐
 DHCPv4 + local  ◀────│ dnsmasq-full (listener 127.0.0.1:5353)        ││
 names               │  • authoritative for home.arpa                 ◀┘│
                     │  • DHCPv4 server (range .100–.249, leases)     ││
                     │  • reads /etc/ethers, PTR for LAN              ││
                     │  • NO upstream recursion (noresolv), local-only││
                     └────────────────────────────────────────────────┘│
                       ┌──────────────────────────────────────────────┐│
 DHCPv6/RA/SLAAC ◀────│ odhcpd (maindhcp=1)  — unchanged              ││
                     │  • RA (other-config flag, per this session)    ││
                     │  • ::/64 delegation, DNS=RA (192.168.1.1)     ││
                     └────────────────────────────────────────────────┘
                                     unbound: DELETED
```

**Why ctrld on `:53` (not dnsmasq-front):** the *point* of Control D is per-device
reporting + upstream filtering + the captive-portal bypass policy. ctrld must be the client-
facing resolver so it sees each client's query (the **Clients** feature maps LAN IP→device
in the Control D dashboard) and so its captive-portal policy actually intercepts. dnsmasq
can't do Control D. unbound as a front just hides clients behind one IP and adds a
redundant recursion hop.

**Only genuine loss vs today:** unbound's *active prefetch* (verified: ctrld has no
prefetch option). ctrld's large cache + serve-stale-on-outage recover most of the rest.

**Why keep dnsmasq for local + DHCP (not fold into ctrld):** ctrld is not a DHCP server and
has weak local-zone support. dnsmasq-full remains the DHCPv4 authority and the
`home.arpa` / PTR name server. ctrld's config gets a **split/local-upstream** entry so
`home.arpa` and reverse zones resolve against dnsmasq at `127.0.0.1:5353`; everything else
goes to the Control D DoH upstream.

**Concrete listener/split config:**

`ctrld` (`/etc/controld/ctrld.toml`, [P] — currently `port = 5354`, captive policy already
present and **preserved verbatim**):
```toml
[service]
  cache_enable       = true
  cache_size         = 8192        # ~2× the 4096 floor; RAM is ample (3.7 GB)
  cache_serve_stale  = true        # serve stale ONLY on upstream outage (resilience net)
  # cache_ttl_override intentionally UNSET — high override = fewer per-device reports
  # discover_refresh_interval = 120  # lower to learn new client→device faster

[listener]
  [listener.0]
    ip   = '0.0.0.0'
    port = 53                      # ← was 5354; ctrld becomes the front resolver
    [listener.0.policy]
      name = 'My Policy'
      # captive-portal pass-through rules UNCHANGED (46 domains: captive.apple.com,
      # *.network-auth.com, neverssl.com, airline/rail wifi, detectportal.firefox.com …)
      # split: send local zones to dnsmasq, everything else upstream
      networks = []                # (client-net rules unchanged)

[upstream]
  [upstream.0]                     # Control D — unchanged
    type = 'doh'
    endpoint = 'https://dns.controld.com/l554pnhobf'
    bootstrap_ip = '76.76.2.22'
    timeout = 5000
  [upstream.local]                 # local resolver for home.arpa + PTR
    type = 'legacy'
    endpoint = '127.0.0.1:5353'
    timeout = 2000

# domain→upstream routing: home.arpa and reverse zones → local dnsmasq
[listener.0.policy]                # (rule form; exact schema per ctrld version)
  # 'home.arpa'  → upstream.local
  # '*.in-addr.arpa' / '*.ip6.arpa' → upstream.local
```

`dnsmasq` (`/etc/config/dhcp`, [O]) — move it **off `:53`-nothing to an explicit local
port, keep DHCP + local authority:**
```
config dnsmasq
    option port          '5353'          # local-only; ctrld is the client-facing :53
    option localservice  '1'             # only answer on LAN/loopback
    option domain        'home.arpa'
    option local         '/home.arpa/'
    option authoritative '1'
    option expandhosts   '1'
    option readethers    '1'
    option noresolv      '1'             # no upstream recursion here — ctrld owns upstream
    option rebind_protection '1'
    list  interface      'lan'
    # (DHCPv4 pools, dhcp_option, ntp etc. unchanged from live)
```
`odhcpd` (`/etc/config/dhcp` `config odhcpd`) — **unchanged** (`maindhcp '1'`,
`dhcpv4_forcereconf '0'`, `leasetrigger` retargeted off unbound's odhcpd.sh to a no-op or
dnsmasq host-file hook). RA flags stay `other-config` (this session's fix).

**Migration guardrails (SACRED):** DNS is the one change that can black-hole the whole
house. Roll it as: (1) stage ctrld on `:53` while dnsmasq still answers `:53` on a *second*
test → verify `nslookup` for both a public name (Control D path) and `router.home.arpa`
(dnsmasq path); (2) only then flip DHCP to hand out 192.168.1.1 as sole resolver; (3)
`suxwatch`'s DNS probe (`nslookup cloudflare.com 127.0.0.1`) + heal (`restart ctrld →
restart dnsmasq`) is the safety net. Keep the pre-change `/etc/config/{dhcp,unbound}` in
the NVMe last-good bundle for one-command revert.

### 2.2 ksmbd NVMe share — SMB3, tuned for 2.5GbE

Kernel SMB (`ksmbd`) over samba4: in-kernel SMB3 has far lower CPU per byte and higher
throughput on the N5105 + 2.5GbE path, and a much smaller footprint — the right 80-20 for a
NAS bolted onto a router. Tradeoff: ksmbd is younger and has a smaller feature set (no
full AD DC, thinner ACL story) — fine for a single-user home share; we are not a domain
controller.

Current live: `config globals` only, **zero shares**. Add a share rooted on the NVMe:

`/etc/config/ksmbd`:
```
config globals
    option workgroup              'WORKGROUP'
    option description            'owl-tegu NAS'
    option interface              'lan'          # never bind wan
    option allow_legacy_protocols '0'            # SMB3-only (drop SMB1/2 — was '1')
    option smb_neg_timeout        '20'

config share
    option name        'nvme'
    option path        '/mnt/nvme/samba'         # dir already exists on the NVMe
    option read_only   'no'
    option guest_ok    'no'
    option create_mask '0644'
    option dir_mask    '0755'
    option force_root  '1'                        # single-user box; skip user-map churn
    # perf: large IO + multichannel on the 2.5GbE link
    option smb3_multi_channel  'yes'
    option force_streams       'no'
    option vfs_objects         ''                 # no recycle/catia unless needed
```
Perf knobs (ksmbd.conf-level, set via the share/globals options the LuCI app exposes):
`max read/write size` large (1 MB), `smb3 multi channel = yes` (the 2.5GbE NIC + client
NIC can bond streams), `oplocks = yes`. Bind **only** to `lan` (never `wan`/`tailscale`
unless deliberately sharing over the tailnet). Firewall: no new open ports on wan; SMB
stays LAN-only.

### 2.3 IPv4/IPv6 client correlation + friendly hostnames

**Goal (Colin):** one physical device's **IPv4** (DHCPv4) and **IPv6** (SLAAC + DHCPv6,
including privacy/temp addresses) resolve to the **same friendly hostname**, and Control D
**Clients** + logs/Grafana attribute *both* address families to one named device. Today the
v6 side is nameless — the live NDP table shows raw addresses like
`2601:601:a484:1500:9930:28c0:425f:a244` with no PTR, and multiple v6 addresses per MAC
(privacy addressing in action, e.g. several addrs behind `a8:51:ab:93:38:16`).

**The correlation-key nuance (why DUID is not enough):**

- **DUID** identifies a *DHCPv6* client, and DUID-LL/LLT often embeds the MAC — but it only
  exists for devices that actually do DHCPv6. **SLAAC and RFC-4941 privacy/temporary
  addresses have NO DUID** (they're self-assigned, never touch the DHCPv6 server). A
  DUID→lease match therefore names only the DHCPv6 subset and **misses every SLAAC/privacy
  address** — which, per the live NDP dump, is most of the v6 traffic here.
- The **robust key is the MAC via the neighbor table (NDP for v6 / ARP for v4)**. Every v6
  address a device uses — SLAAC, privacy, temporary, link-local, *and* any DHCPv6 lease —
  shows up in the NDP table bound to that device's MAC (`ip -6 neigh` confirms
  `<v6addr> … lladdr <mac>`). The same MAC is the key in the DHCPv4 lease. **MAC is the one
  identifier that spans v4 + all v6 forms;** DUID is a partial view.

**Mechanism — `ip6neigh`.** ip6neigh is the purpose-built OpenWrt tool for exactly this: a
daemon that **monitors the IPv6 NDP table**, maps each `v6 → MAC → DHCPv4-lease hostname`,
and writes **forward (AAAA) + reverse (PTR)** records into dnsmasq so every v6 address gets
the device's friendly name. It **labels SLAAC vs privacy/temporary** addresses (e.g.
`hostname.lan`, `hostname-tmp.lan`, `hostname-ll.lan`), so it covers DHCPv6 **and** SLAAC
**and** privacy — precisely the coverage DUID-matching alone cannot reach. It's the
NDP/MAC-based approach the nuance above demands, packaged.

**Feed availability (verified on the live 25.12.3 box, reproduce-before-theorize):**
`apk search ip6neigh` and `apk search luci-app-ip6neigh` both return **empty** — ip6neigh is
**NOT in the 25.12.3 apk feeds** (neither official nor the community feed the box currently
has enabled). Treat it as a **[P] payload**: install the ip6neigh shell package from source
(the `hnyman`/`AndreBL` project — pure POSIX-sh + a dnsmasq hook, no compiled deps, so it
drops onto OpenWrt cleanly) and bake it into the image + the NVMe recovery bundle, exactly
like `ctrld`/`suxproxy`. **Build-time check:** re-verify each image build whether a
25.12.3-compatible ip6neigh apk has appeared in a community feed; prefer the packaged form
if it lands, else ship the vendored script. (If ip6neigh proves unmaintained for 25.12.3,
the fallback is a small local `ip -6 neigh` → dnsmasq-hosts script doing the same
MAC-join — but ip6neigh already handles the privacy-label edge cases, so don't reinvent it
unless forced.)

**Concrete config + how it feeds the rest of the design:**

`/etc/config/ip6neigh` ([P]):
```
config ip6neigh 'config'
    option domain          'home.arpa'      # match dnsmasq's local domain (§2.1)
    option ll_label        'LL'             # link-local suffix label
    option ula_label       ''               # ULA gets the plain name (fdf7:c24e:499::/48)
    option gua_label       ''               # global SLAAC gets the plain name
    option tmp_label       'TMP'            # RFC-4941 privacy/temp addresses → name-TMP
    option unknown         '1'              # synthesize names for un-leased MACs too
    option fritzbox        '0'
    option dhcpv6_names     '1'             # also name DHCPv6-leased addrs
    option dhcpv4_names     '1'             # ← the join: reuse the DHCPv4 lease hostname
    option load_static      '1'
```

**Data flow (one coherent chain):**
```
 DHCPv4 lease (dnsmasq)  ──hostname+MAC──┐
                                         ▼
 ip -6 neigh (NDP) ──v6+MAC──►  ip6neigh  ──writes AAAA+PTR (name, name-TMP, name-LL)──►
                                         │      dnsmasq hosts dir (/tmp/hosts/*)
                                         ▼
                          dnsmasq (§2.1, :5353) now authoritative for BOTH
                          v4 (A/PTR from leases) and v6 (AAAA/PTR from ip6neigh)
                          under the SAME home.arpa name
                                         ▼
             ctrld (front :53) forwards home.arpa/PTR → dnsmasq (upstream.local),
             and correlates a device's v4+v6 queries by MAC via ARP/NDP for the
             Control D **Clients** feature → one named device in the dashboard
                                         ▼
             Grafana / logs read the same consistent hostname → per-device panels
             are readable ("colin-iphone") instead of raw v6 hex
```

- **dnsmasq owns DHCPv4 leases + local names** (§2.1) — the authoritative source of the
  friendly hostname and the MAC↔name↔v4 binding.
- **ip6neigh names the v6 side consistently** by joining NDP-derived `v6→MAC` to that same
  dnsmasq lease, writing records back into dnsmasq's hosts dir (live: `/tmp/hosts/`). One
  name, all address families, privacy addresses labeled not dropped.
- **ctrld (front) correlates v4+v6 by MAC via ARP/NDP** for Control D Clients; because
  ip6neigh has already given every v6 address the device's real hostname, the Control D
  per-device dashboard **and** Grafana render `hostname`, not opaque hex — the whole point.

**Ordering / dependency:** ip6neigh must start after dnsmasq (needs the lease file) and
re-run its hook on NDP changes; its records live in dnsmasq's hosts dir, so a dnsmasq
restart (a `suxwatch` DNS heal) must not clobber them — point ip6neigh at a persistent
hosts file it re-owns, and add it to `sysupgrade.conf` + the NVMe bundle so names survive a
reflash. This is additive to the DNS rework (§2.1), touches only naming, and never affects
resolution correctness if it fails (worst case: v6 goes back to nameless — a cosmetic
degrade, safe for the SACRED path).

### 2.4 Docker data-root → NVMe + fstab + recovery hook

**The invariant (from the upgrade plan): docker data MUST move off the 29 GB eMMC.** Live
box still has `Docker Root Dir: /opt/docker` (eMMC) — the render container would fill eMMC
and can wear it. `/mnt/nvme/docker` already exists.

`/etc/config/dockerd`:
```
config globals 'globals'
    option data_root '/mnt/nvme/docker/'     # ← was /opt/docker/ (eMMC)
    option log_level 'warn'
    option iptables  '1'
config firewall 'firewall'
    option device 'docker0'
    list blocked_interfaces 'wan'            # keep — containers never exposed to wan
```
Migration: `/etc/init.d/dockerd stop` → move/rsync existing `/opt/docker` → set data_root →
start. (One-time; the render container is fresh anyway.)

`fstab` (`/etc/config/fstab`) — the NVMe mount by **UUID** (already correct on the live box,
`d1e33113-…`, target `/mnt/nvme`, `enabled 1`). Keep `auto_mount`/`check_fs`. Because
docker data-root now depends on this mount, add ordering: dockerd must start **after**
`/mnt/nvme` is mounted (procd dependency or a `block mount` gate in the init). This is the
one hard coupling — a failed NVMe mount must **fail docker closed**, never silently recreate
data on eMMC.

**Recovery/restore hook:** the NVMe holds `/mnt/nvme/recovery/` (last-good config bundle,
payload, tailscale identity, apk-world snapshot — already populated: `recovery/`, `build/`,
the emmc dd image, the combined-EFI image). On first boot after a flash, the
`uci-defaults` restore hook (router-watchdog.md §5.2) reasserts data_root, remounts NVMe,
and restarts docker. Docker data itself lives on NVMe → **survives an eMMC reflash for
free** (no restore needed for container volumes, only the daemon config).

---

## 3. LuCI app inventory — the SPEC for the LuCI-apps session

Quality bar: **OPNsense's firewall + dashboard UX** — a real-time dashboard with live
throughput/latency/service tiles, a firewall UI where rules read clearly and live state is
visible. LuCI is further from that; the goal is to *close the gap on the surfaces we run*,
not to reskin all of LuCI.

| Surface | App | Feed | Verdict |
|---|---|---|---|
| **Cloudflare tunnel** | `luci-app-sux-cloudflare` | [C] | **BUILT** (owl-tegu-luci, merged). Went beyond adopt-official: integrates the `Router` tunnel, decodes tunnel-id from the token (no secret leak), ready-connection count via the local `/ready` metrics, start/stop/restart. Verified live (4 connections). Supersedes the "adopt `luci-app-cloudflared`" call. |
| **Tailscale** | `luci-app-sux-tailscale` | [C] | **BUILT** (owl-tegu-luci, merged). The "improve" goal delivered as a clean rebuild of the community app: exit-node use/advertise, advertised routes, peer list, auth — readable, least-privilege ACL, no browser-side DERP fetch. Verified live. Supersedes "adopt+improve `luci-app-tailscale-community`". |
| **NAS / ksmbd** | `luci-app-ksmbd` | [O] | **ADOPT.** Official share editor. Adequate — expose the perf knobs (§2.2) in the form if not already. |
| **Firewall** | `luci-app-firewall` | [O] | **ADOPT + accept limits.** Stock fw4 UI. Don't rebuild — OPNsense-grade firewalling is out of scope. Add zone-labels clarity only if trivial. |
| **DNS / Control D** | *(none)* | — | **BUILD (thin).** No LuCI app for ctrld exists. Build a small status panel: front-`:53` resolver = ctrld (up/down, upstream reachable), captive-policy active, dnsmasq local/DHCP health, "who's my upstream" one-liner. This is the highest-value custom surface — DNS is the reworked, least-visible subsystem. Keep it read-mostly; config edits stay in the toml/uci. |
| **Diagnostics / traffic** | `luci-app-log-viewer` (+ vnstat if added) | [O] | **ADOPT log-viewer; traffic history → Grafana.** Don't ship darkstat/collectd for graphs; point live traffic at the Grafana story (§4). A simple live-throughput tile can go on the sux dashboard. |
| **Unified sux dashboard** | *(none)* | — | **BUILD.** One LuCI "sux" tab that composes: WAN/LAN up + throughput, DNS (ctrld/dnsmasq), Tailscale (exit-node/routes), cloudflared tunnel, Docker (render container state), NAS (share + NVMe free/SMART), watchdog/`suxwatch` state, and a **link out to Grafana + the Worker `/health` hub**. This is the OPNsense-dashboard analog and the single pane. Aggregates data the other apps already expose — **compose, don't duplicate**. |
| **Observability / Grafana** | *(link, not app)* | — | **LINK only.** No LuCI Grafana app — the sux dashboard links to the external Grafana + Worker `/health` (§4). Don't embed. |
| **ttyd console** | `luci-app-ttyd` | [O] | **ADOPT.** Browser shell; official. |
| **Watchcat** | `luci-app-watchcat` | [O] | **ADOPT.** Tune the L1 window; `suxwatch` state shows on the sux dashboard. |
| **Attended sysupgrade** | `luci-app-attendedsysupgrade` | [O] | **ADOPT.** Drives the ASU clean-image rebuild. |

**Build list for the LuCI session (in priority order):**
- ✅ **`luci-app-sux-cloudflare`** — BUILT & merged (owl-tegu-luci #2), verified live.
- ✅ **`luci-app-sux-tailscale`** — BUILT & merged (owl-tegu-luci #1), verified live (satisfies the "improve Tailscale" item).
- ⬜ (1) the **sux unified dashboard** (the pane, composes everything) — next.
- ⬜ (2) the **DNS/Control-D status panel** (the one dark subsystem) — highest-value custom surface after the dashboard.

The remaining "build" items are **read-mostly status views** — they must never mutate the
SACRED subsystems from the web UI without an explicit confirm. The shipped apps live in the
**owl-tegu-luci** repo (modern JS view + ucode RPC; app anatomy + dev loop in its
`docs/design.md`); bake them into the image via the package/overlay list (§1.1).

---

## 4. Observability hook — one story, no duplication

Three signal planes already exist; the rule is **connect, don't invent** (per
`generalized-watchdog-debug.md` and [[sux-design-verdict-2026-07]]):

```
  router (owl-tegu)          Grafana stack                Worker /health hub
  ─────────────────          ─────────────                ──────────────────
  suxwatch probes ──┐        Loki  = logs                 gatherHealth() aggregates:
  (DNS/WAN/LAN/TS/  │        Prom  = metrics                • CF bindings/cron/metrics
   proxy/docker/NAS)│                ▲                       • Tailscale nodeStatus
                    │  metrics push  │                       • recovery:status:<node> KV
  dead-drop checkin ┼───────────────►│                              ▲
  (HMAC, health up, │  (node metrics)│         signed checkin       │
   cmds down) ──────┼────────────────┼──────────────────────────────┘
                    │                │
  LuCI sux dashboard├──── links ─────┴──── links ──► Grafana + /health (read planes)
```

**Division of labor (no overlap):**
- **Router `suxwatch`** = the box-side self-heal brain (router-watchdog.md). It *detects
  and heals* in the safe direction and *reports* health two ways: (a) into the signed
  dead-drop checkin (→ Worker `recovery:status:*` KV → `/health`), and (b) as metrics for
  Grafana (node/service gauges). It is **not** a dashboard.
- **Grafana** = the **history/metrics** plane (Loki logs + Prom metrics). The router emits
  node + service metrics here. **The collectd-vs-pull decision lives in
  `observability-grafana.md`, not this doc** — this spec only reserves the hook: if that
  design picks collectd, §1.2 pulls `collectd`+`luci-statistics` into the world; if it
  picks a pull/textfile exporter, they stay out. One decision, one owner.
- **Worker `/health`** = the **presence/status hub** (read plane) + GitHub Issues = the
  **escalation queue**. The router's health reaches it via the dead-drop checkin KV, which
  `gatherHealth()` surfaces as a `router` component with derived staleness. This is the
  cross-tier single pane for an operator/agent.
- **LuCI sux dashboard** (§3) = the **on-box** live view; it **links out** to Grafana
  (history) and `/health` (cross-tier) rather than re-implementing either.

**No duplication rule:** metrics history = Grafana only; cross-tier presence = `/health`
only; on-box live = LuCI dashboard only; the box→cloud channel = the dead-drop only. The
watchdog (`suxwatch`) is the *producer*; the three panes are *consumers*. Nothing commits a
status file to git ([[autonomous-pipeline-lessons]] #1). One HW watchdog owner
(`kmod-itco-wdt`, petted only by `suxwatch`).

---

## 5. Phased build order

The **DNS rework and the docker-root move are the two changes that touch the SACRED path** —
they gate on the router-watchdog + recovery harness being live first, and on the
[[router-host-upgrade-plan]] go/no-go gates (dd backup verified, lifelines up, Colin
physically present). Order:

1. **Curate the world.** Reconcile `/etc/apk/world` → the §1 target (drop §1.3, add
   luci-ssl / kmod-tcp-bbr / nvme-cli / kmod-veth+br-netfilter). Rebuild the ASU/USB
   combined-EFI image from the *curated* world. Snapshot to `/mnt/nvme/recovery/`.
   *(No box mutation — image build only.)*
2. **Recovery + watchdog first** (router-watchdog.md build order §6): `suxwatch` +
   dead-drop dispatch + watchcat window + `kmod-itco-wdt` + NVMe last-good bundle. This is
   the safety net that must exist **before** touching DNS.
3. **Docker data-root → NVMe** (§2.4) + fstab ordering. Reversible, off the DNS path;
   verify render container runs from NVMe.
4. **ksmbd share** (§2.2). Additive, LAN-only, zero risk to gateway/DNS.
5. **DNS rework** (§2.1) — the delicate one. Stage ctrld:53 + dnsmasq:5353 side-by-side,
   verify both resolution paths, *then* flip DHCP, *then* delete unbound. `suxwatch` DNS
   heal armed. Keep pre-change configs in the NVMe bundle for one-command revert.
6. **LuCI surfaces** (§3, separate session): sux dashboard → DNS/Control-D panel →
   Tailscale app improvements. Read-mostly.
7. **Observability wiring** (§4, per `observability-grafana.md`): confirm suxwatch metrics
   land in Grafana + checkin health lands in `/health`. No new plane.

Each step lands **green and reversible** before the next (one change per cycle). The clean
image (step 1) is the reference the flash consumes; steps 3-5 can also be applied in-place
to the running box under the recovery net.

## 6. NOT building (explicit)

Refusing the temptations, per [[sux-design-verdict-2026-07]] + [[sux-engineering-taste]]:

- **No second filtering/DNS provider on the box.** ctrld/Control D is the one upstream —
  no nextdns, no adblock-fast, no on-box blocklist engine, no unbound recursion. One
  resolver chain.
- **No IDS/agent on the gateway** (crowdsec) — attack surface + RAM for ~zero benefit on a
  1-user LAN.
- **No samba4** — ksmbd is the single SMB server. Never both.
- **No toys baked in** — darkstat, librespeed/netspeedtest daemons, filemanager, kadnode,
  einat, nmap-full: install ad-hoc if ever needed; not in the image.
- **No new observability plane.** Not a status-page SaaS, not a third Grafana, not a
  committed status file, not D1 for presence state. `/health` + Grafana + LuCI dashboard,
  each with one job (§4).
- **No event framework / Queues / Workflows / rule-DSL** to move health or drive
  remediation (the verdict's core "don't build the moon"). Pull-based `/health` + cron
  heartbeats + the dead-drop cover it.
- **No efibootmgr A/B** (upgrade-plan reversal: same PARTUUID → ambiguous root). Serial +
  USB image + dead-drop are the recovery floor.
- **No web-UI mutation of SACRED subsystems** without explicit confirm — the LuCI builds
  are read-mostly status.
- **No OPNsense-grade firewall rebuild.** Adopt stock `luci-app-firewall`; take OPNsense as
  the *dashboard* quality bar only, on the sux pane.

---

*One coherent image: stock generic + a deliberate role set, a coherent single-chain DNS,
NAS + docker rooted on the NVMe, three read-mostly LuCI panes, and a watchdog that produces
into three non-overlapping observability planes. Git/CI/recovery-net are the guardrails;
the gateway stays sacred.*
