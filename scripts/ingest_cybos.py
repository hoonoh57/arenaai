#!/usr/bin/env python3
"""Convert CYBOS parquet (Drive db/raw/cybos) into data/bars CSV for [0150]."""
from __future__ import annotations

import argparse
from collections import defaultdict
from pathlib import Path

try:
    import pyarrow.parquet as pq
except ImportError as e:
    raise SystemExit("pyarrow 필요: python3 -m venv .venv && .venv/bin/pip install pyarrow") from e


def code6(raw: str) -> str | None:
    if not raw:
        return None
    c = raw[1:] if raw.startswith("A") else raw
    return c if len(c) == 6 and c.isdigit() else None


def ingest_daily(src: Path, dest: Path) -> int:
    dest.mkdir(parents=True, exist_ok=True)
    by: dict[str, list[tuple]] = defaultdict(list)
    for f in src.rglob("*.parquet"):
        t = pq.read_table(f, columns=["code", "date", "open", "high", "low", "close", "volume"])
        d = t.to_pydict()
        for i in range(len(d["code"])):
            c = code6(d["code"][i])
            if not c:
                continue
            by[c].append(
                (
                    int(d["date"][i]),
                    int(d["open"][i]),
                    int(d["high"][i]),
                    int(d["low"][i]),
                    int(d["close"][i]),
                    int(d["volume"][i] or 0),
                )
            )
    for code, rows in by.items():
        uniq = {r[0]: r for r in rows}
        ordered = [uniq[k] for k in sorted(uniq)]
        with open(dest / f"{code}.csv", "w") as w:
            w.write("time,open,high,low,close,volume\n")
            for r in ordered:
                w.write(f"{r[0]},{r[1]},{r[2]},{r[3]},{r[4]},{r[5]}\n")
    return len(by)


def ingest_minute(src: Path, dest: Path) -> int:
    dest.mkdir(parents=True, exist_ok=True)
    by: dict[str, list[tuple]] = defaultdict(list)
    for f in src.rglob("*.parquet"):
        t = pq.read_table(f, columns=["code", "date", "time_end", "open", "high", "low", "close", "volume"])
        d = t.to_pydict()
        for i in range(len(d["code"])):
            c = code6(d["code"][i])
            if not c:
                continue
            date = int(d["date"][i])
            hh, mm = divmod(int(d["time_end"][i]), 100)
            ts = f"{date}{hh:02d}{mm:02d}00"
            by[c].append(
                (
                    ts,
                    int(d["open"][i]),
                    int(d["high"][i]),
                    int(d["low"][i]),
                    int(d["close"][i]),
                    int(d["volume"][i] or 0),
                )
            )
    for code, rows in by.items():
        seen: set[str] = set()
        ordered = []
        for r in sorted(rows, key=lambda x: x[0]):
            if r[0] in seen:
                continue
            seen.add(r[0])
            ordered.append(r)
        with open(dest / f"{code}.csv", "w") as w:
            w.write("time,open,high,low,close,volume\n")
            for r in ordered:
                w.write(f"{r[0]},{r[1]},{r[2]},{r[3]},{r[4]},{r[5]}\n")
    return len(by)


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--src", default="data/cybos", help="parquet 루트")
    p.add_argument("--dest", default="data/bars")
    args = p.parse_args()
    root = Path(args.src)
    dest = Path(args.dest)
    n_d = ingest_daily(root / "1d", dest / "D") if (root / "1d").exists() else 0
    n_m = ingest_minute(root / "1m", dest / "1") if (root / "1m").exists() else 0
    print(f"daily={n_d} minute={n_m} -> {dest}")


if __name__ == "__main__":
    main()
