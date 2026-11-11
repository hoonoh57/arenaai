#!/usr/bin/env python3
"""원본 parquet → data/bars/*.bar 증분. 앱 안에 parquet을 복사하지 않는다."""
from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ingest_cybos import first_existing, ingest_daily, ingest_minute, load_manifest, save_manifest  # noqa: E402


def candidates() -> list[Path]:
    raw = os.environ.get("CYBOS_SRC") or ""
    out: list[Path] = []
    if raw.strip():
        out.append(Path(raw))
    out.extend(
        [
            Path(r"G:\내 드라이브\db\raw\cybos"),
            Path(r"G:\My Drive\db\raw\cybos"),
            Path("data/cybos"),
        ]
    )
    seen: set[str] = set()
    uniq: list[Path] = []
    for p in out:
        key = str(p)
        if key in seen:
            continue
        seen.add(key)
        uniq.append(p)
    return uniq


def find_origin() -> Path | None:
    for p in candidates():
        if (p / "cybos_1d_A").is_dir() or (p / "1d").is_dir():
            print(f"origin {p}", flush=True)
            return p
    print("origin not found", flush=True)
    return None


def main() -> None:
    origin = find_origin()
    bars = Path(os.environ.get("BARS_DIR") or "data/bars")
    if origin is None:
        return
    daily = first_existing(origin, "cybos_1d_A", "1d")
    minute = first_existing(origin, "cybos_1m_A", "1m")
    man = load_manifest(bars)
    n_d = ingest_daily(daily, bars / "D", man.setdefault("daily", {})) if daily else 0
    n_m = ingest_minute(minute, bars / "1", man.setdefault("minute", {})) if minute else 0
    save_manifest(bars, man)
    print(f"sync bar daily={n_d} minute={n_m} -> {bars}", flush=True)


if __name__ == "__main__":
    main()
