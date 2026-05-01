# How this thing actually got built

A learning-oriented walkthrough of the workflow — data sources, physics,
deployment, and the bugs we hit along the way. If you want to extend or
tinker, start here.

## Big picture

**The real OpenDrift is a Python framework that runs on a server.**
GitHub Pages can only host static files — no Python, no server. So the trick was:

1. Keep the *data* from the real sources (CMEMS for currents, Open-Meteo for wind)
2. *Port just the physics we care about* from OpenDrift into ~1,600 lines of JavaScript
3. Do all the integration client-side in the browser using `<canvas>` overlays on a Leaflet map

It's a research / education toy, not an operational tool. But it uses the
same equations and the same data sources as the real thing.

---

## Step-by-step workflow

### 1. Download the ocean current data (CMEMS)

CMEMS = Copernicus Marine Environment Monitoring Service. Free account, NetCDF downloads.

The specific product: `cmems_mod_glo_phy_anfc_merged-uv_PT1H-i` — hourly,
global, surface currents (`utotal`, `vtotal`) on a ~1/12° grid (about 9 km per cell).

You end up with a file like `cmems_mod_glo_phy_anfc_merged-uv_PT1H-i_1776382234335.nc` —
a multi-dimensional array with axes `(time, depth, latitude, longitude)` and variables
`utotal` (east velocity, m/s) and `vtotal` (north velocity, m/s).

**To play**: grab a different bounding box on the CMEMS download page and drop the new `.nc` file into the repo root.

### 2. Get the wind data (Open-Meteo)

Wind matters for Leeway (things floating on the surface get pushed by wind) and
Stokes drift (wave-induced surface current). CMEMS doesn't have wind.

Originally we were going to use **NCEP GFS** via NOMADS OpenDAP — that's the same
dataset real OpenDrift uses. But it requires `pydap` and goes down occasionally.
So we switched to **Open-Meteo** — a free, no-auth HTTP API that re-serves GFS data as JSON.

The request is a simple URL like:

```
https://api.open-meteo.com/v1/forecast?latitude=26.5&longitude=56.0
    &hourly=wind_speed_10m,wind_direction_10m
    &wind_speed_unit=ms          ← ★ had to add this, default is km/h!
    &start_date=2026-04-15&end_date=2026-04-25
```

**Big lesson here**: every data source has defaults you have to verify. Open-Meteo's
default wind unit is km/h; initially assumed m/s and got 32 m/s hurricane winds in
the output. A one-line fix after hours of "why is everything washing ashore?"

### 3. Bake currents + wind into one JSON file

File: **`scripts/prepare_data.py`**

- Uses `xarray` to open the NetCDF
- Loops through a 5×7 grid of (lat, lon) query points covering the Strait, hitting Open-Meteo for each
- Converts wind speed+direction to u,v components:
  ```python
  u10 = -ws * sin(wd_rad)   # meteorological convention:
  v10 = -ws * cos(wd_rad)   # direction is where wind comes FROM
  ```
- Interpolates the sparse wind grid onto the dense CMEMS grid (`xarray.interp`)
- Rounds to 3 decimals, replaces NaN (land cells) with `null`
- Dumps everything into `data/currents.json` (~10 MB)

Output structure:

```json
{
  "meta": {...},
  "times": ["2026-04-15 23:00:00", ...],     // 241 hourly frames
  "lats": [25.500, 25.583, ..., 27.500],     // 19 points
  "lons": [54.500, 54.583, ..., 57.833],     // 33 points
  "u":  [[[...], [...]], ...],               // [time][lat][lon]
  "v":  [...],                               // currents
  "uw": [...], "vw": [...]                   // wind
}
```

**To play**: run `python scripts/prepare_data.py` after dropping in a new `.nc` file.
It takes ~2 minutes (mostly Open-Meteo rate limiting).

### 4. Port the physics from OpenDrift to JavaScript

This is the meat. OpenDrift is ~50k lines of Python; we only needed maybe ~300 lines
of the core equations.

**`js/field.js`** — loads `currents.json` and provides two sampling functions:

