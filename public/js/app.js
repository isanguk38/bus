import * as api from './api.js';
import { approachingBuses, formatDistance, formatDuration, routeSpeed, walkingMinutes } from './eta.js';
import { createPolyline, locateStops, pointAt, project, slicePath } from './geometry.js';
import { BusTrack, DEFAULT_SPEED } from './tracker.js';

const KOREA_CENTER = [36.4, 127.8];
const OFF_ROUTE_METERS = 500; // 경로에서 이보다 멀리 떨어진 GPS는 잘못된 값으로 보고 표시하지 않는다
const WINDOW_MARGIN = 300;
const HIDDEN_DISCONNECT_MS = 60_000; // 탭이 이만큼 가려져 있으면 연결을 끊어 API 호출을 아낀다
const NEARBY_COUNT = 8; // "내 주변 정류장 보기"에 보여줄 정류장 수
const SOON_SECONDS = 180;
const PASSED_VISIBLE_METERS = 400; // 내 정류장을 지난 버스를 이 거리까지는 흐리게 계속 보여준다

// server/lib/query.js와 같은 규칙: "10번 버스" → "10"
const normalizeRouteQuery = (value) => value.replace(/\s+/g, '').replace(/(번버스|번|버스)$/, '');

const $ = (id) => document.getElementById(id);
const ui = {
  panel: $('panel'),
  panelBody: $('panel-body'),
  back: $('back'),
  title: $('panel-title'),
  collapse: $('collapse'),
  // 노선 검색
  form: $('search-form'),
  region: $('region'),
  detectRegion: $('detect-region'),
  query: $('query'),
  searchMessage: $('search-message'),
  results: $('results'),
  // 노선 화면
  viewSearch: $('view-search'),
  viewRoute: $('view-route'),
  number: $('route-number'),
  type: $('route-type'),
  ends: $('route-ends'),
  legend: $('route-legend'),
  mystop: $('mystop'),
  mystopName: $('mystop-name'),
  mystopDirection: $('mystop-direction'),
  approachList: $('approach-list'),
  showAllBuses: $('show-all-buses'),
  changeStop: $('change-stop'),
  // 탈 곳 정하기
  board: $('board'),
  boardNearby: $('board-nearby'),
  boardForm: $('board-form'),
  boardQuery: $('board-query'),
  boardMessage: $('board-message'),
  boardResults: $('board-results'),
  // 실시간 상태
  busCount: $('bus-count'),
  lastUpdate: $('last-update'),
  progress: $('progress-bar'),
  liveMessage: $('live-message'),
  liveDot: $('live-dot'),
  pathNote: $('path-note'),
  showRaw: $('show-raw'),
};

const state = {
  view: 'search',
  me: null, // 기준 위치: GPS { lat, lng, accuracy } 또는 검색한 장소 { lat, lng, label }
  routeToken: 0,
  route: null,
  line: null,
  stops: [], // 노선 정류장 + 경로 위 거리 s
  stopSByOrd: new Map(),
  stopsByOrd: new Map(),
  stopSorted: [],
  segments: [], // 방향별 경로 구간 [{ direction, from, to }]
  colorOf: new Map(), // 방향 → 색
  segmentLines: [],
  stopMarkers: [],
  myStop: null,
  focusPending: false,
  tracks: new Map(), // 버스 ID → { id, track, marker, arrow, root }
  source: null,
  hiddenTimer: null,
  receivedAt: 0,
  pollMs: 0,
};

// ── 공통 도구 ──
const escapeHtml = (text) =>
  String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function setMessage(el, text, isError = false) {
  el.textContent = text;
  el.classList.toggle('error', isError);
}

function routeTypeClass(type) {
  if (!type) return '';
  if (/간선/.test(type)) return 't-trunk';
  if (/광역|직행|좌석|급행|공항/.test(type)) return 't-express';
  if (/순환/.test(type)) return 't-circular';
  if (/지선|마을|일반/.test(type)) return 't-branch';
  return '';
}

function updateUrl(params, title) {
  const entries = Object.entries(params ?? {}).filter(([, v]) => v != null && v !== '');
  history.replaceState(null, '', entries.length ? `?${new URLSearchParams(entries)}` : location.pathname);
  document.title = title ? `${title} · 버스 지금 어디` : '버스 지금 어디';
}

