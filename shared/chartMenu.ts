/** 키움 종합차트 우클릭·툴바와 같은 도구 목록. 툴바 축소 시에도 메뉴는 여기만 고친다. */
export type DrawToolId = 'cursor' | 'hline' | 'vline' | 'trend' | 'text' | 'target' | 'stop' | 'entry';

export const DRAW_TOOLS: {id: DrawToolId; label: string; menu: string}[] = [
  {id: 'cursor', label: '선택', menu: '선택 (커서)'},
  {id: 'hline', label: '수평', menu: '수평선'},
  {id: 'vline', label: '수직', menu: '수직선'},
  {id: 'trend', label: '추세', menu: '추세선'},
  {id: 'text', label: '메모', menu: '텍스트'},
  {id: 'target', label: '목표', menu: '목표선'},
  {id: 'stop', label: '손절', menu: '손절선'},
  {id: 'entry', label: '진입', menu: '진입마크'},
];

export const CHART_PERIODS: {id: string; label: string}[] = [
  {id: 'T1', label: '1틱'},
  {id: 'T3', label: '3틱'},
  {id: 'T30', label: '30틱'},
  {id: '1', label: '1분'},
  {id: '3', label: '3분'},
  {id: '5', label: '5분'},
  {id: '10', label: '10분'},
  {id: '15', label: '15분'},
  {id: '30', label: '30분'},
  {id: '60', label: '60분'},
  {id: 'D', label: '일봉'},
  {id: 'W', label: '주봉'},
  {id: 'M', label: '월봉'},
];