- `Field.sampleCurrent(lon, lat, tSec)` → `{u, v}` in m/s
- `Field.sampleWind(lon, lat, tSec)`    → `{u, v}` in m/s

Both do **bilinear interpolation in space** (weighted average of the 4 surrounding
grid cells) + **linear interpolation in time** (weighted average of the before/after hour).
Returns `null` if you're on land or outside the grid.

**`js/drift.js`** — the `Drifter` class. Per particle, each timestep:

```
dx/dt = V_current(x,t)        ← from CMEMS
      + V_leeway(W)           ← fraction of wind speed, table lookup
      + V_stokes(W)           ← ~1.6% of wind (Kenyon 1969)
      + η(t)                  ← random walk, models sub-grid eddies
```

- **Integration method**: RK2 midpoint — sample velocity at `x`, step half way to
  estimate midpoint, sample there, use that velocity for the full step. Better than
  Euler, simpler than RK4, plenty accurate at 5-minute timesteps.
- **Leeway table** (top of `drift.js`): 19 object types from NOAA — survival-suited
  PIW (1.5% dw, 0% cw), life raft (3.5% dw, 4% cw), 20-ft container (2.9% dw, 0.5% cw),
  kayak, etc. "dw" = downwind slope, "cw" = crosswind slope.
- **Diffusion**: `η ~ N(0, √(2·K·δt))` per axis, where `K = 10 m²/s` by default.
  This is the random-walk approximation of turbulent mixing.
- **Stranding**: if `Field.isLand()` returns true (grid cell is NaN), particle is
  marked stranded, doesn't move further.

**`js/weathering.js`** — oil-specific: Fay (1971) 3-regime spreading
(gravity-inertial → gravity-viscous → surface tension), exponential evaporation mass loss.

**To play**:

- Open `js/drift.js`, change `K = 10` to `K = 50` and see the ensemble fan out much wider
- Add a new entry to `LEEWAY_CATEGORIES` — say, a pet flamingo pool float (invent some slopes) and test it
- Change the timestep in `app.js` from 300s to 60s and see if it changes the result
  (answer: at this scale, barely — which is the point of RK2)

### 5. Wire it to a map (`js/app.js` + `index.html`)

- **Leaflet.js** (CDN) provides the map + tiles (Carto Voyager basemap)
- A custom `L.Layer` subclass with **three stacked `<canvas>` elements**:
  1. Field hue layer (current direction as color, speed as opacity)
  2. Background tracer particles (~2000 pretty streamlines, just visual)
  3. Ensemble overlay (the actual drifters, with trails fading via `destination-out` compositing)
- **`requestAnimationFrame` loop** advances the simulation clock; each canvas redraws as needed
- **Click on map** → sets release point; **Run button** → spawns N particles with Gaussian
  scatter around that point, each with slightly perturbed Leeway slopes so the ensemble
  reflects real uncertainty
- **Timeline scrubber** lets you jump around in the 10-day forcing window

**To play**: just click around. Try different scenarios. Change the S&R preset to Oil spill,
see how weathering (evaporation) shrinks the slick over time.

### 6. Automate the daily refresh

File: **`.github/workflows/daily-data.yml`**

A GitHub Actions cron job that runs **every day at 06:00 UTC**:

1. Install Python deps (`copernicusmarine`, `xarray`, etc.)
2. Run `scripts/fetch_data.py` which pulls fresh 10-day forecasts from CMEMS + Open-Meteo
3. Commit the updated `data/currents.json` back to the repo
4. GitHub Pages auto-redeploys

Needs two secrets in GitHub **Settings → Secrets → Actions**: `CMEMS_USER` and
`CMEMS_PASS` (your Copernicus account credentials).

---

## Mental model of the data flow