// ── 지도 ──
// 서버에 브이월드 키가 설정되어 있으면 브이월드 지도를, 아니면 OpenStreetMap을 쓴다.
const appConfig = await api.config().catch(() => ({ tiles: null, placeSearch: false }));
const darkMode = matchMedia('(prefers-color-scheme: dark)').matches;
const map = L.map('map', { zoomControl: false }).setView(KOREA_CENTER, 7);
L.control.zoom({ position: 'topright' }).addTo(map);
const DATA_CREDIT = '버스 데이터: 공공데이터포털';
if (appConfig.tiles) {
  const { light, dark, attribution, minZoom, maxZoom } = appConfig.tiles;
  document.documentElement.classList.add('native-dark-tiles');
  L.tileLayer(darkMode ? dark : light, { minZoom, maxZoom, attribution: `${attribution} · ${DATA_CREDIT}` }).addTo(map);
} else {
  // OpenStreetMap 기본 타일은 키 없이 무료로 쓸 수 있다. 다크 모드는 CSS 필터로 어둡게 바꾼다.
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: `&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · ${DATA_CREDIT}`,
  }).addTo(map);
}

// 장소 검색(카카오·브이월드)이 켜져 있으면 상가·건물 이름으로도 찾을 수 있다고 안내한다.
if (appConfig.placeSearch) ui.boardQuery.placeholder = '정류장·상가·건물 이름으로 찾기';

const LocateControl = L.Control.extend({
  options: { position: 'topright' },
  onAdd() {
    const box = L.DomUtil.create('div', 'leaflet-bar locate-control');
    const link = L.DomUtil.create('a', '', box);
    link.href = '#';
    link.role = 'button';
    link.title = '내 위치';
    link.setAttribute('aria-label', '내 위치로 이동');
    link.textContent = '◎';
    L.DomEvent.disableClickPropagation(box);
    L.DomEvent.on(link, 'click', (e) => {
      L.DomEvent.preventDefault(e);
      onLocateButton();
    });
    return box;
  },
});
new LocateControl().addTo(map);

const meLayer = L.layerGroup().addTo(map);
const routeLayer = L.layerGroup().addTo(map);
const myStopLayer = L.layerGroup().addTo(map);
const busLayer = L.layerGroup().addTo(map);
const rawLayer = L.layerGroup();

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// 패널이 가리는 영역(데스크톱은 왼쪽, 모바일은 아래쪽)을 피해서 보이게 맞춘다.
function fitTo(points, maxZoom = 17) {
  const bounds = L.latLngBounds(points);
  if (!bounds.isValid()) return;
  const mobile = matchMedia('(max-width: 640px)').matches;
  const collapsed = ui.panel.classList.contains('collapsed');
  const panelW = mobile || collapsed ? 0 : ui.panel.offsetWidth + 16;
  const panelH = mobile && !collapsed ? ui.panel.offsetHeight : 0;
  map.fitBounds(bounds, {
    paddingTopLeft: [panelW + 32, 40],
    paddingBottomRight: [56, panelH + 40],
    maxZoom,
  });
}

// ── 화면 전환 (노선 검색 ↔ 노선 지도) ──
function showSearch() {
  if (state.view === 'route') closeRoute();
  state.view = 'search';
  ui.viewSearch.hidden = false;
  ui.viewRoute.hidden = true;
  ui.back.hidden = true;
  ui.title.innerHTML = '<span aria-hidden="true">🚌</span> 버스 지금 어디';
  updateUrl(null);
  expandPanel();
}

function showRoute() {
  state.view = 'route';
  ui.viewSearch.hidden = true;
  ui.viewRoute.hidden = false;
  ui.back.hidden = false;
  ui.title.textContent = '실시간 버스 위치';
  ui.panelBody.scrollTop = 0;
  expandPanel();
}

function expandPanel() {
  ui.panel.classList.remove('collapsed');
  ui.collapse.textContent = '접기';
  ui.collapse.setAttribute('aria-expanded', 'true');
}

// ── 내 위치 ──
function locate() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('이 브라우저는 위치 기능을 지원하지 않아요.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy }),
      (err) =>
        reject(
          new Error(
            err.code === err.PERMISSION_DENIED
              ? '위치 권한이 꺼져 있어요. 브라우저 주소창의 자물쇠 아이콘에서 위치를 허용해 주세요.'
              : '현재 위치를 확인하지 못했어요. 잠시 후 다시 시도해 주세요.',
          ),
        ),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 30_000 },
    );
  });
}

