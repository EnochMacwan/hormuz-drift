#!/usr/bin/env python3
"""Validate the packed browser forcing file.

The web app expects data/currents.json to be a compact cube with matching
time, latitude, longitude, current, and optional wind arrays. This script is
intentionally dependency-free so it can run in GitHub Actions after either the
CMEMS path or the NOAA RTOFS fallback path refreshes the dataset.
"""

from __future__ import annotations

import argparse
import json
import math
import statistics
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


REQUIRED_TOP_LEVEL_KEYS = ("meta", "times", "lats", "lons", "u", "v")


def parse_utc(value: Any) -> datetime | None:
    if not value:
        return None
    text = str(value).strip().replace(" ", "T")
    if text.endswith("Z"):
        text = f"{text[:-1]}+00:00"
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def is_finite_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def validate_axis(name: str, values: Any, failures: list[str]) -> int:
    if not isinstance(values, list) or not values:
        failures.append(f"{name} must be a non-empty list")
        return 0
    bad = [idx for idx, value in enumerate(values) if not is_finite_number(value)]
    if bad:
        failures.append(f"{name} contains non-numeric values at indexes {bad[:5]}")
    if any(values[idx] >= values[idx + 1] for idx in range(len(values) - 1) if is_finite_number(values[idx]) and is_finite_number(values[idx + 1])):
        failures.append(f"{name} must be strictly increasing")
    return len(values)


def validate_cube(name: str, cube: Any, n_time: int, n_lat: int, n_lon: int, failures: list[str]) -> tuple[int, int]:
    """Return (valid_number_count, null_count) after shape and value checks."""
    if not isinstance(cube, list):
        failures.append(f"{name} must be a list")
        return 0, 0
    if len(cube) != n_time:
        failures.append(f"{name} time dimension is {len(cube)}, expected {n_time}")
        return 0, 0

    valid = 0
    nulls = 0
    shape_errors = 0
    value_errors = 0

    for ti, time_slice in enumerate(cube):
        if not isinstance(time_slice, list) or len(time_slice) != n_lat:
            shape_errors += 1
            if shape_errors <= 3:
                failures.append(f"{name}[{ti}] latitude dimension is invalid")
            continue
        for j, row in enumerate(time_slice):
            if not isinstance(row, list) or len(row) != n_lon:
                shape_errors += 1
                if shape_errors <= 3:
                    failures.append(f"{name}[{ti}][{j}] longitude dimension is invalid")
                continue
            for i, value in enumerate(row):
                if value is None:
                    nulls += 1
                elif is_finite_number(value):
                    valid += 1
                else:
                    value_errors += 1
                    if value_errors <= 5:
                        failures.append(f"{name}[{ti}][{j}][{i}] must be a finite number or null")

    if shape_errors > 3:
        failures.append(f"{name} has {shape_errors} total shape errors")
    if value_errors > 5:
        failures.append(f"{name} has {value_errors} total value errors")
    return valid, nulls


