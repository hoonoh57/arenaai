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
    files = sorted(src.rglob("*.parquet"))
    started: set[str] = set()
    for fi, f in enumerate(files, 1):
        print(f"1m {fi}/{len(files)} {f.relative_to(src)}", flush=True)
        t = pq.read_table(f, columns=["code", "date", "time_end", "open", "high", "low", "close", "volume"])
        d = t.to_pydict()
        by: dict[str, list[str]] = defaultdict(list)
        n = len(d["code"])
        for i in range(n):
            c = code6(d["code"][i])
            if not c:
                continue
            date = int(d["date"][i])
            hh, mm = divmod(int(d["time_end"][i]), 100)
            ts = f"{date}{hh:02d}{mm:02d}00"
            by[c].append(
                f"{ts},{int(d['open'][i])},{int(d['high'][i])},{int(d['low'][i])},{int(d['close'][i])},{int(d['volume'][i] or 0)}\n"
            )
        del d, t
        for code, lines in by.items():
            path = dest / f"{code}.csv"
            mode = "a" if code in started else "w"
            started.add(code)
            with open(path, mode, encoding="utf-8") as w:
                if mode == "w":
                    w.write("time,open,high,low,close,volume\n")
                w.writelines(lines)
    return len(started)


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--src", default="data/cybos", help="parquet 루트")
    p.add_argument("--dest", default="data/bars")
    p.add_argument("--skip-daily", action="store_true")
    p.add_argument("--skip-minute", action="store_true")
    args = p.parse_args()
    root = Path(args.src)
    dest = Path(args.dest)

    def first_existing(*names: str) -> Path | None:
        for name in names:
            pth = root / name
            if pth.exists():
                return pth
        return None

    daily = first_existing("cybos_1d_A", "1d")
    minute = first_existing("cybos_1m_A", "1m")
    n_d = ingest_daily(daily, dest / "D") if daily and not args.skip_daily else 0
    n_m = ingest_minute(minute, dest / "1") if minute and not args.skip_minute else 0
    print(f"daily={n_d} minute={n_m} src_d={daily} src_m={minute} -> {dest}")


if __name__ == "__main__":
    main()
