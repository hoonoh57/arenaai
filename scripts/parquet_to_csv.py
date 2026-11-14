#!/usr/bin/env python3
"""cybos 1분 parquet → 같은 달 폴더 아래 csv/. parquet는 앱에 복사하지 않음."""
from __future__ import annotations

import sys
from pathlib import Path


def convert_dir(src: Path) -> list[Path]:
    files = sorted(src.glob("*.parquet"))
    if not files:
        return []
    out_dir = src / "csv"
    out_dir.mkdir(parents=True, exist_ok=True)
    try:
        import pyarrow.parquet as pq  # type: ignore
    except ImportError:
        import pandas as pd  # type: ignore

        pq = None
        pd_mod = pd
    else:
        pd_mod = None
    written: list[Path] = []
    skipped = 0
    for p in files:
        dest = out_dir / (p.stem + ".csv")
        if dest.is_file() and dest.stat().st_size > 0:
            print(f"있음 {dest.name}")
            written.append(dest)
            continue
        try:
            if pq is not None:
                table = pq.read_table(p)
                import pyarrow.csv as pcsv  # type: ignore

                pcsv.write_csv(table, dest)
            else:
                pd_mod.read_parquet(p).to_csv(dest, index=False)
        except Exception as e:
            skipped += 1
            print(f"건너뜀 {p.name}: {e}", file=sys.stderr)
            continue
        written.append(dest)
        print(f"{p.name} → {dest} ({dest.stat().st_size} bytes)")
    if skipped:
        print(f"깨진 parquet {skipped}개 건너뜀", file=sys.stderr)
    return written


def main() -> int:
    raw = sys.argv[1] if len(sys.argv) > 1 else str(Path("data") / "cybos" / "cybos_1m_A")
    root = Path(raw)
    if not root.exists():
        print(f"없음: {root.resolve()}", file=sys.stderr)
        return 1
    dirs = [root] if list(root.glob("*.parquet")) else sorted({p.parent for p in root.rglob("*.parquet")})
    n = 0
    for d in dirs:
        n += len(convert_dir(d))
    if not n:
        print("parquet 없음", file=sys.stderr)
        return 1
    print(f"csv {n}개")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
