#!/usr/bin/env python3
"""CYBOS parquet → data/bars/*.bar (증분). CSV는 --csv 일 때만."""
from __future__ import annotations

import argparse
import json
import struct
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

try:
    import pyarrow.parquet as pq
except ImportError as e:
    raise SystemExit("pyarrow 필요: .venv 에 pyarrow") from e

KST = timezone(timedelta(hours=9))
MAGIC = b"BAR1"
HDR = struct.pack("<4sBBH", MAGIC, 1, 7, 0)
REC = struct.Struct("<ddddddd")
MANIFEST = "manifest.json"


def code6(raw: str) -> str | None:
    if not raw:
        return None
    c = raw[1:] if raw.startswith("A") else raw
    return c if len(c) == 6 and c.isdigit() else None


def daily_ts(date: int) -> float:
    s = f"{int(date):08d}"
    return datetime(int(s[0:4]), int(s[4:6]), int(s[6:8]), 9, 0, 0, tzinfo=KST).timestamp()


def minute_ts(date: int, time_end: int) -> float:
    hh, mm = divmod(int(time_end), 100)
    s = f"{int(date):08d}"
    return datetime(int(s[0:4]), int(s[4:6]), int(s[6:8]), hh, mm, 0, tzinfo=KST).timestamp()


def load_manifest(dest: Path) -> dict:
    p = dest / MANIFEST
    if not p.exists():
        return {"daily": {}, "minute": {}}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {"daily": {}, "minute": {}}


def save_manifest(dest: Path, man: dict) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    (dest / MANIFEST).write_text(json.dumps(man, indent=1), encoding="utf-8")


def pending(src: Path, done: dict) -> list[Path]:
    out = []
    for f in sorted(src.rglob("*.parquet")):
        rel = str(f.relative_to(src)).replace("\\", "/")
        st = f.stat()
        prev = done.get(rel)
        if prev and prev.get("size") == st.st_size and prev.get("mtime") == int(st.st_mtime):
            continue
        out.append(f)
    return out


def mark_done(done: dict, src: Path, files: list[Path]) -> None:
    for f in files:
        rel = str(f.relative_to(src)).replace("\\", "/")
        st = f.stat()
        done[rel] = {"size": st.st_size, "mtime": int(st.st_mtime)}


def read_bar_rows(path: Path) -> dict[float, tuple]:
    if not path.exists() or path.stat().st_size < 8:
        return {}
    data = path.read_bytes()
    if data[:4] != MAGIC:
        return {}
    out: dict[float, tuple] = {}
    for i in range(8, len(data) - REC.size + 1, REC.size):
        row = REC.unpack_from(data, i)
        out[row[0]] = row
    return out


def write_bar(path: Path, rows: list[tuple]) -> None:
    rows = sorted(rows, key=lambda r: r[0])
    buf = bytearray(HDR)
    for r in rows:
        buf.extend(REC.pack(*r))
    path.write_bytes(buf)


def last_time(path: Path) -> float:
    if not path.exists():
        return 0.0
    n = path.stat().st_size
    if n < 8 + REC.size:
        return 0.0
    with open(path, "rb") as f:
        f.seek(n - REC.size)
        return REC.unpack(f.read(REC.size))[0]


def append_bar(path: Path, rows: list[tuple]) -> None:
    if not rows:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists() or path.stat().st_size < 8:
        write_bar(path, rows)
        return
    with open(path, "ab") as f:
        for r in rows:
            f.write(REC.pack(*r))


def ingest_daily(src: Path, dest: Path, done: dict) -> int:
    dest.mkdir(parents=True, exist_ok=True)
    files = pending(src, done)
    print(f"daily parquet pending {len(files)}/{len(list(src.rglob('*.parquet')))} in {src}", flush=True)
    if not files:
        return len(list(dest.glob("*.bar")))
    by: dict[str, list[tuple]] = defaultdict(list)
    for f in files:
        print(f"  daily {f.name}", flush=True)
        names = pq.read_schema(f).names
        cols = ["code", "date", "open", "high", "low", "close", "volume"]
        if "market_cap" in names:
            cols.append("market_cap")
        d = pq.read_table(f, columns=cols).to_pydict()
        mcaps = d.get("market_cap")
        for i in range(len(d["code"])):
            c = code6(d["code"][i])
            if not c:
                continue
            cap = float(mcaps[i] or 0) if mcaps else 0.0
            by[c].append(
                (
                    daily_ts(d["date"][i]),
                    float(d["open"][i]),
                    float(d["high"][i]),
                    float(d["low"][i]),
                    float(d["close"][i]),
                    float(d["volume"][i] or 0),
                    cap,
                )
            )
    for code, rows in by.items():
        path = dest / f"{code}.bar"
        merged = read_bar_rows(path)
        for r in rows:
            merged[r[0]] = r
        write_bar(path, list(merged.values()))
    mark_done(done, src, files)
    print(f"daily codes={len(by)} files={len(files)}", flush=True)
    return len(by)


def ingest_minute(src: Path, dest: Path, done: dict) -> int:
    dest.mkdir(parents=True, exist_ok=True)
    files = pending(src, done)
    print(f"1m parquet pending {len(files)}/{len(list(src.rglob('*.parquet')))}", flush=True)
    touched: set[str] = set()
    for fi, f in enumerate(files, 1):
        print(f"1m {fi}/{len(files)} {f.relative_to(src)}", flush=True)
        d = pq.read_table(f, columns=["code", "date", "time_end", "open", "high", "low", "close", "volume"]).to_pydict()
        by: dict[str, list[tuple]] = defaultdict(list)
        for i in range(len(d["code"])):
            c = code6(d["code"][i])
            if not c:
                continue
            by[c].append(
                (
                    minute_ts(d["date"][i], d["time_end"][i]),
                    float(d["open"][i]),
                    float(d["high"][i]),
                    float(d["low"][i]),
                    float(d["close"][i]),
                    float(d["volume"][i] or 0),
                    0.0,
                )
            )
        del d
        for code, rows in by.items():
            path = dest / f"{code}.bar"
            cut = last_time(path)
            rows = [r for r in rows if r[0] > cut]
            rows.sort(key=lambda r: r[0])
            append_bar(path, rows)
            touched.add(code)
        mark_done(done, src, [f])
    print(f"minute codes={len(touched)}", flush=True)
    return len(touched)


def first_existing(root: Path, *names: str) -> Path | None:
    for name in names:
        pth = root / name
        if pth.exists():
            return pth
    return None


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--src", default="", help="parquet 루트 (Drive cybos)")
    p.add_argument("--dest", default="data/bars")
    p.add_argument("--skip-daily", action="store_true")
    p.add_argument("--skip-minute", action="store_true")
    args = p.parse_args()
    root = Path(args.src) if args.src else None
    dest = Path(args.dest)
    if root is None or not root.exists():
        raise SystemExit(f"원본 없음: {args.src}")
    daily = first_existing(root, "cybos_1d_A", "1d")
    minute = first_existing(root, "cybos_1m_A", "1m")
    man = load_manifest(dest)
    n_d = ingest_daily(daily, dest / "D", man.setdefault("daily", {})) if daily and not args.skip_daily else 0
    n_m = ingest_minute(minute, dest / "1", man.setdefault("minute", {})) if minute and not args.skip_minute else 0
    save_manifest(dest, man)
    print(f"daily={n_d} minute={n_m} src_d={daily} src_m={minute} -> {dest} (bar)", flush=True)


if __name__ == "__main__":
    main()
