# MK3S Calibration Bench (self-hosted)

The same calibration bench as the claude.ai page, packaged as one small container
for CT 203, set up for both printers: the standalone MK3S (`octoprint-a`) and the
MK3S+ with MMU3 in the PrusaBox (`octoprint-b`). It adds what the hosted page can't do:

- **Send to OctoPrint / Send and print** — the G-code goes straight into an
  OctoPrint folder (`calibration/` by default), no download/upload step.
- **Profiles stored on CT 203** — one JSON file you own and can back up, shared by
  every device that opens the page.
- **A printer picker.** Each printer gets its own OctoPrint target, model check,
  E-steps, and test results (see "How results are stored" below).
- **PrusaSlicer and OpenSCAD built in.** The temperature tower (Printables STL),
  the flow fine-tune squares, the overhang fan tower, the bridge swatches and the
  benchmark hex tile are sliced by real
  PrusaSlicer with Prusa's profile for each printer plus every value you've
  tested, and step 11 exports a ready-made PrusaSlicer filament profile.

## How it fits together

```
browser (any device)
   │  page + /api/*            ┌──────────── CT 203 ────────────┐
   └────────────────────────▶  │ calbench container (Node, :8080)│
                               │   ├─ public/index.html          │
                               │   ├─ slicer.js → openscad, prusa-slicer (headless)
                               │   ├─ /data/profiles.json  ◀── ./data bind mount
                               │   ├─ /data/models/*.stl   (uploaded models)
                               │   └─ /api/octoprint/* ─┬─▶ host:80   octoprint-a (MK3S)
                               │                        └─▶ host:5001 octoprint-b (MK3S+ MMU3)
                               └─────────────────────────────────┘
```

- `server.js` and `slicer.js` are plain Node 20 with no npm packages, so there's
  nothing to `npm install`.
- The image is Debian 13 (trixie) with Debian's own `prusa-slicer` (2.9.2),
  `openscad` and `nodejs` packages. See "Slicing" below for why not 2.9.6.
- The browser never sees the OctoPrint API key. It stays in `.env` on CT 203, and
  the server adds it when it forwards an upload. That's why uploads go *through*
  this container rather than from the browser to OctoPrint directly (that would
  also need CORS turned on in OctoPrint).
- Profile writes go through a single queue and are written to a temp file then
  `rename()`d over `profiles.json`. Rename is atomic on the same filesystem, so a
  crash mid-save leaves the old file intact, never half a file.
- On first start, if `data/profiles.json` doesn't exist, it's created from
  `seed.json` (your Overture PETG starting point).

## Slicing

**Where the settings come from.** PrusaSlicer ships Prusa's own profiles as one
"vendor bundle" file (`/usr/share/PrusaSlicer/profiles/PrusaResearch.ini`) in
which presets inherit from each other. `slicer.js` flattens that inheritance the
way PrusaSlicer does, for:

| | Printer A | Printer B |
|---|---|---|
| Printer | Original Prusa i3 MK3S & MK3S+ | Original Prusa i3 MK3S & MK3S+ MMU3 Single |
| Print | 0.20mm QUALITY @MK3 | 0.20mm QUALITY @MK3 |
| Filament | Generic PLA / PETG / FLEX, Prusament ASA | the `@MMU` variant where Prusa has one |

Then it overrides only what calbench tested: temperature (the first layer keeps
Prusa's own first-layer temperature for the material, e.g. 230 °C for PETG, since
that's set for adhesion, not by the tower), bed, extrusion multiplier, `M900 K` in the filament start G-code,
retraction length and speed (as filament overrides), max volumetric speed,
minimum fan, overhang and bridge fan, and bridge speed and flow ratio. Everything else (z-hop, travel speed, line widths, cooling
slowdowns) is Prusa's tuned default for the MK3S. Override the printer preset
with `PRINTER_A_PRESET=…` or the print preset with `PRINT_PRESET=…` in `.env`.

**Jobs:**
- **Temperature tower:** upload the Printables **3MF** once (stored in
  `data/models`). Calbench reads the block heights and temperatures from the
  3MF's `before_layer_gcode` (Prusa writes `{if layer_z>=11.05} M104 S225 …`
  there) or from per-height custom G-code, converts the mesh to STL with
  PrusaSlicer's own 3MF reader, slices it with your settings, and inserts one
  `M104` at the first layer of each block. The temperatures are locked to the
  file because they're moulded into the tower. An STL works too, with heights
  and temperatures entered by hand. The base plate prints at the filament's own
  temperature, as in Prusa's file.
