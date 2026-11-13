# 중앙관리자 허브 스펙 (창 개발 필수)

새 창은 키움 REST·WSS를 직접 열지 않는다. **요청은 `hub.ask`, 회신은 아래 필드만** 본다. 타입은 `shared/hubAsk.ts`.

## 1. 원칙

1. 소켓 1개, REST 총량은 허브만. 창이 `fetch('https://api.kiwoom.com')` 또는 자체 WSS를 쓰면 거부.
2. 창 식별 `owner`를 반드시 넣는다. 예: `desk:chart`, `pane:잔고`.
3. `ok === false`여도 화면을 죽이지 않는다. `book`·`candles`가 있으면 그대로 그린다.
4. `held === true`는 총량 보호. 추가 재요청 폭주 금지. 캐시로 표시.
5. 종목코드는 6자리 숫자만. 가짜 코드 금지.
6. 분봉·강도는 **한 페이지**. `+이전`만 `nextKey`로 다시 `ask`. 정렬·전구간 재요청 금지.
7. 이미 구독한 종목은 `watch`를 반복하지 않는다. 재 REG는 TRNM.
8. 주문 레인은 차트 REST와 분리되어 있다. 신호·주문은 창이 가려져 있어도 허브가 수행한다.

## 2. 요청 `HubAsk`

| 필드 | 필수 | 내용 |
|---|---|---|
| owner | 예 | 창 ID |
| op | 예 | 아래 표 |
| code | 차트·주문 | 6자리 |
| timeframe | | `1` 또는 `D` |
| baseDate | | 당일 키. 빈 문자열=오늘 |
| nextKey | | 이전 페이지 키. 첫 장은 생략 |
| items, types | watch | 종목 배열, 기본 `['0B']` |
| fresh | | true면 캐시 무시하고 신규 REST (랩 전용. 창은 쓰지 말 것) |
| qty, orderType, limitPrice, orderId | 주문 | |

## 3. 회신 `HubAskReply`

항상 온다: `ok`, `held`, `candles`, `hasMore`, `nextKey`, `quote`.  
있으면 쓴다: `reason`, `name`, `book`, `order`, `orders`, `cancelled`, `status`, `quota`, `ready`, `nxt`.

- `held`: 허브가 REST/REG를 막음. `reason`에 잔여/대기.
- `book`: `{holdings, working, recent, fillMode, ...}` 잔고·미체결·최근체결.
- `quota`: `{rest:{used,left,cap,waitForOneMs}, wss:{used,left,cap,packet}}`.

## 4. op

| op | 하는 일 | 창이 볼 필드 |
|---|---|---|
| chart | 분봉 1장 | candles, hasMore, nextKey, quote |
| strength | 강도 페이지(총량 안 연속) | candles, hasMore, nextKey, ready, nxt |
| live | 캐시+체결 합성. REST 없음 | candles, quote |
| quote | 시세만 | quote |
| name | 종목명 | name |
| watch | 0B 구독. 상한이면 held | held, reason |
| book | 잔고·미체결 | book |
| buy / sell | 주문 | order, book |
| flatten | 전량 청산 | orders, book |
| cancel | 미체결 취소 | order 또는 cancelled, book |
| system | 링크·총량·장부 | status, quota, book |

## 5. 창 HTTP (서버가 ask로 위임)

| 창 | 방법 | 경로 |
|---|---|---|
| 차트 1장 | POST | `/api/chart` `{code,timeframe,baseDate,nextKey,withStrength}` |
| 실시간 봉 | GET | `/api/live-bars?code=&timeframe=&baseDate=` |
| 매수 | POST | `/api/book/buy` `{code,type,limitPrice,qty}` |
| 매도 | POST | `/api/book/sell` 동일 |
| 청산 | POST | `/api/book/flatten` `{type}` |
| 미체결취소 | POST | `/api/book/cancel` `{id}` 또는 `{code}` |
| 전체 상태 | GET | `/api/state` → `book`, `quota`, `realtime.hub` |

새 창은 이 경로만 호출한다. 새 op가 필요하면 허브에 op를 등록한 뒤 경로를 추가한다. 미등록 op는 회신 `ok:false`.

## 6. 용량 (랩 실측, `shared/hubCaps.ts`)

- REST 버스트 10, **주문용 1칸 예약**, 대기 한도 초과 시 차트는 캐시.
- WSS 구독 100, 패킷당 10. 초과 REG 없음.
- 신규 분봉 1장 실측 약 1.5~12초. 1초는 목표(비교)이지 창 타임아웃이 아님.
- 체결강도 08:30(NXT)/09:00(KRX)까지. 빈 봉은 허브가 페이징.

창이 병렬로 16종목 REST를 치면 허브가 줄 세우거나 `held`한다. 창은 폴링 간격을 늘린다.

## 7. 새 창 체크리스트

- [ ] 키움 URL·앱키 없음
- [ ] `owner` 고유
- [ ] 데이터는 ask 회신만
- [ ] `held`이면 재폭주 없음
- [ ] 주문 실패해도 `book`으로 잔고 유지
- [ ] 차트 가림·가상화면 이동과 무관하게 신호는 허브
- [ ] 구독은 허브 `watch`. 창 REG 없음

## 8. 하지 말 것

- ka10080/ka10046를 창에서 직접
- 같은 종목 반복 REG
- 봉 배열 sort
- 총량 무시 재시도 루프
- 가짜 종목코드로 주문·차트
