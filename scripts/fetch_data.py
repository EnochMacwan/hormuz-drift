"""
Daily data refresh for the Hormuz Drift web model.

Run by .github/workflows/daily-data.yml (cron 06:00 UTC) or manually:

    python scripts/fetch_data.py

Downloads:
  • Copernicus Marine global hourly merged surface currents (utotal, vtotal)
  • Open-Meteo/GFS surface wind (u10, v10)  [if available]

Produces: data/currents.json (replaces previous file)

Environment variables:
  CMEMS_USER, CMEMS_PASS
  or COPERNICUSMARINE_SERVICE_USERNAME, COPERNICUSMARINE_SERVICE_PASSWORD
  — required unless `copernicusmarine login` has already saved credentials

BBox + time window are the editable knobs at the top of this file.
"""

import json
# Maintainer note:
# This script is the automated "data factory" for the browser app. It trims
# large scientific source datasets down to the compact JSON cube sampled by
# js/field.js during playback and simulation.
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import xarray as xr

# ── knobs ──────────────────────────────────────────────────────────────
# Regional domain: Abu Dhabi and the UAE Gulf coast through the Strait of Hormuz.
CMEMS_PRODUCT_ID = 'GLOBAL_ANALYSISFORECAST_PHY_001_024'
CMEMS_DATASET_ID = 'cmems_mod_glo_phy_anfc_merged-uv_PT1H-i'
CMEMS_VARIABLES = ['utotal', 'vtotal']
LON_MIN, LON_MAX = 53.7, 57.8
LAT_MIN, LAT_MAX = 24.1, 27.5
HINDCAST_DAYS    = 3     # pull the last N days as "history"
FORECAST_DAYS    = 5     # pull the next N days as forecast

ROOT      = Path(__file__).resolve().parent.parent
OUT_JSON  = ROOT / 'data' / 'currents.json'
CACHE_DIR = ROOT / 'data' / 'cache'
CACHE_DIR.mkdir(parents=True, exist_ok=True)


def has_saved_copernicus_credentials():
    """Return True when the toolbox can find saved credentials without prompting."""
    base_dir = Path(os.environ.get('COPERNICUSMARINE_CREDENTIALS_DIRECTORY', Path.home()))
    candidates = [
        base_dir / '.copernicusmarine' / '.copernicusmarine-credentials',
        Path.home() / 'motuclient' / 'motuclient-python.ini',
        Path.home() / ('_netrc' if os.name == 'nt' else '.netrc'),
    ]
    return any(path.exists() for path in candidates)


def fetch_cmems():
    """Subset the Copernicus Marine merged-uv hourly product to the UAE-Hormuz bbox."""
    try:
        import copernicusmarine as cm
    except ImportError:
        sys.exit("pip install copernicusmarine")

    user = os.environ.get('CMEMS_USER') or os.environ.get('COPERNICUSMARINE_SERVICE_USERNAME')
    pw   = os.environ.get('CMEMS_PASS') or os.environ.get('COPERNICUSMARINE_SERVICE_PASSWORD')
    auth_kwargs = {}
    if user and pw:
        auth_kwargs = {'username': user, 'password': pw}
    elif not has_saved_copernicus_credentials():
        sys.exit(
            "Copernicus Marine credentials are not configured. Set CMEMS_USER/CMEMS_PASS, "
            "set COPERNICUSMARINE_SERVICE_USERNAME/COPERNICUSMARINE_SERVICE_PASSWORD, "
            "or run `copernicusmarine login`."
        )

    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    t0  = now - timedelta(days=HINDCAST_DAYS)
    t1  = now + timedelta(days=FORECAST_DAYS)

    out = CACHE_DIR / 'cmems.nc'
    print(f"Copernicus Marine product: {CMEMS_PRODUCT_ID}")
    print(f"Dataset: {CMEMS_DATASET_ID} ({', '.join(CMEMS_VARIABLES)})")
    print(f"Subset bbox: lon {LON_MIN}..{LON_MAX}, lat {LAT_MIN}..{LAT_MAX}")
    print(f"Time window: {t0.isoformat()} → {t1.isoformat()}")
    print(f"CMEMS subset → {out}")
    cm.subset(
        dataset_id=CMEMS_DATASET_ID,
        variables=CMEMS_VARIABLES,
        minimum_longitude=LON_MIN, maximum_longitude=LON_MAX,
        minimum_latitude =LAT_MIN, maximum_latitude =LAT_MAX,
        minimum_depth=0, maximum_depth=1,
        start_datetime=t0.isoformat(), end_datetime=t1.isoformat(),
        output_directory=str(CACHE_DIR),
        output_filename=out.name,
        file_format='netcdf',
        overwrite=True,
        disable_progress_bar=True,
        **auth_kwargs,
    )
    return xr.open_dataset(out)


def fetch_wind(times, lats, lons):
    """Fetch Open-Meteo/GFS wind on the same time window and grid as currents."""
    try:
        from prepare_data import fetch_wind_openmeteo
        return fetch_wind_openmeteo(times, lats, lons)
    except Exception as e:
        print(f"Wind fetch skipped: {e}", file=sys.stderr)
        return None, None, None


def pack(a):
    # JSON has no NaN literal, so missing values become null and the rest are
    # rounded to keep file size modest.
    return np.where(np.isnan(a), None, np.round(a, 3)).tolist()


def main():
    # Step 1: currents define the canonical grid and time axis for the payload.
    ds_cm = fetch_cmems()
    lats  = ds_cm['latitude'].values.astype(float)
    lons  = ds_cm['longitude'].values.astype(float)
    times = [str(t)[:19].replace('T', ' ') for t in ds_cm['time'].values]
    u = ds_cm['utotal'].isel(depth=0).values.astype(np.float32)
    v = ds_cm['vtotal'].isel(depth=0).values.astype(np.float32)

    # Step 2: enrich with wind when possible; otherwise leave uw/vw null so the
    # front-end can disable wind-specific controls cleanly.
    uw = vw = None
    wind_source = None
    uw_arr, vw_arr, wind_source = fetch_wind(ds_cm['time'].values, lats, lons)
    if uw_arr is not None and vw_arr is not None:
        uw = pack(uw_arr)
        vw = pack(vw_arr)

    # Step 3: write the minimal schema the browser actually needs.
    payload = {
        'meta': {
            'source':        f'CMEMS {CMEMS_PRODUCT_ID} ({CMEMS_DATASET_ID}, merged-uv hourly)',
            'wind_source':   wind_source,
            'time_start':    times[0], 'time_end': times[-1],
            'time_step_sec': 3600, 'n_times': len(times),
            'n_lat': len(lats), 'n_lon': len(lons),
            'dlat':  float(lats[1] - lats[0]),
            'dlon':  float(lons[1] - lons[0]),
            'generated_utc': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        },
        'times': times,
        'lats':  [round(x, 4) for x in lats.tolist()],
        'lons':  [round(x, 4) for x in lons.tolist()],
        'u':     pack(u),  'v':  pack(v),
        'uw':    uw,       'vw': vw,
    }

    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT_JSON, 'w', encoding='utf-8') as f:
        json.dump(payload, f, separators=(',', ':'))
    print(f"Wrote {OUT_JSON}  ({OUT_JSON.stat().st_size / 1e6:.2f} MB · wind={wind_source is not None})")


if __name__ == '__main__':
    main()
