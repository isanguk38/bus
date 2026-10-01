import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRouteQuery } from '../server/lib/query.js';

test('"번", "버스"와 공백을 떼고 노선 번호만 남긴다', () => {
  assert.equal(normalizeRouteQuery('10번'), '10');
  assert.equal(normalizeRouteQuery(' 10 번 버스 '), '10');
  assert.equal(normalizeRouteQuery('7016버스'), '7016');
  assert.equal(normalizeRouteQuery('11-1번'), '11-1');
});

test('번호 중간이나 노선 이름은 건드리지 않는다', () => {
  assert.equal(normalizeRouteQuery('N26'), 'N26');
  assert.equal(normalizeRouteQuery('안양똑버스01'), '안양똑버스01');
  assert.equal(normalizeRouteQuery(undefined), '');
});
