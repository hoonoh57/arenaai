---
name: cybos-plus
description: CYBOS Plus 대량시세(캔들·체결강도·외국인·섹터·MarketEye·실시간) 코딩 계약. 키움 REST와 섞지 말 것.
---

# CYBOS Plus 대량 데이터 (코딩 시 이 파일만 따른다)

주문·조건검색·체결은 **키움**. CYBOS는 **대량 시세·이력**만. 창은 `hub.ask`만. 64비트 파이썬이 32비트 COM 워커를 호출하는 기존 경로를 쓰고, 허브는 64비트 엔트리만 본다.

공식 도움말: [StockChart](https://cybosplus.github.io/cpsysdib_rtf_1_/stockchart.htm), [MarketEye](https://cybosplus.github.io/cpsysdib_rtf_1_/marketeye.htm), [CpCybos](https://cybosplus.github.io/cputil_rtf_1_/cpcybos.htm), 대신증권 갱신본 [StockChart 도움말](https://money2.daishin.com/e5/mboard/ptype_basic/HTS_Plus_Helper/DW_Basic_Read_Page.aspx?boardseq=284&seq=102).

COM: `CpSysDib.StockChart`, `CpSysDib.MarketEye`, `CpUtil.CpCybos`, `CpUtil.CpCodeMgr`, `DsCbo1.StockCur`.

종목코드는 **`A`+6자리** (`A005930`). 업종 `U001`.

---

## 1. 연결·한도 (헤매면 여기)

- `CpCybos.IsConnect == 1` 아니면 요청 금지.
- 시세 RQ: **15초에 60건**. 초과 시 Plus가 `BlockRequest` 안에서 **스스로 대기 후 재시작**.
- `GetLimitRemainCount(LT_NONTRADE_REQUEST=1)`, `LimitRequestRemainTime`(ms).
- 주문 RQ는 15초 20건·초과 시 코드 4. **CYBOS로 주문하지 않음.**
- 실시간 SB 최대 **400**.
- 동시 워커 **4개**까지. 한도 초과 대기는 Plus가 하므로 스레드마다 임의 sleep 루프를 넣지 않는다. RemainCount가 0이면 그 스레드만 `LimitRequestRemainTime` 대기.
- `GetDibStatus`: 0 정상, -1 오류(`GetDibMsg1`), 1 수신대기(같은 객체에 겹쳐 Request 금지).

---

## 2. StockChart 캔들 — 필수 규칙

`SetInputValue`

| type | 의미 | 값 |
|---|---|---|
| 0 | 종목 | `A003540` |
| 1 | 요청구분 | `'1'` 기간, `'2'` 개수 |
| 2 | 종료일 | YYYYMMDD, 0=최근 |
| 3 | 시작일 | YYYYMMDD |
| 4 | 개수 | ulong |
| 5 | 필드 배열 | 아래. **요청한 필드 ID 오름차순으로 GetDataValue 인덱스가 재배치됨** |
| 6 | 주기 | `'D'`일 `'W'`주 `'M'`월 `'m'`분 `'T'`틱 |
| 7 | 주기배수 | 분/틱 n분·n틱. default 1 |
| 8 | 갭보정 | `'0'`무 `'1'`보 |
| 9 | 수정주가 | `'1'` 사용 |
| 10 | 거래량 | `'1'` 시간외 포함(기본) `'3'` 제외 |
| 11 | 분차트 기산 | `'Y'` 08:45, `'N'` 09:00 (기본) |
| 12 | 거래소 | `'K'` KRX(기본) `'N'` NXT `'A'` **전체** |

### 기간 vs 개수 (운영 계약)

- **일·주·월**: 기간(`'1'` + 시작·종료) **또는** 개수(`'2'` + type4).
- **분·틱**: **개수만**. 기간 요청 불가(대신 도움말: `'1'`은 주·월·분·틱 불가라고도 함. 분·틱에 기간을 넣지 말 것).
- 분·틱으로 **이전 날짜**를 채울 때: 개수 N으로 `BlockRequest` → `Continue`가 있으면 같은 객체로 다음 페이지 → 받은 봉의 **가장 오래된 일시가 목표 첫 일시 이하**이면 **루프 종료**. 목표보다 최신만 있으면 계속. 요청개수와 수신개수를 **누적 비교**(요청 ≤ 누적수신이 될 때까지 Continue).

`Continue`가 참이면 입력값을 다시 넣지 않고 `BlockRequest`.

수신: `GetHeaderValue(3)` 개수. 보통 **index 0 = 최신**. 허브 캐시는 오래된→최신으로 reverse. **sort 금지, reverse만.**

### 봉 시각 = 봉 **종료** 시각

필드 0 날짜 YYYYMMDD, 필드 1 시간 **hhmm**.  
1분봉 `0901` = 09:00:00~09:01:00이 끝난 봉. 키움 시작시각과 섞지 말 것. 허브 `Candle.time`은 이 종료시각의 KST unix.

미완성 봉: `GetHeaderValue(4)` 마지막봉 틱수.

### NXT

NXT 포함 분·틱·시세는 type12 **`'A'`(전체)**. `'N'`은 NXT만·가능 종목만. 기본 `'K'`면 NXT 장이 빠진다.

### 필드 (차트)

필수 OHLCV: `0,1,2,3,4,5,8` (분·틱은 1 필수, 일은 1 생략 가능).

| id | 내용 |
|---|---|
| 8 | 거래량 |
| 9 | 거래대금 |
| 10·11 | 누적체결매도/매수 (**호가비교**, 분·틱만) |
| 62·63 | 누적체결매도/매수 (**체결가비교**, 분·틱만, 갱신 도움말) |
| 20·21 | 기관순매수·누적 (일 등) |
| 16·17 | 외국인 보유수량·비율 |

`GetDataValue(필드인덱스, 봉index)` — 필드인덱스는 **요청 배열을 오름차순 정렬한 위치**이지 id 자체가 아님.

---

## 3. 체결강도

별도 “분봉 강도 차트” TR 없음.

- **스냅샷(전종목·200개씩)**: MarketEye 필드 **24** 체결강도(float).
- **봉별 이력**: 분·틱 StockChart 누적매수/매도.
  - 키움·대신 정의: **체결강도 = 누적매수 ÷ 누적매도 × 100**.
  - 기본은 **체결가비교(62,63)**. 호가비교는 10,11.
  - 매도 0이면 강도 없음(날조 금지).
- 실시간: `StockCur` 누적매수/매도(체결가 15·16, 호가 27·28)로 동일 산식. 또는 일부 오브젝트 헤더 체결강도.

키움 `ka10046` 페이지와 숫자를 같다고 가정하지 말 것. 허브 필드는 `strength`. 소스 태그 `cybos`.

---

## 4. 외국인 순매수

| 용도 | 오브젝트 | 필드 |
|---|---|---|
| 전종목 당일 스냅샷 | MarketEye | 62 외국인순매매, **118** 당일외국인순매수, 117 잠정/확정, 121 전일 |
| 종목 일자별 추이 | `CpSysDib.CpSvrNew7216` | 8 외국인순매매, 9 지분율, 6·7 기관 |
| 투자자 일별 | `CpSvrNew7224` | 시장·투자자·기간 |
| 일봉 보조 | StockChart 16·17 보유 (순매수 아님) |

118과 62를 섞지 말 것. 잠정(117=`'2'`)은 확정 전 값.

---

## 5. 주도 섹터 / 소속 종목

`CpUtil.CpCodeMgr`

- `GetIndustryList()` → 업종코드 배열.
- `GetGroupName(code)` / `GetGroupCodeList(업종코드)` → **소속 종목**.
- `GetIndustryGroupCodeList(code)` 동일 계열(도움말 갱신명).
- 관심그룹 700–799도 `GetGroupCodeList`.
- 업종 차트: StockChart 종목 `U001` 등.
- 업종 시세 대량: MarketEye에 `U`+코드, 200개씩.

“주도”는 API 한 방이 아니다. 업종 등락·거래대금·순매수를 MarketEye로 받은 뒤 **허브가 순위**. 가짜 주도 리스트 금지.

---

## 6. MarketEye (대량 스냅샷)

- 관련 HTS **7059**. RQ, 연속 없음.
- type0: 필드 배열 **최대 64**.
- type1: 종목코드 배열 **최대 200**. 전종목은 200개씩 여러 번.
- type2: `'1'` 체결가비교(기본) `'2'` 호가비교.
- `GetHeaderValue(2)` 종목수. `GetDataValue(필드정렬index, 종목index)`.

자주 쓰는 필드: 0코드 4현재가 5–7 OHLC 10거래량 11대금 17이름 **24체결강도** 21외인비율 **62/118 외인순매수** 116프로그램 120기관.

대비(3)는 부호(2)와 같이. 예상체결(29)은 부호(30)와 같이.

---

## 7. 실시간

주문/조건 실시간은 키움 WSS. CYBOS SB는 대량 보조만. SB 400 넘기지 말 것.

`DsCbo1.StockCur` (7021/7024): Subscribe/Unsubscribe. Header 13 현재가, 17 순간량, 18 초, 19 예상/실체결, 15·16 누적매도·매수(체결가).

특징주: `CpMarketWatchS` (외국인 순매수 코드 12 등).

COM 이벤트는 32비트 워커에서만. 64비트/Node는 콜백을 큐로 받는다.

---

## 8. 허브 저장 (키움과 동일)

`SharedCache` 봉: `{time, open, high, low, close, volume, strength?}`. time = **봉 종료 KST unix**.  
페이지 키 `code|tf|baseDate` 기존과 동일. 출처만 `cybos`.  
창은 키움/CYBOS를 고르지 않음. 대량 적재 실패 시 `held`, 키움 1장으로 메우지 말 것(총량 소진).

parquet 통째 복사 금지. 기존 64비트 다운로드가 쓰는 저장만 증분.

---

## 9. 코딩할 때 하지 말 것

- 분·틱에 기간 모드.
- NXT를 `'K'`로 조회하고 없다고 단정.
- 봉 시간을 시작시각으로 저장.
- GetDataValue에 필드 **id**를 그대로 넣기 (정렬 인덱스여야 함).
- 한 프로세스에서 32비트 COM 직접 (64비트 엔트리만).
- 4개 초과 스레드로 RQ 폭주. Plus 대기 중에 객체 재생성 남발.
- CYBOS 가격으로 키움 지정가.
- 가짜 80봉·빈 강도 50 보정.
- MarketEye 200개 초과 한 방.

---

## 10. 최소 호출 스케치 (분봉 페이징)

```
obj.SetInputValue(0, "A"+code)
obj.SetInputValue(1, ord('2'))          # 개수
obj.SetInputValue(4, page_cnt)          # 예: 2000
obj.SetInputValue(5, [0,1,2,3,4,5,8,62,63])
obj.SetInputValue(6, ord('m'))
obj.SetInputValue(7, 1)
obj.SetInputValue(9, ord('1'))
obj.SetInputValue(12, ord('A'))         # NXT 포함
obj.BlockRequest()
# 최신→과거 페이지를 이어 붙이다가 min(date,time) <= 목표 첫 일시 이면 break
# while obj.Continue: BlockRequest()
```

일봉 기간:

```
SetInputValue(1, ord('1'))
SetInputValue(2, end_yyyymmdd)   # 최근
SetInputValue(3, start_yyyymmdd)
SetInputValue(6, ord('D'))
```
