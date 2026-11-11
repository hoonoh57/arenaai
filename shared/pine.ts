import type {Formula, Kind} from './formula';

export type PineNote = {line: number; text: string};
export type PineResult = {
  formula: Omit<Formula, 'id'>;
  notes: PineNote[];
  skipped: string[];
};

const FN: Record<string, string> = {
  'ta.sma': 'SMA',
  'ta.ema': 'EMA',
  'ta.wma': 'WAVG',
  'ta.highest': 'HIGHEST',
  'ta.lowest': 'LOWEST',
  'ta.crossover': 'CROSSUP',
  'ta.crossunder': 'CROSSDOWN',
  'ta.change': 'ROC',
  'ta.cum': 'SUM',
  'math.abs': 'ABS',
  'math.max': 'MAX',
  'math.min': 'MIN',
  'math.log': 'LOG',
  'math.log10': 'LOG10',
  'math.sqrt': 'SQRT',
  'math.pow': 'POW',
  'math.sin': 'SIN',
  'math.cos': 'COS',
  'math.tan': 'TAN',
  sma: 'SMA',
  ema: 'EMA',
  wma: 'WAVG',
  highest: 'HIGHEST',
  lowest: 'LOWEST',
  crossover: 'CROSSUP',
  crossunder: 'CROSSDOWN',
  abs: 'ABS',
  max: 'MAX',
  min: 'MIN',
};

const SERIES: Record<string, string> = {
  close: 'CLOSE',
  open: 'OPEN',
  high: 'HIGH',
  low: 'LOW',
  volume: 'VOLUME',
  hl2: '((HIGH+LOW)/2)',
  hlc3: '((HIGH+LOW+CLOSE)/3)',
  ohlc4: '((OPEN+HIGH+LOW+CLOSE)/4)',
};