def paired_speeds(u_cube: list[Any], v_cube: list[Any]) -> tuple[list[float], int]:
    speeds: list[float] = []
    mask_mismatches = 0
    for u_slice, v_slice in zip(u_cube, v_cube):
        for u_row, v_row in zip(u_slice, v_slice):
            for u_value, v_value in zip(u_row, v_row):
                u_ok = is_finite_number(u_value)
                v_ok = is_finite_number(v_value)
                if u_ok and v_ok:
                    speeds.append(math.hypot(float(u_value), float(v_value)))
                elif u_ok != v_ok:
                    mask_mismatches += 1
    return speeds, mask_mismatches


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate data/currents.json for the browser drift app.")
    parser.add_argument("path", nargs="?", default="data/currents.json", help="Path to currents JSON")
    args = parser.parse_args()

    path = Path(args.path)
    failures: list[str] = []
    warnings: list[str] = []

    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        print(f"FAIL: {path} does not exist", file=sys.stderr)
        return 1
    except json.JSONDecodeError as exc:
        print(f"FAIL: {path} is not valid JSON: {exc}", file=sys.stderr)
        return 1

    if not isinstance(payload, dict):
        print("FAIL: payload must be a JSON object", file=sys.stderr)
        return 1

    for key in REQUIRED_TOP_LEVEL_KEYS:
        if key not in payload:
            failures.append(f"missing top-level key: {key}")
    if failures:
        for message in failures:
            print(f"FAIL: {message}", file=sys.stderr)
        return 1

    meta = payload["meta"] if isinstance(payload["meta"], dict) else {}
    if not meta:
        failures.append("meta must be an object")

    times = payload["times"]
    if not isinstance(times, list) or not times:
        failures.append("times must be a non-empty list")
        n_time = 0
    else:
        n_time = len(times)

    n_lat = validate_axis("lats", payload["lats"], failures)
    n_lon = validate_axis("lons", payload["lons"], failures)

    if failures:
        for message in failures:
            print(f"FAIL: {message}", file=sys.stderr)
        return 1

    for meta_key, actual in (("n_times", n_time), ("n_lat", n_lat), ("n_lon", n_lon)):
        declared = meta.get(meta_key)
        if declared is not None and int(declared) != actual:
            failures.append(f"meta.{meta_key} is {declared}, expected {actual}")

    parsed_times = [parse_utc(value) for value in times]
    if any(value is None for value in parsed_times):
        failures.append("times contains values that cannot be parsed as UTC datetimes")
    else:
        for idx in range(len(parsed_times) - 1):
            assert parsed_times[idx] is not None
            assert parsed_times[idx + 1] is not None
            if parsed_times[idx] >= parsed_times[idx + 1]:
                failures.append(f"times must be strictly increasing around index {idx}")
                break
        dt_sec = int(meta.get("time_step_sec") or 0)
        if dt_sec <= 0:
            failures.append("meta.time_step_sec must be positive")
        elif len(parsed_times) > 1:
            for idx in range(len(parsed_times) - 1):
                assert parsed_times[idx] is not None
                assert parsed_times[idx + 1] is not None
                delta = int((parsed_times[idx + 1] - parsed_times[idx]).total_seconds())
                if delta != dt_sec:
                    failures.append(f"times step at index {idx} is {delta}s, expected {dt_sec}s")
                    break

    u_valid, _u_nulls = validate_cube("u", payload["u"], n_time, n_lat, n_lon, failures)
    v_valid, _v_nulls = validate_cube("v", payload["v"], n_time, n_lat, n_lon, failures)

    has_wind = "uw" in payload or "vw" in payload
    if has_wind and ("uw" not in payload or "vw" not in payload):
        failures.append("wind arrays must include both uw and vw")
    elif has_wind:
        validate_cube("uw", payload["uw"], n_time, n_lat, n_lon, failures)
        validate_cube("vw", payload["vw"], n_time, n_lat, n_lon, failures)

    if failures:
        for message in failures:
            print(f"FAIL: {message}", file=sys.stderr)
        return 1

    current_speeds, current_mask_mismatches = paired_speeds(payload["u"], payload["v"])
    if current_mask_mismatches:
        failures.append(f"u/v land masks differ in {current_mask_mismatches} cells")
    if not current_speeds:
        failures.append("no valid paired current cells found")
    else:
        total_cells = n_time * n_lat * n_lon
        water_fraction = len(current_speeds) / max(1, total_cells)
        max_current = max(current_speeds)
        if water_fraction < 0.01:
            failures.append(f"only {water_fraction:.1%} of current cells are valid water")
        if max_current > 10:
            failures.append(f"current speed max {max_current:.2f} m/s is outside sanity bound")
        elif max_current > 3:
            warnings.append(f"current speed max {max_current:.2f} m/s is unusually high")

    wind_speeds: list[float] = []
    wind_mask_mismatches = 0
    if has_wind and not failures:
        wind_speeds, wind_mask_mismatches = paired_speeds(payload["uw"], payload["vw"])
        if wind_mask_mismatches:
            failures.append(f"uw/vw masks differ in {wind_mask_mismatches} cells")
        if not wind_speeds:
            warnings.append("wind arrays are present but contain no paired finite values")
        elif max(wind_speeds) > 75:
            failures.append(f"wind speed max {max(wind_speeds):.2f} m/s is outside sanity bound")
        elif max(wind_speeds) > 40:
            warnings.append(f"wind speed max {max(wind_speeds):.2f} m/s is unusually high")

    generated = parse_utc(meta.get("generated_utc"))
    if generated:
        age_hours = (datetime.now(timezone.utc) - generated).total_seconds() / 3600
        if age_hours > 240:
            warnings.append(f"dataset was generated {age_hours / 24:.1f} days ago")
        elif age_hours < -24:
            warnings.append(f"dataset generated_utc is {abs(age_hours) / 24:.1f} days in the future")
    else:
        warnings.append("meta.generated_utc is missing or unparsable")

    if failures:
        for message in failures:
            print(f"FAIL: {message}", file=sys.stderr)
        return 1

    current_median = statistics.median(current_speeds)
    current_p90 = statistics.quantiles(current_speeds, n=10)[8] if len(current_speeds) >= 10 else max(current_speeds)

    print(f"OK: {path}")
    print(f"  source: {meta.get('source', 'unknown')}")
    print(f"  wind: {meta.get('wind_source', 'not embedded') if has_wind else 'not embedded'}")
    print(f"  window: {times[0]} UTC to {times[-1]} UTC")
    print(f"  grid: {n_time} frames x {n_lat} lat x {n_lon} lon")
    print(f"  current cells: {len(current_speeds):,} paired valid ({u_valid:,} u / {v_valid:,} v)")
    print(f"  current speed: median {current_median:.2f} m/s, p90 {current_p90:.2f} m/s, max {max(current_speeds):.2f} m/s")
    if wind_speeds:
        print(f"  wind speed: median {statistics.median(wind_speeds):.2f} m/s, max {max(wind_speeds):.2f} m/s")
    for message in warnings:
        print(f"WARN: {message}", file=sys.stderr)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
