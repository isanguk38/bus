import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateSpeeds } from '../server/lib/speed.js';

const T0 = 1_000_000;
const NORTH_100M = 100 / 111_195; // 위도 약 100m

// 위도 방향으로 n×100m 떨어진 관측
const at = (hundreds, sec) => [{ id: 'a', lat: 37.5 + NORTH_100M * hundreds, lng: 127, observedAt: T0 + sec * 1000 }];

test('위치가 바뀌는 순간을 본 뒤부터 속도를 구한다', () => {
  const first = estimateSpeeds(new Map(), at(0, 0));
  assert.equal(first.buses[0].speed, null, '첫 관측은 속도를 모른다');

  // 처음 본 위치는 언제부터 거기 있었는지 모르므로 출발점으로 쓰지 않는다
  const second = estimateSpeeds(first.tracked, at(3, 20));
  assert.equal(second.buses[0].speed, null, '수집 시작 직후의 이동은 시간을 몰라 속도에 쓰지 않는다');

  const third = estimateSpeeds(second.tracked, at(6, 50));
  assert.ok(Math.abs(third.buses[0].speed - 10) < 0.1, `300m / 30초 = 10m/s (${third.buses[0].speed})`);
});

test('위치가 아직 안 바뀐 관측은 속도를 바꾸지 않는다', () => {
  let state = estimateSpeeds(new Map(), at(0, 0));
  state = estimateSpeeds(state.tracked, at(3, 20));
  state = estimateSpeeds(state.tracked, at(6, 50));
  assert.ok(state.buses[0].speed > 0);
  // TAGO는 위치가 그대로면 처음 본 시각을 유지해 보낸다
  const same = estimateSpeeds(state.tracked, [{ id: 'a', lat: 37.5 + NORTH_100M * 3, lng: 127, observedAt: T0 + 30_000 }]);
  assert.equal(same.buses[0].speed, state.buses[0].speed);
});

test('비현실적으로 빠른 이동(GPS 튐)은 무시한다', () => {
  let state = estimateSpeeds(new Map(), at(0, 0));
  state = estimateSpeeds(state.tracked, at(3, 20));
  state = estimateSpeeds(state.tracked, at(6, 50));
  const jump = estimateSpeeds(state.tracked, [{ id: 'a', lat: 37.6, lng: 127, observedAt: T0 + 60_000 }]);
  assert.ok(state.buses[0].speed > 0);
  assert.equal(jump.buses[0].speed, state.buses[0].speed);
});

test('같은 이력이면 언제 접속했든 같은 속도를 받는다 (화면마다 값이 같음)', () => {
  const history = [
    [{ id: 'a', lat: 37.5, lng: 127, observedAt: T0 }],
    [{ id: 'a', lat: 37.5 + NORTH_100M * 2, lng: 127, observedAt: T0 + 20_000 }],
    [{ id: 'a', lat: 37.5 + NORTH_100M * 5, lng: 127, observedAt: T0 + 40_000 }],
  ];
  let tracked = new Map();
  let last;
  for (const buses of history) ({ tracked, buses: last } = estimateSpeeds(tracked, buses));
  assert.ok(last[0].speed > 0);
});
