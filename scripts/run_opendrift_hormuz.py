#!/usr/bin/env python3
"""
Run a high-fidelity OpenDrift/OpenOil case from the Tridel Hormuz web forcing.

This is the operational/fidelity bridge for the browser app:
- reads data/currents.json, the same hourly forcing used by the website
- writes a CF-style NetCDF file that OpenDrift readers can consume
- runs OpenOil for oil spills or Leeway for S&R-style objects

Install:
    pip install opendrift xarray netCDF4 numpy

Examples:
    python scripts/run_opendrift_hormuz.py --scenario oil --lon 56.10 --lat 26.45
    python scripts/run_opendrift_hormuz.py --scenario leeway --category piw_light --lon 56.10 --lat 26.45
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import numpy as np
import xarray as xr

try:
    from forcing_chunks import expand_chunked_payload
except ImportError:  # Allows importing this file as scripts.run_opendrift_hormuz.
    from scripts.forcing_chunks import expand_chunked_payload

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_FORCING_JSON = ROOT / "data" / "currents.json"
DEFAULT_OUTPUT_DIR = ROOT / "opendrift_output"

OIL_PRESETS = {
    "light_crude": {
        "name_hints": ["GENERIC LIGHT CRUDE", "LIGHT CRUDE", "EKOFISK"],
        "density": 820.0,
        "viscosity": 5.0e-6,
    },
    "medium_crude": {
        "name_hints": ["GENERIC MEDIUM CRUDE", "MEDIUM CRUDE", "STATFJORD"],
        "density": 910.0,
        "viscosity": 1.0e-4,
    },
    "heavy_fuel": {
        "name_hints": ["GENERIC HEAVY FUEL OIL", "FUEL OIL NO. 6", "IFO", "BUNKER"],
        "density": 980.0,
        "viscosity": 1.0e-3,
    },
    "diesel": {
        "name_hints": ["DIESEL", "MARINE DIESEL", "NO. 2"],
        "density": 840.0,
        "viscosity": 3.0e-6,
    },
    "condensate": {
        "name_hints": ["CONDENSATE", "GASOLINE"],
        "density": 780.0,
        "viscosity": 2.0e-6,
    },
}

LEEWAY_HINTS = {
    "piw_ps": ["PIW", "SURVIVAL"],
    "piw_heavy": ["PIW", "HEAVY"],
    "piw_light": ["PIW", "PERSON-IN-WATER"],
    "piw_dec": ["PIW", "DECEASED"],
    "raft_4_6": ["RAFT", "4", "6"],
    "raft_4_6b": ["RAFT", "BALLAST", "CANOPY"],
    "raft_15": ["RAFT", "15"],
    "raft_20": ["RAFT", "20"],
    "sail_keel": ["SAILBOAT", "KEEL"],
    "sail_dism": ["SAILBOAT", "DISMASTED"],
    "skiff": ["SKIFF"],
    "fish_sm": ["FISHING", "VESSEL"],
    "fish_md": ["FISHING", "VESSEL"],
    "cont_40": ["CONTAINER", "40"],
    "cont_20": ["CONTAINER", "20"],
    "kayak": ["KAYAK"],
    "surf": ["SURFBOARD"],
    "swamp": ["SWAMPED"],
    "debris": ["DEBRIS"],
}


def parse_utc(value: str | None) -> datetime | None:
    if not value:
        return None
    text = value.replace("Z", "+00:00").replace(" ", "T")
    dt = datetime.fromisoformat(text)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).replace(tzinfo=None)


def load_payload(path: Path) -> dict[str, Any]:
    return expand_chunked_payload(path)


def cube(payload: dict[str, Any], key: str) -> np.ndarray:
    return np.array(payload[key], dtype=np.float32)


def payload_times(payload: dict[str, Any]) -> list[datetime]:
    return [parse_utc(t) for t in payload["times"]]


def forcing_json_to_cf_netcdf(payload: dict[str, Any], output_nc: Path) -> Path:
    output_nc.parent.mkdir(parents=True, exist_ok=True)
    times = np.array(payload_times(payload), dtype="datetime64[ns]")
    lats = np.array(payload["lats"], dtype=np.float32)
    lons = np.array(payload["lons"], dtype=np.float32)

    data_vars = {
        "x_sea_water_velocity": (("time", "lat", "lon"), cube(payload, "u")),
        "y_sea_water_velocity": (("time", "lat", "lon"), cube(payload, "v")),
    }
    if payload.get("uw") is not None and payload.get("vw") is not None:
        data_vars["x_wind"] = (("time", "lat", "lon"), cube(payload, "uw"))
        data_vars["y_wind"] = (("time", "lat", "lon"), cube(payload, "vw"))

    ds = xr.Dataset(
        data_vars=data_vars,
        coords={
            "time": ("time", times),
            "lat": ("lat", lats),
            "lon": ("lon", lons),
        },
        attrs={
            "title": "Tridel Hormuz OpenDrift forcing converted from browser JSON",
            "source": payload.get("meta", {}).get("source", "unknown"),
            "Conventions": "CF-1.8",
        },
    )
    ds["lat"].attrs.update({"standard_name": "latitude", "units": "degrees_north", "axis": "Y"})
    ds["lon"].attrs.update({"standard_name": "longitude", "units": "degrees_east", "axis": "X"})
    ds["x_sea_water_velocity"].attrs.update(
        {"standard_name": "eastward_sea_water_velocity", "units": "m s-1"}
    )
    ds["y_sea_water_velocity"].attrs.update(
        {"standard_name": "northward_sea_water_velocity", "units": "m s-1"}
    )
    if "x_wind" in ds:
        ds["x_wind"].attrs.update({"standard_name": "eastward_wind", "units": "m s-1"})
        ds["y_wind"].attrs.update({"standard_name": "northward_wind", "units": "m s-1"})

    encoding = {name: {"zlib": True, "complevel": 4, "_FillValue": np.float32(np.nan)} for name in data_vars}
    ds.to_netcdf(output_nc, encoding=encoding)
    return output_nc


def safe_set_config(model: Any, key: str, value: Any) -> None:
    try:
        model.set_config(key, value)
    except Exception as exc:  # OpenDrift config keys vary by model/version.
        print(f"[skip] {key}={value!r}: {exc}")


def add_readers(model: Any, forcing_nc: Path) -> None:
    from opendrift.readers import reader_netCDF_CF_generic

    readers = [reader_netCDF_CF_generic.Reader(str(forcing_nc))]
    try:
        from opendrift.readers import reader_global_landmask

        readers.append(reader_global_landmask.Reader())
    except Exception as exc:
        print(f"[warn] Global landmask reader unavailable: {exc}")
    model.add_reader(readers)


def configure_model(model: Any, forcing_nc: Path, args: argparse.Namespace) -> None:
    add_readers(model, forcing_nc)
    safe_set_config(model, "general:time_step_minutes", args.time_step_minutes)
    safe_set_config(model, "general:time_step_output_minutes", args.output_step_minutes)
    safe_set_config(model, "drift:advection_scheme", "runge-kutta")
    safe_set_config(model, "general:coastline_action", "stranding")
    safe_set_config(model, "drift:horizontal_diffusivity", float(args.diffusion_k))
    if args.vertical_mixing:
        safe_set_config(model, "drift:vertical_mixing", True)


def choose_oil_type(model: Any, oil_key: str) -> str | None:
    preset = OIL_PRESETS.get(oil_key, OIL_PRESETS["medium_crude"])
    available = [str(item) for item in getattr(model, "oiltypes", [])]
    upper_available = [(item, item.upper()) for item in available]
    for hint in preset["name_hints"]:
        hint_u = hint.upper()
        for original, upper in upper_available:
            if hint_u in upper:
                return original
    return None


def choose_leeway_object(model: Any, category: str) -> int:
    hints = [h.upper() for h in LEEWAY_HINTS.get(category, LEEWAY_HINTS["debris"])]
    best_id = 1
    best_score = -1
    for object_id, props in model.leewayprop.items():
        text = f"{props.get('OBJKEY', '')} {props.get('Description', '')}".upper()
        score = sum(1 for hint in hints if hint in text)
        if score > best_score:
            best_id = object_id
            best_score = score
    props = model.leewayprop[best_id]
    print(f"[OK] Leeway category {category!r} -> {best_id}: {props['OBJKEY']} / {props['Description']}")
    return best_id


def run_oil(forcing_nc: Path, args: argparse.Namespace, start_time: datetime) -> Any:
    from opendrift.models.openoil import OpenOil

    model = OpenOil(loglevel=args.loglevel, weathering_model=args.weathering_model)
    configure_model(model, forcing_nc, args)
    for key in [
        "processes:evaporation",
        "processes:emulsification",
        "processes:dispersion",
        "processes:biodegradation",
    ]:
        safe_set_config(model, key, True)

    preset = OIL_PRESETS.get(args.oil_type, OIL_PRESETS["medium_crude"])
    oil_type_name = choose_oil_type(model, args.oil_type)
    seed_kwargs = {
        "lon": args.lon,
        "lat": args.lat,
        "number": args.particles,
        "radius": args.radius_m,
        "time": start_time,
        "m3_per_hour": args.oil_volume_m3,
        "density": preset["density"],
        "viscosity": preset["viscosity"],
    }
    if oil_type_name:
        seed_kwargs["oil_type"] = oil_type_name
        print(f"[OK] OpenOil oil type {args.oil_type!r} -> {oil_type_name!r}")
    else:
        print(f"[warn] No OpenOil library match for {args.oil_type!r}; using density/viscosity override.")
    model.seed_elements(**seed_kwargs)
    return model


def run_leeway(forcing_nc: Path, args: argparse.Namespace, start_time: datetime) -> Any:
    from opendrift.models.leeway import Leeway

    model = Leeway(loglevel=args.loglevel)
    configure_model(model, forcing_nc, args)
    safe_set_config(model, "drift:stokes_drift", bool(args.stokes_drift))
    object_type = choose_leeway_object(model, args.category)
    model.seed_elements(
        lon=args.lon,
        lat=args.lat,
        number=args.particles,
        radius=args.radius_m,
        time=start_time,
        object_type=object_type,
    )
    return model


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run a high-fidelity OpenDrift case for the Hormuz web model.")
    parser.add_argument("--forcing-json", type=Path, default=DEFAULT_FORCING_JSON)
    parser.add_argument("--forcing-nc", type=Path, default=DEFAULT_OUTPUT_DIR / "hormuz_forcing_cf.nc")
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    parser.add_argument("--scenario", choices=["oil", "leeway"], default="oil")
    parser.add_argument("--lon", type=float, required=True)
    parser.add_argument("--lat", type=float, required=True)
    parser.add_argument("--start-time", help="UTC time, defaults to first forcing time")
    parser.add_argument("--duration-hours", type=float, default=72)
    parser.add_argument("--particles", type=int, default=1000)
    parser.add_argument("--radius-m", type=float, default=250)
    parser.add_argument("--diffusion-k", type=float, default=10)
    parser.add_argument("--time-step-minutes", type=float, default=10)
    parser.add_argument("--output-step-minutes", type=float, default=60)
    parser.add_argument("--oil-type", choices=sorted(OIL_PRESETS), default="heavy_fuel")
    parser.add_argument("--oil-volume-m3", type=float, default=100)
    parser.add_argument("--weathering-model", choices=["noaa", "sintef"], default="noaa")
    parser.add_argument("--category", default="piw_light", help="Browser leeway category id")
    parser.add_argument("--vertical-mixing", action="store_true", default=True)
    parser.add_argument("--no-vertical-mixing", action="store_false", dest="vertical_mixing")
    parser.add_argument("--stokes-drift", action="store_true")
    parser.add_argument("--rebuild-forcing", action="store_true")
    parser.add_argument("--loglevel", type=int, default=20)
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)

    payload = load_payload(args.forcing_json)
    if args.rebuild_forcing or not args.forcing_nc.exists():
        print(f"[build] Converting {args.forcing_json} -> {args.forcing_nc}")
        forcing_json_to_cf_netcdf(payload, args.forcing_nc)
    else:
        print(f"[reuse] Using existing forcing NetCDF: {args.forcing_nc}")

    times = payload_times(payload)
    start_time = parse_utc(args.start_time) or times[0]
    forcing_start = times[0]
    forcing_end = times[-1]
    if start_time < forcing_start or start_time >= forcing_end:
        raise SystemExit(
            f"Start time {start_time} is outside forcing window "
            f"{forcing_start} to {forcing_end}."
        )
    max_duration_hours = (forcing_end - start_time).total_seconds() / 3600
    if args.duration_hours > max_duration_hours:
        print(
            f"[warn] Duration capped from {args.duration_hours:g} h to "
            f"{max_duration_hours:g} h to stay inside the forcing window."
        )
        args.duration_hours = max_duration_hours
    if args.scenario == "oil":
        model = run_oil(args.forcing_nc, args, start_time)
    else:
        model = run_leeway(args.forcing_nc, args, start_time)

    outfile = args.output_dir / f"hormuz_{args.scenario}_opendrift.nc"
    print(f"[run] {args.scenario} from lon={args.lon:.5f}, lat={args.lat:.5f}, start={start_time}")
    model.run(
        duration=timedelta(hours=args.duration_hours),
        time_step=timedelta(minutes=args.time_step_minutes),
        time_step_output=timedelta(minutes=args.output_step_minutes),
        outfile=str(outfile),
    )
    print(f"[done] OpenDrift output: {outfile.resolve()}")


if __name__ == "__main__":
    main()
