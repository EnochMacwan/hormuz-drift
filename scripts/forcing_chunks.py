"""Helpers for writing and reading chunked browser forcing payloads.

The browser uses data/currents.json as a small manifest. Large time-dependent
arrays live in data/chunks/*.json so each committed file stays comfortably
below GitHub's large-file limits while the app can still expose a longer
forecast window.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any


DEFAULT_CHUNK_HOURS = 24
CHUNK_DIR_NAME = "chunks"


def _finite(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _paired_speed_stats(u_cube: list[Any], v_cube: list[Any]) -> dict[str, float | int]:
    speeds: list[float] = []
    for u_slice, v_slice in zip(u_cube, v_cube):
        for u_row, v_row in zip(u_slice, v_slice):
            for u_value, v_value in zip(u_row, v_row):
                if _finite(u_value) and _finite(v_value):
                    speeds.append(math.hypot(float(u_value), float(v_value)))
    if not speeds:
        return {"valid_cells": 0, "median": 0.0, "p90": 0.0, "max": 0.0}
    speeds.sort()
    return {
        "valid_cells": len(speeds),
        "median": speeds[len(speeds) // 2],
        "p90": speeds[min(len(speeds) - 1, int(len(speeds) * 0.9))],
        "max": speeds[-1],
    }


def write_chunked_payload(
    payload: dict[str, Any],
    out_json: Path,
    chunk_hours: int = DEFAULT_CHUNK_HOURS,
) -> dict[str, Any]:
    """Write a manifest plus time chunks, returning the manifest object."""
    out_json.parent.mkdir(parents=True, exist_ok=True)
    chunk_dir = out_json.parent / CHUNK_DIR_NAME
    chunk_dir.mkdir(parents=True, exist_ok=True)
    for old_chunk in chunk_dir.glob("currents_*.json"):
        old_chunk.unlink()

    times = payload["times"]
    n_times = len(times)
    has_wind = payload.get("uw") is not None and payload.get("vw") is not None
    chunks: list[dict[str, Any]] = []

    for chunk_id, start in enumerate(range(0, n_times, chunk_hours)):
        end = min(start + chunk_hours, n_times)
        filename = f"currents_{chunk_id:03d}.json"
        chunk_payload = {
            "start_index": start,
            "times": times[start:end],
            "u": payload["u"][start:end],
            "v": payload["v"][start:end],
        }
        if has_wind:
            chunk_payload["uw"] = payload["uw"][start:end]
            chunk_payload["vw"] = payload["vw"][start:end]

        chunk_path = chunk_dir / filename
        with chunk_path.open("w", encoding="utf-8") as handle:
            json.dump(chunk_payload, handle, separators=(",", ":"))

        chunks.append({
            "href": f"{CHUNK_DIR_NAME}/{filename}",
            "start_index": start,
            "end_index": end,
            "time_start": times[start],
            "time_end": times[end - 1],
        })

    meta = dict(payload.get("meta") or {})
    meta.update({
        "chunked": True,
        "chunk_size_hours": chunk_hours,
        "n_chunks": len(chunks),
        "has_wind": has_wind,
        "current_speed_stats": _paired_speed_stats(payload["u"], payload["v"]),
    })

    manifest = {
        "meta": meta,
        "times": times,
        "lats": payload["lats"],
        "lons": payload["lons"],
        "chunks": chunks,
    }
    with out_json.open("w", encoding="utf-8") as handle:
        json.dump(manifest, handle, separators=(",", ":"))
    return manifest


def expand_chunked_payload(path: Path) -> dict[str, Any]:
    """Read either legacy single-file forcing or the chunked manifest format."""
    with path.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)

    if not payload.get("chunks"):
        return payload

    expanded = {
        "meta": payload["meta"],
        "times": payload["times"],
        "lats": payload["lats"],
        "lons": payload["lons"],
        "u": [],
        "v": [],
        "uw": [] if payload["meta"].get("has_wind") else None,
        "vw": [] if payload["meta"].get("has_wind") else None,
    }
    for chunk in payload["chunks"]:
        chunk_path = path.parent / chunk["href"]
        with chunk_path.open("r", encoding="utf-8") as handle:
            chunk_payload = json.load(handle)
        expanded["u"].extend(chunk_payload["u"])
        expanded["v"].extend(chunk_payload["v"])
        if expanded["uw"] is not None:
            expanded["uw"].extend(chunk_payload.get("uw") or [])
            expanded["vw"].extend(chunk_payload.get("vw") or [])
    return expanded
