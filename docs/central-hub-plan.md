# 중앙관리자(허브) 통합 목록과 운영안

작성 기준: 현재 워크트리 (`DemandBridge` + `RealtimeHub` + `SharedCache` + `LimitGovernor`).  
목표: 창·차트·조건식·전략은 **요청만** 하고, 키움 REST·WSS·주문·봉·체결강도·신호는 **허브가 보증**한다.

---

## 1. 원칙 (이미 합의된 5축)

| 축 | 담당 | 하지 않는 일 |
|---|---|---|
| 차트 코어 | `shared/chart` 수식 평가, 축·줌 | REST, WSS, 종목 캐시 |
| 브리지/런타임 | 창이 허브에 읽는 인터페이스 | 키움 소켓 직접 소유 |
| 애드온 | 멀티차트·툴바·TradeBar | 독자 시세 구독 |
| 상태 JSON | 가상화면, 전략ID, 대기/적용 | 캔들 복사본 |
| **중앙관리자** | 연결, 한도, 구독, 캐시, 주문, 신호, 강도 | UI 그리기 |

창이 꺼져도 시세·신호·주문은 산다. 데이터 캐싱은 차트 컴포넌트에 두지 않는다.

---

## 2. 지금 흩어져 있는 것 (위임 대상)

### 2.1 창·라우트가 직접 건드리는 키움 업무

| 현재 위치 | 하는 일 | 문제 | 허브로 옮길 함수 |
|---|---|---|---|
| `POST /api/chart` + `ChartPane.load` | 창마다 `ka10080` + **`attachStrength`(ka10046 연속)** | 창 수 × 페이지. TRNM·REST 한도 | `hub.ensureChart(code, tf)` |
| `ChartPane` `withStrength` / `strengthOnly` | 개별 차트가 강도 이전 페이지 | 전략이 창 다운로드에 종속 | `hub.ensureStrength(code, tf)` |
| `GET /api/live-bars` | 창 0.3s 폴링, 예전엔 REG까지 | 폴링은 읽기만. REG 금지 | `cache.chartPage` + `getQuote` |
| `DeskApp.queuedChart` / `VerifyCompare` | 같은 `/api/chart` 재호출 | ChartGate TTL과 경합 | 허브 페이지 재사용 |
| `POST /api/tr` ka10080/ka10046 | 운영자 TR 창이 REST 직행 | 한도 우회 가능 | `governor` 경유 `hub.tr()` |
| `PUT /api/desks` | 저장 때마다 구독 동기화했음 | REG 폭주 | 종목 집합 변경 시에만 |

### 2.2 WSS

| 현재 | 허브 단일 진입 |
|---|---|
| `RealtimeHub` LOGIN / PING / REAL / REG / REMOVE | 유지. **창은 구독 패킷을 만들지 않음** |
| `DemandBridge.syncSubscriptions` | 조건 포착 + 차트 종목 슬롯 계획 |
| `hub.subscribe('desk:charts')` | 차트·전략 종목 0B |
| 조건식 `CNSRLST` / `CNSRREQ` | 허브 `request()` 만 |
| 30초 무수신 | 허브 `silentMs` → 긴급 재연결. UI는 pill만 |

### 2.3 주문·체결·장부 (창 공통)

| 기능 | 현재 클래스 | 창이 해도 되는 일 |
|---|---|---|
| 시장 매수/매도 | `SimulationBook` + `hub.placeSignalOrder` | 버튼 → `/api/book/*` |
| 키움 모의 주문 레인 | `LimitGovernor` lane `order`, `OrderGate` | 없음 |
| 체결 반영 | `book.onQuote` (0B 가격) | 없음 |
| 미체결/보유 | `book.snapshot()` | 구독해서 그리기 |
| 잠금 | `config.lockedCodes` + 보유/미체결 | 표시만 |
| 위험 한도 | `RiskManager` | 없음 |
| 매매 로그 | `hub.events` + audit | 매매 탭 표시 |
| 신호 평가 | `hub.evaluateSignals` | 마커는 캐시 봉으로만 |

