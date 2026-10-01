import { createPolyline, locateStops, pointAt, project } from './geometry.js';
import { BusTrack, DEFAULT_SPEED } from './tracker.js';

// server/lib/query.js와 같은 규칙: "10번 버스" → "10"
const normalizeRouteQuery = (value) => value.replace(/\s+/g, '').replace(/(번버스|번|버스)$/, '');

const KOREA_CENTER = [36.4, 127.8];
const OFF_ROUTE_METERS = 500; // 경로에서 이보다 멀리 떨어진 GPS는 잘못된 값으로 보고 표시하지 않는다
const WINDOW_MARGIN = 300;
const HIDDEN_DISCONNECT_MS = 60_000; // 탭이 이만큼 가려져 있으면 연결을 끊어 API 호출을 아낀다

const $ = (id) => document.getElementById(id);
const ui = {
  panel: $('panel'),
  collapse: $('collapse'),
  form: $('search-form'),
  region: $('region'),
  query: $('query'),
  searchMessage: $('search-message'),
  results: $('results'),
  card: $('route-card'),
  number: $('route-number'),
  type: $('route-type'),
  ends: $('route-ends'),
  busCount: $('bus-count'),
  lastUpdate: $('last-update'),
  progress: $('progress-bar'),
  liveMessage: $('live-message'),
  liveDot: $('live-dot'),
  pathNote: $('path-note'),
  showRaw: $('show-raw'),
};

const state = {
  route: null, // { regionId, id, number, type, start, end }
  line: null,
  stopS: new Map(), // 정류장 순번 → 경로 위 거리
  stopsByOrd: new Map(),
  tracks: new Map(), // 버스 ID → { track, marker, arrow, raw }
  source: null,
  hiddenTimer: null,
  receivedAt: 0,
  pollMs: 0,
};

// ── 지도 ──
const map = L.map('map', { zoomControl: false }).setView(KOREA_CENTER, 7);
L.control.zoom({ position: 'topright' }).addTo(map);
// OpenStreetMap 기본 타일은 키 없이 무료로 쓸 수 있다. 다크 모드는 CSS 필터로 어둡게 바꾼다.
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · 버스 데이터: 공공데이터포털',
}).addTo(map);

const routeLayer = L.layerGroup().addTo(map);
const busLayer = L.layerGroup().addTo(map);
const rawLayer = L.layerGroup();

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// ── 공통 ──
async function getJson(url) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `요청 실패 (${res.status})`);
  return body;
}

const escapeHtml = (text) =>
  String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function setMessage(el, text, isError = false) {
  el.textContent = text;
  el.classList.toggle('error', isError);
}

// ── 지역 목록 ──
async function loadRegions() {
  try {
    const regions = await getJson('/api/regions');
    const groups = new Map();
    for (const r of regions) {
      if (!groups.has(r.group)) groups.set(r.group, []);
      groups.get(r.group).push(r);
    }
    ui.region.replaceChildren(
      ...[...groups].map(([label, items]) => {
        const group = document.createElement('optgroup');
        group.label = label;
        group.append(...items.map((r) => new Option(r.name, r.id)));
        return group;
      }),
    );
  } catch (err) {
    // 전국 목록을 못 받아도 서울은 쓸 수 있다.
    setMessage(ui.searchMessage, `전국 지역 목록을 불러오지 못했습니다. (${err.message})`, true);
  }
}