- **Flow pass 2:** OpenSCAD generates one square per flow value (notches on the
  front = which one), already placed at its bed position, and PrusaSlicer runs with
  `--dont-arrange` so its auto-arrange can't move them. It slices them as separate
  labelled objects, and
  calbench adds `M221` at the start of each object, relative to the start code's
  own value (Prusa's MMU3 profile starts at `M221 S95`, not 100).
- **Overhangs & bridges, pass 1 (step 8): fan tower.** Overhang fan and bridge fan
  are *filament* settings, so they can't differ per object. Instead the tower
  (`models/fan_tower.scad`: one 8 mm block per value, each with a 60° and a 70°
  overhang and a 24 mm bridge) is sliced once with dynamic fan speeds on and every
  overhang/bridge fan at 100 %. Calbench then walks the G-code by `;Z:` and, inside
  each block, rescales every `M106` above the normal fan N linearly:
  `v → N + (v − N)·(T − N)/(100 − N)` for that block's value T. Ordinary walls and
  infill (at or below N) are untouched, so blocks differ only in overhang and
  bridge cooling, and the result is exactly what PrusaSlicer would produce with
  that value: overhang fans `T, T, (T+N)/2, N` and bridge fan T. The bottom block
  is always N (the reference), and values below N are refused. For PLA, N is
  already 100 %, so pass 1 has nothing to test.
- **Overhangs & bridges, pass 2 (step 8): bridge swatches.** Bridge speed and
  bridge flow ratio are *print* settings, so this works like the finishes below:
  one swatch per value (`models/bridge_swatch.scad`, a 25 mm bridge on two 3 mm
  pillars), each an object with its own settings in a generated 3MF. The result
  goes into every later slice and exports as a print profile.
- **Cosmetic finishes (step 9, optional): ironing and fuzzy skin.** These change
  slicer settings, not G-code values, so calbench writes a 3MF with one swatch per
  value and PrusaSlicer's per-object settings on each (the same place PrusaSlicer
  stores right-click object settings), then slices that. The winner exports as a
  **print** profile (`print` folder), because both are print settings.
- **Tile finishes (optional):** step 10 can iron the tile's top and put fuzzy skin on
  its one plain face, using your step 9 results. Fuzzy skin is applied
  with a modifier volume around that face inside a generated 3MF.
