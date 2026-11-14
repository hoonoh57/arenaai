import assert from 'node:assert/strict';
import test from 'node:test';
import {concatNewestPages, newestFirstToChrono, stampTickUnix} from './barOrder';

test('최근이 앞인 페이지는 전부 붙인 뒤 reverse 한 번만', () => {
  const pages = [
    ['t3', 't2'],
    ['t1', 't0'],
  ];
  assert.deepEqual(concatNewestPages(pages), ['t0', 't1', 't2', 't3']);
});

test('이미 한 장이면 reverse만', () => {
  assert.deepEqual(newestFirstToChrono([3, 2, 1]), [1, 2, 3]);
});

test('같은 hhmm 틱은 sort 없이 초만 붙인다', () => {
  const rows = [
    {date: 20261111, hhmm: 901},
    {date: 20261111, hhmm: 901},
    {date: 20261111, hhmm: 902},
  ];
  const t = stampTickUnix(rows);
  assert.equal(t.length, 3);
  assert.ok(t[0]! < t[1]!);
  assert.ok(t[1]! < t[2]!);
  assert.equal(t[1]! - t[0]!, 1);
});
