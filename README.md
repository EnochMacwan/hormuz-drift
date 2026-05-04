# Hormuz Drift — Interactive Particle Tracking

Static, client-side web model of surface-current drift in the Strait of Hormuz.
Targets two scenarios:

- **Man overboard / S&R** — NOAA Leeway categories with downwind + crosswind slopes.
- **Oil spill** — Fay gravity-viscous spreading + first-order evaporation.

Runs entirely in the browser (JS + Leaflet + Canvas). Designed for **GitHub Pages**.

## What is new in the upgraded UI

- Desktop-first mission-control layout with a map-first interaction model
- Scenario presets for S&R and oil workflows
- Time-jump playback controls and run-window playback
- Trail, density, and uncertainty overlays tied to playback time
- Results analytics chart plus JSON and CSV export
- Shareable scenario links encoded in the URL hash
- Wind-aware controls that automatically enable when the dataset includes GFS wind

## ⚠ Scope & caveats

> **Research / educational use only. Not certified for operational S&R or spill response.**

| Physics | Implemented | Missing vs. real OpenDrift/OpenOil |
|---|---|---|
| Ocean-current advection (RK2 + bilinear) | ✅ | — |
| Horizontal diffusion (random walk) | ✅ | — |
| Leeway wind drift (NOAA 19-category subset) | ✅ | full 50-category table |
| Stokes drift (1.6 % wind, Kenyon) | ✅ | wave-spectrum resolved |
| Oil Fay spreading + evaporation | ✅ | server-side OpenOil transport, 3-D oil state, NOAA OilLibrary/PyGNOME-grade weathering |
| Coastline stranding | partial (grid land-mask) | GSHHS polygons |
| Subsurface 3-D | ❌ | surface only |

For operational use, run real [OpenDrift](https://opendrift.github.io).
For a higher-fidelity oil-spill option, the preferred future direction is a
server-side OpenDrift/OpenOil run that exports browser-ready trajectories.

## Project layout

```
.
├── index.html                    main page
├── css/style.css
├── js/
│   ├── field.js                  data loader + bilinear sampler
│   ├── drift.js                  Drifter class + Leeway + Oil + ensemble
│   └── app.js                    UI, map, animation, glue
├── data/
│   └── currents.json             generated – do not edit by hand
├── scripts/
│   ├── prepare_data.py           one-shot: NetCDF → JSON (local use)
│   ├── fetch_data.py             CMEMS + GFS daily refresh (CI)
│   ├── fetch_rtofs_data.py       no-login NOAA RTOFS fallback refresh
│   └── validate_currents.py      schema + sanity checks for currents.json
└── .github/workflows/
    └── daily-data.yml            cron: 06:00 UTC
```

## Local development

```bash
pip install xarray netCDF4 numpy                         # for prepare_data.py
python scripts/prepare_data.py                           # build data/currents.json
python scripts/validate_currents.py                      # verify shape, dates, and speeds
python -m http.server 8000                               # serve
# open http://localhost:8000
```

Do not open `index.html` directly with `file://`. The browser will block
`data/currents.json` due to CORS/security rules.

The packaged sample `data/currents.json` in this repo is currents-only. The UI
will enable wind drift automatically when refreshed data includes `uw` / `vw`.

No-login live refresh:

```bash
pip install xarray netCDF4 numpy pandas
python scripts/fetch_rtofs_data.py
python scripts/validate_currents.py
```

This pulls NOAA/NCEP RTOFS surface currents for the latest available run,
resamples the browser payload to 1-hour steps, and adds Open-Meteo/GFS wind for
the same hourly time window.

The daily refresh workflow runs `scripts/validate_currents.py` before committing,
so broken shapes, bad timestamps, missing wind/current pairs, or extreme speed
values fail in CI instead of quietly reaching the live page.

## Deploying to GitHub Pages

1. Create a public repo, push this folder.
2. **Settings → Pages** → *Deploy from a branch*, branch `main`, root `/`.
3. **Settings → Secrets and variables → Actions**, add
   `CMEMS_USER` and `CMEMS_PASS` (free at <https://marine.copernicus.eu>).
4. The daily workflow (`.github/workflows/daily-data.yml`) will refresh
   `data/currents.json` automatically. It tries CMEMS first, then falls back to
   NOAA/NCEP RTOFS if CMEMS credentials are missing or rejected. Pages redeploys
   on every push.

The site lives at `https://<user>.github.io/<repo>/`.

## How the drift is computed

Each particle integrates

```
dx/dt = V_current(x,t) + V_leeway(W) + V_stokes(W) + η(t)
```

- `V_current`: bilinear interp of the active current dataset in space + time.
- `V_leeway = dw·W·ŵ + cw·W·ŵ⊥` with object-dependent slopes (NOAA).
- `V_stokes ≈ 0.016·W` (Kenyon surface-current approximation).
- `η ∼ N(0, √(2Kδt))` per axis, with `K = 10 m²/s` default.

Time integration is RK2 (midpoint) with `δt = 300 s`. Stranding = particle
enters a land-mask cell (`null` in the packed forcing grid).

For oil, a slick-scale `OilSlick` tracks Fay radius and mass-fraction
evaporation against the centroid release time; per-particle mass also decays.

## Data sources

- **Currents** — CMEMS `cmems_mod_glo_phy_anfc_merged-uv_PT1H-i`
  when credentials are available, or NOAA/NCEP Global RTOFS via NOMADS HTTPS
  as a no-login fallback.
- **Wind** — Open-Meteo/GFS or NCEP GFS `u10, v10`, depending on the refresh path.
- **Base tiles** — OpenStreetMap + CARTO Voyager.

## License

Code: MIT. Data: subject to upstream licences; keep CMEMS and NOAA/NCEP RTOFS attribution when redistributing derived payloads.
