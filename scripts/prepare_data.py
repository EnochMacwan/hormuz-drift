"""
Convert a local CMEMS NetCDF file into the compact JSON the web model loads,
with GFS surface wind from Open-Meteo (free, no auth).

Run once after every new NetCDF download when you are working offline or with
the bundled local sample file. Output: data/currents.json

When wind is available, uw/vw are populated and the UI automatically enables
wind drift, Leeway, and Stokes controls.
"""

import json
# Maintainer note:
# This is the simplest end-to-end local pipeline in the repo. It takes one
# CMEMS NetCDF file on disk, optionally enriches it with wind, and writes the
# JSON cube the browser app knows how to load.
import sys
import urllib.request
from datetime import datetime
from pathlib import Path

import numpy as np
import xarray as xr

ROOT     = Path(__file__).resolve().parent.parent
NC_FILE  = ROOT / 'cmems_mod_glo_phy_anfc_merged-uv_PT1H-i_1776382234335.nc'
OUT_JSON = ROOT / 'data' / 'currents.json'

# ── Bounding box (Hormuz) ─────────────────────────────────────────────
LON_MIN, LON_MAX = 54.5, 57.8
LAT_MIN, LAT_MAX = 25.5, 27.5


def fetch_wind_openmeteo(cm_times, cm_lats, cm_lons):
    """
    Fetch surface wind (u10, v10) from the Open-Meteo Archive + Forecast API.
    Queries a grid of representative points covering the Hormuz bbox, then
    interpolates to the CMEMS grid.

    Open-Meteo is free, no auth required, and provides hourly data.
    Returns (uw, vw, source_label) or (None, None, None) on failure.
    """
    import pandas as pd

    time_min = pd.Timestamp(cm_times[0])
    time_max = pd.Timestamp(cm_times[-1])
    date_start = time_min.strftime('%Y-%m-%d')
    date_end   = time_max.strftime('%Y-%m-%d')

    # Create a coarse query mesh across the bbox so the resulting wind field
    # can retain some spatial structure rather than becoming one constant vector.
    query_lats = np.linspace(LAT_MIN, LAT_MAX, 5)
    query_lons = np.linspace(LON_MIN, LON_MAX, 7)

    all_u10 = []
    all_v10 = []
    all_lat = []
    all_lon = []

    print(f"  Querying Open-Meteo for wind ({date_start} to {date_end}) ...")
    for lat in query_lats:
        for lon in query_lons:
            url = (
                f"https://api.open-meteo.com/v1/forecast?"
                f"latitude={lat:.2f}&longitude={lon:.2f}"
                f"&hourly=wind_speed_10m,wind_direction_10m"
                f"&wind_speed_unit=ms"
                f"&start_date={date_start}&end_date={date_end}"
                f"&timezone=UTC"
            )
            try:
                req = urllib.request.Request(url)
                with urllib.request.urlopen(req, timeout=30) as resp:
                    data = json.loads(resp.read().decode('utf-8'))

                hourly = data['hourly']
                times_str = hourly['time']
                ws = np.array(hourly['wind_speed_10m'], dtype=np.float32)
                wd = np.array(hourly['wind_direction_10m'], dtype=np.float32)

                # Convert speed+direction to u,v components. Meteorological
                # direction is where the wind comes FROM, so the signs invert to
                # recover the vector pointing where the flow goes TO.
                wd_rad = np.deg2rad(wd)
                u10 = -ws * np.sin(wd_rad)
                v10 = -ws * np.cos(wd_rad)

                all_u10.append(u10)
                all_v10.append(v10)
                all_lat.append(lat)
                all_lon.append(lon)
            except Exception as e:
                print(f"    Warning: failed for ({lat:.2f}, {lon:.2f}): {e}")
                continue

    if not all_u10:
        print("  [X] No wind data retrieved.")
        return None, None, None

    # Parse the timestamps from the first successful query
    om_times = pd.to_datetime(times_str)

    # Build a DataArray: shape (n_points, n_times)
    u_stack = np.array(all_u10)  # (n_points, n_times)
    v_stack = np.array(all_v10)
    q_lats = np.array(all_lat)
    q_lons = np.array(all_lon)

    # Reshape into a 2D lat x lon grid
    n_qlat = len(query_lats)
    n_qlon = len(query_lons)
    n_t = len(om_times)

    # Check we got all grid points
    if len(all_u10) != n_qlat * n_qlon:
        print(f"  Warning: got {len(all_u10)} of {n_qlat*n_qlon} expected grid points.")
        # Fall back to a spatially uniform field so the user still gets
        # time-varying wind even if some query points fail.
        u_mean = np.nanmean(u_stack, axis=0)  # (n_times,)
        v_mean = np.nanmean(v_stack, axis=0)

        # Create uniform field at all CMEMS grid points
        n_cm_times = len(cm_times)
        # Interpolate the coarser wind time axis to the exact CMEMS hours.
        cm_pd_times = pd.to_datetime([str(t)[:19] for t in cm_times])
        u_interp = np.interp(
            cm_pd_times.astype(np.int64),
            om_times.astype(np.int64),
            u_mean
        )
        v_interp = np.interp(
            cm_pd_times.astype(np.int64),
            om_times.astype(np.int64),
            v_mean
        )
        # Broadcast to (n_times, n_lat, n_lon)
        uw = np.broadcast_to(u_interp[:, None, None],
                             (n_cm_times, len(cm_lats), len(cm_lons))).copy()
        vw = np.broadcast_to(v_interp[:, None, None],
                             (n_cm_times, len(cm_lats), len(cm_lons))).copy()
    else:
        u_grid = u_stack.reshape(n_qlat, n_qlon, n_t)
        v_grid = v_stack.reshape(n_qlat, n_qlon, n_t)

        # Build an xarray Dataset so space+time interpolation can be delegated
        # to a well-tested library routine instead of hand-coded here.
        ds_wind = xr.Dataset({
            'u10': (['lat', 'lon', 'time'], u_grid),
            'v10': (['lat', 'lon', 'time'], v_grid),
        }, coords={
            'lat': query_lats,
            'lon': query_lons,
            'time': om_times,
        })

        # Interpolate to the final web-model grid in one step.
        cm_pd_times = pd.to_datetime([str(t)[:19] for t in cm_times])
        ds_wind = ds_wind.interp(
            lat=cm_lats,
            lon=cm_lons,
            time=cm_pd_times,
            method='linear',
        )
        uw = ds_wind['u10'].values.transpose(2, 0, 1).astype(np.float32)  # (time, lat, lon)
        vw = ds_wind['v10'].values.transpose(2, 0, 1).astype(np.float32)

    label = f'Open-Meteo GFS surface wind (u10, v10) {date_start} to {date_end}'
    mean_speed = np.sqrt(np.nanmean(uw**2 + vw**2))
    print(f"  [OK] Wind loaded: mean speed {mean_speed:.1f} m/s, shape {uw.shape}")
    return uw.astype(np.float32), vw.astype(np.float32), label


