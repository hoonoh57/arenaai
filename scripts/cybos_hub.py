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
    if op in ("charts", "strengths"):
        return charts(req)
    if op == "eye":
        return eye(req)
    if op == "list":
        return list_codes(req)
    return _fail(f"미등록 op {op}")


def list_codes(req: dict[str, Any]) -> dict[str, Any]:
    import random
    import win32com.client  # type: ignore

    n = max(1, min(2000, int(req.get("count") or 100)))
    m = str(req.get("market") or "both")
    mkts = [1] if m == "kospi" else [2] if m == "kosdaq" else [1, 2]
    mgr = win32com.client.Dispatch("CpUtil.CpCodeMgr")
    pool: list[str] = []
    for mkt in mkts:
        try:
            arr = mgr.GetStockListByMarket(mkt)
            seq = list(arr)
        except Exception:
            continue
        for raw in seq:
            code = str(raw).replace("A", "")[-6:]
            if not (len(code) == 6 and code.isdigit()):
                continue
            if code not in pool:
                pool.append(code)
    if len(pool) > n:
        pool = random.sample(pool, n)
    return {
        "ok": len(pool) > 0,
        "held": False,
        "reason": "",
        "candles": [],
        "hasMore": False,
        "nextKey": "",
        "codes": pool,
        "universe": len(pool),
        "market": m,
        "provider": "cybos",
    }


def _chart_spec(req: dict[str, Any], code: str) -> tuple[str, str, int, int, list[int]]:
    c = str(code).replace("A", "")
    acode = "A" + c if len(c) == 6 else str(code)
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
    fields = [0, 1, 2, 3, 4, 5, 8]
    if req.get("op") == "strength" and chart_kind in ("m", "T"):
        fields = [0, 1, 2, 3, 4, 5, 8, 62, 63]
    return acode, chart_kind, period, count, fields


def _chart_bind(obj: Any, acode: str, chart_kind: str, period: int, count: int, fields: list[int]) -> None:
    obj.SetInputValue(0, acode)
    obj.SetInputValue(1, ord("2"))
    obj.SetInputValue(4, count)
    obj.SetInputValue(5, fields)
    obj.SetInputValue(6, ord(chart_kind))
    obj.SetInputValue(7, period)
    obj.SetInputValue(9, ord("1"))
    obj.SetInputValue(12, ord("A"))


def chart(req: dict[str, Any]) -> dict[str, Any]:
    import win32com.client  # type: ignore

    acode, chart_kind, period, count, fields = _chart_spec(req, str(req.get("code") or ""))
    obj = win32com.client.Dispatch("CpSysDib.StockChart")
    _chart_bind(obj, acode, chart_kind, period, count, fields)
    obj.BlockRequest()
    if int(obj.GetDibStatus()) != 0:
        return _fail(str(obj.GetDibMsg1()))
    return _chart_read(obj, req, chart_kind, fields)


def _chart_read(obj: Any, req: dict[str, Any], chart_kind: str, fields: list[int]) -> dict[str, Any]:
    n = int(obj.GetHeaderValue(3))
    summary = bool(req.get("summary"))
    idxs = [0, n - 1] if summary and n else list(range(n))
    raw: list[dict[str, Any]] = []
    for i in idxs:
        if i < 0:
            continue
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
    if summary:
        first = candles[0] if candles else None
        last = candles[-1] if candles else None
        return {
            "ok": True,
            "held": False,
            "reason": "",
            "candles": [first, last] if first and last and first is not last else ([first] if first else []),
            "bars": len(candles),
            "hasMore": more,
            "nextKey": str(oldest) if more else "",
            "provider": "cybos",
        }
    return {
        "ok": True,
        "held": False,
        "reason": "",
        "candles": candles,
        "bars": len(candles),
        "hasMore": more,
        "nextKey": str(oldest) if more else "",
        "provider": "cybos",
    }


def _unit(code: str, one: dict[str, Any]) -> dict[str, Any]:
    return {
        "code": str(code).replace("A", "")[-6:],
        "ok": bool(one.get("ok")),
        "held": bool(one.get("held")),
        "reason": one.get("reason") or "",
        "candles": one.get("candles") or [],
        "bars": int(one.get("bars") or 0),
    }


def charts(req: dict[str, Any]) -> dict[str, Any]:
    """같은 STA에서 StockChart를 종목마다 새로 만들고 Request를 최대 4개 겹친다. 스레드/프로세스 금지."""
    import time
    import pythoncom  # type: ignore
    import win32com.client  # type: ignore

    codes = [str(c) for c in (req.get("codes") or [])]
    op = "strength" if req.get("op") == "strengths" else "chart"
    body = {**req, "op": op}
    workers = max(1, min(4, int(req.get("workers") or 4), len(codes) or 1))
    units: list[dict[str, Any]] = []
    inflight: list[dict[str, Any]] = []
    nxt = 0
    t0 = time.time()
    async_ok: bool | None = None

    def launch(code: str) -> None:
        acode, kind, period, count, fields = _chart_spec(body, code)
        obj = win32com.client.Dispatch("CpSysDib.StockChart")
        _chart_bind(obj, acode, kind, period, count, fields)
        try:
            obj.Request()
            inflight.append({"code": code, "obj": obj, "kind": kind, "fields": fields, "t": time.time()})
        except Exception:
            obj.BlockRequest()
            if int(obj.GetDibStatus()) != 0:
                units.append(_unit(code, _fail(str(obj.GetDibMsg1()))))
            else:
                units.append(_unit(code, _chart_read(obj, body, kind, fields)))

    while nxt < len(codes) or inflight:
        while nxt < len(codes) and len(inflight) < workers:
            launch(codes[nxt])
            nxt += 1
        if not inflight:
            break
        pythoncom.PumpWaitingMessages()
        still: list[dict[str, Any]] = []
        for job in inflight:
            obj = job["obj"]
            st = int(obj.GetDibStatus())
            if st == 1 and time.time() - float(job["t"]) < 30:
                still.append(job)
                continue
            if st != 0:
                one = _fail(str(obj.GetDibMsg1()) or f"status {st}")
            else:
                try:
                    one = _chart_read(obj, body, job["kind"], job["fields"])
                except Exception as e:
                    one = _fail(str(e))
            units.append(_unit(str(job["code"]), one))
        inflight = still
        if async_ok is None and time.time() - t0 > 1.5:
            async_ok = len(units) > 0
            if not async_ok:
                inflight = []
                while nxt < len(codes):
                    units.append(_unit(codes[nxt], chart({**body, "code": codes[nxt]})))
                    nxt += 1
                break
        if inflight:
            time.sleep(0.002)
    ok = any(u.get("ok") for u in units)
    return {
        "ok": ok,
        "held": False,
        "reason": "",
        "candles": [],
        "hasMore": False,
        "nextKey": "",
        "units": units,
        "workers": workers,
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