### 2.4 봉·강도·VWAP 보증 (차트/전략 공통)

허브가 **같은 `SharedCache` 페이지**를 전략과 차트에 준다.

| 데이터 | 넣는 곳 | 보증 |
|---|---|---|
| 분봉 OHLC | `ka10080` 1페이지 + `applyLiveTick` | 빈 분은 직전 종가로 잇기. 재시작 갭으로 신호 금지 |
| 거래량 | 링 `applyQuote` 누적 | VWAP은 이 거래량만 사용 |
| 체결강도 이력 | **허브 `ensureStrength`** (창 아님) | 세션 시작(NXT 08:30 / KRX 09:00)까지 허브가 채움 |
| 체결강도 실시간 | 0B FID `228` → 최근 봉 | 창 표시 여부와 무관 |
| VWAP | 수식 `VWAP()` on 허브 봉 | 봉 volume이 갱신되면 최근 점 갱신 |
| 시세 | `Quote` | 30초 무수신 = 긴급. 가짜 값 합성 금지 |
| 순위 가중 | 0B 등락·강도·누적대금 | ka10046 폴백은 예산 내만 |

---

## 3. 중앙관리자에 둘 기능/함수 목록

구현 위치 제안: `RealtimeHub`가 소켓·한도·장부, `DemandBridge`가 수요 계획, `SharedCache`가 유일한 시세 저장.

### A. 세션·감독

- `start()` / `stop()` / `forceReconnect(reason)`
- `status()` — 연결, silentMs, 구독 수, governor, 주문 레인, 강도 미완료 종목
- `watchdogTick()` — 30초 무프레임 → 긴급
- `audit.record` — 전역 로그만
- 실/모의 호스트 전환 (`AppKey` 821≠8030). 전환 시 캐시·구독 리셋

### B. REST 게이트 (창 직접 호출 금지)

- `governor.acquire(apiId, 'read'|'order')`
- `rest(apiId, body)` — 유일한 HTTP
- `ensureChartPage(code, tf, {nextKey})` — ka10080 한 페이지 reverse, sort 금지
- `ensureStrength(code, tf)` — ka10046 **허브 큐**. 창의 강도+이전은 “허브에 한 장 더” 신호만
- `ensureName(code)`
- `trAllowlist(id)` — ka10171 / ka10080 / ka10046만, 같은 게이트
- 분봉 한도 재읽기 루프 금지. 페이지는 운영자/허브 한 장씩

### C. WSS 게이트

- `subscribe(owner, items, types)` — 잠금 안에서만 REG. 이미 있으면 패킷 없음
- `unsubscribe` — 소유자 0일 때만 REMOVE
- `planWatch({chartCodes, captured, budget})` — 차트·전략 종목 고정, 조건식은 남은 슬롯만 회전
- `setActiveCodes` — 신호 평가 집합 (창 표시와 무관)
- 패킷당 종목 수, 총 구독 상한 (`RealtimeCaps`)
- 조건식: 재기동 자동조회 금지. 인증 후 운영자 실행만. 재포착 1분

### D. 캐시 보증

- `putChartPage` / `chartPage` — 키 `code|tf|baseDate`
- `applyLiveTick` / `applyLiveQuote` — OHLC + volume + **strength 이어붙임**
- `getQuote` / `candles(ring)`
- 창 언마운트 시 페이지 삭제 금지 (다른 창·전략이 씀)

### E. 전략·주문

- `setSignalEvaluator` / `evaluateSignals(code)` — 봉 확정 시에만 주문
- `filtersFromFormulas` — 하드코딩 스킵 없음. 수식 신호 on/off
- `placeOrder` / `cancel` — 주문 레인. 적용(run)만 자동
- `book.snapshot` — 보유·미체결 실시간
- `lockCode` — 미체결·보유·신호 중 순위 교체 금지
- `risk.allow`

