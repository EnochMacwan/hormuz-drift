"""
No-login real-time refresh for the Hormuz Drift web model.

This is the fallback/live-data path when CMEMS credentials are unavailable.
It pulls NOAA/NCEP Global RTOFS 2-D forecast NetCDF files from NOMADS, extracts
the Strait of Hormuz box, enriches the result with Open-Meteo/GFS 10 m wind,
and writes data/currents.json.

The source RTOFS files are large global grids, so this script downloads them to
data/cache only long enough to extract the small Hormuz subset.
"""

import argparse
import json
import re
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import xarray as xr

from prepare_data import fetch_wind_openmeteo, pack

LON_MIN, LON_MAX = 54.5, 57.8
LAT_MIN, LAT_MAX = 25.5, 27.5
DEFAULT_HOURS = tuple(range(0, 73, 6))

ROOT = Path(__file__).resolve().parent.parent
OUT_JSON = ROOT / "data" / "currents.json"
CACHE_DIR = ROOT / "data" / "cache"
RTOFS_INDEX = "https://nomads.ncep.noaa.gov/pub/data/nccf/com/rtofs/prod"


def latest_rtofs_day():
    """Return latest YYYYMMDD directory advertised by NOAA NOMADS."""
    with urllib.request.urlopen(RTOFS_INDEX + "/", timeout=60) as response:
        html = response.read().decode("utf-8", errors="replace")
    days = sorted(set(re.findall(r"rtofs\.(\d{8})/", html)))
    if not days:
        raise RuntimeError("No rtofs.YYYYMMDD directories found on NOMADS.")
    return days[-1]


def download_file(day, hour):
    """Download one RTOFS forecast-hour file into the local cache."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    name = f"rtofs_glo_2ds_f{hour:03d}_prog.nc"
    url = f"{RTOFS_INDEX}/rtofs.{day}/{name}"
    out = CACHE_DIR / name
    if out.exists() and out.stat().st_size > 100_000_000:
        print(f"Using cached {name} ...")
        return out
    print(f"Downloading {name} ...")
    request = urllib.request.Request(url, headers={"User-Agent": "hormuz-drift-data-refresh/1.0"})
    with urllib.request.urlopen(request, timeout=300) as response, open(out, "wb") as handle:
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            handle.write(chunk)
    return out


def subset_rtofs(path):
    """Extract surface u/v current data for the configured Hormuz bbox."""
    with xr.open_dataset(path, mask_and_scale=True) as ds:
        lat2 = ds["Latitude"].values.astype(np.float32)
        lon2 = ds["Longitude"].values.astype(np.float32)
        lon_norm = np.where(lon2 > 360, lon2 - 360, lon2)

        y_idx = np.where((lat2[:, 0] >= LAT_MIN) & (lat2[:, 0] <= LAT_MAX))[0]
        x_idx = np.where((lon_norm[0, :] >= LON_MIN) & (lon_norm[0, :] <= LON_MAX))[0]
        if len(y_idx) < 2 or len(x_idx) < 2:
            raise RuntimeError(f"Hormuz bbox not found in {path.name}.")

        lats = lat2[y_idx, 0].astype(float)
        lons = lon_norm[0, x_idx].astype(float)
        u = ds["u_velocity"].isel(MT=0, Layer=0, Y=y_idx, X=x_idx).values.astype(np.float32)
        v = ds["v_velocity"].isel(MT=0, Layer=0, Y=y_idx, X=x_idx).values.astype(np.float32)
        u = np.where(np.abs(u) > 1e10, np.nan, u)
        v = np.where(np.abs(v) > 1e10, np.nan, v)
        time_value = np.asarray(ds["MT"].values)[0]
    return time_value, lats, lons, u, v


def fmt_time(value):
    return np.datetime_as_string(value, unit="s").replace("T", " ")


def main():
    parser = argparse.ArgumentParser(description="Fetch NOAA RTOFS data for Hormuz Drift.")
    parser.add_argument("--day", help="RTOFS day as YYYYMMDD. Defaults to latest NOMADS directory.")
    parser.add_argument("--hours", default=",".join(str(h) for h in DEFAULT_HOURS),
                        help="Comma-separated forecast hours, default: 0,3,...,24")
    parser.add_argument("--keep-cache", action="store_true", help="Keep downloaded NetCDF files.")
    args = parser.parse_args()

    day = args.day or latest_rtofs_day()
    hours = [int(part.strip()) for part in args.hours.split(",") if part.strip()]
    print(f"Using NOAA RTOFS run rtofs.{day}, forecast hours: {hours}")

    times = []
    u_slices = []
    v_slices = []
    lats = lons = None
    downloaded = []

    for hour in hours:
        path = download_file(day, hour)
        downloaded.append(path)
        t, slice_lats, slice_lons, u, v = subset_rtofs(path)
        if lats is None:
            lats = slice_lats
            lons = slice_lons
        times.append(t)
        u_slices.append(u)
        v_slices.append(v)
        print(f"  {fmt_time(t)} | grid {u.shape} | valid cells {np.isfinite(u).sum()}")

    u_arr = np.stack(u_slices, axis=0)
    v_arr = np.stack(v_slices, axis=0)

    print("Fetching Open-Meteo/GFS wind for the same time window ...")
    uw_arr, vw_arr, wind_source = fetch_wind_openmeteo(np.asarray(times), lats, lons)

    payload = {
        "meta": {
            "source": f"NOAA/NCEP Global RTOFS 2-D surface currents (rtofs.{day})",
            "wind_source": wind_source,
            "time_start": fmt_time(times[0]),
            "time_end": fmt_time(times[-1]),
            "time_step_sec": int((times[1] - times[0]) / np.timedelta64(1, "s")) if len(times) > 1 else 3600,
            "n_times": len(times),
            "n_lat": len(lats),
            "n_lon": len(lons),
            "dlat": float(np.mean(np.diff(lats))),
            "dlon": float(np.mean(np.diff(lons))),
            "generated_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        },
        "times": [fmt_time(t) for t in times],
        "lats": [round(float(x), 4) for x in lats.tolist()],
        "lons": [round(float(x), 4) for x in lons.tolist()],
        "u": pack(u_arr),
        "v": pack(v_arr),
        "uw": pack(uw_arr) if uw_arr is not None else None,
        "vw": pack(vw_arr) if vw_arr is not None else None,
    }

    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT_JSON, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, separators=(",", ":"))

    if not args.keep_cache:
        for path in downloaded:
            path.unlink(missing_ok=True)

    print(f"Wrote {OUT_JSON} ({OUT_JSON.stat().st_size / 1e6:.2f} MB)")


if __name__ == "__main__":
    main()
