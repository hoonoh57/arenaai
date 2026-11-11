로컬 조건검색([0150])용 봉 파일.

- `data/bars/D/종목코드.csv` 일봉
- `data/bars/1/종목코드.csv` 1분봉

형식: `time,open,high,low,close,volume`  
time은 `YYYYMMDD` 또는 `YYYYMMDDHHMMSS`(KST) 또는 ISO.  
환경변수 `BARS_DIR`로 루트를 바꿀 수 있습니다. `data/` 는 gitignore.

## CYBOS (Google Drive `db/raw/cybos`)

원본은 연/월 파티션 parquet.

- 일봉 `cybos_1d_A/{year}/part-*.parquet`  
  컬럼: `code`(A005930), `date`(YYYYMMDD), `open,high,low,close,volume`
- 1분 `cybos_1m_A/{YYYYMM}/part-*.parquet`  
  컬럼: `code`, `date`, `time_end`(901=09:01), OHLCV

캐시 위치:

- parquet: `data/cybos/1d`, `data/cybos/1m`
- CSV: `scripts/ingest_cybos.py` → `data/bars`

작업 디렉터리에는 일봉 2026 전종목(~2646)과 1분 2026-11 월을 캐시했습니다. 조건검색은 최대 5000종목, 봉은 메모리 캐시합니다.
