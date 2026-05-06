# Hormuz Drift - Interactive Particle Tracking

A fully client-side ocean drift simulator for the Strait of Hormuz. Click anywhere on the water, pick a scenario and run the ensemble - the browser computes and animates hundreds of Lagrangian particle trajectories in real time using live operational ocean current and wind data.

> **Research / educational use only. Not certified for operational S&R or spill response.**

---

## How it works

### 1. Forcing data - what drives the particles

The simulation is driven by a pre-built JSON file (`data/currents.json`) that contains a 3-D grid of ocean surface velocity vectors:

```
currents.json
  |-- u[time][lat][lon]   - eastward current (m/s), null over land
  |-- v[time][lat][lon]   - northward current (m/s), null over land
  |-- uw[time][lat][lon]  - eastward 10-m wind (m/s), optional
  |-- vw[time][lat][lon]  - northward 10-m wind (m/s), optional
  |-- lats[], lons[]      - coordinate axes
  +-- meta                - time step, resolution, source, generated timestamp
```

This file is rebuilt daily by a GitHub Actions workflow that pulls from two sources:

- **Primary - Copernicus Marine (CMEMS)**: `GLOBAL_ANALYSISFORECAST_PHY_001_024`, dataset `cmems_mod_glo_phy_anfc_merged-uv_PT1H-i`. Requires free credentials.
- **Fallback - NOAA/NCEP RTOFS**: served via NOMADS HTTPS with no login required. Provides surface currents for the Abu Dhabi to Hormuz domain.

Wind is added from **Open-Meteo / GFS** (`u10`, `v10`) for the same hourly time window as the ocean currents. If the wind arrays are absent from the file, wind-driven physics are silently disabled in the UI.

---

### 2. Sampling - reading the data cube in the browser

`field.js` is a singleton (`window.Field`) that fetches and caches `currents.json`, then exposes a query API used by every particle:

```
Field.sampleCurrent(lon, lat, tSec)  ->  {u, v}  or  null
Field.sampleWind(lon, lat, tSec)     ->  {u, v}  or  null
Field.isLand(lon, lat)               ->  true / false
```

Under the hood, each query does **trilinear interpolation** - bilinear in space across the four surrounding grid cells, then linear in time between the two bounding hourly slices:

```
value = (1-fi)(1-fj) * A00 + fi(1-fj) * A10
      + (1-fi)fj    * A01 + fi*fj    * A11
                    [evaluated at tSlice0, then linearly blended with tSlice1]
```

If any of the four corners is `null` (land or missing), the sample returns `null`, which strands the particle immediately. This is the land-masking mechanism.

The dataset wraps in time: once the simulation clock advances past the last available hour, it loops back to the beginning. This means a long forecast run gracefully repeats the available forcing rather than crashing.

---

### 3. Particle motion - the physics

Each particle is a `Drifter` instance. On every time step `dt = 300 s` it evaluates the total velocity vector and advances its position.

#### Total velocity

```
V_total = V_current + V_leeway + V_stokes + eta
```

| Component | Formula | Notes |
|---|---|---|
| Ocean current | `V_current = Field.sampleCurrent(lon, lat, t)` | Bilinear/trilinear interpolated from CMEMS or RTOFS |
| Leeway | `dw * W * w_hat + cw * W * w_perp` | Object-dependent fraction of wind speed; NOAA Allen (2005) coefficients |
| Stokes drift | `0.016 * W_vec` | Surface-wave approximation after Kenyon (1969) |
| Diffusion | `eta ~ N(0, sqrt(2 * K * dt))` per axis | Random walk; default eddy diffusivity `K = 10 m^2/s` |

`W` is the 10-m wind speed (m/s), `w_hat` the unit wind vector, and `w_perp` the right-hand perpendicular (crosswind).

#### Time integration - RK2 midpoint

A simple Euler step would under-shoot in curved current fields. The model uses second-order Runge-Kutta (midpoint method):

```
k1 = V_total(lon,                  lat,                  t)
k2 = V_total(lon + k1*dt/2,        lat + k1*dt/2,        t + dt/2)   <- midpoint
new position = old + k2 * dt
```

Wind-driven terms (leeway, Stokes) vary slowly and are applied with forward Euler on top of the RK2 ocean step.

#### Ensemble variability

When a run is launched, `spawnEnsemble()` creates `n` particles (default 300) from a single release point. Each particle gets:
- A random spatial jitter of +/- 50 m (Gaussian) around the click location.
- A +/- 15% Gaussian perturbation to its leeway downwind and crosswind coefficients.

This spreads the ensemble naturally even before any physical divergence, giving the uncertainty cloud seen on screen.

---

### 4. Scenarios

#### Man overboard / Search & Rescue

Uses NOAA 19-category Leeway table. Each category has a `dw` (downwind fraction, %) and `cw` (crosswind fraction, %):

| Object | dw (%) | cw (%) |
|---|---|---|
| Person in water - survival suit | 1.5 | 0.0 |
| Life raft 4-6 ppl, no ballast | 3.6 | 0.5 |
| Skiff / small open boat | 3.8 | 0.6 |
| Shipping container 40 ft (full) | 2.8 | 0.4 |
| Generic floating debris | 2.0 | 0.3 |
| ... (19 categories total) | | |

The crosswind component shifts the particle to the right of the wind - this is the "jibing" effect that makes life rafts with no ballast drift differently from waterlogged hulls.

#### Oil spill

Oil particles drift like passive tracers with a small wind drag (`dw = 3%`). Additionally:

