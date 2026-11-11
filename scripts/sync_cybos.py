#!/usr/bin/env python3
"""원본 cybos parquet과 data/bars 최근 일자를 비교해 빠진 파일을 복사하고 CSV를 갱신한다."""
from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ingest_cybos import ingest_daily, ingest_minute  # noqa: E402

try:
    import pyarrow.parquet as pq
except ImportError:
    pq = None  # type: ignore


def candidates() -> list[Path]:
    raw = os.environ.get("CYBOS_SRC") or ""
    out = []
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
        key = str(p.resolve()) if p.exists() else str(p)
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


def subdir(root: Path, *names: str) -> Path | None:
    for n in names:
        p = root / n
        if p.is_dir():
            return p
    return None


def csv_max_date(folder: Path) -> int:
    if not folder.is_dir():
        return 0
    files = list(folder.glob("*.csv"))[:8]
    mx = 0
    for f in files:
        try:
            with open(f, "rb") as fh:
                fh.seek(0, 2)
                size = fh.tell()
                fh.seek(max(0, size - 4096))
                tail = fh.read().decode("utf-8", "ignore").strip().splitlines()
            for line in reversed(tail):
                if not line or line.lower().startswith("time"):
                    continue
                token = line.split(",")[0].strip()
                digits = "".join(ch for ch in token if ch.isdigit())[:8]
                if len(digits) == 8:
                    mx = max(mx, int(digits))
                    break
        except OSError:
            continue
    return mx


def parquet_max_date(folder: Path, col: str = "date") -> int:
    if pq is None or not folder.is_dir():
        return 0
    files = sorted(folder.rglob("*.parquet"), key=lambda p: p.stat().st_mtime, reverse=True)[:6]
    mx = 0
    for f in files:
        try:
            t = pq.read_table(f, columns=[col])
            vals = t.column(0).to_pylist()
            for v in vals:
                n = int(v)
                if n > 100000000:  # YYYYMMDDHH sometimes
                    n = n // 1000000 if n > 99999999 else n
                if 19900101 <= n <= 21001231:
                    mx = max(mx, n)
        except Exception as e:
            print(f"parquet skip {f.name}: {e}", flush=True)
    return mx


def copy_missing(src: Path, dest: Path) -> int:
    dest.mkdir(parents=True, exist_ok=True)
    n = 0
    for f in src.rglob("*.parquet"):
        rel = f.relative_to(src)
        target = dest / rel
        if target.exists() and target.stat().st_size == f.stat().st_size:
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(f, target)
        print(f"copy {rel}", flush=True)
        n += 1
    return n


def main() -> None:
    origin = find_origin()
    cache = Path(os.environ.get("CYBOS_CACHE") or "data/cybos")
    bars = Path(os.environ.get("BARS_DIR") or "data/bars")
    if origin is None:
        return
    src_d = subdir(origin, "cybos_1d_A", "1d")
    src_m = subdir(origin, "cybos_1m_A", "1m")
    cache_d = cache / "cybos_1d_A"
    cache_m = cache / "cybos_1m_A"
    copied_d = copy_missing(src_d, cache_d) if src_d and src_d.resolve() != cache_d.resolve() else 0
    copied_m = copy_missing(src_m, cache_m) if src_m and src_m.resolve() != cache_m.resolve() else 0
    pq_d = parquet_max_date(cache_d if cache_d.exists() else src_d or cache)
    csv_d = csv_max_date(bars / "D")
    pq_m = parquet_max_date(cache_m if cache_m.exists() else src_m or cache)
    csv_m = csv_max_date(bars / "1")
    print(f"daily origin/csv {pq_d} / {csv_d} copied={copied_d}", flush=True)
    print(f"minute origin/csv {pq_m} / {csv_m} copied={copied_m}", flush=True)
    if src_d and (copied_d or pq_d > csv_d):
        ingest_daily(cache_d if cache_d.exists() else src_d, bars / "D")
    else:
        print("daily csv up to date", flush=True)
    if src_m and (copied_m or pq_m > csv_m):
        ingest_minute(cache_m if cache_m.exists() else src_m, bars / "1")
    else:
        print("minute csv up to date", flush=True)


if __name__ == "__main__":
    main()
