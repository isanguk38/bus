import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BusTrack, DEFAULT_SPEED } from '../public/js/tracker.js';

const T0 = 1_000_000;

// 화면 버스를 sec초 동안 60fps로 움직인다.
function run(track, fromMs, sec) {
  let now = fromMs;
  for (let i = 0; i < sec * 60; i++) {
    now += 1000 / 60;
    track.step(now, 1 / 60);
  }
  return now;
}

test('첫 관측 직후에는 기본 속도로 예측해 움직인다', () => {
  const track = new BusTrack({ s: 0, at: T0, info: {} });
  run(track, T0, 10);
  assert.ok(track.s > 0, '정지해 있지 않다');
  assert.ok(track.s <= DEFAULT_SPEED * 10, '예측 범위를 넘지 않는다');
});

test('두 관측으로 속도를 추정한다', () => {
  const track = new BusTrack({ s: 0, at: T0, info: {} });
  track.update({ s: 300, at: T0 + 30_000, info: {} });
  assert.equal(track.speed, 10);
  assert.ok(track.measured);
});

test('예측이 실제보다 앞서도 뒤로 가지 않는다', () => {
  const track = new BusTrack({ s: 0, at: T0, info: {} });
  track.update({ s: 300, at: T0 + 30_000, info: {} }); // 10m/s
  run(track, T0 + 30_000, 30); // 약 600m까지 예측
  const before = track.s;
  track.update({ s: 350, at: T0 + 60_000, info: {} }); // 실제로는 정류장에서 멈춰 있었다
  run(track, T0 + 60_000, 5);
  assert.ok(track.s >= before, '뒤로 이동하지 않음');
});

test('GPS가 튀어 비현실적인 속도가 나오면 무시한다', () => {
  const track = new BusTrack({ s: 0, at: T0, info: {} });
  track.update({ s: 300, at: T0 + 30_000, info: {} });
  track.update({ s: 300 + 5000, at: T0 + 40_000, info: {} }); // 10초에 5km
  assert.equal(track.speed, 10);
});

test('크게 어긋나면 따라가지 않고 바로 옮긴다', () => {
  const track = new BusTrack({ s: 0, at: T0, info: {} });
  track.update({ s: 4000, at: T0 + 30_000, info: {} });
  assert.equal(track.s, 4000);
});

test('예측은 마지막 관측 위치보다 최대 400m까지만 앞서 간다', () => {
  const track = new BusTrack({ s: 0, at: T0, info: {} });
  track.update({ s: 600, at: T0 + 30_000, info: {} }); // 20m/s
  assert.equal(track.target(T0 + 30_000 + 600_000), 600 + 400);
});