function setMe(me) {
  state.me = me;
  meLayer.clearLayers();
  if (me.label) {
    // 검색으로 고른 장소
    L.marker([me.lat, me.lng], {
      icon: L.divIcon({
        className: 'map-icon',
        html: `<div class="origin-pin"><span>${escapeHtml(me.label)}</span></div>`,
        iconSize: [16, 16],
        iconAnchor: [8, 8],
      }),
      keyboard: false,
      interactive: false,
      zIndexOffset: 500,
    }).addTo(meLayer);
    return;
  }
  if (me.accuracy && me.accuracy < 500) {
    L.circle([me.lat, me.lng], { radius: me.accuracy, color: css('--me'), weight: 1, fillOpacity: 0.08, interactive: false }).addTo(meLayer);
  }
  L.marker([me.lat, me.lng], {
    icon: L.divIcon({ className: 'map-icon', html: '<div class="me-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }),
    keyboard: false,
    interactive: false,
    zIndexOffset: 500,
  }).addTo(meLayer);
}

// 지도의 ◎ 버튼: 노선 화면에서는 내 주변 정류장 목록, 검색 화면에서는 지역 자동 선택
async function onLocateButton() {
  if (state.view === 'route' && state.line) {
    showNearbyStops();
    return;
  }
  try {
    const me = await locate();
    setMe(me);
    map.setView([me.lat, me.lng], Math.max(map.getZoom(), 15));
    detectRegion(me);
  } catch (err) {
    setMessage(ui.searchMessage, err.message, true);
  }
}

// 위치로 지역을 알아내 노선 검색의 지역 선택을 맞춘다.
async function detectRegion(me, { announce = false } = {}) {
  try {
    const [nearest] = await api.nearby(me.lat, me.lng);
    if (!nearest) return;
    setRegion(nearest.region);
    if (announce) setMessage(ui.searchMessage, `지역을 ${ui.region.selectedOptions[0]?.text ?? ''}(으)로 맞췄어요. 노선 번호를 검색하세요.`);
  } catch {
    // 지역 자동 선택은 편의 기능이라 실패해도 무시
  }
}

function setRegion(regionId) {
  if ([...ui.region.options].some((o) => o.value === regionId)) ui.region.value = regionId;
}

// ── 지역 목록 ──
async function loadRegions() {
  try {
    const regions = await api.regions();
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
  ui.query.blur(); // 모바일에서 키보드를 내려 결과가 보이게 한다
  const button = ui.form.querySelector('button[type="submit"]');
  button.disabled = true;
  setMessage(ui.searchMessage, '검색 중…');
  ui.results.replaceChildren();

  try {
    const regionId = ui.region.value;
    const routes = await api.searchRoutes(regionId, query);
    ui.results.replaceChildren(
      ...routes.map((route) => {
        const li = document.createElement('li');
        li.innerHTML = `<button type="button" class="item">
          <span class="route-badge ${routeTypeClass(route.type)}">${escapeHtml(route.number)}</span>
          <span class="body"><span class="title">${escapeHtml(route.type ?? '')}</span>
          <span class="meta">${escapeHtml(route.start)} ↔ ${escapeHtml(route.end)}</span></span>
          <span class="chev" aria-hidden="true">›</span>
        </button>`;
        li.querySelector('button').addEventListener('click', () => openRoute({ regionId, ...route }));
        return li;
      }),
    );

    // 결과가 하나뿐이거나 입력한 번호와 정확히 같은 노선이 하나면 클릭 없이 바로 보여준다.
    const number = normalizeRouteQuery(query);
    const exact = routes.filter((route) => route.number === number);
    const best = routes.length === 1 ? routes[0] : exact.length === 1 ? exact[0] : null;
    if (!routes.length) {
      setMessage(ui.searchMessage, '검색 결과가 없어요. 지역이 맞는지, 노선 번호만 입력했는지 확인해 주세요. (예: 10, 11-1)');
    } else if (best) {
      setMessage(ui.searchMessage, '');
      openRoute({ regionId, ...best });
    } else {
      setMessage(ui.searchMessage, `${routes.length}개 노선을 찾았어요. 볼 노선을 눌러주세요.`);
    }
  } catch (err) {
    setMessage(ui.searchMessage, err.message, true);
  } finally {
    button.disabled = false;
  }
}

// ── 노선 실시간 화면 ──
async function openRoute(route, { stopId = null } = {}) {
  if (state.view === 'route') closeRoute();
  showRoute();
  const token = ++state.routeToken;

  ui.number.textContent = route.number ?? '';
  ui.number.className = `route-badge ${routeTypeClass(route.type)}`;
  ui.type.textContent = route.type ?? '';
  ui.ends.textContent = route.start && route.end ? `${route.start} ↔ ${route.end}` : '';
  ui.pathNote.hidden = true;
  setLive('warn', '노선 정보를 불러오는 중… (처음 여는 노선은 몇 초 걸릴 수 있어요)');

  let detail;
  try {
    detail = await api.route(route.regionId, route.id);
  } catch (err) {
    if (token === state.routeToken) setLive('error', err.message);
    return;
  }
  if (token !== state.routeToken) return; // 그사이 다른 화면으로 이동함

  state.route = { ...route, number: route.number ?? detail.number, type: route.type ?? detail.type };
  ui.number.textContent = state.route.number ?? '';
  ui.number.className = `route-badge ${routeTypeClass(state.route.type)}`;
  ui.type.textContent = state.route.type ?? '';

  const path = detail.path.length >= 2 ? detail.path : detail.stops.map((s) => [s.lat, s.lng]);
  state.line = createPolyline(path);
  const distances = locateStops(state.line, detail.stops);
  state.stops = detail.stops.map((stop, i) => ({ ...stop, s: distances[i] }));
  state.stopSByOrd = new Map(state.stops.map((stop) => [stop.ord, stop.s]));
  state.stopsByOrd = new Map(state.stops.map((stop) => [stop.ord, stop]));
  state.stopSorted = [...distances].sort((a, b) => a - b);

  // 방향(가는 길 / 오는 길)마다 선과 버스 색을 다르게 그린다.
  const segments = directionSegments(state.stops, state.line.length);
  const colorOf = new Map(segments.map((seg, i) => [seg.direction, css(`--dir-${(i % 3) + 1}`)]));
  state.segments = segments;
  state.colorOf = colorOf;
  state.segmentLines = segments.map((seg) =>
    L.polyline(slicePath(state.line, seg.from, seg.to), { color: colorOf.get(seg.direction), weight: 5, opacity: 0.85 })
      .addTo(routeLayer),
  );
  renderLegend(segments, colorOf);
  state.stopMarkers = state.stops.map((stop) => ({
    stop,
    marker: L.circleMarker([stop.lat, stop.lng], {
      radius: 6,
      color: colorOf.get(stop.direction ?? null) ?? css('--route'),
      weight: 2,
      fillColor: css('--surface'),
      fillOpacity: 1,
    })
      .bindTooltip(stop.name, { direction: 'top', offset: [0, -6] })
      .bindPopup(() => stopPopup(stop))
      .addTo(routeLayer),
  }));

  const pathNotes = {
    osm: '이 지역은 공식 도로 경로가 없어 OpenStreetMap 도로를 따라 추정한 경로로 표시합니다.',
    stops: '이 지역은 도로 경로 데이터가 없어 정류장을 이은 선으로 표시합니다.',
  };
  ui.pathNote.textContent = pathNotes[detail.pathSource] ?? '';
  ui.pathNote.hidden = !pathNotes[detail.pathSource];

  const linked = stopId && state.stops.find((s) => s.id === stopId);
  if (linked) {
    setMyStop(linked, { focus: true });
  } else {
    fitTo(state.line.latlngs, 16);
    // 위치를 이미 알고 있으면 가까운 탑승 후보를 바로 목록으로 보여준다 (선택은 사용자가).
    if (state.me) listNearbyStops(state.me, state.me.label ? `'${state.me.label}'` : '내 위치');
  }

  updateRouteUrl();
  connect();
}

function updateRouteUrl() {
  const { route, myStop } = state;
  updateUrl(
    { region: route.regionId, route: route.id, no: route.number, stop: myStop?.id },
    route.number ? `${route.number}번` : null,
  );
}

function closeRoute() {
  state.routeToken += 1;
  disconnect();
  clearBuses();
  routeLayer.clearLayers();
  myStopLayer.clearLayers();
  Object.assign(state, {
    route: null,
    line: null,
    stops: [],
    stopSorted: [],
    segments: [],
    colorOf: new Map(),
    segmentLines: [],
    stopMarkers: [],
    myStop: null,
    receivedAt: 0,
    focusPending: false,
  });
  ui.mystop.hidden = true;
  ui.board.hidden = false;
  ui.legend.hidden = true;
  ui.showAllBuses.checked = false;
  clearBoardResults();
  ui.boardQuery.value = '';
  ui.busCount.textContent = '-';
  ui.lastUpdate.textContent = '-';
  ui.progress.style.width = '0';
  setLive('', '');
}

// 정류장 순서대로 방향 라벨이 바뀌는 지점에서 경로를 나눈다. 방향 정보가 없으면 한 덩어리.
function directionSegments(stops, length) {
  const segments = [];
  for (const stop of stops) {
    const direction = stop.direction ?? null;
    const last = segments.at(-1);
    if (last && last.direction === direction) continue;
    if (last) last.to = stop.s;
    segments.push({ direction, from: last ? stop.s : 0, to: length });
  }
  return segments.length ? segments : [{ direction: null, from: 0, to: length }];
}

// 경로 위 거리 s가 속한 방향 구간
function segmentIndexAt(s) {
  const i = state.segments.findIndex((seg) => s < seg.to);
  return i === -1 ? state.segments.length - 1 : i;
}

const directionColorAt = (s) => state.colorOf.get(state.segments[segmentIndexAt(s)].direction);

function renderLegend(segments, colorOf) {
  const labeled = [...new Set(segments.map((s) => s.direction).filter(Boolean))];
  ui.legend.innerHTML = labeled
    .map((dir) => `<span><i style="background:${colorOf.get(dir)}"></i>${escapeHtml(dir)}</span>`)
    .join('');
  ui.legend.hidden = labeled.length < 2;
}

// 내 정류장을 정하면 그 방향의 선·정류장만 진하게, 반대 방향은 흐리게 보여준다.
function applyDirectionFocus() {
  const focus = state.myStop ? segmentIndexAt(state.myStop.s) : null;
  const focusDirection = focus == null ? undefined : state.segments[focus].direction;
  state.segmentLines.forEach((line, i) => line.setStyle({ opacity: focus == null || i === focus ? 0.85 : 0.15 }));
  for (const { stop, marker } of state.stopMarkers) {
    const visible = focus == null || (stop.direction ?? null) === focusDirection;
    marker.setStyle({ opacity: visible ? 1 : 0.15, fillOpacity: visible ? 1 : 0.15 });
  }
}

function stopPopup(stop) {
  const el = document.createElement('div');
  el.innerHTML = `<div class="popup-title">${escapeHtml(stop.name)}</div>
    ${stop.no ? `<div>정류장 번호 ${escapeHtml(stop.no)}</div>` : ''}
    ${stop.direction ? `<div>${escapeHtml(stop.direction)}</div>` : ''}`;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'popup-btn';
  const isMine = state.myStop?.id === stop.id && state.myStop?.ord === stop.ord;
  button.textContent = isMine ? '✓ 내 정류장' : '여기서 탈래요';
  button.disabled = isMine;
  button.addEventListener('click', () => {
    map.closePopup();
    setMyStop(stop, { focus: true });
  });
  el.append(button);
  return el;
}

// ── 탈 곳 정하기 ──
function openBoard() {
  ui.board.hidden = false;
  ui.mystop.hidden = Boolean(!state.myStop);
  ui.board.scrollIntoView({ block: 'nearest' });
}

function clearBoardResults() {
  ui.boardResults.replaceChildren();
  setMessage(ui.boardMessage, '');
}

function boardItem(icon, title, meta, onClick, extraClass = '') {
  const li = document.createElement('li');
  li.innerHTML = `<button type="button" class="item ${extraClass}">
    <span class="icon" aria-hidden="true">${icon}</span>
    <span class="body"><span class="title">${escapeHtml(title)}</span>${meta ? `<span class="meta">${escapeHtml(meta)}</span>` : ''}</span>
    <span class="chev" aria-hidden="true">›</span>
  </button>`;
  li.querySelector('button').addEventListener('click', onClick);
  return li;
}

function groupLabel(text) {
  const li = document.createElement('li');
  li.className = 'group-label';
  li.textContent = text;
  return li;
}

// 이 노선의 정류장 중 기준 위치에서 가까운 순서. 같은 정류장이 두 번 서는 노선은 방면으로 구분된다.
function stopsNear(origin) {
  const here = L.latLng(origin.lat, origin.lng);
  return state.stops
    .map((stop) => ({ ...stop, distance: here.distanceTo([stop.lat, stop.lng]) }))
    .sort((a, b) => a.distance - b.distance);
}

function stopMeta(stop) {
  return [
    stop.direction,
    stop.distance != null && `${formatDistance(stop.distance)} · 도보 ${walkingMinutes(stop.distance)}분`,
  ].filter(Boolean).join(' · ');
}

// 기준 위치에서 가까운 이 노선의 정류장을 목록으로 보여주고, 고르면 내 정류장으로 정한다.
function listNearbyStops(origin, label) {
  const nearby = stopsNear(origin).slice(0, NEARBY_COUNT);
  setMessage(
    ui.boardMessage,
    nearby[0].distance > 2000
      ? `${label}에서 이 노선은 꽤 멀리 지나가요. 가장 가까운 정류장이 ${formatDistance(nearby[0].distance)} 떨어져 있어요.`
      : `${label}에서 가까운 이 노선 정류장이에요. 탈 곳을 골라주세요.`,
  );
  ui.boardResults.replaceChildren(
    ...nearby.map((stop, i) =>
      boardItem(i === 0 ? '⭐' : '🚏', `${stop.name}${stop.no ? ` (${stop.no})` : ''}`, stopMeta(stop), () => setMyStop(stop, { focus: true })),
    ),
  );
  // 기준 위치와 가까운 정류장들이 함께 보이도록
  fitTo([[origin.lat, origin.lng], ...nearby.slice(0, 4).map((s) => [s.lat, s.lng])], 17);
}

async function showNearbyStops() {
  openBoard();
  ui.boardNearby.disabled = true;
  ui.boardResults.replaceChildren();
  setMessage(ui.boardMessage, '내 위치를 확인하는 중…');
  try {
    const me = await locate();
    setMe(me);
    listNearbyStops(me, '내 위치');
  } catch (err) {
    // 위치를 못 쓰면 지금 보고 있는 지도 가운데를 기준으로 보여준다.
    const c = map.getCenter();
    setMessage(ui.boardMessage, `${err.message} 대신 지도 가운데 기준으로 보여드려요.`, true);
    const nearby = stopsNear({ lat: c.lat, lng: c.lng }).slice(0, NEARBY_COUNT);
    ui.boardResults.replaceChildren(
      ...nearby.map((stop) => boardItem('🚏', `${stop.name}${stop.no ? ` (${stop.no})` : ''}`, stopMeta(stop), () => setMyStop(stop, { focus: true }))),
    );
  } finally {
    ui.boardNearby.disabled = false;
  }
}

// 이름 검색: 이 노선의 정류장은 바로 고르고, 다른 정류장·장소는 그 근처의 이 노선 정류장 목록으로 이어진다.
async function searchBoarding(event) {
  event.preventDefault();
  const query = ui.boardQuery.value.trim();
  if (query.length < 2) return;
  ui.boardQuery.blur();
  const submit = ui.boardForm.querySelector('button[type="submit"]');
  submit.disabled = true;
  ui.boardResults.replaceChildren();
  setMessage(ui.boardMessage, '찾는 중… (지역에 따라 몇 초 걸릴 수 있어요)');

  try {
    const result = await api.search(state.route.regionId, query, state.me);
    const routeStops = new Map(state.stops.map((s) => [s.id, s]));
    const onRoute = result.stops.filter((s) => routeStops.has(s.id));
    const others = result.stops.filter((s) => !routeStops.has(s.id));
    if (!onRoute.length && !others.length && !result.places.length) {
      setMessage(
        ui.boardMessage,
        appConfig.placeSearch
          ? '검색 결과가 없어요. 다른 이름으로 찾거나 "내 주변 정류장 보기"를 이용해 주세요.'
          : '정류장 이름으로 찾지 못했어요. 이름 일부로 찾거나 "내 주변 정류장 보기"를 이용해 주세요.',
      );
      return;
    }
    setMessage(ui.boardMessage, '');
    const items = [];
    if (onRoute.length) {
      items.push(groupLabel('이 노선이 서는 정류장'));
      for (const s of onRoute) {
        const stop = routeStops.get(s.id);
        items.push(boardItem('⭐', `${stop.name}${stop.no ? ` (${stop.no})` : ''}`, stop.direction, () => setMyStop(stop, { focus: true })));
      }
    }
    const nearHere = (origin) => {
      setMe(origin);
      listNearbyStops(origin, `'${origin.label}'`);
    };
    if (others.length) {
      items.push(groupLabel('다른 정류장 · 누르면 근처의 이 노선 정류장을 보여드려요'));
      for (const s of others) items.push(boardItem('🚏', s.name, s.no && `정류장 번호 ${s.no}`, () => nearHere({ lat: s.lat, lng: s.lng, label: s.name })));
    }
    if (result.places.length) {
      items.push(groupLabel('장소 · 누르면 근처의 이 노선 정류장을 보여드려요'));
      for (const p of result.places) items.push(boardItem('📍', p.name, p.address, () => nearHere({ lat: p.lat, lng: p.lng, label: p.name })));
    }
    ui.boardResults.replaceChildren(...items);
  } catch (err) {
    setMessage(ui.boardMessage, err.message, true);
  } finally {
    submit.disabled = false;
  }
}

function setMyStop(stop, { focus = false } = {}) {
  state.myStop = stop;
  myStopLayer.clearLayers();
  L.marker([stop.lat, stop.lng], {
    icon: L.divIcon({
      className: 'map-icon',
      html: '<div class="mystop-marker"><span>여기서 탑승</span></div>',
      iconSize: [22, 22],
      iconAnchor: [11, 11],
    }),
    zIndexOffset: 300,
    title: stop.name,
  })
    .bindPopup(() => stopPopup(stop))
    .addTo(myStopLayer);

  ui.mystop.hidden = false;
  ui.board.hidden = true;
  clearBoardResults();
  ui.mystopName.textContent = [stop.name, stop.no && `(${stop.no})`].filter(Boolean).join(' ');
  ui.mystopDirection.textContent = stop.direction ?? '';
  for (const entry of state.tracks.values()) entry.track.holdAt = stop.s;
  applyDirectionFocus();
  renderApproach();
  updateRouteUrl();

  // 버스 위치가 오면 내 정류장과 가장 가까이 다가오는 버스가 함께 보이도록 맞춘다.
  state.focusPending = focus;
  if (focus) {
    fitTo([[stop.lat, stop.lng]], 15);
    if (state.tracks.size) focusMyStop();
  }
}

// 내 정류장으로 오는 버스. 같은 방향 구간을 달리는 버스만 보여주고,
// 그런 버스가 없을 때만 반환점을 돌아서 올 버스를 보여준다.
function approachList() {
  const entries = [...state.tracks.values()];
  const speed = routeSpeed(entries.filter((e) => e.track.measured).map((e) => e.track.speed));
  const all = approachingBuses({
    stopS: state.myStop.s,
    stopDistances: state.stopSorted,
    buses: entries.map((e) => ({ id: e.id, s: e.track.s })),
    speed,
  });
  const segment = state.segments[segmentIndexAt(state.myStop.s)];
  const sameDirection = all.filter((bus) => state.myStop.s - bus.distance >= segment.from - 1);
  return sameDirection.length ? sameDirection : all.map((bus) => ({ ...bus, viaTurn: true }));
}

function renderApproach() {
  if (!state.myStop) return;
  if (!state.receivedAt) {
    ui.approachList.innerHTML = '<li class="empty">버스 위치를 불러오는 중…</li>';
    return;
  }
  const list = approachList();
  // 나에게 오는 버스만 지도에 남긴다. 방금 내 정류장을 지난 버스는 갑자기 사라지지 않도록
  // 400m 더 흐리게 보여준 뒤 숨긴다. "다른 버스도 보기"를 켜면 나머지도 흐리게 보여준다.
  const coming = new Set(list.map((b) => b.id));
  const stopS = state.myStop.s;
  for (const entry of state.tracks.values()) {
    const mine = coming.has(entry.id);
    const justPassed = !mine && entry.track.s > stopS && entry.track.s - stopS <= PASSED_VISIBLE_METERS;
    entry.root?.classList.toggle('past', !mine);
    const el = entry.marker.getElement();
    if (el) el.style.display = mine || justPassed || ui.showAllBuses.checked ? '' : 'none';
  }

  if (!list.length) {
    ui.approachList.innerHTML = '<li class="empty">이 방향으로 다가오는 버스가 없어요. 길 건너편 정류장인지 확인해 주세요.</li>';
    return;
  }
  ui.approachList.innerHTML = list
    .slice(0, 3)
    .map((bus) => {
      const soon = bus.seconds < SOON_SECONDS;
      const time = bus.seconds === 0 ? '도착' : bus.seconds < 60 ? '곧 도착' : `약 ${formatDuration(bus.seconds)}`;
      const where = bus.seconds === 0
        ? '정류장에 도착했거나 서 있어요'
        : [bus.stopsAway > 0 && `${bus.stopsAway}정거장 전`, formatDistance(bus.distance), bus.viaTurn && '반환점 돌아서 와요']
          .filter(Boolean)
          .join(' · ');
      return `<li><span class="arr-time${soon ? ' soon' : ''}">${time}</span><span class="arr-stops">${where}</span></li>`;
    })
    .join('');
}

function focusMyStop() {
  state.focusPending = false;
  const [nearest] = approachList();
  const points = [[state.myStop.lat, state.myStop.lng]];
  if (nearest) {
    const p = pointAt(state.line, state.myStop.s - nearest.distance);
    points.push([p.lat, p.lng]);
  }
  fitTo(points, 16);
}

// ── 실시간 연결 (SSE) ──
function connect() {
  if (!state.route || state.source) return;
  setLive('warn', '실시간 위치에 연결하는 중…');
  const source = new EventSource(api.liveUrl(state.route.regionId, state.route.id));
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
  const { line, stopSByOrd } = state;
  let minS = 0;
  let maxS = line.length;
  if (bus.stopOrd && stopSByOrd.has(bus.stopOrd)) {
    minS = (stopSByOrd.get(bus.stopOrd - 1) ?? stopSByOrd.get(bus.stopOrd)) - WINDOW_MARGIN;
    maxS = (stopSByOrd.get(bus.stopOrd + 1) ?? line.length) + WINDOW_MARGIN;
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
    rawLayer.addLayer(L.circleMarker([bus.lat, bus.lng], { radius: 5, color: css('--raw'), weight: 2, fill: false }));
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
  setLive('ok', seen.size ? '' : '지금 운행 중인 버스가 없어요.');
  renderApproach();
  if (state.focusPending && state.myStop) focusMyStop();
}

function addBus(id, track) {
  const { info } = track;
  track.holdAt = state.myStop?.s ?? null;
  // 버스 색 = 지금 달리는 방향의 노선 색. 저상버스는 라벨에 ♿ 표시.
  const label = `${state.route.number ?? ''}${info.lowFloor ? ' ♿' : ''}`;
  const icon = L.divIcon({
    className: 'map-icon',
    html: `<div class="bus" style="--bus-color:${directionColorAt(track.s)}"><div class="bus-arrow"></div><span class="bus-label">${escapeHtml(label)}</span></div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
  const start = pointAt(state.line, track.s);
  const marker = L.marker([start.lat, start.lng], { icon, keyboard: false, title: info.plate })
    .bindPopup(() => busPopup(id, track))
    .addTo(busLayer);
  const root = marker.getElement()?.querySelector('.bus');
  state.tracks.set(id, { id, track, marker, root, arrow: root?.querySelector('.bus-arrow') });
}

function busPopup(id, track) {
  const { info } = track;
  const lastStop = state.stopsByOrd.get(info.stopOrd);
  const speedText = track.measured
    ? `${Math.round(track.speed * 3.6)} km/h`
    : `측정 중 (기본 ${Math.round(DEFAULT_SPEED * 3.6)} km/h로 예측)`;
  const toMyStop = state.myStop ? approachList().find((b) => b.id === id) : null;
  const rows = [
    `<div class="popup-title">${escapeHtml(state.route.number ?? '')}번 버스</div>`,
    toMyStop ? `<b>내 정류장까지 약 ${formatDuration(toMyStop.seconds)}</b>` : null,
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
      if (!entry.root) {
        entry.root = entry.marker.getElement()?.querySelector('.bus');
        entry.arrow = entry.root?.querySelector('.bus-arrow');
      }
      entry.arrow?.style.setProperty('--bearing', `${p.bearing}deg`);
    }
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// 수신 시각, 진행 막대
setInterval(() => {
  if (state.view === 'route' && state.receivedAt) {
    const elapsed = Date.now() - state.receivedAt;
    ui.lastUpdate.textContent = `${Math.floor(elapsed / 1000)}초 전`;
    ui.progress.style.width = `${Math.min(100, (elapsed / state.pollMs) * 100)}%`;
  }
}, 250);

// 버스 색(반환점을 돌면 바뀜)과 도착 예상 시간
setInterval(() => {
  if (state.view !== 'route' || !state.line) return;
  for (const entry of state.tracks.values()) entry.root?.style.setProperty('--bus-color', directionColorAt(entry.track.s));
  renderApproach();
}, 1000);

// ── 이벤트 ──
ui.back.addEventListener('click', showSearch);
ui.form.addEventListener('submit', search);
ui.detectRegion.addEventListener('click', async () => {
  setMessage(ui.searchMessage, '내 위치를 확인하는 중…');
  try {
    const me = await locate();
    setMe(me);
    await detectRegion(me, { announce: true });
  } catch (err) {
    setMessage(ui.searchMessage, err.message, true);
  }
});
ui.boardNearby.addEventListener('click', showNearbyStops);
ui.boardForm.addEventListener('submit', searchBoarding);
ui.changeStop.addEventListener('click', openBoard);
ui.showAllBuses.addEventListener('change', renderApproach);

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
      setLive('warn', '화면이 가려져 있어 업데이트를 잠시 멈췄어요.');
    }, HIDDEN_DISCONNECT_MS);
  } else {
    clearTimeout(state.hiddenTimer);
    if (state.view === 'route') connect();
  }
});

// ── 시작 ──
await loadRegions();
const params = new URLSearchParams(location.search);
const region = params.get('region');
if (region) setRegion(region);

if (region && params.get('route')) {
  if (params.get('no')) ui.query.value = params.get('no');
  openRoute({ regionId: region, id: params.get('route'), number: params.get('no') }, { stopId: params.get('stop') });
}

// 이미 위치 권한을 허용한 사용자는 묻지 않고 지역을 맞춰둔다.
navigator.permissions
  ?.query({ name: 'geolocation' })
  .then((status) => {
    if (status.state !== 'granted') return;
    return locate().then((me) => {
      setMe(me);
      if (state.view === 'search') detectRegion(me);
    });
  })
  .catch(() => {});