```
┌──────────────┐        ┌──────────────┐
│   CMEMS      │        │  Open-Meteo  │
│  (NetCDF,    │        │  (JSON, free │
│   auth req)  │        │   no auth)   │
└──────┬───────┘        └──────┬───────┘
       │                       │
       └───────┐    ┌──────────┘
               │    │
               ▼    ▼
      ┌──────────────────────┐
      │ scripts/prepare_data │    ← Python: xarray, interp, pack
      │      .py             │
      └──────────┬───────────┘
                 │
                 ▼
      ┌──────────────────────┐
      │  data/currents.json  │    ← 10 MB, 241 frames × 19×33 grid
      └──────────┬───────────┘
                 │  (fetched by browser)
                 ▼
      ┌──────────────────────┐
      │   js/field.js        │    ← bilinear + linear sampler
      │   js/drift.js        │    ← RK2 + Leeway + Stokes + diffusion
      │   js/weathering.js   │    ← Fay + evaporation (oil)
      │   js/app.js          │    ← Leaflet + canvas + RAF loop
      └──────────────────────┘
                 │
                 ▼
         The browser draws.
```

---

## Where to poke if you want to learn

| What to tweak | Where | What you'll see |
|---|---|---|
| Diffusion coefficient `K` | `js/drift.js` (`Drifter` constructor) or UI slider | Smaller K → tight cluster; larger K → fast fan-out |
| Leeway slopes for an object | `js/drift.js` `LEEWAY_CATEGORIES` array | Bigger dw = more wind-blown; cw ≠ 0 = drifts off-axis of wind |
| Timestep | `js/app.js` search for `300` (seconds) | Larger = less accurate but faster; smaller = barely different (RK2 is stable) |
| Ensemble size | UI "Particles" input | Statistical noise scales with `1/√N` — 200 is usually enough |
| Bounding box | `scripts/prepare_data.py` top — `LON_MIN`, `LAT_MIN`, etc. | Restrict region → smaller JSON, faster load |
| Wind fraction for Stokes | `js/drift.js` search `0.016` | Literature says 1.3–1.8% of wind speed |
| Base map | `js/app.js` search `cartocdn` or `tiles` | Try `openstreetmap.org` or ESRI satellite imagery |

Two especially instructive experiments:

1. **Turn off wind**: in the UI, uncheck "Use wind". Re-run. The ensemble should
   now be purely tidal — back-and-forth with net displacement dominated by residual
   currents. This shows you exactly how much of the drift is wind-driven.

2. **Change the release depth**: (hypothetical — would need code) CMEMS NetCDF has
   a `depth` axis. Right now `prepare_data.py` does `isel(depth=0)` (surface only).
   Change it to e.g. `depth=3` (a few meters down) and regenerate. Surface wind/Stokes
   forcing effectively vanishes at depth — useful intuition for how subsurface
   drifters behave differently.

---

## Bugs hit during development (so you don't waste time on them)

1. **Plotly heatmap flashing** (pre-Leaflet attempt) — fixed by switching to `Scatter`
   with square markers + `transition.duration=150`. Tradeoff: slower on huge grids.
2. **JavaScript Temporal Dead Zone** — `let fieldLayer = …` references `fieldLayer`
   during construction. Fix: declare with `let fieldLayer;` first, then assign, and add
   a guard `if (!fieldLayer) return;` in draw functions.
3. **Esri World Ocean Base tiles flaky** — switched to Carto Voyager
   (`basemaps.cartocdn.com`).
4. **`tIdx` going negative after wrap** — replaced `if (tIdx >= nT) tIdx -= nT` with
   `tIdx = ((tIdx % nT) + nT) % nT` (modulo works correctly for negative inputs this way).
5. **Open-Meteo wind in km/h** — the one documented above; added `&wind_speed_unit=ms`.
   Caught by running `window.Field.sampleWind(56.0, 26.5, t)` live in the browser and
   noticing the number `32.3` was hurricane-force, not a typical 3 m/s Hormuz breeze.

The debugging trick that saved a lot of time: being able to run
`window.Field.sampleWind(56.0, 26.5, t)` *inside the running browser* and inspect
the actual numerical values. Every time something looked off visually, one live
numeric sample told you whether the data was wrong, the physics was wrong, or the
rendering was wrong.

---

Start with `index.html` → `js/app.js` → `js/drift.js`. They're the three files that
together tell the whole story.
