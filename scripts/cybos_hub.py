#!/usr/bin/env python3
"""64비트 엔트리. 32비트 COM 워커는 이 프로세스가 관리자로 떠 있을 때만 연결된다.
stdin JSON 한 줄 → stdout JSON 한 줄. sort 금지, 페이지는 reverse 한 번.
"""
from __future__ import annotations

import json
import sys
from typing import Any


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
                return _fail(f"CYBOS COM 없음: {e}")
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
    try:
        import win32com.client  # type: ignore
    except Exception:
        return _fail("win32com 없음")
    cy = win32com.client.Dispatch("CpUtil.CpCybos")
    if int(cy.IsConnect) != 1:
        return _fail("CYBOS 미연결")
    if op in ("chart", "strength"):
        return chart(req, win32com.client)
    if op == "eye":
        return eye(req, win32com.client)
    return _fail(f"미등록 op {op}")


def chart(req: dict[str, Any], win32com) -> dict[str, Any]:
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


def eye(req: dict[str, Any], win32com) -> dict[str, Any]:
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
    main()
