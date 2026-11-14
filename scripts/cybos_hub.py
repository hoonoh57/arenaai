#!/usr/bin/env python3
"""64비트 엔트리. 32비트 COM 워커는 이 프로세스가 관리자로 떠 있을 때만 연결된다.
stdin JSON 한 줄 → stdout JSON 한 줄. sort 금지, 페이지는 reverse 한 번.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8")


def _has_com() -> bool:
    try:
        import win32com.client  # noqa: F401

        return True
    except Exception:
        return False


def _find_py32() -> list[str] | None:
    env = (os.environ.get("CYBOS_PYTHON32") or "").strip()
    if env:
        return [env]
    roots = [
        Path(os.environ.get("LOCALAPPDATA") or "") / "Programs" / "Python",
        Path(r"C:\\"),
    ]
    names = ["Python38-32", "Python39-32", "Python310-32", "Python311-32", "Python312-32", "Python37-32"]
    for root in roots:
        for name in names:
            p = root / name / "python.exe"
            if p.is_file():
                return [str(p)]
            p2 = Path(r"C:\\") / name / "python.exe"
            if p2.is_file():
                return [str(p2)]
    for n in range(8, 14):
        p = Path(rf"C:\Python3{n}-32\python.exe")
        if p.is_file():
            return [str(p)]
    py = shutil.which("py")
    if py:
        return [py, "-3-32"]
    return None


def _admin() -> bool:
    try:
        import ctypes

        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return False


def _fail(reason: str) -> dict[str, Any]:
    return {"ok": False, "held": True, "reason": reason, "candles": [], "hasMore": False, "nextKey": ""}


def _kst_unix(date: int, hhmm: int, second: int) -> int:
    from datetime import datetime, timedelta, timezone

    d = f"{int(date):08d}"
    h, m = divmod(int(hhmm), 100)
    s = max(0, min(59, int(second)))
    kst = timezone(timedelta(hours=9))
    dt = datetime(int(d[0:4]), int(d[4:6]), int(d[6:8]), h, m, s, tzinfo=kst)
    return int(dt.timestamp())


def _stamp_ticks(rows: list[dict[str, Any]]) -> None:
    prev = ""
    sec = 0
    for r in rows:
        key = f"{int(r['date']):08d}{int(r['hhmm']):04d}"
        if key == prev:
            sec = min(59, sec + 1)
        else:
            prev = key
            sec = 0
        r["time"] = _kst_unix(r["date"], r["hhmm"], sec)


def handle(req: dict[str, Any]) -> dict[str, Any]:
    op = req.get("op") or "status"
    if op == "status":
        admin = _admin()
        connected = False
        if admin:
            try:
                import win32com.client  # type: ignore

                cy = win32com.client.Dispatch("CpUtil.CpCybos")
                connected = int(cy.IsConnect) == 1
            except Exception as e:
                return _fail(f"CYBOS COM 실패: {e}")
        return {
            "ok": admin and connected,
            "held": not (admin and connected),
            "reason": "" if admin and connected else ("관리자 권한 필요" if not admin else "CYBOS 미연결"),
            "admin": admin,
            "connected": connected,
            "provider": "cybos",
            "candles": [],
            "hasMore": False,
            "nextKey": "",
        }
    if not _admin():
        return _fail("관리자 권한 필요")
    if not _has_com():
        return _fail("32비트 파이썬 win32com 없음. CYBOS_PYTHON32 지정")
    import win32com.client  # type: ignore
    cy = win32com.client.Dispatch("CpUtil.CpCybos")
    if int(cy.IsConnect) != 1:
        return _fail("CYBOS 미연결")
    if op in ("chart", "strength"):
        return chart(req)
    if op == "eye":
        return eye(req)
    return _fail(f"미등록 op {op}")


def chart(req: dict[str, Any]) -> dict[str, Any]:
    import win32com.client  # type: ignore
    code = str(req.get("code") or "")
    if len(code) == 6:
        code = "A" + code
    tf = str(req.get("timeframe") or "1")
    count = int(req.get("count") or 2000)
    chart_kind = "m"
    period = 1
    if tf in ("D", "W", "M"):
        chart_kind = {"D": "D", "W": "W", "M": "M"}[tf]
    elif tf.startswith("T"):
        chart_kind = "T"
        period = int(tf[1:] or "1")
    else:
        period = int(tf) if tf.isdigit() else 1
    obj = win32com.client.Dispatch("CpSysDib.StockChart")
    obj.SetInputValue(0, code)
    obj.SetInputValue(1, ord("2"))
    obj.SetInputValue(4, count)
    fields = [0, 1, 2, 3, 4, 5, 8]
    if req.get("op") == "strength" and chart_kind in ("m", "T"):
        fields = [0, 1, 2, 3, 4, 5, 8, 62, 63]
    obj.SetInputValue(5, fields)
    obj.SetInputValue(6, ord(chart_kind))
    obj.SetInputValue(7, period)
    obj.SetInputValue(9, ord("1"))
    obj.SetInputValue(12, ord("A"))
    obj.BlockRequest()
    if int(obj.GetDibStatus()) != 0:
        return _fail(str(obj.GetDibMsg1()))
    n = int(obj.GetHeaderValue(3))
    raw: list[dict[str, Any]] = []
    for i in range(n):
        date = int(obj.GetDataValue(0, i))
        hhmm = int(obj.GetDataValue(1, i)) if chart_kind in ("m", "T") else 0
        o = abs(float(obj.GetDataValue(2, i)))
        h = abs(float(obj.GetDataValue(3, i)))
        l = abs(float(obj.GetDataValue(4, i)))
        c = abs(float(obj.GetDataValue(5, i)))
        v = abs(float(obj.GetDataValue(6, i)))
        rec: dict[str, Any] = {"date": date, "hhmm": hhmm, "open": o, "high": h, "low": l, "close": c, "volume": v}
        if req.get("op") == "strength" and len(fields) >= 9:
            sell = float(obj.GetDataValue(7, i) or 0)
            buy = float(obj.GetDataValue(8, i) or 0)
            rec["strength"] = (buy / sell * 100) if sell > 0 else None
        raw.append(rec)
    raw.reverse()
    _stamp_ticks(raw)
    candles = [
        {
            "time": r["time"],
            "open": r["open"],
            "high": r["high"],
            "low": r["low"],
            "close": r["close"],
            "volume": r["volume"],
            **({"strength": r["strength"]} if r.get("strength") else {}),
        }
        for r in raw
        if r.get("time")
    ]
    more = bool(getattr(obj, "Continue", 0))
    oldest = candles[0]["time"] if candles else ""
    return {
        "ok": True,
        "held": False,
        "reason": "",
        "candles": candles,
        "hasMore": more,
        "nextKey": str(oldest) if more else "",
        "provider": "cybos",
    }


def eye(req: dict[str, Any]) -> dict[str, Any]:
    import win32com.client  # type: ignore
    codes = req.get("codes") or []
    out_codes = []
    for c in codes:
        s = str(c).replace("A", "")
        if len(s) == 6:
            out_codes.append("A" + s)
        if len(out_codes) >= 200:
            break
    if not out_codes:
        return _fail("종목 없음")
    obj = win32com.client.Dispatch("CpSysDib.MarketEye")
    obj.SetInputValue(0, [0, 4, 24, 118])
    obj.SetInputValue(1, out_codes)
    obj.BlockRequest()
    if int(obj.GetDibStatus()) != 0:
        return _fail(str(obj.GetDibMsg1()))
    n = int(obj.GetHeaderValue(2))
    rows = []
    for i in range(n):
        code = str(obj.GetDataValue(0, i)).replace("A", "")
        price = abs(float(obj.GetDataValue(1, i) or 0))
        strength = float(obj.GetDataValue(2, i) or 0)
        rows.append({"code": code, "price": price, "strength": strength})
    return {"ok": True, "held": False, "reason": "", "candles": [], "hasMore": False, "nextKey": "", "rows": rows, "provider": "cybos"}


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            print(json.dumps(_fail("JSON"), ensure_ascii=False), flush=True)
            continue
        try:
            out = handle(req)
        except Exception as e:
            out = _fail(str(e))
        print(json.dumps(out, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    if not _has_com():
        cmd = _find_py32()
        if cmd:
            script = str(Path(__file__).resolve())
            proc = subprocess.Popen(
                cmd + [script],
                stdin=sys.stdin,
                stdout=sys.stdout,
                stderr=sys.stderr,
                env={**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"},
            )
            sys.exit(proc.wait())
        def _no32() -> None:
            for line in sys.stdin:
                if not line.strip():
                    continue
                print(
                    json.dumps(
                        _fail("64비트 python에는 win32com이 없습니다. 32비트 파이썬 경로를 CYBOS_PYTHON32에 넣으세요."),
                        ensure_ascii=False,
                    ),
                    flush=True,
                )
        _no32()
    else:
        main()
