"""
Daily data refresh for the Hormuz Drift web model.

Run by .github/workflows/daily-data.yml (cron 06:00 UTC) or manually:

    python scripts/fetch_data.py

Downloads:
  • CMEMS global hourly merged surface currents (utotal, vtotal)
  • NCEP GFS 0.25° surface wind (u10, v10)  [if available]

Produces: data/currents.json (replaces previous file)

Environment variables:
  CMEMS_USER, CMEMS_PASS   — required for the copernicusmarine client

BBox + time window are the editable knobs at the top of this file.
"""

import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import xarray as xr

# ── knobs ──────────────────────────────────────────────────────────────
LON_MIN, LON_MAX = 54.5, 57.8
LAT_MIN, LAT_MAX = 25.5, 27.5
HINDCAST_DAYS    = 3     # pull the last N days as "history"
FORECAST_DAYS    = 5     # pull the next N days as forecast

ROOT      = Path(__file__).resolve().parent.parent
OUT_JSON  = ROOT / 'data' / 'currents.json'
CACHE_DIR = ROOT / 'data' / 'cache'
CACHE_DIR.mkdir(parents=True, exist_ok=True)


def fetch_cmems():
    """Subset the CMEMS merged-uv hourly product to the Hormuz bbox."""
    try:
        import copernicusmarine as cm
    except ImportError:
        sys.exit("pip install copernicusmarine")

    user = os.environ.get('CMEMS_USER')
    pw   = os.environ.get('CMEMS_PASS')
    if not user or not pw:
        sys.exit("Set CMEMS_USER and CMEMS_PASS environment variables.")

    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    t0  = now - timedelta(days=HINDCAST_DAYS)
    t1  = now + timedelta(days=FORECAST_DAYS)

    out = CACHE_DIR / 'cmems.nc'
    print(f"CMEMS subset → {out}")
    cm.subset(
        dataset_id='cmems_mod_glo_phy_anfc_merged-uv_PT1H-i',
        variables=['utotal', 'vtotal'],
        minimum_longitude=LON_MIN, maximum_longitude=LON_MAX,
        minimum_latitude =LAT_MIN, maximum_latitude =LAT_MAX,
        minimum_depth=0, maximum_depth=1,
        start_datetime=t0.isoformat(), end_datetime=t1.isoformat(),
        output_filename=str(out),
        username=user, password=pw,
        force_download=True, overwrite_output_data=True,
    )
    return xr.open_dataset(out)


def fetch_gfs(times):
    """
    Pull GFS surface wind (u10, v10) at the requested hours via NOMADS OpenDAP.
    Falls back to None on any failure (offline mode, outage). The web model
    handles missing wind gracefully — currents-only drift still works.
    """
    try:
        url = ('https://nomads.ncep.noaa.gov/dods/gfs_0p25_1hr/'
               f'gfs{times[0].strftime("%Y%m%d")}/gfs_0p25_1hr_00z')
        ds = xr.open_dataset(url)
        ds = ds[['ugrd10m', 'vgrd10m']].sel(
            lon=slice(LON_MIN % 360, LON_MAX % 360),
            lat=slice(LAT_MIN, LAT_MAX),
        )
        ds = ds.interp(time=times, method='linear')
        return ds
    except Exception as e:
        print(f"GFS fetch skipped: {e}", file=sys.stderr)
        return None


def pack(a):
    return np.where(np.isnan(a), None, np.round(a, 3)).tolist()


def main():
    ds_cm = fetch_cmems()
    lats  = ds_cm['latitude'].values.astype(float)
    lons  = ds_cm['longitude'].values.astype(float)
    times = [str(t)[:19].replace('T', ' ') for t in ds_cm['time'].values]
    u = ds_cm['utotal'].isel(depth=0).values.astype(np.float32)
    v = ds_cm['vtotal'].isel(depth=0).values.astype(np.float32)

    uw = vw = None
    wind_source = None
    ds_wind = fetch_gfs(ds_cm['time'].values)
    if ds_wind is not None:
        wind_source = 'NCEP GFS 0.25° surface (u10, v10)'
        # re-grid wind to CMEMS grid via bilinear interp
        w = ds_wind.interp(lat=xr.DataArray(lats, dims='latitude'),
                           lon=xr.DataArray(lons % 360, dims='longitude'))
        uw = pack(w['ugrd10m'].values.astype(np.float32))
        vw = pack(w['vgrd10m'].values.astype(np.float32))

    payload = {
        'meta': {
            'source':        'CMEMS GLOBAL_ANALYSISFORECAST_PHY_001_024 (merged-uv hourly)',
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