### F. 창에 남을 것

- 그리기, 줌 persist, TradeBar UI, 수식 편집
- `GET /api/live-bars` **읽기 전용** (구독·ka10046 없음)

---

## 4. 키움 제약 운영 (허브만 지킴)

### REST

- 전역 1통 + API별 버킷 + **주문 전용 레인** (`LimitGovernor`)
- 429/TRNM 유사 코드 → `penalize()` 전 레인 일시 정지
- 차트 자동 8초 재다운로드 금지. 강도는 **허브가 세션 시작까지 백그라운드 한 장씩**
- 같은 `(code, tf, page)` 는 `ChartGate` 1회. 멀티차트는 공유
- 모의 15:30 이후 강도 공백이면 실/모의 전환으로 빈 값을 전략에 넣지 않음

### WSS

- 연결 **1개**. 창별 소켓 금지
- REG는 구독 집합 변경 시에만. 폴링·persist·줌이 REG를 못 함
- 조건식 포착 종목을 차트 종목과 바꿔 끼우지 않음 (차트·매매 중 잠금)
- 30초 미수신 = 긴급. UI는 허브 `link`만 표시 (종목별 WSS 아님)

### 주문

- 전략 **적용** + 봉 마감 신호만 자동 주문
- 대기는 신호만. 백테스트는 주문 없음
- 키움 모의여도 매매로그 필수. 가정 체결이면 로그에 `assumed` 명시
- 주문 레인이 차트 REST에 밀리지 않음

---

## 5. 체결강도·차트 데이터 보증 절차

```
종목이 차트 또는 전략 집합에 들어옴
  → 허브 0B REG (이미 있으면 skip)
  → ensureChartPage (ka10080 1장) → SharedCache
  → ensureStrength 큐에 등록 (창 대기 없음)
       한 장씩 ka10046, 세션 시작까지
       완료 전: strengthReady=false, 전략은 강도 게이트 미사용
       완료 후: 전 봉 STRENGTH, 0B로 최근 봉만 갱신
  → 차트/전략은 cache.chartPage 만 읽음
분 변경
  → applyLiveTick 새 버킷, 직전 strength·volume 이어줌
  → VWAP/강도 선은 같은 봉의 마지막 점만 update
가상화면 복귀
  → 허브 마지막 봉 시각 ≠ 화면이면 허브 페이지로 즉시 교체
```

창의 「강도+이전」은 `hub.requestStrengthPage(code)` 한 줄. REST는 허브 큐.

---

## 6. 단계 (코드 이동 순서)

1. **강도 위임** — `attachStrength`를 창 `withStrength`에서 떼고, 종목 합류 시 허브 큐. `/api/chart`는 캐시+상태만 반환.
2. **차트 페이지 위임** — `ensureChartPage`만 REST. 창 force 재조회는 쿨다운 유지.
3. **구독 단일 소유자** — `bridge:quotes` + `desk:charts`를 `hub:watch` 하나로. persist는 REG 안 함.
4. **live-bars 읽기 전용** 유지. 폴링 간격은 표시용, 신호와 무관.
5. **주문/신호**는 이미 허브. 창 매수 버튼도 같은 `placeOrder`.
6. 창에서 `post('/api/chart', {withStrength})` / `queuedChart(..., true)` 삭제.

---

## 7. 감독 화면 (중앙관리자가 보여 줄 것)

운영자 한 줄:

- WSS: ok / 경고 / 긴급 (silentMs)
- REST: 대기열, penalty, 주문 레인
- 구독: n / cap, REG 실패
- 강도: 종목별 ready / 다음 페이지 / 세션 시각
- 장부: 보유, 미체결, 당일 위험
- 전략: 적용 종목, 마지막 평가 봉 시각 (창이 꺼져 있어도)

이 숫자가 창 상태와 다르면 **창 버그**로 본다. 허브가 진실이다.