- **Slick spreading** - the `OilSlick` class computes the Fay (1971) gravity-viscous spreading radius:
  ```
  r(t) = 1.5 * (delta * g * V^2 * t^1.5 / sqrt(nu_w))^(1/6)
  ```
  where `delta = (rho_water - rho_oil) / rho_water`, `g = 9.81 m/s^2`, `V` = spill volume (m^3), `nu_w = 1.05e-6 m^2/s`.

- **Evaporation** - each particle tracks a remaining mass fraction that decays exponentially:
  ```
  mass_frac(t) = exp(-t / tau_evap)
  ```
  `tau_evap` varies by oil type (6 h for condensate, up to 200 h for heavy fuel oil).

Five oil types are available: light crude, medium crude, heavy fuel oil, diesel, and condensate.

---

### 5. Rendering

The browser uses a **multi-layer canvas stack** on top of a Leaflet map:

| Layer | What it draws |
|---|---|
| Background particles | Faint animated tracers showing the overall current field |
| Drift trails | Particle track lines colour-coded by speed or scenario |
| Density footprint | Kernel-smoothed heat map of particle positions |
| Uncertainty ellipse | Bounding ellipse of the ensemble at the current playback time |
| Oil slick | Translucent circle scaled to the Fay spreading radius |
| Current field arrows | Vector arrows sampled from the forcing grid |

All layers are redrawn each animation frame keyed to the playback clock. The playback clock can be scrubbed, paused, jumped +/- 6 h or +/- 24 h, or set to run at 60x real-time.

---

### 6. Data pipeline

```
scripts/fetch_data.py          (CMEMS, requires credentials)
scripts/fetch_rtofs_data.py    (NOAA RTOFS, no login needed)
        |
        v
  NetCDF source files (downloaded to /tmp, not committed)
        |
        v
  Slice to Hormuz bounding box, resample to 1-hour steps
  Append Open-Meteo GFS wind at same hourly grid
        |
        v
scripts/validate_currents.py   schema + sanity checks
        |
        v
  data/currents.json            committed to the repo
        |
        v
  GitHub Pages redeploy         live within ~2 min
```

The validation script rejects a file if any of these conditions are true: wrong shape, NaN-heavy arrays, extreme speeds (> 5 m/s ocean, > 40 m/s wind), timestamps that don't span at least 48 hours.

---

## Project layout

```
.
|-- index.html                    main page and all UI markup
|-- css/style.css                 all styles (dark theme, responsive grid)
|-- js/
|   |-- field.js                  forcing data loader + bilinear sampler
|   |-- drift.js                  Drifter, OilSlick, spawnEnsemble
|   +-- app.js                    UI, Leaflet map, canvas rendering, glue
|-- assets/
|   |-- tridel.png                Tridel logo (header + favicon)
|   |-- austides.svg              Austides Adelaide partner logo (header)
|   +-- opendrift_logo.png        OpenDrift attribution badge (info card)
|-- data/
|   +-- currents.json             generated - do not edit by hand
|-- scripts/
|   |-- fetch_data.py             CMEMS + GFS daily refresh (CI)
|   |-- fetch_rtofs_data.py       no-login NOAA RTOFS fallback
|   |-- prepare_data.py           one-shot: NetCDF -> JSON (local use)
|   +-- validate_currents.py      schema + sanity checks
+-- .github/workflows/
    +-- daily-data.yml            cron: 06:00 UTC daily refresh
```

---

## Local development

```bash
# Serve the site (must use HTTP, not file://)
python -m http.server 8000
# open http://localhost:8000
```

To rebuild `data/currents.json` locally:

```bash
pip install xarray netCDF4 numpy pandas

# Option A - NOAA RTOFS (no credentials needed)
python scripts/fetch_rtofs_data.py
python scripts/validate_currents.py

# Option B - CMEMS (higher quality, free account required)
# Set env vars CMEMS_USER and CMEMS_PASS (or run `copernicusmarine login`)
python scripts/fetch_data.py
python scripts/validate_currents.py
```

---

## Deploying to GitHub Pages

1. Push this folder to a public repository.
2. **Settings -> Pages** -> Deploy from branch `main`, root `/`.
3. **Settings -> Secrets -> Actions** - add `CMEMS_USER` and `CMEMS_PASS` (free at [marine.copernicus.eu](https://marine.copernicus.eu)). If absent, the workflow falls back to NOAA RTOFS automatically.
4. The daily workflow runs at 06:00 UTC, commits a fresh `data/currents.json`, and Pages redeploys automatically.

Live URL: `https://<user>.github.io/<repo>/`

---

## Physics scope & caveats

| Physics | Status | What a full model adds |
|---|---|---|
| Ocean-current advection (RK2 + bilinear) | yes | - |
| Horizontal diffusion (random walk) | yes | - |
| Leeway wind drift (19 NOAA categories) | yes | Full 50-category table |
| Stokes drift (1.6 % wind surrogate) | yes | Wave-spectrum resolved |
| Oil Fay spreading + first-order evaporation | yes | Server-side OpenOil 3-D transport, NOAA OilLibrary weathering |
| Coastline stranding | partial (grid land-mask) | GSHHS polygon shorelines |
| Subsurface / 3-D | no | Full depth profiles |

For operational use, run [OpenDrift](https://github.com/OpenDrift/opendrift) directly.

---

## Branding & partners

- Header styled after the [Tridel Technologies](https://www.trideltechnologies.com) brand - dark navy, compact nav, teal CTA.
- [Austides Adelaide](https://austides.com) partner logo in the header.
- [OpenDrift](https://github.com/OpenDrift/opendrift) attribution badge in the info card.

---

## License

Code: MIT. Data: subject to upstream licences - retain CMEMS and NOAA/NCEP RTOFS attribution when redistributing derived data payloads.