// ── 노선 검색 ──
async function search(event) {
  event.preventDefault();
  const query = ui.query.value.trim();
  if (!query) return;
  const button = ui.form.querySelector('button');
  button.disabled = true;
  setMessage(ui.searchMessage, '검색 중…');
  ui.results.replaceChildren();

  try {
    const regionId = ui.region.value;
    const routes = await getJson(`/api/routes?region=${encodeURIComponent(regionId)}&q=${encodeURIComponent(query)}`);
    ui.results.replaceChildren(
      ...routes.map((route) => {
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.dataset.routeId = route.id;
        btn.innerHTML = `<span class="num">${escapeHtml(route.number)}</span>${escapeHtml(route.type ?? '')}
          <span class="ends">${escapeHtml(route.start)} ↔ ${escapeHtml(route.end)}</span>`;
        btn.addEventListener('click', () => selectRoute({ regionId, ...route }));
        li.append(btn);
        return li;
      }),
    );

    // 결과가 하나뿐이거나 입력한 번호와 정확히 같은 노선이 하나면 클릭 없이 바로 보여준다.
    const number = normalizeRouteQuery(query);
    const exact = routes.filter((route) => route.number === number);
    const best = routes.length === 1 ? routes[0] : exact.length === 1 ? exact[0] : null;
    if (!routes.length) setMessage(ui.searchMessage, '검색 결과가 없습니다. 노선 번호만 입력해 보세요. (예: 10, 11-1)');
    else if (best) selectRoute({ regionId, ...best });
    else setMessage(ui.searchMessage, `${routes.length}개 노선을 찾았습니다. 볼 노선을 눌러주세요.`);
  } catch (err) {
    setMessage(ui.searchMessage, err.message, true);
  } finally {
    button.disabled = false;
  }
}

// ── 노선 선택 ──
async function selectRoute(route) {
  disconnect();
  clearBuses();
  routeLayer.clearLayers();
  // 다른 노선으로 바로 바꿔볼 수 있도록 검색 결과는 남겨두고 선택한 노선만 표시한다.
  for (const btn of ui.results.querySelectorAll('button')) {
    btn.classList.toggle('active', btn.dataset.routeId === route.id);
  }
  setMessage(ui.searchMessage, '노선 정보를 불러오는 중…');

  let detail;
  try {
    detail = await getJson(`/api/routes/${encodeURIComponent(route.regionId)}/${encodeURIComponent(route.id)}`);
  } catch (err) {
    setMessage(ui.searchMessage, err.message, true);
    return;
  }
  setMessage(ui.searchMessage, '');

  state.route = { ...route, number: route.number ?? detail.number };
  const path = detail.path.length >= 2 ? detail.path : detail.stops.map((s) => [s.lat, s.lng]);
  state.line = createPolyline(path);
  const stopDistances = locateStops(state.line, detail.stops);
  state.stopS = new Map(detail.stops.map((stop, i) => [stop.ord, stopDistances[i]]));
  state.stopsByOrd = new Map(detail.stops.map((stop) => [stop.ord, stop]));

  const polyline = L.polyline(state.line.latlngs, { color: css('--route'), weight: 5, opacity: 0.75 }).addTo(routeLayer);
  for (const stop of detail.stops) {
    L.circleMarker([stop.lat, stop.lng], {
      radius: 4,
      color: css('--route'),
      weight: 2,
      fillColor: css('--surface'),
      fillOpacity: 1,
    })
      .bindTooltip(stop.name, { direction: 'top', offset: [0, -4] })
      .addTo(routeLayer);
  }
  // 패널이 가리는 영역(데스크톱은 왼쪽, 모바일은 아래쪽)을 피해서 노선 전체가 보이게 한다.
  const mobile = matchMedia('(max-width: 640px)').matches;
  const panelSize = mobile ? [0, ui.panel.offsetHeight] : [ui.panel.offsetWidth + 16, 0];
  map.fitBounds(polyline.getBounds(), {
    paddingTopLeft: [mobile ? 24 : panelSize[0] + 24, 24],
    paddingBottomRight: [24, mobile ? panelSize[1] + 24 : 24],
  });

  ui.card.hidden = false;
  ui.number.textContent = state.route.number ?? '';
  ui.type.textContent = state.route.type ?? '';
  ui.ends.textContent = route.start && route.end ? `${route.start} ↔ ${route.end}` : '';
  const pathNotes = {
    osm: '이 지역은 공식 도로 경로가 없어 OpenStreetMap 도로를 따라 추정한 경로로 표시합니다.',
    stops: '이 지역은 도로 경로 데이터가 없어 정류장을 이은 선으로 표시합니다.',
  };
  ui.pathNote.textContent = pathNotes[detail.pathSource] ?? '';
  ui.pathNote.hidden = !pathNotes[detail.pathSource];
  ui.busCount.textContent = '-';
  ui.lastUpdate.textContent = '-';

  const params = new URLSearchParams({ region: route.regionId, route: route.id });
  if (state.route.number) params.set('no', state.route.number);
  history.replaceState(null, '', `?${params}`);
  document.title = `${state.route.number ?? ''} 버스 지금 어디`;

  connect();
}