const UNSUPPORTED =
  /\b(request\.|security\s*\(|ticker\.|timeframe\.|alert\s*\(|box\.|label\.|line\.|table\.|polyline\.|matrix\.|map\.|array\.|for\s+|while\s+|switch\s+|type\s+|method\s+|import\s+|library\s+|varip\s+|na\b|nz\s*\(|fixnan\s*\(|barstate\.|timenow|timestamp\s*\(|str\.|color\.|bgcolor\s*\(|fill\s*\()/i;

function slug(name: string): string {
  const base = name.replace(/[^a-zA-Z0-9가-힣]+/g, '').slice(0, 24) || 'pine';
  return `pine-${base}-${Date.now().toString(36)}`.slice(0, 80);
}

export function convertPine(source: string, kindHint?: Kind): PineResult {
  const notes: PineNote[] = [];
  const skipped: string[] = [];
  const rawLines = source.replace(/\r/g, '').split('\n');
  rawLines.forEach((line, i) => {
    if (UNSUPPORTED.test(line)) {
      notes.push({line: i + 1, text: `지원하지 않는 파인 구문: ${line.trim().slice(0, 80)}`});
      skipped.push(line.trim());
    }
  });

  let name = '파인 이식';
  const title = /(?:indicator|strategy|study)\s*\(\s*["']([^"']+)/.exec(source);
  if (title) name = title[1].slice(0, 60);

  const overlay = /overlay\s*=\s*true/.test(source);
  let kind: Kind = kindHint || 'indicator';
  if (/strategy\s*\(/.test(source) || /strategy\.(entry|close|exit)/.test(source)) kind = 'system';
  else if (/plotshape|plotchar|plotarrow/.test(source)) kind = 'signal';
  else if (/barcolor\s*\(/.test(source)) kind = 'highlight';

  const variables: Record<string, number> = {};
  const inputRe =
    /(?:(?:(?:const|var)\s+)?(?:int|float|simple\s+int|simple\s+float)\s+)?([A-Za-z_]\w*)\s*=\s*input(?:\.(?:int|float|source))?\s*\(\s*([+-]?\d+(?:\.\d+)?)[^)]*\)/g;
  let m: RegExpExecArray | null;
  while ((m = inputRe.exec(source))) {
    const key = m[1];
    const value = Number(m[2]);
    if (Number.isFinite(value)) variables[key] = value;
  }

  const plots: {name: string; expression: string}[] = [];
  for (const call of extractCalls(source, 'plot')) {
    const args = splitArgs(call);
    const title = /title\s*=\s*["']([^"']+)["']/.exec(call)?.[1];
    if (args[0]) plots.push({name: (title || `plot${plots.length + 1}`).slice(0, 60), expression: args[0]});
  }

  let longExpr = '';
  let exitExpr = '';
  const long = /strategy\.entry\s*\([^)]*(?:strategy\.long|id\s*=\s*["'][^"']+["'])[^)]*\)\s*(?:when\s*=\s*)?([^\n]+)?/.exec(source);
  const ifLong = /if\s+(.+)\n\s*strategy\.entry\s*\([^)]*strategy\.long/.exec(source);
  if (ifLong) longExpr = ifLong[1].trim();
  else if (long?.[1]) longExpr = long[1].replace(/^when\s*=\s*/, '').trim();
  const close = /strategy\.close(?:_all)?\s*\([^)]*\)(?:\s*when\s*=\s*)?([^\n]+)?/.exec(source);
  const ifClose = /if\s+(.+)\n\s*strategy\.close/.exec(source);
  if (ifClose) exitExpr = ifClose[1].trim();
  else if (close?.[1]) exitExpr = close[1].replace(/^when\s*=\s*/, '').trim();

  const shape = /plotshape\s*\(\s*([^,]+)/.exec(source);
  const barcolor = /barcolor\s*\(\s*([^)]+?)\s*\)/.exec(source);

  let body = rawLines
    .map((line) =>
      line
        .replace(/\/\/.*$/, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .trim(),
    )
    .filter((line) => line && !line.startsWith('//@') && !/^(indicator|strategy|study)\s*\(/.test(line) && !/^plot/.test(line) && !/^strategy\./.test(line) && !/^barcolor/.test(line) && !/^input/.test(line))
    .join('\n');

  let expression = '';
  if (kind === 'system') expression = longExpr || plots[0]?.expression || 'CROSSUP(SMA(CLOSE, 5), SMA(CLOSE, 20))';
  else if (kind === 'signal') expression = shape?.[1]?.trim() || plots[0]?.expression || 'CROSSUP(SMA(CLOSE, 5), SMA(CLOSE, 20))';
  else if (kind === 'highlight') expression = barcolor?.[1]?.trim() || 'CLOSE > OPEN';
  else expression = plots[0]?.expression || lastAssignment(body) || 'SMA(CLOSE, 20)';

  const extraLines = plots.slice(1, 5).map((p, i) => ({
    name: p.name,
    expression: translateExpr(p.expression, notes),
    color: ['#6ba8ed', '#e8bd64', '#d48ad4', '#a8ec6a'][i],
    visible: true,
  }));

  const translated = translateBlock(expression, notes);
  const translatedExit = exitExpr ? translateBlock(exitExpr, notes) : '';
  extraLines.forEach((line, i) => {
    extraLines[i] = {...line, expression: translateBlock(line.expression, notes)};
  });

  if (!Object.keys(variables).length && /\blen\b|\blength\b|\bperiod\b/.test(source)) {
    const n = Number(/\b(?:len|length|period)\s*=\s*(\d+)/.exec(source)?.[1]);
    if (n) variables.기간 = n;
  }

  notes.push({line: 0, text: '파인 전체 문법·리페인트·멀티타임프레임은 이식하지 않습니다. 수식 검증 후 키움 차트와 대조하세요.'});

  return {
    formula: {
      name,
      kind,
      expression: translated,
      exitExpression: translatedExit,
      enabled: false,
      color: '#a8ec6a',
      variables: Object.keys(variables).length ? variables : undefined,
      description: `Pine 이식\n${skipped.length ? `생략 ${skipped.length}줄` : ''}`.trim(),
      extraLines: extraLines.length ? extraLines : undefined,
      pane: overlay || kind !== 'indicator' ? 'price' : 'separate',
    },
    notes,
    skipped,
  };
}

function extractCalls(source: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`\\b${name}\\s*\\(`, 'g');
  let found: RegExpExecArray | null;
  while ((found = re.exec(source))) {
    let depth = 1;
    let i = found.index + found[0].length;
    const start = i;
    while (i < source.length && depth) {
      if (source[i] === '(') depth += 1;
      else if (source[i] === ')') depth -= 1;
      i += 1;
    }
    out.push(source.slice(start, i - 1));
  }
  return out;
}

function splitArgs(inner: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of inner) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      args.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) args.push(cur.trim());
  return args;
}

function lastAssignment(body: string): string {
  const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    const asg = /^[A-Za-z_]\w*\s*=\s*(.+)$/.exec(line);
    if (asg) return asg[1];
    if (!/^(if|else|for)/.test(line)) return line;
  }
  return '';
}

function translateBlock(expr: string, notes: PineNote[]): string {
  return expr
    .split('\n')
    .map((line) => translateExpr(line, notes))
    .filter(Boolean)
    .join('\n');
}

function translateExpr(expr: string, notes: PineNote[]): string {
  let s = expr.trim().replace(/;+$/, '');
  s = s.replace(/\btrue\b/g, '1').replace(/\bfalse\b/g, '0');
  s = s.replace(/\b(close|open|high|low|volume|hl2|hlc3|ohlc4)\s*\[\s*(\d+)\s*\]/gi, (_, name: string, n: string) => `REF(${SERIES[name.toLowerCase()] || name.toUpperCase()}, ${n})`);
  s = s.replace(/\b(close|open|high|low|volume|hl2|hlc3|ohlc4)\b/gi, (name) => SERIES[name.toLowerCase()] || name);
  s = s.replace(/\b([A-Za-z_]\w*)\s*\[\s*(\d+)\s*\]/g, 'REF($1, $2)');
  for (const [from, to] of Object.entries(FN)) {
    const re = new RegExp(`\\b${from.replace('.', '\\.')}\\s*\\(`, 'gi');
    s = s.replace(re, `${to}(`);
  }
  s = s.replace(/\bta\.rsi\s*\(/gi, () => {
    notes.push({line: 0, text: 'ta.rsi는 키움 내장 RSI가 없어 SMA/MAX 조합으로 직접 쓰세요.'});
    return 'RSI_UNSUPPORTED(';
  });
  s = s.replace(/\s+and\s+/gi, ' AND ').replace(/\s+or\s+/gi, ' OR ').replace(/\bnot\s+/gi, 'NOT ');
  s = s.replace(/:=/g, '=');
  s = s.replace(/\?:/g, ','); // cannot map ternary well
  if (s.includes('RSI_UNSUPPORTED')) s = s.replace(/RSI_UNSUPPORTED\([^)]*\)/g, 'SMA(CLOSE, 14)');
  return s;
}

export function formulaFromPine(source: string, kindHint?: Kind): Formula {
  const {formula} = convertPine(source, kindHint);
  return {id: slug(formula.name), ...formula};
}