- **Overhang fan / bridge fan** can also be set by hand in Filament settings
  (0 = off / Prusa's default). Both are written into the exported filament profile.
- **Benchmark tile:** `models/hex_tile.scad`, with the filament, colour, printer,
  temperature and date written into it.

**Why Debian's 2.9.2 and not 2.9.6.** Calbench never imports your desktop
profiles; it generates them. Files from 2.9.2 open fine in your 2.9.6, and the
differences between bug-fix releases don't change how calibration parts print.
Debian's stable package keeps rebuilds reproducible; the alternatives were
Debian testing (a moving target) or the official AppImage (dependencies by hand).

**Build self-test.** `docker compose build` runs `selftest.js`, which generates
and slices a tile for both printer types. If a package, font or Prusa's profile
file is missing, the build stops there with the reason.

## How results are stored

- **Per printer:** E-steps, and every test result you save. Each saved result is
  recorded against the printer that's selected when you click Save.
- **Fallback:** if a printer has no result of its own for something, it uses the
  other printer's tested value. The step list shows that as a dashed amber ring
  ("tested on the other printer") instead of a green check, and step 11 says where
  each value came from.
- **Per filament:** the starting values in Filament settings, used until a test is
  saved on either printer.

Why it's split this way: both printers have the same hotend, so flow and K
usually carry over closely. The PrusaBox changes cooling and chamber temperature,
which moves the best nozzle temperature, bridging, stringing and fan for the
enclosed printer. Results stay per printer so the enclosed one never silently
overwrites the open one's numbers.

## How the container reaches the two OctoPrints

Both OctoPrint containers already publish ports on CT 203 (`-a` → 80,
`-b` → 5001, both bound to `0.0.0.0`). `compose.yaml` adds
`host.docker.internal:host-gateway`, which makes that name resolve to the
Docker bridge's gateway, i.e. CT 203 itself. So `http://host.docker.internal:5001`
goes out of the calbench container, back into CT 203, and through the same
`docker-proxy` your browser uses to reach `octoprint-b`.

The alternative is a shared user-defined Docker network and container names
(`http://octoprint-b:80`, always the container port). It's more direct, but it
ties the compose projects together. The published-port route doesn't touch your
OctoPrint setup; it only depends on those port numbers staying the same.

## MMU3 printer

- **Sliced files** use Prusa's own MMU3 start code: the printer asks which slot
  to load (`Tx`), loads it (`Tc`) and runs Prusa's purge.
- **Generated files** (E-steps excluded) load the slot chosen in **Printer
  settings** with `T<n>` just before the purge line, then purge a bit longer.
- E-steps on the MMU printer: load to the nozzle from the LCD, then unscrew the
  PTFE fitting on top of the extruder to mark the filament. The page says this
  on that step.
- Model check: `MK3SMMU3` is what PrusaSlicer's MK3S+MMU3 profiles write. If the
  printer complains, copy the `M862.3` line from a file PrusaSlicer slices for
  that printer into `PRINTER_B_MODEL`.
- Out of scope: MMU-specific tuning (loading distances, FINDA and filament sensor
  checks, ramming). Those are done through the MMU's own menus and PrusaSlicer's
  MMU filament settings.

## 1. Install

Copy this folder to CT 203 (e.g. `/opt/calbench`), then:

```bash
cd /opt/calbench
cp .env.example .env
nano .env                       # the two API keys (everything else is pre-filled)
mkdir -p data
chown 1000:1000 data            # the container runs as uid 1000
docker compose up -d --build    # first build: a few minutes (apt) + the self-test
docker compose logs -f          # lists both printers; "[NO API KEY]" means a key is missing
```

API keys: in **each** OctoPrint instance → Settings → Application Keys → generate
one named `calbench`. Keys are per instance, so printer A's key won't work on B.
A dedicated key can be revoked on its own without touching anything else.

Watch the build output for `selftest: ok`. Expect an image of roughly 1 GB:
PrusaSlicer is a GUI program, and even in command-line mode it links its GUI
libraries. It only runs while slicing, so memory use at rest is just Node.

**Why `chown 1000:1000`:** the image runs as the unprivileged `calbench` user, not
root. A bind-mounted folder keeps the host's ownership, so it has to be writable
by uid 1000 or the first save fails with `EACCES`. Inside an unprivileged LXC,
uid 1000 in CT 203 maps to 101000 on the Proxmox host — that's expected.

Open `http://<CT-203-IP>:8090`.

## 2. Fit it into the rest of the lab

- **NPM:** add a proxy host pointing to `CT-203-IP:8090`, same pattern as your
  other services, plus a local DNS record for it in Pi-hole.
- **Uptime Kuma:** HTTP monitor on `/healthz` (returns `{"ok":true}`).
- **Homepage:** a tile linking to the NPM hostname.
- **Backup:** `data/` holds all state: `profiles.json` plus uploaded models in
  `data/models/`. Copy it to Unraid with the rest of your backups, or use
  **Export all** in Filament settings for the profiles alone.
- **Diun:** the image is built locally, so Diun won't flag updates. To pick up
  Debian's PrusaSlicer/OpenSCAD security fixes, rebuild with
  `docker compose build --pull && docker compose up -d` now and then.

## 3. Security — read before exposing it

There is **no login**. Anyone who can open the page can edit profiles, upload
models (up to 32 MB each) and, with `ALLOW_PRINT=true`, start a print on either
printer. `.dockerignore` keeps `.env` (your API keys) and `data/` out of the image.

- LAN and Tailscale only is fine for a home lab.
- If you ever route it through the Cloudflare Tunnel, put Cloudflare Access in
  front of it first.
- Set `ALLOW_PRINT=false` to keep upload-only. The page then hides **Send and print**.

The page also guards prints itself: **Send and print** asks for a second click
("Bed clear?"), only appears when OctoPrint reports the printer connected and
idle, and the server re-checks that state before starting.

## When a slice fails

The page shows PrusaSlicer's own reason and exit code. The full output of the
failed run, with the exact command, is in `docker compose logs calbench`.

## Updating

Replace the files (keep `.env` and `data/`), then rebuild. The page, server and
models are baked into the image, so a restart alone won't pick up changes:

```bash
docker compose up -d --build
```

## API reference

| Method | Path | Does |
|---|---|---|
| GET | `/api/profiles` | List profiles |
| PUT | `/api/profiles/:id` | Create/replace one (id: lowercase, digits, dashes) |
| DELETE | `/api/profiles/:id` | Delete one |
| GET | `/api/export` | Download all profiles as JSON |
| POST | `/api/import` | Merge profiles from an export (same ids are replaced) |
| GET | `/api/printers` | Configured printers (no keys) |
| GET | `/api/machines` | Per-printer values (E-steps) |
| PUT | `/api/machines/:id` | Save them |
| GET | `/api/octoprint?printer=a` | That OctoPrint's reachability and printer state |
| POST | `/api/octoprint/upload` | `{printer, filename, gcode, print}` → upload, optionally start |
| GET | `/api/slicer` | PrusaSlicer/OpenSCAD versions, presets in use |
| GET / POST / DELETE | `/api/models` | List, upload (`?name=x.stl` or `x.3mf`, raw body), delete models |
| POST | `/api/slice` | `{job, printer, material, values, …}` → G-code, bands, estimate |
| POST | `/api/print-ini` | `{printer, kind: bridge|ironing|fuzzy, settings, name}` → PrusaSlicer print `.ini` |
| POST | `/api/profile-ini` | `{printer, material, values, name}` → PrusaSlicer filament `.ini` |
| GET | `/healthz` | Liveness |