// ── 실시간 연결 (SSE) ──
function connect() {
  if (!state.route || state.source) return;
  const { regionId, id } = state.route;
  setLive('warn', '실시간 위치에 연결하는 중…');
  const source = new EventSource(`/api/live?region=${encodeURIComponent(regionId)}&route=${encodeURIComponent(id)}`);
  source.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'positions') onPositions(message);
    else if (message.type === 'error') setLive('error', message.message);
  };
  source.onerror = () => setLive('warn', '연결이 끊겨 다시 연결하는 중…');
  state.source = source;
}

function disconnect() {
  state.source?.close();
  state.source = null;
}

function setLive(level, text) {
  ui.liveDot.className = `live-dot ${level}`;
  setMessage(ui.liveMessage, text, level === 'error');
}

// 버스 GPS → 경로 위 거리. 정류장 순번으로 찾을 구간을 좁혀 왕복 노선에서도 올바른 방향에 붙인다.
function locateBus(bus) {
  const { line, stopS } = state;
  let minS = 0;
  let maxS = line.length;
  if (bus.stopOrd && stopS.has(bus.stopOrd)) {
    minS = (stopS.get(bus.stopOrd - 1) ?? stopS.get(bus.stopOrd)) - WINDOW_MARGIN;
    maxS = (stopS.get(bus.stopOrd + 1) ?? line.length) + WINDOW_MARGIN;
  }
  let hit = project(line, bus.lat, bus.lng, minS, maxS);
  if (hit.distance > OFF_ROUTE_METERS) hit = project(line, bus.lat, bus.lng);
  return hit.distance <= OFF_ROUTE_METERS ? hit.s : null;
}

function onPositions(message) {
  if (!state.line) return;
  // 서버 시계와 브라우저 시계 차이를 보정해 관측 시각을 브라우저 기준으로 바꾼다.
  const clockOffset = Date.now() - message.fetchedAt;
  state.receivedAt = Date.now();
  state.pollMs = message.pollMs;

  const seen = new Set();
  rawLayer.clearLayers();
  for (const bus of message.buses) {
    if (!Number.isFinite(bus.lat) || !Number.isFinite(bus.lng) || !bus.lat) continue;
    rawLayer.addLayer(
      L.circleMarker([bus.lat, bus.lng], { radius: 5, color: css('--raw'), weight: 2, fill: false }),
    );
    const s = locateBus(bus);
    if (s == null) continue;

    seen.add(bus.id);
    const observation = { s, at: bus.observedAt + clockOffset, info: bus };
    const entry = state.tracks.get(bus.id);
    if (entry) entry.track.update(observation);
    else addBus(bus.id, new BusTrack(observation));
  }

  for (const [id, entry] of state.tracks) {
    if (!seen.has(id)) {
      busLayer.removeLayer(entry.marker);
      state.tracks.delete(id);
    }
  }

  ui.busCount.textContent = `${seen.size}대`;
  setLive('ok', seen.size ? '' : '지금 운행 중인 버스가 없습니다.');
}

