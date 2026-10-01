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
  const now = run(track, T0, 10);
  assert.ok(track.s > DEFAULT_SPEED * 5, `정지해 있지 않다 (s=${track.s})`);
  assert.ok(track.s <= track.target(now + 8000), '예측 범위를 넘지 않는다');
});

test('새 관측이 예측보다 크게 앞서도 순간이동하지 않고 서서히 따라잡는다', () => {
  const track = new BusTrack({ s: 0, at: T0, info: {} });
  track.update({ s: 300, at: T0 + 30_000, info: {} }); // 10m/s
  let now = run(track, T0 + 30_000, 5);
  track.update({ s: 900, at: T0 + 40_000, info: {} }); // 예상보다 훨씬 앞에서 관측됨
  const before = track.s;
  now = run(track, now, 0.5);
  assert.ok(track.s - before < 20, `0.5초 동안 ${(track.s - before).toFixed(1)}m 이동 (튀지 않음)`);
  run(track, now, 60);
  assert.ok(track.s > 900, `결국 따라잡는다 (s=${track.s.toFixed(0)})`);
});

test('같은 관측(위치가 아직 안 바뀜)이 다시 와도 멈추지 않는다', () => {
  const track = new BusTrack({ s: 0, at: T0, info: {} });
  track.update({ s: 300, at: T0 + 30_000, info: {} });
  const speed = track.speed;
  track.update({ s: 300, at: T0 + 30_000, info: {} }); // 서버가 처음 본 시각을 유지해 보냄
  assert.equal(track.speed, speed);
  const before = track.s;
  run(track, T0 + 50_000, 5);
  assert.ok(track.s > before);
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

test('내 정류장은 실제로 지나간 게 확인될 때까지 예측만으로 지나가지 않는다', () => {
  const track = new BusTrack({ s: 0, at: T0, info: {} });
  track.update({ s: 300, at: T0 + 30_000, info: {} }); // 10m/s
  track.holdAt = 400;
  run(track, T0 + 30_000, 60);
  assert.ok(track.s <= 400, `정류장에서 기다림 (s=${track.s.toFixed(0)})`);
  track.update({ s: 450, at: T0 + 90_000, info: {} }); // 정류장을 지난 관측
  run(track, T0 + 90_000, 10);
  assert.ok(track.s > 450, '지난 게 확인되면 다시 달린다');
});

test('크게 어긋나면 따라가지 않고 바로 옮긴다', () => {
  const track = new BusTrack({ s: 0, at: T0, info: {} });
  track.update({ s: 4000, at: T0 + 30_000, info: {} });
  assert.equal(track.s, 4000);
});

test('예측은 마지막 관측 위치보다 최대 600m까지만 앞서 간다', () => {
  const track = new BusTrack({ s: 0, at: T0, info: {} });
  track.update({ s: 600, at: T0 + 30_000, info: {} }); // 20m/s
  assert.equal(track.target(T0 + 30_000 + 600_000), 600 + 600);
});