def pack(a):
    # Preserve missing cells as null and round the rest to keep the JSON small.
    return np.where(np.isnan(a), None, np.round(a, 3)).tolist()


def main():
    # Step 1: load the local CMEMS file and extract the surface current cube.
    print(f"Loading {NC_FILE.name}")
    ds = xr.open_dataset(NC_FILE)

    lats  = ds['latitude'].values.astype(float)
    lons  = ds['longitude'].values.astype(float)
    times = [str(t)[:19].replace('T', ' ') for t in ds['time'].values]
    u     = ds['utotal'].isel(depth=0).values.astype(np.float32)
    v     = ds['vtotal'].isel(depth=0).values.astype(np.float32)

    print(f"  Currents: {len(times)} time-steps, {len(lats)}x{len(lons)} grid")
    print(f"  Window:   {times[0]} -> {times[-1]}")

    # ── Fetch wind ────────────────────────────────────────────────────
    # Step 2: try to enrich the local current cube with wind.
    print("Fetching surface wind ...")
    uw_arr, vw_arr, wind_source = fetch_wind_openmeteo(ds['time'].values, lats, lons)

    uw = pack(uw_arr) if uw_arr is not None else None
    vw = pack(vw_arr) if vw_arr is not None else None

    # ── Build JSON payload ────────────────────────────────────────────
    # Step 3: write the exact schema the front-end expects.
    payload = {
        'meta': {
            'source':        'CMEMS GLOBAL_ANALYSISFORECAST_PHY_001_024 (merged-uv hourly)',
            'wind_source':   wind_source,
            'time_start':    times[0],
            'time_end':      times[-1],
            'time_step_sec': 3600,
            'n_times':       len(times),
            'n_lat':         len(lats),
            'n_lon':         len(lons),
            'dlat':          float(lats[1] - lats[0]),
            'dlon':          float(lons[1] - lons[0]),
            'generated_utc': datetime.utcnow().isoformat(timespec='seconds'),
        },
        'times': times,
        'lats':  [round(x, 4) for x in lats.tolist()],
        'lons':  [round(x, 4) for x in lons.tolist()],
        'u':     pack(u),
        'v':     pack(v),
        'uw':    uw,
        'vw':    vw,
    }

    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT_JSON, 'w', encoding='utf-8') as f:
        json.dump(payload, f, separators=(',', ':'))

    sz = OUT_JSON.stat().st_size / 1e6
    wind_flag = "with wind" if wind_source else "currents only"
    print(f"\nWrote {OUT_JSON}  ({sz:.2f} MB, {wind_flag})")


if __name__ == '__main__':
    main()