function addBus(id, track) {
  const { info } = track;
  // 지도에는 노선 번호를, 차량번호는 클릭했을 때 팝업으로 보여준다.
  const label = state.route.number ?? '';
  const icon = L.divIcon({
    className: 'bus-icon',
    html: `<div class="bus${info.lowFloor ? ' low-floor' : ''}"><div class="bus-arrow"></div><span class="bus-label">${escapeHtml(label)}</span></div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
  const start = pointAt(state.line, track.s);
  const marker = L.marker([start.lat, start.lng], { icon, keyboard: false, title: info.plate })
    .bindPopup(() => busPopup(track))
    .addTo(busLayer);
  state.tracks.set(id, { track, marker, arrow: marker.getElement()?.querySelector('.bus-arrow') });
}

function busPopup(track) {
  const { info } = track;
  const lastStop = state.stopsByOrd.get(info.stopOrd);
  const speedText = track.measured ? `${Math.round(track.speed * 3.6)} km/h` : `측정 중 (기본 ${Math.round(DEFAULT_SPEED * 3.6)} km/h로 예측)`;
  const rows = [
    `<div class="popup-title">${escapeHtml(state.route.number ?? '')}번 버스</div>`,
    `차량번호: ${escapeHtml(info.plate)}`,
    lastStop ? `최근 정류장: ${escapeHtml(lastStop.name)}` : null,
    `추정 속도: ${speedText}`,
    info.lowFloor ? '저상버스' : null,
    info.congestion ? `혼잡도: ${escapeHtml(info.congestion)}` : null,
  ];
  return rows.filter(Boolean).join('<br>');
}

function clearBuses() {
  busLayer.clearLayers();
  rawLayer.clearLayers();
  state.tracks.clear();
}

// ── 애니메이션 루프 ──
let lastFrame = performance.now();
function frame(time) {
  const dt = Math.min(0.25, (time - lastFrame) / 1000);
  lastFrame = time;
  if (state.line) {
    const now = Date.now();
    for (const entry of state.tracks.values()) {
      const p = pointAt(state.line, entry.track.step(now, dt));
      entry.marker.setLatLng([p.lat, p.lng]);
      entry.arrow ??= entry.marker.getElement()?.querySelector('.bus-arrow');
      entry.arrow?.style.setProperty('--bearing', `${p.bearing}deg`);
    }
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// 마지막 수신 시각과 다음 수신까지의 진행 막대
setInterval(() => {
  if (!state.receivedAt) return;
  const elapsed = Date.now() - state.receivedAt;
  ui.lastUpdate.textContent = `${Math.floor(elapsed / 1000)}초 전`;
  ui.progress.style.width = `${Math.min(100, (elapsed / state.pollMs) * 100)}%`;
}, 250);

// ── 이벤트 ──
ui.form.addEventListener('submit', search);

ui.showRaw.addEventListener('change', () => {
  if (ui.showRaw.checked) rawLayer.addTo(map);
  else rawLayer.remove();
});

ui.collapse.addEventListener('click', () => {
  const collapsed = ui.panel.classList.toggle('collapsed');
  ui.collapse.textContent = collapsed ? '펼치기' : '접기';
  ui.collapse.setAttribute('aria-expanded', String(!collapsed));
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    state.hiddenTimer = setTimeout(() => {
      disconnect();
      setLive('warn', '화면이 가려져 있어 업데이트를 잠시 멈췄습니다.');
    }, HIDDEN_DISCONNECT_MS);
  } else {
    clearTimeout(state.hiddenTimer);
    connect();
  }
});

// ── 시작 ──
await loadRegions();
const params = new URLSearchParams(location.search);
if (params.get('region') && params.get('route')) {
  const regionId = params.get('region');
  if ([...ui.region.options].some((o) => o.value === regionId)) ui.region.value = regionId;
  if (params.get('no')) ui.query.value = params.get('no');
  selectRoute({ regionId, id: params.get('route'), number: params.get('no') });
}
