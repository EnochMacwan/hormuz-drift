"""Static smoke checks for the Hormuz browser app.

This intentionally avoids extra dependencies so it can run on any machine with
Python. It catches the small UI regressions that are easy to miss in a visual
single-page app: missing controls, duplicate modal actions, and broken asset
references.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
INDEX = ROOT / "index.html"


REQUIRED_IDS = [
    "controls",
    "scenarioPreset",
    "runBtn",
    "quickRunRailBtn",
    "expertToggleBtn",
    "resetMapBtn",
    "map-chip-chunk",
    "webgnome-modal",
    "closeWgModal",
]


def fail(message: str) -> None:
    print(f"SMOKE_CHECK_FAILED: {message}")
    sys.exit(1)


def main() -> None:
    html = INDEX.read_text(encoding="utf-8")

    for element_id in REQUIRED_IDS:
        if f'id="{element_id}"' not in html:
            fail(f"missing required id #{element_id}")

    if "closeWgModal2" in html:
        fail("duplicate WebGNOME modal close button returned")

    asset_refs = re.findall(r'(?:href|src)="([^"]+\.(?:css|js)(?:\?v=[^"]+)?)"', html)
    for ref in asset_refs:
        asset_path = ref.split("?", 1)[0]
        if asset_path.startswith(("http://", "https://")):
            continue
        if not (ROOT / asset_path).exists():
            fail(f"missing asset referenced by index.html: {asset_path}")

    ui_cleanup_refs = [ref for ref in asset_refs if ref.startswith("css/ui-cleanup.css")]
    if not ui_cleanup_refs or "?v=" not in ui_cleanup_refs[0]:
        fail("ui-cleanup.css must stay cache-busted")

    print("SMOKE_CHECK_OK")


if __name__ == "__main__":
    main()
