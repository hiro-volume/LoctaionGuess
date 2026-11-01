"use strict";

const CONFIG = window.LG_CONFIG;
// 古い config.js でも動くよう、あとから増えた上限には既定値を入れておく
CONFIG.limits = { staticMapsPerMonth: 8000, ...CONFIG.limits };
const PRESETS = window.LG_PRESETS;
const STORE_USAGE = "lg.usage";
const STORE_AREAS = "lg.customAreas";
const STORE_SETTINGS = "lg.settings";
const STORE_HISTORY = "lg.history";
const STORE_PREFS = "lg.prefs";
const STORE_SCORES = "lg.scores";
const STORE_PROFILE = "lg.profile";
const MAX_LOCATION_TRIES = 60;

const $ = (id) => document.getElementById(id);
const app = $("app");

const state = {
  map: null,
  pano: null,
  areaOverlays: [],
  selectedAreaId: "singapore",
  mode: "rounds",
  game: null,
  editor: null,
};

// ---------------------------------------------------------------- 保存データ

function loadJSON(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}

function saveJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 保存できなくてもゲームは続ける
  }
}

// ---------------------------------------------------------------- 使用量カウンタ（無料枠ガード）

function monthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function getUsage() {
  const all = loadJSON(STORE_USAGE, {});
  return { streetView: 0, mapLoads: 0, metadata: 0, staticMaps: 0, ...all[monthKey()] };
}

function addUsage(kind, n = 1) {
  const all = loadJSON(STORE_USAGE, {});
  const key = monthKey();
  const u = all[key] || { streetView: 0, mapLoads: 0, metadata: 0 };
  u[kind] = (u[kind] || 0) + n;
  all[key] = u;
  saveJSON(STORE_USAGE, all);
  renderUsage();
  // マルチプレイの参加者は、使った分をホストにも知らせる（ホストのグラフに全員分を足すため）
  if (state.mp && state.mp.role === "guest") guestSend({ type: "usage", kind, n });
}

function remainingStreetView() {
  return CONFIG.limits.streetViewPerMonth - getUsage().streetView;
}

function renderUsage() {
  const u = getUsage();
  const rows = [
    ["ストリートビュー", u.streetView, CONFIG.limits.streetViewPerMonth],
    ["地図の読み込み", u.mapLoads, CONFIG.limits.mapLoadsPerMonth],
    ["範囲の地図画像", u.staticMaps || 0, CONFIG.limits.staticMapsPerMonth],
  ];
  const games = Math.max(0, Math.floor(remainingStreetView() / 5));
  $("usage").innerHTML =
    `<div class="usage-title">今月の無料枠（このブラウザ）</div>` +
    rows.map(([label, used, limit]) => {
      const pct = Math.min(100, (used / limit) * 100);
      return `<div class="usage-row"><span>${label}</span><span>${used.toLocaleString()} / ${limit.toLocaleString()}</span></div>
        <div class="bar ${pct > 90 ? "warn" : ""}"><div style="width:${pct}%"></div></div>`;
    }).join("") +
    `<div class="help">あと約 ${games} ゲーム（5ラウンド換算）</div>`;
  $("usage-mini").textContent = `今月の無料枠: あと約 ${games} ゲーム`;
}

// ---------------------------------------------------------------- 範囲（エリア）の計算

function allAreas() {
  return [...PRESETS, ...loadJSON(STORE_AREAS, [])];
}

function findArea(id) {
  return allAreas().find((a) => a.id === id) || PRESETS[0];
}

// 円の範囲は、1つの円（"circle"）でも複数の円（"circles"）でも円のリストとして扱う
function areaCircles(area) {
  if (area.type === "circle") return [{ center: area.center, radius: area.radius }];
  if (area.type === "circles") return area.circles;
  return null;
}

function areaBounds(area) {
  if (area.type === "world") return { south: -56, north: 72, west: -180, east: 180 };
  const b = { south: 90, north: -90, west: 180, east: -180 };
  const circles = areaCircles(area);
  if (circles) {
    for (const { center, radius } of circles) {
      const dLat = radius / 111320;
      const dLng = radius / (111320 * Math.cos((center.lat * Math.PI) / 180));
      b.south = Math.min(b.south, center.lat - dLat); b.north = Math.max(b.north, center.lat + dLat);
      b.west = Math.min(b.west, center.lng - dLng); b.east = Math.max(b.east, center.lng + dLng);
    }
    return b;
  }
  for (const ring of area.rings) {
    for (const [lat, lng] of ring) {
      b.south = Math.min(b.south, lat); b.north = Math.max(b.north, lat);
      b.west = Math.min(b.west, lng); b.east = Math.max(b.east, lng);
    }
  }
  return b;
}

function pointInRing(lat, lng, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i];
    const [yj, xj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function areaContains(area, lat, lng) {
  // 全世界: 見つかった場所ならどこでもよい
  if (area.type === "world") return true;
  const circles = areaCircles(area);
  if (circles) return circles.some((c) => distanceMeters(c.center, { lat, lng }) <= c.radius);
  if (area.rings.some((ring) => pointInRing(lat, lng, ring))) return true;
  // 国の範囲は簡略化した国境なので、海沿いの町がはみ出すことがある。その国の中なら入れる
  return !!area.iso && countryNear(lat, lng) === area.iso;
}

// 全世界: ストリートビューのある国を（広い国ほど選ばれやすく）選んでから、その国の中の点を選ぶ
let coverageCountries = null;
function randomWorldPoint() {
  if (!coverageCountries) {
    const ids = new Set(window.LG_WORLD_COVERAGE || []);
    coverageCountries = WORLD.filter((c) => ids.has(c.id)).map((c) => {
      const area = { type: "polygons", rings: c.rings.map((r) => r.map(([lng, lat]) => [lat, lng])) };
      const b = areaBounds(area);
      const size = (b.north - b.south) * (b.east - b.west) * Math.cos((((b.north + b.south) / 2) * Math.PI) / 180);
      return { area, weight: Math.sqrt(Math.max(size, 0.1)) };
    });
  }
  const total = coverageCountries.reduce((s, c) => s + c.weight, 0);
  let r = rand() * total;
  const pick = coverageCountries.find((c) => (r -= c.weight) <= 0) || coverageCountries[0];
  return randomPointIn(pick.area);
}

// 0 以上 1 未満の乱数。ブラウザの暗号用の乱数を使い、偏りやくり返しを減らす
function rand() {
  try {
    return crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;
  } catch {
    return Math.random();
  }
}

function randomPointIn(area) {
  if (area.type === "world") return randomWorldPoint();
  const b = areaBounds(area);
  for (let i = 0; i < 5000; i++) {
    const lat = b.south + rand() * (b.north - b.south);
    const lng = b.west + rand() * (b.east - b.west);
    if (areaContains(area, lat, lng)) return { lat, lng };
  }
  return null;
}

// 範囲の対角線の長さ（m）。得点の基準と検索半径に使う
function areaSizeMeters(area) {
  const b = areaBounds(area);
  return distanceMeters({ lat: b.south, lng: b.west }, { lat: b.north, lng: b.east });
}

// ---------------------------------------------------------------- 距離と得点

function distanceMeters(a, b) {
  const R = 6371008.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function formatDistance(m) {
  if (m < 1000) return `${Math.round(m)} m`;
  if (m < 100000) return `${(m / 1000).toFixed(2)} km`;
  return `${Math.round(m / 1000)} km`;
}

// 1ラウンド最大 5000 点。範囲が広いほどゆるく、狭いほど厳しく減点する
const MAX_SCORE = 5000;
// 範囲の線の色（出題範囲・範囲エディタ）
const AREA_LINE_COLOR = "#38bdf8";

function scoreFor(distance, area) {
  if (distance <= 25) return MAX_SCORE;
  const decay = areaSizeMeters(area) * 0.07;
  return Math.round(MAX_SCORE * Math.exp(-distance / decay));
}

// ---------------------------------------------------------------- 出題地点の検索（無料の Metadata API）

// 最近のゲームで出た場所（マップごとに新しいものだけ残す）。次のゲームでその近くを避けるのに使う
const STORE_RECENT = "lg.recent";
const MAX_RECENT_SPOTS = 150;

function loadRecentSpots(areaId) {
  return (loadJSON(STORE_RECENT, {})[areaId] || []).map(([lat, lng]) => ({ lat, lng }));
}

function rememberSpot(areaId, p) {
  const all = loadJSON(STORE_RECENT, {});
  const list = [...(all[areaId] || []), [Math.round(p.lat * 1e5) / 1e5, Math.round(p.lng * 1e5) / 1e5]];
  all[areaId] = list.slice(-MAX_RECENT_SPOTS);
  saveJSON(STORE_RECENT, all);
}

function nearestDistance(p, spots) {
  return spots.reduce((min, s) => Math.min(min, distanceMeters(p, s)), Infinity);
}

// usedSpots: このゲームで出た場所。見つけた場所はここに足す
async function findLocation(area, usedPanos, usedSpots = []) {
  const wide = area.type === "world" || !!area.iso;
  // 検索の半径が大きいと、道の少ない場所（まわりに他の道がない道）ばかり選ばれやすくなるので、広い範囲でも 5km までにする
  const radius = Math.round(Math.min(wide ? 5000 : 1000, Math.max(50, areaSizeMeters(area) / 100)));
  const size = areaSizeMeters(area);
  // 同じゲームの中では、前の出題から範囲の 6% ほど離れた場所を選ぶ
  const gameGap = Math.max(60, size * 0.06);
  // 最近のゲームで出た場所の近くも避ける（狭い範囲ほど、くり返しが目立つので広めに）
  const recent = loadRecentSpots(area.id);
  const recentGap = wide ? Math.max(30, size * 0.015) : Math.max(40, size * 0.05);
  const accept = (spot) => {
    usedSpots.push({ lat: spot.lat, lng: spot.lng });
    rememberSpot(area.id, spot);
    return spot;
  };
  const tries = wide ? 200 : MAX_LOCATION_TRIES;
  const batch = wide ? 6 : 4;
  const ask = async (p) => {
    const url = "https://maps.googleapis.com/maps/api/streetview/metadata" +
      `?location=${p.lat},${p.lng}&radius=${radius}&source=outdoor&key=${encodeURIComponent(CONFIG.apiKey)}`;
    const res = await fetch(url).then((r) => r.json());
    addUsage("metadata");
    if (res.status === "REQUEST_DENIED") {
      throw new Error(`APIキーが拒否されました: ${res.error_message || ""}\nStreet View Static API が有効か、キーの制限を確認してください。`);
    }
    if (res.status !== "OK") return null;
    // Google 公式の撮影だけを使う（個人投稿の写真は除外）
    if (!String(res.copyright || "").includes("Google")) return null;
    if (usedPanos.has(res.pano_id)) return null;
    if (!areaContains(area, res.location.lat, res.location.lng)) return null;
    return { panoId: res.pano_id, lat: res.location.lat, lng: res.location.lng, date: res.date };
  };
  // 狭い範囲（自作の範囲など）は撮影地点の数が限られるので、候補を 8 か所集めてから、
  // このゲームと最近のゲームで出た場所から、いちばん離れたものを選ぶ。
  // 広い範囲は、十分に離れた候補が見つかった時点で決める
  const enough = wide ? 1 : 8;
  let best = null;
  let bestRoom = -1;
  let seen = 0;
  for (let i = 0; i < tries; i += batch) {
    const points = Array.from({ length: batch }, () => randomPointIn(area)).filter(Boolean);
    if (!points.length) break;
    const found = (await Promise.all(points.map(ask))).filter(Boolean);
    for (const spot of found) {
      const room = Math.min(nearestDistance(spot, usedSpots) / gameGap, nearestDistance(spot, recent) / recentGap);
      seen += 1;
      if (room > bestRoom) { best = spot; bestRoom = room; }
    }
    // まだ何も出ていない（比べる相手がいない）なら、最初の候補でよい
    if (bestRoom === Infinity) return accept(best);
    if (wide ? bestRoom >= 1 : seen >= enough) return accept(best);
  }
  if (best) return accept(best);
  throw new Error("この範囲ではストリートビューが見つかりませんでした。範囲を広げるか、道路のある場所を選んでください。");
}

// ---------------------------------------------------------------- 地図の表示

function clearOverlay() {
  state.areaOverlays.forEach((o) => o.setMap(null));
  state.areaOverlays = [];
}

function drawArea(area, fit = true) {
  clearOverlay();
  // 全世界は囲む線を引かず、世界地図を広く見せる
  if (area.type === "world") {
    if (fit) { state.map.setCenter({ lat: 20, lng: 0 }); state.map.setZoom(1); }
    return;
  }
  const style = {
    map: state.map, strokeColor: AREA_LINE_COLOR, strokeOpacity: 0.9, strokeWeight: 2,
    fillColor: AREA_LINE_COLOR, fillOpacity: 0.08, clickable: false,
  };
  const circles = areaCircles(area);
  if (circles) {
    state.areaOverlays = circles.map((c) => new google.maps.Circle({ ...style, center: c.center, radius: c.radius }));
  } else {
    state.areaOverlays = [new google.maps.Polygon({
      ...style, paths: area.rings.map((ring) => ring.map(([lat, lng]) => ({ lat, lng }))),
    })];
  }
  if (fit) {
    const b = areaBounds(area);
    state.map.fitBounds(b, 20);
    state.mapTouched = false;
  }
}

function setScreen(name) {
  app.className = `screen-${name}`;
  if (name !== "game") $("game-settings").hidden = true;
}

// ブラウザ標準の confirm の代わりに使う確認ダイアログ。OK なら true で解決する
function askConfirm({ title, text, okText = "OK", cancelText = "キャンセル", danger = false }) {
  const dlg = $("dialog");
  $("dialog-title").textContent = title;
  $("dialog-text").textContent = text;
  $("dialog-ok").textContent = okText;
  $("dialog-cancel").textContent = cancelText;
  $("dialog-icon").textContent = danger ? "!" : "?";
  dlg.classList.toggle("danger", danger);
  dlg.hidden = false;
  $("dialog-cancel").focus();
  return new Promise((resolve) => {
    const close = (result) => {
      dlg.hidden = true;
      $("dialog-ok").removeEventListener("click", onOk);
      $("dialog-cancel").removeEventListener("click", onCancel);
      dlg.querySelector(".dialog-backdrop").removeEventListener("click", onCancel);
      document.removeEventListener("keydown", onKey, true);
      resolve(result);
    };
    const onOk = () => close(true);
    const onCancel = () => close(false);
    const onKey = (e) => {
      if (e.key === "Escape") { e.stopPropagation(); close(false); }
    };
    $("dialog-ok").addEventListener("click", onOk);
    $("dialog-cancel").addEventListener("click", onCancel);
    dlg.querySelector(".dialog-backdrop").addEventListener("click", onCancel);
    document.addEventListener("keydown", onKey, true);
  });
}

function showMessage(text, persistent = false) {
  const el = $("message");
  el.textContent = text;
  el.hidden = false;
  el.style.whiteSpace = "pre-wrap";
  if (!persistent) setTimeout(() => { el.hidden = true; }, 7000);
}

// ---------------------------------------------------------------- タイトル画面

const CATEGORIES = window.LG_CATEGORIES;

// マップの難しさ（カードに出す。ライフの量の「多め・ふつう・少なめ」とは別）
const AREA_DIFFICULTY_NAMES = { easy: "かんたん", normal: "普通", hard: "難しい" };

function categoryName(id) {
  if (id === "world") return "全世界";
  const c = CATEGORIES.find((x) => x.id === id);
  return c ? c.name : "自作";
}

// 自作の範囲でカテゴリを選んでいれば「アジア・自作」のように出す
function categoryLabel(area) {
  if (!area.custom) return categoryName(area.category);
  return area.category ? `${categoryName(area.category)}・自作` : "自作";
}

function showTitle() {
  closeSettings();
  setScreen("title");
  renderUsage();
  $("quick-map").textContent = findArea(state.selectedAreaId).name;
}

// タイトルの「クイックプレイ」: 前に選んだマップで、ラウンド制 5 ラウンド・制限時間 2 分ですぐ始める
const QUICK_ROUNDS = 5;
const QUICK_TIME_LIMIT = 120;

async function startQuickGame() {
  if (!ensureMap()) return;
  closeSettings();
  if (remainingStreetView() < QUICK_ROUNDS) {
    return showMessage("今月の無料枠の上限に達しました（config.js の limits）。来月まで待つか、上限を見直してください。");
  }
  state.mode = "rounds";
  state.game = {
    area: findArea(state.selectedAreaId),
    move: true, pan: true, zoom: true,
    timeLimit: QUICK_TIME_LIMIT,
    mode: "rounds", difficulty: "normal", hardcore: false, guessMode: "pin",
    maxLife: LIFE_PRESETS.normal, life: LIFE_PRESETS.normal,
    rounds: QUICK_ROUNDS,
    index: 0, results: [], overlays: [], usedPanos: new Set(), usedSpots: [],
  };
  state.lifeShown = null;
  setScreen("game");
  await startRound();
}

// タイトルの背景は、プリセットの写真をゆっくり切り替えて見せる
function buildTitleBackground() {
  const imgs = PRESETS.filter((a) => a.image);
  $("title-bg").innerHTML = imgs
    .map((a, i) => `<div class="title-slide${i === 0 ? " active" : ""}" style="background-image:url('${a.image.src}')"></div>`)
    .join("");
  $("title-credit").textContent = "写真: " + imgs.map((a) => a.image.credit).join(" ・ ") + "（Wikimedia Commons）";
  let i = 0;
  setInterval(() => {
    const slides = document.querySelectorAll(".title-slide");
    if (slides.length < 2) return;
    slides[i].classList.remove("active");
    i = (i + 1) % slides.length;
    slides[i].classList.add("active");
  }, 6000);
}

// ---------------------------------------------------------------- マップ選択画面

function showSelect() {
  stopTimer();
  clearGameMarkers();
  state.editor = null;
  $("result").hidden = true;
  setScreen("select");
  renderSelect();
  decorateSelectForMulti();
}

// ゲーム終了後などに戻る「ホーム」はマップ選択画面
const showHome = showSelect;

function areasInCategory(cat) {
  return allAreas().filter((a) => {
    if (cat === "all") return true;
    if (cat === "custom") return !!a.custom;
    return a.category === cat;
  });
}

function renderSelect() {
  const cat = state.category || "all";
  // 中身のあるカテゴリだけ出す（「すべて」と「自作」は常に出す）
  $("category-chips").innerHTML = CATEGORIES
    .map((c) => ({ ...c, count: areasInCategory(c.id).length }))
    .filter((c) => c.count > 0 || c.id === "all" || c.id === "custom")
    .map((c) => `<button class="chip${c.id === cat ? " active" : ""}" data-cat="${c.id}">${c.name}<span>${c.count}</span></button>`)
    .join("");
  document.querySelectorAll("#category-chips .chip").forEach((b) => b.addEventListener("click", () => {
    state.category = b.dataset.cat;
    renderSelect();
  }));

  renderProgress(cat);

  const grid = $("map-grid");
  grid.innerHTML = "";
  const list = areasInCategory(cat).filter((a) => a.type !== "world");
  const world = cat === "all" && PRESETS.find((a) => a.type === "world");
  if (world) {
    const hero = mapCard(world);
    hero.classList.add("hero");
    hero.querySelector(".map-card-info").insertAdjacentHTML("afterbegin", '<span class="hero-eyebrow">🌏 いちばん大きなマップ</span>');
    grid.appendChild(hero);
  }
  list.forEach((area, i) => {
    const card = mapCard(area);
    card.style.setProperty("--i", i);
    grid.appendChild(card);
  });
  const create = document.createElement("button");
  create.className = "map-card create";
  create.style.setProperty("--i", list.length);
  create.innerHTML = `<div class="create-inner"><span class="plus">＋</span><b>新しい範囲を作る</b><small>円や多角形で、好きな場所を囲めます</small></div>`;
  create.addEventListener("click", openEditor);
  grid.appendChild(create);

  const credits = PRESETS.filter((a) => a.image)
    .map((a) => `<a href="${a.image.link}" target="_blank" rel="noopener">${escapeHtml(a.name)}: ${escapeHtml(a.image.credit)}</a>`);
  $("credits").innerHTML = "写真（Wikimedia Commons）: " + credits.join(" ・ ");
}

function mapCard(area) {
  const card = document.createElement("div");
  card.className = "map-card";
  card.tabIndex = 0;
  card.setAttribute("role", "button");
  const cover = area.image ? area.image.src : area.cover;
  const visual = cover
    ? `<div class="map-card-img" style="background-image:url('${cover}')"></div>`
    : `<div class="map-card-img custom">${customVisual(area)}</div>`;
  if (area.custom) {
    card.classList.add("custom-card");
    card.style.setProperty("--ac", area.color || AREA_COLORS[0]);
  }
  card.innerHTML = `
    ${visual}
    <span class="pill">${categoryLabel(area)}</span>
    <div class="map-card-info">
      <div class="map-card-title"><b></b>${difficultyBadge(area)}</div>
      <span>${escapeHtml(areaSummary(area))}</span>
      ${recordBadge(area)}
    </div>`;
  card.querySelector("b").textContent = area.name;
  if (!cover) hydrateThumbs(card, area);
  const open = () => openSettings(area.id);
  card.addEventListener("click", open);
  card.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
  if (area.custom) {
    const del = document.createElement("button");
    del.className = "card-del";
    del.title = "削除";
    del.textContent = "×";
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      const ok = await askConfirm({
        title: "範囲を削除しますか？",
        text: `「${area.name}」を削除します。
この操作は取り消せません。`,
        okText: "削除する",
        danger: true,
      });
      if (!ok) return;
      saveJSON(STORE_AREAS, loadJSON(STORE_AREAS, []).filter((a) => a.id !== area.id));
      if (state.selectedAreaId === area.id) state.selectedAreaId = PRESETS[0].id;
      renderSelect();
    });
    card.appendChild(del);
    const edit = document.createElement("button");
    edit.className = "card-edit";
    edit.title = "範囲の形・名前・メモ・色・カバー画像を編集";
    edit.textContent = "✎";
    edit.addEventListener("click", (e) => {
      e.stopPropagation();
      openEditor(area.id);
    });
    card.appendChild(edit);
  }
  return card;
}

// 難易度のバー（3本のうち何本光るか）
function difficultyBadge(area) {
  if (!area.difficulty) return "";
  return `<span class="diff diff-${area.difficulty}" title="難易度"><i></i><i></i><i></i>${AREA_DIFFICULTY_NAMES[area.difficulty]}</span>`;
}

function recordBadge(area) {
  const st = loadHistory().games[area.id];
  if (!st) return `<span class="card-record new">未プレイ</span>`;
  return `<span class="card-record">${st.played}回プレイ ・ ベスト平均 ${st.bestAvg}点</span>`;
}

// カードに出す「広さ・ひとこと」
function areaSummary(area) {
  if (area.type === "world") return `${(window.LG_WORLD_COVERAGE || []).length} か国以上 ・ ${area.description}`;
  const m = areaSizeMeters(area) / Math.SQRT2;
  const size = m < 1000 ? `約 ${Math.round(m / 10) * 10} m 四方` : `約 ${Math.round(m / 1000)} km 四方`;
  if (area.description) return `${size} ・ ${area.description}`;
  // 自作の範囲は、どこの範囲なのか（国・地域と形）を添える
  return area.custom ? `${size} ・ ${areaPlaceName(area)} ・ ${areaShapeKind(area)}` : size;
}

// 範囲の真ん中がどの国・地域か（「シンガポール付近」のように出す）
function areaPlaceName(area) {
  const b = areaBounds(area);
  const id = countryNear((b.south + b.north) / 2, (b.west + b.east) / 2);
  const c = id && WORLD.find((x) => x.id === id);
  return c ? `${c.name}付近` : "海の上";
}

function areaShapeKind(area) {
  const circles = areaCircles(area);
  if (circles) return `円 ${circles.length} 個`;
  return `多角形 ${area.rings[0].length} 点`;
}

// 写真のない自作の範囲は、「範囲の地図」の小窓で見せる
// （Maps Static API の地図に、範囲の外を暗くして範囲を浮かび上がらせる。使えないときは線画）
function customVisual(area) {
  const thumb = staticThumb(area);
  return `<div class="cv"><figure class="cv-shape${thumb ? " has-map" : ""}">${thumb || areaShapeSvg(area)}<figcaption>範囲の地図</figcaption></figure></div>`;
}

// ---------------------------------------------------------------- 範囲の地図サムネイル（Maps Static API）

const THUMB = 200;       // サムネイルの大きさ（表示上の px。画像は scale=2 で2倍の解像度）
const THUMB_FOOTER = 22; // 下の帯（Google のロゴと著作権表示）は暗くしない
const staticCounted = new Set();
let thumbSeq = 0;

// Web メルカトルでのピクセル座標（ズーム z）
function mercPx(lat, lng, z) {
  const size = 256 * 2 ** z;
  const sin = Math.sin((lat * Math.PI) / 180);
  return { x: ((lng + 180) / 360) * size, y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size };
}

function staticThumb(area) {
  if (!CONFIG.apiKey || CONFIG.apiKey === "YOUR_API_KEY") return null;
  const b = areaBounds(area);
  const center = { lat: (b.south + b.north) / 2, lng: (b.west + b.east) / 2 };
  // 範囲が枠の8割に収まる、いちばん大きなズームを選ぶ
  let z = 18;
  for (; z > 1; z--) {
    const sw = mercPx(b.south, b.west, z), ne = mercPx(b.north, b.east, z);
    if (Math.abs(ne.x - sw.x) <= THUMB * 0.8 && Math.abs(sw.y - ne.y) <= (THUMB - THUMB_FOOTER) * 0.8) break;
  }
  const url = "https://maps.googleapis.com/maps/api/staticmap" +
    `?center=${center.lat.toFixed(5)},${center.lng.toFixed(5)}&zoom=${z}&size=${THUMB}x${THUMB}&scale=2&language=ja` +
    `&maptype=${encodeURIComponent(state.prefs ? state.prefs.mapType : "roadmap")}&key=${encodeURIComponent(CONFIG.apiKey)}`;
  // 同じ画像はブラウザが覚えているので、このページを開いている間は1回だけ数える
  if (!staticCounted.has(url)) {
    if (getUsage().staticMaps >= CONFIG.limits.staticMapsPerMonth) return null;
    staticCounted.add(url);
    addUsage("staticMaps");
  }

  const c = mercPx(center.lat, center.lng, z);
  const px = (lat, lng) => {
    const p = mercPx(lat, lng, z);
    return [p.x - c.x + THUMB / 2, p.y - c.y + THUMB / 2];
  };
  const circles = areaCircles(area);
  const shapes = circles
    ? circles.map((ci) => {
      const [x, y] = px(ci.center.lat, ci.center.lng);
      const metersPerPx = (40075016.686 * Math.cos((ci.center.lat * Math.PI) / 180)) / (256 * 2 ** z);
      return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(ci.radius / metersPerPx).toFixed(1)}"/>`;
    }).join("")
    : area.rings.map((ring) => `<polygon points="${ring.map(([lat, lng]) => px(lat, lng).map((v) => v.toFixed(1)).join(",")).join(" ")}"/>`).join("");
  const id = `thumb-mask-${++thumbSeq}`;
  return `<svg class="static-thumb" viewBox="0 0 ${THUMB} ${THUMB}">
    <defs><mask id="${id}"><rect width="${THUMB}" height="${THUMB - THUMB_FOOTER}" fill="#fff"/><g fill="#000">${shapes}</g></mask></defs>
    <image href="${url}" width="${THUMB}" height="${THUMB}"/>
    <rect class="thumb-dim" width="${THUMB}" height="${THUMB}" mask="url(#${id})"/>
    <g class="thumb-outline">${shapes}</g>
  </svg>`;
}

// 地図画像が読めなかったとき（Maps Static API が有効でないなど）は線画に切り替える
function hydrateThumbs(root, area) {
  root.querySelectorAll(".static-thumb image").forEach((img) => {
    img.addEventListener("error", () => {
      const fig = img.closest(".cv-shape");
      if (!fig) return;
      fig.classList.remove("has-map");
      fig.querySelector(".static-thumb").outerHTML = areaShapeSvg(area);
    }, { once: true });
  });
}

// 範囲の形をそのまま線画にする
function areaShapeSvg(area) {
  const b = areaBounds(area);
  const k = Math.cos((((b.north + b.south) / 2) * Math.PI) / 180);
  const w = (b.east - b.west) * k;
  const h = b.north - b.south;
  const scale = 80 / Math.max(w, h);
  const ox = (100 - w * scale) / 2;
  const oy = (100 - h * scale) / 2;
  const xy = (lat, lng) => [ox + (lng - b.west) * k * scale, oy + (b.north - lat) * scale];
  const circles = areaCircles(area);
  let shapes;
  if (circles) {
    shapes = circles.map((c) => {
      const [x, y] = xy(c.center.lat, c.center.lng);
      return `<circle cx="${x}" cy="${y}" r="${(c.radius / 111320) * scale}"/>`;
    }).join("");
  } else {
    shapes = area.rings.map((ring) => `<polygon points="${ring.map(([lat, lng]) => xy(lat, lng).join(",")).join(" ")}"/>`).join("");
  }
  return `<svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet">${shapes}</svg>`;
}

// ---------------------------------------------------------------- プレイ記録

const WORLD = window.LG_WORLD || [];
const MAX_HISTORY_ROUNDS = 3000;

function loadHistory() {
  const h = loadJSON(STORE_HISTORY, {});
  return { rounds: h.rounds || [], games: h.games || {} };
}

// 1ラウンドごとに「出題された場所・国・得点」を残す
function recordRound(areaId, r) {
  const h = loadHistory();
  h.rounds.push({
    lat: Math.round(r.answer.lat * 1e4) / 1e4,
    lng: Math.round(r.answer.lng * 1e4) / 1e4,
    area: areaId,
    score: r.score,
    c: countryNear(r.answer.lat, r.answer.lng),
    t: Date.now(),
  });
  // 記録が増えすぎないように、新しいものだけ残す
  if (h.rounds.length > MAX_HISTORY_ROUNDS) h.rounds = h.rounds.slice(-MAX_HISTORY_ROUNDS);
  saveJSON(STORE_HISTORY, h);
}

// 1ゲームごとに、マップ別の「遊んだ回数」と「1ラウンドあたりの最高平均点」を残す
function recordGame(g) {
  if (!g.results.length) return;
  const h = loadHistory();
  const st = h.games[g.area.id] || { played: 0, bestAvg: 0 };
  const avg = Math.round(g.results.reduce((sum, r) => sum + r.score, 0) / g.results.length);
  st.played += 1;
  st.bestAvg = Math.max(st.bestAvg, avg);
  h.games[g.area.id] = st;
  saveJSON(STORE_HISTORY, h);
}

// [経度, 緯度] の境界データのリストから「その点を含むもの」を探す関数を作る
function makeLocator(list) {
  let boxes = null;
  const at = (lat, lng) => {
    if (!boxes) {
      boxes = list.map((c) => {
        const b = { w: 180, e: -180, s: 90, n: -90 };
        c.rings.forEach((r) => r.forEach(([x, y]) => {
          b.w = Math.min(b.w, x); b.e = Math.max(b.e, x); b.s = Math.min(b.s, y); b.n = Math.max(b.n, y);
        }));
        return b;
      });
    }
    for (let i = 0; i < list.length; i++) {
      const b = boxes[i];
      if (lng < b.w || lng > b.e || lat < b.s || lat > b.n) continue;
      // データは [経度, 緯度] なので、[緯度, 経度] に直して判定する
      if (list[i].rings.some((r) => pointInRing(lat, lng, r.map(([x, y]) => [y, x])))) return list[i].id;
    }
    return null;
  };
  // 簡略化した境界では小さな島（宮島など）が消えているので、見つからなければ周りを少しずつ探す
  return (lat, lng) => {
    const hit = at(lat, lng);
    if (hit) return hit;
    for (const d of [0.05, 0.1, 0.25, 0.5]) {
      for (let k = 0; k < 8; k++) {
        const a = (k * Math.PI) / 4;
        const c = at(lat + d * Math.sin(a), lng + d * Math.cos(a));
        if (c) return c;
      }
    }
    return null;
  };
}

const REGIONS = window.LG_REGIONS || [];
const countryNear = makeLocator(WORLD);
const regionNear = makeLocator(REGIONS);
const regionById = new Map(REGIONS.map((r) => [r.id, r]));
const regionCache = new Map();

// ---------------------------------------------------------------- 当て方（地点・国・都道府県）

const GUESS_MODES = {
  pin: { tab: "📍 地点", noun: "地点", help: "ピンを刺した場所と正解の距離で得点が決まります。" },
  country: { tab: "🌐 国", noun: "国", help: "地図で国をクリックして選びます。正解の国なら満点、違う国でも近ければ少し点が入ります（最大で半分）。" },
  pref: { tab: "🗾 都道府県", noun: "都道府県", help: "地図で都道府県をクリックして選びます。正解なら満点、違う都道府県でも近ければ少し点が入ります（最大で半分）。" },
};
const JAPAN_PREFS = REGIONS.filter((r) => r.country === "JPN");
const prefNear = makeLocator(JAPAN_PREFS);

// その範囲で選べる当て方
function guessModesFor(area) {
  const modes = ["pin"];
  if (area.type === "world") modes.push("country");
  if (area.iso === "JPN") modes.push("pref");
  return modes;
}

function isRegionMode(g) {
  return !!g && (g.guessMode === "country" || g.guessMode === "pref");
}

function regionAt(mode, lat, lng) {
  if (mode === "country") return countryNear(lat, lng);
  if (mode === "pref") return prefNear(lat, lng);
  return null;
}

function regionInfo(mode, id) {
  const list = mode === "country" ? WORLD : mode === "pref" ? JAPAN_PREFS : [];
  return list.find((r) => r.id === id) || null;
}

function regionName(mode, id) {
  const r = regionInfo(mode, id);
  return r ? r.name : "（海の上）";
}

// 回答の判定。地点は距離で、国・都道府県は「同じなら満点、違えば選んだ区画のふちまでの近さで最大半分」
function judgeGuess(g, guess, answer) {
  if (!guess) return { distance: null, score: 0 };
  if (!isRegionMode(g)) {
    const distance = distanceMeters(guess, answer);
    return { distance, score: scoreFor(distance, g.area) };
  }
  const answerRegion = regionAt(g.guessMode, answer.lat, answer.lng);
  const guessRegion = regionAt(g.guessMode, guess.lat, guess.lng);
  if (guessRegion && guessRegion === answerRegion) {
    return { distance: 0, score: MAX_SCORE, answerRegion, guessRegion, correct: true };
  }
  const r = regionInfo(g.guessMode, guessRegion);
  const distance = r
    ? r.rings.reduce((min, ring) => ring.reduce((m, [lng, lat]) => Math.min(m, distanceMeters({ lat, lng }, answer)), min), Infinity)
    : distanceMeters(guess, answer);
  const score = Math.round((MAX_SCORE / 2) * Math.exp(-distance / (areaSizeMeters(g.area) * 0.07)));
  return { distance, score, answerRegion, guessRegion, correct: false };
}

// 結果に出す「あなたの答え」（地点は距離、国・都道府県は名前と正誤）
function guessResultText(g, r) {
  if (!r.guess) return "時間切れ";
  if (!isRegionMode(g)) return formatDistance(r.distance);
  return `${r.correct ? "✓" : "✗"} ${regionName(g.guessMode, r.guessRegion)}`;
}

// 区画（国・都道府県）を地図に塗る
function regionPolygon(mode, id, color, opacity) {
  const r = regionInfo(mode, id);
  if (!r) return null;
  return new google.maps.Polygon({
    paths: r.rings.map((ring) => ring.map(([lng, lat]) => ({ lat, lng }))),
    strokeColor: color, strokeOpacity: 0.95, strokeWeight: 2, fillColor: color, fillOpacity: opacity,
    clickable: false, zIndex: 0,
  });
}

const REGION_RIGHT_LINES = [
  "正解！お見事🎯", "ばっちり当たり！✨", "その読み、正確です👏", "迷わず正解！さすが😎",
  "当たり！地理に強いですね📚", "完璧！次も当てましょう🔥",
];

function regionReaction(g, r) {
  if (!r || !r.guess) return reactionFor(null, false);
  if (r.correct) return REGION_RIGHT_LINES[Math.floor(rand() * REGION_RIGHT_LINES.length)];
  return reactionFor(r.distance, false);
}

// 設定シートの「当て方」
function renderGuessTabs(area) {
  const modes = guessModesFor(area);
  if (!modes.includes(state.guessMode)) state.guessMode = "pin";
  $("guess-row").hidden = modes.length < 2;
  $("guess-tabs").innerHTML = modes.map((m) =>
    `<button class="tab${m === state.guessMode ? " active" : ""}" data-guess="${m}">${GUESS_MODES[m].tab}</button>`).join("");
  $("guess-help").textContent = GUESS_MODES[state.guessMode].help;
  // 国・都道府県を当てるときは、数メートル単位のエクストラモードは使えない
  const region = state.guessMode !== "pin";
  document.querySelector(".hardcore-row").hidden = region;
  $("hardcore-help").hidden = region;
  $("guess-tabs").querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => {
    state.guessMode = b.dataset.guess;
    renderGuessTabs(area);
  }));
}

function guessIdleText(g) {
  return isRegionMode(g) ? `${GUESS_MODES[g.guessMode].noun}をクリックして選ぶ` : "ピンをマップに配置する";
}

// 記録の点がどの区画（県・州など）か。何度も描き直すので結果を覚えておく
function regionOfRound(r) {
  const key = `${r.lat},${r.lng}`;
  if (!regionCache.has(key)) regionCache.set(key, regionNear(r.lat, r.lng));
  return regionCache.get(key);
}

// 世界地図は正距円筒図法: x = 経度 + 180、y = 85 − 緯度（南緯60度より南は切る）
const projX = (lng) => lng + 180;
const projY = (lat) => 85 - lat;
const FULL_VIEW = { x: 0, y: 0, w: 360, h: 150 };
const ringsToPath = (rings) => rings.map((r) => "M" + r.map(([x, y]) => `${projX(x).toFixed(2)},${projY(y).toFixed(2)}`).join("L") + "Z").join("");
let worldPaths = null;

function getWorldPaths() {
  if (!worldPaths) worldPaths = WORLD.map((c) => ({ id: c.id, name: c.name, d: ringsToPath(c.rings) }));
  return worldPaths;
}

// カテゴリに合わせて、地図の見せる範囲（viewBox）を決める
function progressViewBox(areas, cat) {
  if (cat === "all" || !areas.length) return { ...FULL_VIEW };
  let w = 180, e = -180, so = 90, n = -90;
  areas.forEach((a) => {
    const b = areaBounds(a);
    w = Math.min(w, b.west); e = Math.max(e, b.east); so = Math.min(so, b.south); n = Math.max(n, b.north);
  });
  // 小さなマップでも周りの国が見えるよう、最低でも横60度は見せる
  const cx = (projX(w) + projX(e)) / 2, cy = (projY(n) + projY(so)) / 2;
  let vw = Math.max(60, (projX(e) - projX(w)) * 1.6);
  const vh = Math.max(vw / 2.4, (projY(so) - projY(n)) * 1.6);
  vw = vh * 2.4;
  return { x: cx - vw / 2, y: cy - vh / 2, w: vw, h: vh };
}

function setProgressView(vb) {
  // 拡大しすぎ・縮小しすぎを防ぐ（横 2度〜360度）
  const w = Math.max(2, Math.min(360, vb.w));
  const h = w / 2.4;
  const cx = vb.x + vb.w / 2, cy = vb.y + vb.h / 2;
  state.progressView = { x: cx - w / 2, y: cy - h / 2, w, h };
  const v = state.progressView;
  $("world-map").setAttribute("viewBox", `${v.x} ${v.y} ${v.w} ${v.h}`);
}

// 地図の中の点（割合 fx, fy）を中心に拡大・縮小する
function zoomProgress(factor, fx = 0.5, fy = 0.5) {
  const v = state.progressView;
  const px = v.x + v.w * fx, py = v.y + v.h * fy;
  const w = Math.max(2, Math.min(360, v.w * factor));
  const h = w / 2.4;
  setProgressView({ x: px - w * fx, y: py - h * fy, w, h });
}

// 拡大ボタン・ドラッグ移動・ホイール拡大
function bindProgressMap() {
  const svg = $("world-map");
  $("btn-pm-in").addEventListener("click", () => zoomProgress(1 / 1.6));
  $("btn-pm-out").addEventListener("click", () => zoomProgress(1.6));
  $("btn-pm-reset").addEventListener("click", () => setProgressView(state.progressHome));
  svg.addEventListener("wheel", (e) => {
    e.preventDefault();
    const r = svg.getBoundingClientRect();
    zoomProgress(e.deltaY < 0 ? 1 / 1.25 : 1.25, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
  }, { passive: false });
  let drag = null;
  svg.addEventListener("pointerdown", (e) => {
    drag = { x: e.clientX, y: e.clientY, view: { ...state.progressView } };
    svg.setPointerCapture(e.pointerId);
    svg.classList.add("dragging");
  });
  svg.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const r = svg.getBoundingClientRect();
    const k = drag.view.w / r.width;
    setProgressView({ ...drag.view, x: drag.view.x - (e.clientX - drag.x) * k, y: drag.view.y - (e.clientY - drag.y) * k });
  });
  const end = () => { drag = null; svg.classList.remove("dragging"); };
  svg.addEventListener("pointerup", end);
  svg.addEventListener("pointercancel", end);
}

function renderProgress(cat) {
  const h = loadHistory();
  const level = (n) => (!n ? 0 : n < 5 ? 1 : n < 20 ? 2 : 3);

  // 遊んだ区画（県・州など）ごとのラウンド数
  const regionCounts = new Map();
  const countries = new Set();
  h.rounds.forEach((r) => {
    if (r.c) countries.add(r.c);
    const id = regionOfRound(r);
    if (id) regionCounts.set(id, (regionCounts.get(id) || 0) + 1);
  });

  // 国の形は下地として薄く、遊んだ区画だけを濃さで塗る
  const base = getWorldPaths()
    .map((c) => `<path class="country" d="${c.d}"><title>${escapeHtml(c.name)}</title></path>`)
    .join("");
  const played = [...regionCounts].map(([id, n]) => {
    const reg = regionById.get(id);
    if (!reg) return "";
    if (!reg.path) reg.path = ringsToPath(reg.rings);
    return `<path class="region lv-${level(n)}" d="${reg.path}"><title>${escapeHtml(reg.name)}: ${n} ラウンド</title></path>`;
  }).join("");

  const svg = $("world-map");
  svg.innerHTML = `<rect class="ocean" x="-720" y="-300" width="1800" height="750"/>${base}${played}`;
  state.progressHome = progressViewBox(areasInCategory(cat), cat);
  setProgressView(state.progressHome);

  // 数字のまとめ
  const presetsPlayed = PRESETS.filter((a) => h.games[a.id]).length;
  const pct = PRESETS.length ? Math.round((presetsPlayed / PRESETS.length) * 100) : 0;
  const games = Object.values(h.games).reduce((sum, g) => sum + g.played, 0);
  const avg = h.rounds.length ? Math.round(h.rounds.reduce((sum, r) => sum + r.score, 0) / h.rounds.length) : 0;
  $("progress-stats").innerHTML = `
    <div class="ring" style="--p:${pct}"><div><b>${pct}%</b><span>マップ制覇</span></div></div>
    <div class="stat-grid">
      <div><b>${presetsPlayed}<small> / ${PRESETS.length}</small></b><span>遊んだマップ</span></div>
      <div><b>${countries.size}</b><span>訪れた国</span></div>
      <div><b>${regionCounts.size}</b><span>訪れた区画（県・州など）</span></div>
      <div><b>${games}</b><span>ゲーム数</span></div>
      <div><b>${h.rounds.length}</b><span>ラウンド数</span></div>
      <div><b>${avg.toLocaleString()}<small> / ${MAX_SCORE.toLocaleString()}</small></b><span>平均スコア</span></div>
    </div>`;
}

// ---------------------------------------------------------------- スコアのランキング

const MAX_SCORES_PER_BOARD = 50;
const DEFAULT_AVATAR = `<svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="24" fill="#2b3a5c"/><circle cx="24" cy="19" r="8" fill="#c9d4ea"/><path d="M9 40c2.5-8 8.5-12 15-12s12.5 4 15 12" fill="#c9d4ea"/></svg>`;

function loadScores() {
  return loadJSON(STORE_SCORES, {});
}

// ランキングは「同じ条件で遊んだもの」どうしで比べる（ラウンド数・ライフ制の難易度ごと）
function boardOf(g) {
  const base = g.mode === "life" ? `life-${g.difficulty}-${g.maxLife}${g.hardcore ? "-x" : ""}` : `rounds-${g.rounds}`;
  // 国・都道府県を当てたゲームは、別の部門にする（例: rounds-5@country）
  return isRegionMode(g) ? `${base}@${g.guessMode}` : base;
}

function boardLabel(key) {
  const [rule, guess] = key.split("@");
  const [mode, a, b, x] = rule.split("-");
  const suffix = GUESS_MODES[guess] ? `・${GUESS_MODES[guess].noun}当て` : "";
  if (mode === "rounds") return `${a}ラウンド${suffix}`;
  const label = a === "custom" ? `ライフ ${Number(b).toLocaleString()}` : `ライフ・${DIFFICULTY_NAMES[a] || a}`;
  return (x ? `${label}・🔥エクストラ` : label) + suffix;
}

// 並べ方: ラウンド制は点数が高い順、ライフ制は生き残ったラウンド数 → 点数の順。同点なら早い方が上
function sortEntries(list, key) {
  const life = key.startsWith("life");
  return list.sort((x, y) =>
    (life ? y.rounds - x.rounds : 0) || y.score - x.score || x.timeMs - y.timeMs || x.date - y.date);
}

function formatPlayTime(ms) {
  const sec = Math.round(ms / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

function avatarHtml(icon) {
  return icon ? `<img src="${icon}" alt="">` : DEFAULT_AVATAR;
}

// 最後まで遊んだゲームだけランキングに残せる（途中でやめたものは条件が揃わないため）
function canSaveScore(g) {
  if (!g.results.length) return false;
  return g.mode === "life" ? g.life <= 0 : g.results.length >= g.rounds;
}

function renderSavePrompt(g) {
  const box = document.createElement("div");
  box.className = "save-prompt";
  if (!canSaveScore(g)) {
    box.innerHTML = `<p class="muted">途中で終わったゲームは、ランキングに残せません。</p>`;
  } else if (g.savedRank) {
    box.innerHTML = `<p class="saved">ランキングに記録しました（${boardLabel(boardOf(g))}で ${g.savedRank} 位）</p>`;
  } else {
    box.innerHTML = `<p>このスコアをランキングに残しますか？</p>
      <div class="save-buttons"><button class="primary" data-act="save">残す</button><button class="secondary" data-act="skip">残さない</button></div>`;
    box.querySelector('[data-act="save"]').addEventListener("click", () => openScoreDialog(g, box));
    box.querySelector('[data-act="skip"]').addEventListener("click", () => {
      box.innerHTML = `<p class="muted">今回のスコアは残しませんでした。</p>`;
    });
  }
  $("result-text").appendChild(box);
}

// ---- スコアを記録するダイアログ

const scoreForm = { icon: null, game: null, box: null };

function openScoreDialog(g, box) {
  const profile = loadJSON(STORE_PROFILE, {});
  scoreForm.icon = profile.icon || null;
  scoreForm.game = g;
  scoreForm.box = box;
  const total = g.results.reduce((sum, r) => sum + r.score, 0);
  $("score-summary").innerHTML = `
    <div><span>マップ</span><b>${escapeHtml(g.area.name)}</b></div>
    <div><span>${g.mode === "life" ? "生き残り" : "スコア"}</span><b>${g.mode === "life" ? `${g.results.length} ラウンド` : `${total.toLocaleString()} 点`}</b></div>
    <div><span>タイム</span><b>${formatPlayTime(g.playMs || 0)}</b></div>
    <div><span>部門</span><b>${boardLabel(boardOf(g))}</b></div>`;
  $("score-name").value = profile.name || "";
  $("avatar-preview").innerHTML = avatarHtml(scoreForm.icon);
  $("score-dialog").hidden = false;
  $("score-name").focus();
}

function closeScoreDialog() {
  $("score-dialog").hidden = true;
}

function saveScore() {
  const g = scoreForm.game;
  const name = $("score-name").value.trim() || "名無しの旅人";
  const entry = {
    id: `s-${Date.now()}`,
    name,
    icon: scoreForm.icon,
    score: g.results.reduce((sum, r) => sum + r.score, 0),
    max: g.results.length * MAX_SCORE,
    rounds: g.results.length,
    timeMs: g.playMs || 0,
    date: Date.now(),
    rules: rulesText(g),
  };
  const key = boardOf(g);
  const all = loadScores();
  const boards = all[g.area.id] || {};
  const list = sortEntries([...(boards[key] || []), entry], key).slice(0, MAX_SCORES_PER_BOARD);
  boards[key] = list;
  all[g.area.id] = boards;
  saveJSON(STORE_SCORES, all);
  // 次回のために名前とアイコンを覚えておく
  saveJSON(STORE_PROFILE, { name, icon: scoreForm.icon });
  const rank = list.findIndex((e) => e.id === entry.id) + 1;
  g.savedRank = rank || `${MAX_SCORES_PER_BOARD}位圏外`;
  closeScoreDialog();
  const box = scoreForm.box;
  box.innerHTML = rank
    ? `<p class="saved">ランキングに記録しました！ <b>${boardLabel(key)}で ${rank} 位</b></p>`
    : `<p class="saved">記録しましたが、上位 ${MAX_SCORES_PER_BOARD} 件には入りませんでした。</p>`;
}

// 選んだ画像を 128px の正方形に切り抜いて小さくする（保存する量を減らすため）
function readAvatar(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        const size = 128;
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = size;
        const side = Math.min(img.width, img.height);
        canvas.getContext("2d").drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
        resolve(canvas.toDataURL("image/jpeg", 0.85));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function bindScoreDialog() {
  const pick = () => $("avatar-file").click();
  $("avatar-preview").addEventListener("click", pick);
  $("btn-avatar-pick").addEventListener("click", pick);
  $("avatar-file").addEventListener("change", async () => {
    const file = $("avatar-file").files[0];
    $("avatar-file").value = "";
    if (!file) return;
    try {
      scoreForm.icon = await readAvatar(file);
      $("avatar-preview").innerHTML = avatarHtml(scoreForm.icon);
    } catch {
      showMessage("画像を読み込めませんでした。別の画像を選んでください。");
    }
  });
  $("btn-avatar-reset").addEventListener("click", () => {
    scoreForm.icon = null;
    $("avatar-preview").innerHTML = avatarHtml(null);
  });
  $("btn-to-ranking").addEventListener("click", () => $("ranking").scrollIntoView({ behavior: "smooth", block: "start" }));
  $("score-save").addEventListener("click", saveScore);
  $("score-cancel").addEventListener("click", closeScoreDialog);
  $("score-dialog").querySelector(".dialog-backdrop").addEventListener("click", closeScoreDialog);
  $("score-name").addEventListener("keydown", (e) => { if (e.key === "Enter") saveScore(); });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("score-dialog").hidden) {
      e.stopPropagation();
      closeScoreDialog();
    }
  }, true);
}

// ---- 設定シートの下に出すランキング

function renderRanking(areaId, key) {
  const boards = loadScores()[areaId] || {};
  const keys = Object.keys(boards).filter((k) => boards[k].length)
    .sort((a, b) => (a.startsWith("life") - b.startsWith("life")) || parseInt(a.split("-")[1], 10) - parseInt(b.split("-")[1], 10));
  // いま選んでいるルールの部門があればそれを、なければ記録のある最初の部門を出す
  const current = state.mode === "life" ? null : `rounds-${$("opt-rounds").value}`;
  const active = key || (keys.includes(current) ? current : keys[0]);
  $("board-tabs").innerHTML = keys.map((k) => `<button data-board="${k}" class="${k === active ? "active" : ""}">${boardLabel(k)}</button>`).join("");
  $("board-tabs").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => renderRanking(areaId, b.dataset.board)));

  const list = active ? boards[active] : [];
  $("ranking-empty").hidden = list.length > 0;
  const life = active && active.startsWith("life");
  const main = (e) => (life ? `${e.rounds} ラウンド` : `${e.score.toLocaleString()} 点`);
  const sub = (e) => (life ? `${e.score.toLocaleString()} 点 ・ ${formatPlayTime(e.timeMs)}` : formatPlayTime(e.timeMs));
  const date = (e) => new Date(e.date).toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" });

  // 1〜3位は表彰台（左から 2位・1位・3位）
  const medals = ["gold", "silver", "bronze"];
  $("podium").innerHTML = [1, 0, 2].map((i) => {
    const e = list[i];
    if (!e) return `<div class="podium-slot empty ${medals[i]}"></div>`;
    return `<div class="podium-slot ${medals[i]}" style="--d:${i}">
      ${i === 0 ? '<div class="crown">👑</div>' : ""}
      <div class="avatar ring">${avatarHtml(e.icon)}<span class="medal">${i + 1}</span></div>
      <b class="p-name">${escapeHtml(e.name)}</b>
      <span class="p-score">${main(e)}</span>
      <span class="p-time">${sub(e)}</span>
      <div class="step"><span>${i + 1}</span></div>
    </div>`;
  }).join("");
  $("podium").hidden = list.length === 0;

  $("ranking-list").innerHTML = list.slice(3).map((e, i) => `
    <li style="--d:${i}">
      <span class="r-rank">${i + 4}</span>
      <span class="avatar small">${avatarHtml(e.icon)}</span>
      <span class="r-name">${escapeHtml(e.name)}</span>
      <span class="r-score">${main(e)}</span>
      <span class="r-time">${sub(e)}</span>
      <span class="r-date">${date(e)}</span>
    </li>`).join("");
}

// ---------------------------------------------------------------- 設定シート

function openSettings(id) {
  const area = findArea(id);
  state.selectedAreaId = area.id;
  saveSettings();
  $("sheet-title").textContent = area.name;
  $("sheet-cat").textContent = categoryLabel(area);
  $("sheet-desc").innerHTML = `${escapeHtml(areaSummary(area))} ${difficultyBadge(area)} ${recordBadge(area)}`;
  const hero = $("sheet-hero");
  const cover = area.image ? area.image.src : area.cover;
  hero.style.backgroundImage = cover ? `url('${cover}')` : "";
  hero.classList.toggle("custom", !cover);
  hero.style.setProperty("--ac", area.color || AREA_COLORS[0]);
  hero.querySelector(".hero-custom")?.remove();
  if (!cover) {
    hero.insertAdjacentHTML("afterbegin", `<div class="hero-custom">${customVisual(area)}</div>`);
    hydrateThumbs(hero, area);
  }
  renderUsage();
  $("settings-sheet").hidden = false;
  renderRanking(area.id);
  renderGuessTabs(area);
  decorateSheetForMulti();
  $("btn-start").focus();
}

function closeSettings() {
  $("settings-sheet").hidden = true;
}

function saveSettings() {
  saveJSON(STORE_SETTINGS, {
    areaId: state.selectedAreaId,
    mode: state.mode,
    rounds: $("opt-rounds").value,
    difficulty: $("opt-difficulty").value,
    customLife: $("opt-life").value,
    hardcore: $("opt-hardcore").checked,
    move: $("opt-move").checked,
    pan: $("opt-pan").checked,
    zoom: $("opt-zoom").checked,
    timer: $("opt-timer").checked,
    time: $("opt-time").value,
  });
}

// ---------------------------------------------------------------- 方位ベルト

const TAPE_PX_PER_DEG = 2;
const TAPE_LABELS = { 0: "北", 45: "北東", 90: "東", 135: "南東", 180: "南", 225: "南西", 270: "西", 315: "北西" };

// -360°〜720° の目盛りを並べておき、向きに合わせて横にずらす（つなぎ目が見えないように3周分）
function buildHeadingTape() {
  const strip = $("heading-strip");
  const html = [];
  for (let deg = -360; deg <= 720; deg += 15) {
    const x = (deg + 360) * TAPE_PX_PER_DEG;
    const d = ((deg % 360) + 360) % 360;
    const label = TAPE_LABELS[d];
    html.push(`<div class="tick${label ? " major" : ""}" style="left:${x}px"></div>`);
    if (label) html.push(`<div class="tick-label${d === 0 ? " north" : ""}" style="left:${x}px">${label}</div>`);
  }
  strip.innerHTML = html.join("");
  strip.style.width = `${1080 * TAPE_PX_PER_DEG}px`;
}

function updateHeadingTape(heading) {
  const h = ((heading % 360) + 360) % 360;
  const center = $("heading-tape").clientWidth / 2;
  $("heading-strip").style.transform = `translateX(${center - (h + 360) * TAPE_PX_PER_DEG}px)`;
}

// ---------------------------------------------------------------- 制限時間

function formatTime(sec) {
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

function updateTimerSettings() {
  // チーム戦の制限時間はロビーで決めるので、設定シートでは出さない
  const team = !!(state.mp && state.mp.role === "host" && state.mp.config && state.mp.config.mode === "team");
  $("timer-switch-row").hidden = team;
  $("timer-row").hidden = team || !$("opt-timer").checked;
  $("time-label").textContent = `${$("opt-time").value}秒`;
}

// seconds を渡すと、その秒数から数え直す（マルチプレイで誰かが回答して、残りが短くなったとき）
function startTimer(seconds = state.game.timeLimit) {
  stopTimer();
  const pill = $("timer-pill");
  pill.hidden = !seconds;
  pill.classList.remove("urgent", "beat");
  if (!seconds) return;
  const deadline = Date.now() + seconds * 1000;
  state.timerDeadline = deadline;
  let shown = null;
  let flashed = false;
  const tick = () => {
    const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    if (left === shown) return;
    shown = left;
    $("timer-text").textContent = formatTime(left);
    pill.classList.toggle("urgent", left <= 10);
    // 残り 15 秒になったら、1回だけ画面のふちを赤くボワッと光らせる
    if (!flashed && left <= 15 && left > 0) {
      flashed = true;
      const edge = $("danger-edge");
      edge.hidden = false;
      edge.classList.remove("flash");
      void edge.offsetWidth;
      edge.classList.add("flash");
      clearTimeout(state.edgeTimer);
      state.edgeTimer = setTimeout(() => { edge.hidden = true; }, 1600);
    }
    // 残り10秒からは、1秒減るたびにビクッと動かす（アニメーションを最初からやり直す）
    if (left <= 10) {
      pill.classList.remove("beat");
      void pill.offsetWidth;
      pill.classList.add("beat");
    }
    if (left <= 0) {
      stopTimer();
      submitGuess(true);
    }
  };
  tick();
  state.timer = setInterval(tick, 250);
}

function stopTimer() {
  $("danger-edge").hidden = true;
  state.timerDeadline = null;
  clearInterval(state.timer);
  state.timer = null;
}

// 結果画面に出す「どんなルールで遊んだか」の短い説明
function rulesText(g) {
  const parts = [
    g.move ? "移動あり" : "移動なし",
    g.pan ? null : "見回しなし",
    g.zoom ? null : "ズームなし",
    g.timeLimit ? `制限時間 ${g.timeLimit}秒` : null,
    g.hardcore ? "🔥エクストラ" : null,
    isRegionMode(g) ? `${GUESS_MODES[g.guessMode].noun}当て` : null,
  ].filter(Boolean);
  return `（${parts.join("・")}）`;
}

// ---------------------------------------------------------------- ライフ制

const LIFE_PRESETS = { easy: 50000, normal: 25000, hard: 12500 };
const DIFFICULTY_NAMES = { easy: "多め", normal: "ふつう", hard: "少なめ", custom: "カスタム" };

function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll("#mode-tabs .tab").forEach((t) => t.classList.toggle("active", t.dataset.mode === mode));
  $("rounds-row").hidden = mode !== "rounds";
  $("life-row").hidden = mode !== "life";
  $("custom-life-row").hidden = $("opt-difficulty").value !== "custom";
}

function selectedLife() {
  const d = $("opt-difficulty").value;
  if (d !== "custom") return LIFE_PRESETS[d];
  const v = Math.round(Number($("opt-life").value));
  return Number.isFinite(v) ? Math.min(500000, Math.max(500, v)) : 25000;
}

// 外した度合いに応じて減るライフ。得点の裏返しなので、近ければ少し・遠ければ最大 5000
const HARDCORE_DECAY = 2000;

// エクストラモード: 5m 未満は減らさず、5m からは最低でも 10 減る。範囲の広さに関係なく 2km を目安に減らし、数メートルのずれでも少し減る。
// 狭い範囲ではふつうの方が厳しいこともあるので、ふつうより減る量が少なくならないようにする
function damageFor(score, distance, hardcore) {
  const normal = MAX_SCORE - score;
  if (!hardcore) return normal;
  if (distance == null) return MAX_SCORE; // 時間切れ
  if (distance < 5) return normal;
  const strict = Math.max(10, Math.round(MAX_SCORE * (1 - Math.exp(-distance / HARDCORE_DECAY))));
  return Math.max(normal, strict);
}

function lifeBar(life, max) {
  return `<span class="lifebar"><span style="width:${(life / max) * 100}%;background:${lifeColor(life / max)}"></span></span>`;
}

// ライフのバーの色: 40% までは緑、20% あたりで黄色、10% を切ると赤（間はなめらかに変える）
function lifeColor(ratio) {
  const p = Math.max(0, Math.min(1, ratio)) * 100;
  const hue = p >= 40 ? 130 : p >= 20 ? 50 + ((p - 20) / 20) * 80 : p >= 10 ? ((p - 10) / 10) * 50 : 0;
  return `linear-gradient(180deg, hsl(${hue} 85% 60%), hsl(${hue} 80% 42%))`;
}

function renderLifeHud() {
  const g = state.game;
  const show = !!(g && g.mode === "life" && !g.multi);
  $("life-hud").hidden = !show;
  $("info-card").hidden = show;
  if (!show) return;
  const fill = document.querySelector("#life-hud .lh-fill");
  const ratio = g.life / g.maxLife;
  const from = state.lifeShown != null && state.lifeShown >= g.life ? state.lifeShown : g.life;
  fill.style.width = `${ratio * 100}%`;
  fill.style.background = lifeColor(ratio);
  if (from !== g.life && typeof countNumber === "function") countNumber($("lh-life"), from, g.life);
  else $("lh-life").textContent = g.life.toLocaleString();
  state.lifeShown = g.life;
  $("lh-extra").hidden = !g.hardcore;
  $("lh-area").textContent = g.area.name;
  $("lh-round").textContent = g.index + 1;
  $("lh-score").textContent = g.results.reduce((s, r) => s + r.score, 0).toLocaleString();
}

function renderHudLife() {
  const g = state.game;
  renderLifeHud();
  // エクストラモード中は、右上のカードに目立つ印を出す
  $("info-extra").hidden = !g.hardcore;
  $("info-card").classList.toggle("extra", !!g.hardcore);
  $("info-life-box").hidden = g.mode !== "life";
  if (g.mode !== "life") return;
  $("info-life-box").querySelector(".lifebar > span").style.width = `${(g.life / g.maxLife) * 100}%`;
  $("info-life").textContent = g.life.toLocaleString();
}

// ---------------------------------------------------------------- 自作の範囲の見た目（メモ・色・カバー画像）

const AREA_COLORS = ["#2fb36b", "#3b82f6", "#a855f7", "#f97316", "#ec4899", "#14b8a6", "#f5c542", "#e5392f"];
// 範囲エディタで入力中の色とカバー画像
const areaForms = { area: { color: AREA_COLORS[0], cover: null } };

function renderAreaForm(prefix) {
  const form = areaForms[prefix];
  $(`${prefix}-color`).innerHTML = AREA_COLORS.map((c) =>
    `<button class="swatch${c === form.color ? " active" : ""}" data-c="${c}" style="--c:${c}" aria-label="色 ${c}"></button>`).join("");
  $(`${prefix}-color`).querySelectorAll(".swatch").forEach((b) => b.addEventListener("click", () => {
    form.color = b.dataset.c;
    renderAreaForm(prefix);
  }));
  const preview = $(`${prefix}-cover-preview`);
  preview.style.backgroundImage = form.cover ? `url('${form.cover}')` : "";
  preview.classList.toggle("has", !!form.cover);
  preview.style.setProperty("--c", form.color);
  $(`btn-${prefix}-cover-remove`).hidden = !form.cover;
}

// カバー画像は、カードの形（16:10）に切り抜いて小さくしてから保存する
function readCover(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        const w = 640, h = 400;
        const scale = Math.max(w / img.width, h / img.height);
        const sw = w / scale, sh = h / scale;
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        canvas.getContext("2d").drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", 0.8));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function bindAreaForm(prefix) {
  $(`btn-${prefix}-cover`).addEventListener("click", () => $(`${prefix}-cover-file`).click());
  $(`${prefix}-cover-preview`).addEventListener("click", () => $(`${prefix}-cover-file`).click());
  $(`${prefix}-cover-file`).addEventListener("change", async () => {
    const input = $(`${prefix}-cover-file`);
    const file = input.files[0];
    input.value = "";
    if (!file) return;
    try {
      areaForms[prefix].cover = await readCover(file);
      renderAreaForm(prefix);
    } catch {
      showMessage("画像を読み込めませんでした。別の画像を選んでください。");
    }
  });
  $(`btn-${prefix}-cover-remove`).addEventListener("click", () => {
    areaForms[prefix].cover = null;
    renderAreaForm(prefix);
  });
}

// ---------------------------------------------------------------- 範囲エディタ

const EDIT_COLOR = AREA_LINE_COLOR;
const EDIT_ERROR_COLOR = "#ff5a4e";

// editId を渡すと、保存してある自作の範囲を読み込んで編集する（形も見た目も変えられる）
function openEditor(editId) {
  if (!ensureMap()) return;
  closeSettings();
  const editing = typeof editId === "string" ? loadJSON(STORE_AREAS, []).find((a) => a.id === editId) : null;
  state.editor = { tool: "circle", circles: [], polygon: null, added: [], selected: null, editingId: editing ? editing.id : null };
  setScreen("editor");
  $("editor-eyebrow").textContent = editing ? "EDIT" : "CREATE";
  $("editor-title").textContent = editing ? "範囲を編集" : "範囲を作る";
  $("btn-save-area").textContent = editing ? "変更を保存する" : "保存する";
  $("area-name").value = editing ? editing.name : "";
  $("area-category").value = editing
    ? editing.category || "custom"
    : state.category && !["all", "custom"].includes(state.category) ? state.category : "custom";
  // 色は、まだ使っていない色から順に選んでおく（カードが見分けやすいように）
  const used = new Set(loadJSON(STORE_AREAS, []).map((a) => a.color));
  areaForms.area = editing
    ? { color: editing.color || AREA_COLORS[0], cover: editing.cover || null }
    : { color: AREA_COLORS.find((c) => !used.has(c)) || AREA_COLORS[0], cover: null };
  $("area-desc").value = editing ? editing.description || "" : "";
  renderAreaForm("area");
  clearOverlay();
  state.map.setOptions({ draggableCursor: "crosshair" });
  setTool(editing && editing.type === "polygons" ? "polygon" : "circle");
  if (editing) loadEditorShapes(editing);
}

// 保存してある範囲の図形を、エディタで動かせる図形として置き直す
function loadEditorShapes(area) {
  const ed = state.editor;
  const circles = areaCircles(area);
  if (circles) {
    circles.forEach((c) => addEditorCircle(new google.maps.LatLng(c.center.lat, c.center.lng), c.radius));
  } else {
    const path = ensureEditorPolygon().getPath();
    area.rings[0].forEach(([lat, lng]) => path.push(new google.maps.LatLng(lat, lng)));
    ed.selected = ed.polygon;
  }
  state.map.fitBounds(areaBounds(area), 40);
  updateEditorStatus();
}

function clearEditorShapes() {
  const ed = state.editor;
  ed.circles.forEach((c) => c.setMap(null));
  if (ed.polygon) ed.polygon.setMap(null);
  ed.circles = [];
  ed.polygon = null;
  ed.added = [];
  ed.selected = null;
}

function setTool(tool) {
  const ed = state.editor;
  clearEditorShapes();
  ed.tool = tool;
  document.querySelectorAll("#editor-panel .tab").forEach((t) => t.classList.toggle("active", t.dataset.tool === tool));
  $("radius-row").hidden = tool !== "circle";
  $("btn-undo").title = tool === "circle" ? "最後の円を消す" : "最後の点を消す";
  const steps = tool === "circle"
    ? ["地図をクリックして円を置く", "スライダーで大きさを決める", "円の中をドラッグで移動、縁の白い点で大きさを調整", "消すときは下の一覧の「削除」か、円を選んで Delete キー"]
    : ["地図をクリックして頂点を3つ以上置く", "点は形が崩れない位置に自動で入る", "図形の中をドラッグで移動、白い点で形を整える", "消すときは下の一覧の「削除」か Delete キー"];
  $("editor-help").innerHTML = steps.map((t) => `<li>${t}</li>`).join("");
  updateRadiusLabel();
  updateEditorStatus();
}

function updateRadiusLabel() {
  $("radius-label").textContent = formatDistance(Number($("radius").value));
}

function editorShapeOptions() {
  // 編集できる図形は、クリックが地図に届かなくなるので自分でも受け取る
  return {
    map: state.map, strokeColor: EDIT_COLOR, strokeWeight: 2,
    fillColor: EDIT_COLOR, fillOpacity: 0.15, editable: true, clickable: true,
    // 図形そのものを掴んで動かせるようにする
    draggable: true,
  };
}

function editorClick(latLng) {
  const ed = state.editor;
  if (Date.now() < (ed.suppressClickUntil || 0)) return;
  if (ed.tool === "circle") {
    addEditorCircle(latLng, Number($("radius").value));
  } else {
    addPolygonPoint(latLng);
  }
  updateEditorStatus();
}

function addEditorCircle(center, radius) {
  const circle = new google.maps.Circle({ ...editorShapeOptions(), center, radius });
  circle.addListener("click", () => selectShape(circle));
  ["center_changed", "radius_changed"].forEach((ev) => circle.addListener(ev, updateEditorStatus));
  bindShapeHover(circle);
  state.editor.circles.push(circle);
  selectShape(circle);
}

function ensureEditorPolygon() {
  const ed = state.editor;
  if (ed.polygon) return ed.polygon;
  ed.polygon = new google.maps.Polygon(editorShapeOptions());
  ed.polygon.setPath(new google.maps.MVCArray());
  ed.polygon.addListener("click", (e) => { if (e.vertex == null && e.edge == null) editorClick(e.latLng); });
  // 図形ごと動かしたあとも、広さや場所の表示を更新する
  ed.polygon.addListener("dragend", updateEditorStatus);
  const path = ed.polygon.getPath();
  ["insert_at", "set_at", "remove_at"].forEach((ev) => path.addListener(ev, updateEditorStatus));
  bindShapeHover(ed.polygon);
  return ed.polygon;
}

// 平面とみなして計算するための座標（経度は緯度に応じて縮める）
function toXY(latLng, refLat) {
  return { x: latLng.lng() * Math.cos((refLat * Math.PI) / 180), y: latLng.lat() };
}

// 新しい頂点を「周の長さが一番伸びない辺」に差し込む。クリック順に関係なく、形が交差しにくくなる
function addPolygonPoint(latLng) {
  const ed = state.editor;
  ensureEditorPolygon();
  ed.selected = ed.polygon;
  const path = ed.polygon.getPath();
  const pts = path.getArray();
  let index = pts.length;
  if (pts.length >= 3) {
    const ref = latLng.lat();
    const p = toXY(latLng, ref);
    const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    let best = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const a = toXY(pts[i], ref);
      const b = toXY(pts[(i + 1) % pts.length], ref);
      const cost = d(a, p) + d(p, b) - d(a, b);
      if (cost < best) { best = cost; index = i + 1; }
    }
  }
  path.insertAt(index, latLng);
  ed.added.push(latLng);
}

function undoEditor() {
  const ed = state.editor;
  if (ed.tool === "circle") {
    const c = ed.circles.pop();
    if (c) c.setMap(null);
    ed.selected = ed.circles[ed.circles.length - 1] || null;
    highlightSelected();
  } else if (ed.polygon) {
    const path = ed.polygon.getPath();
    // 最後に追加した点を消す（ドラッグで動かされていたら、最後の点を消す）
    const last = ed.added.pop();
    const i = path.getArray().indexOf(last);
    if (i >= 0) path.removeAt(i);
    else if (path.getLength()) path.removeAt(path.getLength() - 1);
  }
  updateEditorStatus();
}

function segmentsCross(a, b, c, d) {
  const cross = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

function polygonSelfIntersects(latLngs) {
  const n = latLngs.length;
  if (n < 4) return false;
  const ref = latLngs[0].lat();
  const p = latLngs.map((ll) => toXY(ll, ref));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      // 隣り合う辺は端点を共有するので調べない
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      if (segmentsCross(p[i], p[(i + 1) % n], p[j], p[(j + 1) % n])) return true;
    }
  }
  return false;
}

// いま描いている範囲の広さ
function editorSizeText() {
  const ed = state.editor;
  const area = ed.tool === "circle"
    ? { type: "circles", circles: ed.circles.map((c) => ({ center: { lat: c.getCenter().lat(), lng: c.getCenter().lng() }, radius: c.getRadius() })) }
    : { type: "polygons", rings: [ed.polygon.getPath().getArray().map((p) => [p.lat(), p.lng()])] };
  return areaSummary({ ...area, custom: true });
}

// 図形の数や交差の有無を表示して、保存できる状態かを見せる
function updateEditorStatus() {
  const ed = state.editor;
  if (!ed) return;
  let text = "";
  let ok = false;
  const pts = ed.polygon ? ed.polygon.getPath().getArray() : [];
  if (ed.tool === "circle") {
    ok = ed.circles.length > 0;
    text = `円: ${ed.circles.length} 個`;
  } else {
    const crossed = polygonSelfIntersects(pts);
    if (ed.polygon) ed.polygon.setOptions({ strokeColor: crossed ? EDIT_ERROR_COLOR : EDIT_COLOR, fillColor: crossed ? EDIT_ERROR_COLOR : EDIT_COLOR });
    ok = pts.length >= 3 && !crossed;
    text = crossed ? "⚠ 線が交差しています。白い点をドラッグして直してください" : `頂点: ${pts.length} 個`;
  }
  const error = text.startsWith("⚠");
  $("editor-status").textContent = error ? text.slice(2) : text;
  $("editor-status-card").classList.toggle("error", error);
  $("editor-status-card").classList.toggle("ready", ok);
  $("editor-status-icon").textContent = error ? "!" : ok ? "✓" : "…";
  $("editor-size").textContent = ok ? editorSizeText() : ed.tool === "circle" ? "まだ円がありません" : "頂点が3つ以上必要です";
  $("editor-hint").textContent = ed.tool === "circle"
    ? (ed.circles.length ? "続けてクリックすると円を追加できます" : "地図をクリックして円を置こう")
    : (pts.length >= 3 ? "白い点をドラッグして形を整えられます" : `地図をクリックして頂点を置こう（あと ${3 - pts.length} 点）`);
  $("btn-save-area").disabled = !ok;
  $("btn-undo").disabled = ed.tool === "circle" ? !ed.circles.length : !(ed.polygon && ed.polygon.getPath().getLength());
  // 図形が動いたり大きさが変わったりしたら、一覧の表示も直す
  renderShapeList();
}

function saveEditor() {
  const ed = state.editor;
  const name = $("area-name").value.trim() || "自作の範囲";
  let area;
  if (ed.tool === "circle") {
    if (!ed.circles.length) return showMessage("地図をクリックして円を置いてください。");
    area = {
      type: "circles",
      circles: ed.circles.map((c) => ({ center: { lat: c.getCenter().lat(), lng: c.getCenter().lng() }, radius: Math.round(c.getRadius()) })),
    };
  } else {
    const pts = ed.polygon ? ed.polygon.getPath().getArray() : [];
    if (pts.length < 3) return showMessage("頂点を3つ以上置いてください。");
    if (polygonSelfIntersects(pts)) return showMessage("線が交差しているので保存できません。白い点をドラッグして直してください。");
    area = { type: "polygons", rings: [pts.map((p) => [p.lat(), p.lng()])] };
  }
  const category = $("area-category").value;
  area = {
    ...area, id: ed.editingId || `custom-${Date.now()}`, name, custom: true, category: category === "custom" ? null : category,
    description: $("area-desc").value.trim() || undefined,
    color: areaForms.area.color,
    cover: areaForms.area.cover || undefined,
  };
  const others = loadJSON(STORE_AREAS, []);
  const saved = ed.editingId ? others.map((a) => (a.id === area.id ? area : a)) : [...others, area];
  try {
    localStorage.setItem(STORE_AREAS, JSON.stringify(saved));
  } catch {
    return showMessage("保存できませんでした。ブラウザの保存容量がいっぱいかもしれません。カバー画像を外すか、使っていない範囲を削除してください。");
  }
  closeEditor();
  openSettings(area.id);
}

// ---------------------------------------------------------------- 図形の一覧と削除（パネルの一覧と Delete キー）
// 地図の上にボタンを重ねると、地図側がクリックを横取りして図形が増えてしまうことがあったため、
// 削除は地図の外（左のパネル）の一覧から行う。

function editorShapes() {
  const ed = state.editor;
  if (!ed) return [];
  return ed.tool === "circle" ? ed.circles : ed.polygon ? [ed.polygon] : [];
}

function renderShapeList() {
  const ed = state.editor;
  if (!ed) return;
  const shapes = editorShapes();
  $("shape-list").innerHTML = shapes.map((s, i) => {
    const circle = s instanceof google.maps.Circle;
    const label = circle ? `円 ${i + 1}` : "多角形";
    const sub = circle ? `半径 ${formatDistance(s.getRadius())}` : `頂点 ${s.getPath().getLength()} 個`;
    return `<li class="${s === ed.selected ? "sel" : ""}">
      <button class="sl-pick" data-i="${i}" title="この図形を選ぶ"><b>${label}</b><small>${sub}</small></button>
      <button class="sl-del" data-i="${i}" title="${label}を削除" aria-label="${label}を削除">
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>削除
      </button>
    </li>`;
  }).join("") || '<li class="empty">まだ図形がありません</li>';
}

// 一覧のボタン（一覧は描き直すので、親の要素でまとめて受け取る）
function bindShapeList() {
  $("shape-list").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-i]");
    if (!btn) return;
    const shape = editorShapes()[Number(btn.dataset.i)];
    if (!shape) return;
    if (btn.classList.contains("sl-del")) return deleteShape(shape);
    selectShape(shape);
    // 選んだ図形が見えるように地図を寄せる
    if (shape instanceof google.maps.Circle) state.map.panTo(shape.getCenter());
    else if (shape.getPath().getLength()) state.map.panTo(shape.getPath().getAt(0));
  });
}

// 選んでいる図形を目立たせる（一覧でも、地図でも）
function selectShape(shape) {
  const ed = state.editor;
  if (!ed) return;
  ed.selected = shape;
  // スライダーも、選んだ円の半径に合わせる
  if (shape instanceof google.maps.Circle) {
    $("radius").value = Math.round(shape.getRadius());
    updateRadiusLabel();
  }
  highlightSelected();
  renderShapeList();
}

function highlightSelected() {
  const ed = state.editor;
  if (!ed || ed.tool !== "circle") return;
  ed.circles.forEach((c) => c.setOptions(c === ed.selected
    ? { strokeWeight: 4, strokeColor: "#ffffff", fillOpacity: 0.28, zIndex: 2 }
    : { strokeWeight: 2, strokeColor: EDIT_COLOR, fillOpacity: 0.15, zIndex: 1 }));
}

function bindShapeHover(shape) {
  // 選ぶのはクリックとドラッグ（マウスが通っただけでは選ばない）
  shape.addListener("mousedown", () => selectShape(shape));
  shape.addListener("dragstart", () => selectShape(shape));
}

function deleteShape(shape) {
  const ed = state.editor;
  if (!ed || !shape) return;
  if (shape instanceof google.maps.Circle) {
    ed.circles = ed.circles.filter((c) => c !== shape);
  } else if (shape === ed.polygon) {
    ed.polygon = null;
    ed.added = [];
  } else {
    return;
  }
  shape.setMap(null);
  ed.selected = ed.tool === "circle" ? ed.circles[ed.circles.length - 1] || null : null;
  highlightSelected();
  updateEditorStatus();
}

function closeEditor() {
  if (state.editor) clearEditorShapes();
  state.editor = null;
  showHome();
}

// ---------------------------------------------------------------- ゲーム本体

function clearGameMarkers() {
  const g = state.game;
  if (!g) return;
  if (g.guessMarker) g.guessMarker.setMap(null);
  g.guessMarker = null;
  (g.overlays || []).forEach((o) => o.setMap(null));
  g.overlays = [];
  if (g.pickShape) g.pickShape.setMap(null);
  g.pickShape = null;
}

// ---------------------------------------------------------------- 結果表示用のピン・線・ラベル

const GUESS_COLOR = "#e5392f";
const ANSWER_COLOR = "#2fae6e";

// scale: ポンと出るアニメーションで、少しずつ大きさを変えるときに使う
function pinIcon(color, kind, scale = 1) {
  // 正解は旗、自分のピンは丸印
  const glyph = kind === "answer"
    ? '<path d="M14 9v17" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/><path d="M15 9.5h9l-2.6 3.6 2.6 3.6h-9z" fill="#fff"/>'
    : '<circle cx="18" cy="17" r="6" fill="#fff"/>';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="48" viewBox="0 0 36 48">
    <path d="M18 46.5S33.5 28.5 33.5 17A15.5 15.5 0 0 0 2.5 17C2.5 28.5 18 46.5 18 46.5Z" fill="${color}" stroke="#fff" stroke-width="2.5"/>
    ${glyph}</svg>`;
  return {
    url: "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(svg),
    scaledSize: new google.maps.Size(36 * scale, 48 * scale),
    anchor: new google.maps.Point(18 * scale, 46 * scale),
  };
}

// その場で「ポン」と出す: 小さく出て、少し大きくなってから元の大きさに戻る（約0.25秒）
function popPin(marker, color, kind) {
  const steps = [0.35, 0.7, 1.05, 1.2, 1.12, 1.0];
  steps.forEach((s, i) => setTimeout(() => {
    if (marker.getMap()) marker.setIcon(pinIcon(color, kind, s));
  }, i * 40));
}

let MapLabel = null;

// 地図上の好きな位置に HTML のラベルを置くためのオーバーレイ
function defineMapLabel() {
  MapLabel = class extends google.maps.OverlayView {
    constructor(position, html, className) {
      super();
      this.position = new google.maps.LatLng(position.lat, position.lng);
      this.div = document.createElement("div");
      this.div.className = `map-label ${className}`;
      this.div.innerHTML = html;
    }
    onAdd() { this.getPanes().floatPane.appendChild(this.div); }
    draw() {
      const p = this.getProjection().fromLatLngToDivPixel(this.position);
      if (!p) return;
      this.div.style.left = `${p.x}px`;
      this.div.style.top = `${p.y}px`;
    }
    onRemove() { this.div.remove(); }
  };
}

function addOverlay(o) {
  o.setMap(state.map);
  state.game.overlays.push(o);
  return o;
}

// 1ラウンド分の「自分のピン・正解・その間の線」を描く
function drawRoundResult(r, { tag, showDistance, guessPin }) {
  const g = state.game;
  if (isRegionMode(g)) {
    // 正解の区画は緑、はずれたときは選んだ区画を赤で塗る
    const answerShape = regionPolygon(g.guessMode, r.answerRegion || regionAt(g.guessMode, r.answer.lat, r.answer.lng), ANSWER_COLOR, 0.3);
    if (answerShape) addOverlay(answerShape);
    if (r.guess && !r.correct) {
      const guessShape = regionPolygon(g.guessMode, r.guessRegion, GUESS_COLOR, 0.25);
      if (guessShape) addOverlay(guessShape);
    }
    showDistance = false;
  }
  if (!r.guess) {
    // ピンを立てる前に時間切れになったラウンドは、正解だけを表示する
    addOverlay(new google.maps.Marker({ position: r.answer, icon: pinIcon(ANSWER_COLOR, "answer"), title: "正解", zIndex: 3 }));
    addOverlay(new MapLabel(r.answer, tag ? `${tag} 正解（時間切れ）` : "正解", "tag answer"));
    return;
  }
  if (guessPin) {
    addOverlay(new google.maps.Marker({ position: r.guess, icon: pinIcon(GUESS_COLOR, "guess"), title: "あなたのピン", zIndex: 2 }));
  }
  addOverlay(new google.maps.Marker({ position: r.answer, icon: pinIcon(ANSWER_COLOR, "answer"), title: "正解", zIndex: 3 }));
  // 白いふち + 破線で、どんな地図の上でも見やすくする
  addOverlay(new google.maps.Polyline({ path: [r.guess, r.answer], strokeColor: "#ffffff", strokeOpacity: 0.85, strokeWeight: 7, zIndex: 1 }));
  addOverlay(new google.maps.Polyline({
    path: [r.guess, r.answer], strokeOpacity: 0, zIndex: 1,
    icons: [{ icon: { path: "M 0,-1 0,1", strokeColor: "#1b2330", strokeOpacity: 1, strokeWeight: 3, scale: 3 }, offset: "0", repeat: "12px" }],
  }));
  if (showDistance && r.distance != null) {
    const mid = { lat: (r.guess.lat + r.answer.lat) / 2, lng: (r.guess.lng + r.answer.lng) / 2 };
    addOverlay(new MapLabel(mid, formatDistance(r.distance), "distance"));
  }
  addOverlay(new MapLabel(r.answer, tag ? `${tag} 正解` : "正解", "tag answer"));
  addOverlay(new MapLabel(r.guess, tag ? `${tag} あなた` : "あなた", "tag guess"));
}

function fitResults(results, padding) {
  const b = new google.maps.LatLngBounds();
  const points = results.flatMap((r) => (r.guess ? [r.guess, r.answer] : [r.answer]));
  points.forEach((p) => b.extend(p));
  // 地図のサイズが変わった直後なので、少し待ってから合わせる
  setTimeout(() => {
    if (points.length === 1) {
      state.map.setCenter(points[0]);
      state.map.setZoom(14);
    } else {
      state.map.fitBounds(b, padding);
    }
  }, 50);
}

function scoreBar(score, max) {
  return `<div class="scorebar"><div style="width:${(score / max) * 100}%"></div></div>`;
}

const LEGEND = `<div class="legend">
  <span><i class="dot guess"></i>あなたのピン</span>
  <span><i class="dot answer"></i>正解の地点</span>
</div>`;

async function startGame() {
  if (state.mp && state.mp.role === "host") return hostStartGame();
  if (!ensureMap()) return;
  closeSettings();
  const mode = state.mode;
  // ライフ制はライフが尽きるまで続くので、ラウンド数の上限はなし
  const rounds = mode === "life" ? Infinity : Number($("opt-rounds").value);
  if (remainingStreetView() < (mode === "life" ? 1 : rounds)) {
    return showMessage("今月の無料枠の上限に達しました（config.js の limits）。来月まで待つか、上限を見直してください。");
  }
  saveSettings();
  const maxLife = selectedLife();
  state.game = {
    area: findArea(state.selectedAreaId),
    move: $("opt-move").checked,
    pan: $("opt-pan").checked,
    zoom: $("opt-zoom").checked,
    timeLimit: $("opt-timer").checked ? Number($("opt-time").value) : 0,
    mode,
    difficulty: $("opt-difficulty").value,
    guessMode: state.guessMode || "pin",
    hardcore: mode === "life" && $("opt-hardcore").checked && (state.guessMode || "pin") === "pin",
    maxLife,
    life: maxLife,
    rounds,
    index: 0,
    results: [],
    overlays: [],
    usedPanos: new Set(),
    usedSpots: [],
  };
  state.lifeShown = null;
  setScreen("game");
  await startRound();
}

// 最終結果の「もう一度遊ぶ」: 同じマップ・同じルールで、はじめから遊ぶ
async function replayGame() {
  const old = state.game;
  if (!old) return;
  if (old.multi) return hostReplay();
  if (remainingStreetView() < (old.mode === "life" ? 1 : old.rounds)) {
    return showMessage("今月の無料枠の上限に達しました（config.js の limits）。来月まで待つか、上限を見直してください。");
  }
  clearGameMarkers();
  const keep = ["area", "move", "pan", "zoom", "timeLimit", "mode", "difficulty", "hardcore", "maxLife", "rounds", "guessMode"];
  state.game = {
    ...Object.fromEntries(keep.map((k) => [k, old[k]])),
    life: old.maxLife, index: 0, results: [], overlays: [], usedPanos: new Set(), usedSpots: [],
  };
  state.lifeShown = null;
  $("result").hidden = true;
  setScreen("game");
  await startRound();
}

// 結果の下のボタンを、途中のラウンド用と、最終結果用で切り替える
function setResultButtons(final, replay) {
  $("btn-replay").hidden = !replay;
  $("btn-next").className = final && replay ? "secondary" : "primary";
}

async function startRound() {
  const g = state.game;
  stopTimer();
  clearGameMarkers();
  g.guess = null;
  g.answer = null;
  $("timer-pill").hidden = true;
  $("result").hidden = true;
  $("btn-guess").disabled = true;
  $("btn-guess").textContent = guessIdleText(g);
  $("btn-back-start").hidden = !g.move;
  $("btn-zoom-in").disabled = $("btn-zoom-out").disabled = !g.zoom;
  $("info-area").textContent = g.area.name;
  $("info-round").textContent = g.mode === "life" ? `${g.index + 1}` : `${g.index + 1} / ${g.rounds}`;
  $("info-score").textContent = g.results.reduce((s, r) => s + r.score, 0).toLocaleString();
  renderHudLife();
  setScreen("game");
  drawArea(g.area);
  state.map.setOptions({ draggableCursor: "crosshair" });

  if (remainingStreetView() <= 0) {
    showMessage("今月の無料枠の上限に達したので、ゲームを終了します。");
    return showHome();
  }

  $("loading").hidden = false;
  let answer;
  try {
    answer = await findLocation(g.area, g.usedPanos, g.usedSpots);
  } catch (e) {
    $("loading").hidden = true;
    showMessage(e.message);
    return showHome();
  }
  $("loading").hidden = true;
  // 探している間に「やめる」が押された場合は表示しない（無駄な課金を防ぐ）
  if (state.game !== g || app.className !== "screen-game") return;
  g.answer = answer;
  g.usedPanos.add(g.answer.panoId);
  showPanorama(g.answer.panoId, g);
  g.roundStartedAt = Date.now();
  updateHeadingTape(state.pano.getPov().heading);
  startTimer();
}

function showPanorama(panoId, { move, pan, zoom }) {
  const opts = {
    pano: panoId,
    pov: { heading: Math.random() * 360, pitch: 0 },
    zoom: 0,
    addressControl: false,
    showRoadLabels: false,
    fullscreenControl: false,
    motionTracking: false,
    motionTrackingControl: false,
    enableCloseButton: false,
    linksControl: move,
    clickToGo: move,
    keyboardShortcuts: move,
    panControl: false,
    zoomControl: false,
    scrollwheel: zoom,
  };
  // 見回しなしのときは、この向きに固定する
  state.lockPov = opts.pov;
  // パノラマの読み込み = Dynamic Street View の課金対象。1ラウンド1回として数える
  addUsage("streetView");
  if (!state.pano) {
    state.pano = new google.maps.StreetViewPanorama($("pano"), opts);
    state.pano.addListener("pov_changed", () => {
      const pov = state.pano.getPov();
      const g = state.game;
      const lock = state.lockPov;
      if (g && !g.pan && lock && !state.spectating && (Math.abs(pov.heading - lock.heading) > 0.01 || Math.abs(pov.pitch - lock.pitch) > 0.01)) {
        state.pano.setPov(lock);
        return;
      }
      // 向いている方角に合わせてコンパスを回す
      $("compass-rose").style.transform = `rotate(${-pov.heading}deg)`;
      updateHeadingTape(pov.heading);
      if (g && g.multi) sendMyView();
    });
    state.pano.addListener("zoom_changed", () => {
      const g = state.game;
      if (g && !g.zoom && !state.spectating && state.pano.getZoom() !== 0) state.pano.setZoom(0);
      if (g && g.multi) sendMyView();
    });
    state.pano.addListener("pano_changed", () => {
      if (state.game && state.game.multi) sendMyView();
    });
  } else {
    state.pano.setOptions(opts);
    state.pano.setPano(panoId);
    state.pano.setPov(opts.pov);
    state.pano.setZoom(0);
  }
}

function placeGuess(latLng) {
  const g = state.game;
  let picked = null;
  if (isRegionMode(g)) {
    picked = regionAt(g.guessMode, latLng.lat(), latLng.lng());
    if (!picked) {
      $("btn-guess").textContent = `${GUESS_MODES[g.guessMode].noun}の上をクリックしてください`;
      return;
    }
    // 選んだ区画を塗って、どこを選んだかひと目でわかるようにする
    if (g.pickShape) g.pickShape.setMap(null);
    g.pickShape = regionPolygon(g.guessMode, picked, GUESS_COLOR, 0.3);
    if (g.pickShape) g.pickShape.setMap(state.map);
  }
  g.guess = { lat: latLng.lat(), lng: latLng.lng() };
  // 刺し直すたびに作り直して、毎回その場にポンと出す
  if (g.guessMarker) g.guessMarker.setMap(null);
  g.guessMarker = new google.maps.Marker({
    map: state.map, position: g.guess, icon: pinIcon(GUESS_COLOR, "guess", state.prefs.anim ? 0.35 : 1), title: "あなたのピン", zIndex: 2,
    // ピンの絵が上に重なっていても、クリックは地図に届けて刺し直せるようにする
    clickable: false,
  });
  if (state.prefs.anim) {
    popPin(g.guessMarker, GUESS_COLOR, "guess");
    showPinRipple(g.guess);
  }
  $("btn-guess").disabled = false;
  $("btn-guess").textContent = picked ? `「${regionName(g.guessMode, picked)}」で決定` : "決定する";
  if (g.multi) sendMyView();
}

// ---------------------------------------------------------------- 距離に応じたひとこと

// 近さごとのひとこと（同じ段階でも毎回少し変える）
const REACTIONS = [
  { max: 10, lines: [
    "は！？ ほぼ同じ場所…！！😱", "ミリ単位の精度…人間ですか？🤖", "Street View の中の人ですか？📸",
    "伝説が生まれました…👑", "完全一致！拍手が鳴りやまない👏👏👏", "もう地図いらないですね🗺️❌",
  ] },
  { max: 50, lines: [
    "ぴったり！？ もしかしてここに住んでます？😳", "うそでしょ…ほぼ正解！神ですか！？✨", "ドンピシャ！！地図が頭に入ってる…🤯",
    "目の前！ここ毎日通ってます？🏠", "鳥肌立ちました…🐔", "その読み、プロの犯行です🕵️",
  ] },
  { max: 300, lines: [
    "すごい！この辺りに詳しいんですか！？", "近っ！この辺よく来ます？👀", "さすが！ほとんど目の前です🎯",
    "声をかければ届く距離！📣", "ほぼ正解！角ひとつ分のずれ🏢", "この精度、ただ者じゃない…😎",
    "あの看板、見逃さなかったですね🔎",
  ] },
  { max: 1000, lines: [
    "かなり近い！土地勘ありますね👏", "おしい！歩いて行ける距離です🚶", "いい読み！あと少しでした",
    "ご近所さんレベル！🏘️", "コンビニ1軒分くらいのずれ🏪", "いいね！この調子でいこう🔥",
    "ほぼ同じ町内！🎉",
  ] },
  { max: 5000, lines: [
    "いい線いってる！あと一歩！", "方向はバッチリ！もう一声👍", "なかなか！自転車ならすぐの距離🚲",
    "雰囲気はつかめてる！✨", "同じエリア！次はもっと寄せよう📍", "惜しい！バス停いくつか分🚌",
    "勘がいい！あとは細かい手がかりを🔍",
  ] },
  { max: 20000, lines: [
    "だいたいこの辺…かも？🤔", "惜しい…けど、まだまだいける！", "エリアは合ってる！次は近づけよう",
    "車ならすぐ！🚗", "方角は悪くない！🧭", "道路標識をよく見てみよう🪧",
    "うん、遠からず近からず😌",
  ] },
  { max: 100000, lines: [
    "うーん、ちょっと遠いかな😅", "電車でひと駅…どころじゃないかも🚃", "次はもっと手がかりを探してみよう🔍",
    "ちょっとした旅行になりそう🧳", "迷子になってません？🙈", "景色はきれいでしたね…😇",
    "ドンマイ！次で取り返そう💪",
  ] },
  { max: Infinity, lines: [
    "どこ行っちゃったの！？🌏", "大冒険でしたね…！✈️", "逆にすごい、この遠さ😂",
    "パスポートが必要かも🛂", "地球の裏側…ではないはず🌍", "ピンが旅に出ました🎒",
    "今のはなかったことに…🤫",
  ] },
];

const TIMEOUT_LINES = [
  "時間切れ…！次は急いでいこう⏰", "あっ、時間が…！⌛", "考えすぎちゃいました？🤯",
  "タイムアップ！迷ったらまずピンを置こう📍", "時計を見るのを忘れずに…🕰️",
];

// エクストラモード用: 数メートル単位で見る、厳しめのひとこと
const EXTRA_REACTIONS = [
  { max: 4.999, lines: [
    "…合格。これくらいは当然です🔥", "ふん、やるじゃないですか", "これが本物の実力…認めましょう👑",
    "完璧。次も同じことができますか？", "文句なし。でも油断は禁物です", "ようやく EXTRA の入り口に立てましたね",
  ] },
  { max: 10, lines: [
    "数メートルずれてます。EXTRA では甘えです", "惜しい？いいえ、ずれはずれです", "その数メートルが命取りです⚠️",
    "この街を知っているなら、ここは外さないはず", "目の前でした。でも目の前では足りません", "あと一歩。その一歩が遠いんです",
    "ギリギリ及第点…とは言いません",
  ] },
  { max: 30, lines: [
    "家一軒ぶんずれてます🏠", "その距離、詳しいとは呼べません", "本当にこの道、通ったことあります？",
    "建物を見間違えましたね", "道路の反対側…かもしれません", "ライフは正直です。しっかり減りました",
    "近いけど、EXTRA では遠いです",
  ] },
  { max: 100, lines: [
    "100m 近くずれてます。論外です", "ひと区画まるごと違います", "目印、ちゃんと見ました？👀",
    "その感覚、一度リセットしましょう", "これで詳しいと名乗るのは早いです", "交差点ひとつ分の見落としです",
    "ライフが悲鳴をあげています😱",
  ] },
  { max: 300, lines: [
    "完全に別の場所です", "地図、逆さに持ってません？🙃", "この程度のずれ、EXTRA では致命傷です",
    "勘で置きましたね？バレてます", "そこは隣の町内です", "町の地図、もう一度覚え直しましょう📖",
    "ずれ方が雑すぎます",
  ] },
  { max: 1000, lines: [
    "話になりません", "1km 近く外して、詳しい…？", "これは EXTRA の戦い方じゃありません",
    "ライフがみるみる減っていきます🩸", "ふつうモードに戻りますか？", "どこを見て判断したんですか…",
    "そこ、駅ひとつ分ずれてます🚉",
  ] },
  { max: 5000, lines: [
    "まったく別のエリアです", "その自信はどこから来たんですか", "EXTRA を選んだこと、後悔してません？",
    "これは厳しい…ライフが溶けていきます🫠", "完全に迷子です", "もう範囲の外まで行ってませんか？",
    "もはや観光客の感覚です🧳",
  ] },
  { max: Infinity, lines: [
    "論外。EXTRA を舐めないでください🔥", "どこに置いたのか、本気でわかりません", "ここまで外す人は初めて見ました",
    "ふつうモードからやり直しましょう", "ライフ、ほぼ全部持っていかれました💀", "地図を見ずに置きましたね？",
    "これは…ノーコメントで",
  ] },
];

const EXTRA_TIMEOUT_LINES = [
  "時間切れ。EXTRA では迷った時点で負けです⏰", "何もしないのが一番の失敗です", "考えすぎ。わかる人なら即答のはず",
  "タイムアップ。ライフは容赦なく減ります", "沈黙は答えになりません",
];

let lastReaction = "";

function reactionFor(distance, extra = false) {
  const tiers = extra ? EXTRA_REACTIONS : REACTIONS;
  const timeout = extra ? EXTRA_TIMEOUT_LINES : TIMEOUT_LINES;
  const lines = distance == null ? timeout : tiers.find((r) => distance <= r.max).lines;
  // 同じひとことが続かないようにする
  const pool = lines.filter((l) => l !== lastReaction);
  lastReaction = pool[Math.floor(Math.random() * pool.length)];
  return lastReaction;
}

// ピンを刺した場所に、波紋が広がる
function showPinRipple(pos) {
  const ripple = new MapLabel(pos, "", "pin-ripple");
  ripple.setMap(state.map);
  setTimeout(() => ripple.setMap(null), 800);
}

// timedOut: 制限時間切れで自動的に呼ばれたとき
function submitGuess(timedOut = false) {
  if (state.game && state.game.multi) return submitMultiGuess(timedOut);
  const g = state.game;
  if (!g || !g.answer || app.className !== "screen-game") return;
  if (!g.guess && !timedOut) return;
  stopTimer();
  g.playMs = (g.playMs || 0) + (Date.now() - (g.roundStartedAt || Date.now()));
  const missed = !g.guess;
  const judged = judgeGuess(g, g.guess, g.answer);
  const { distance, score } = judged;
  const result = { ...judged, answer: g.answer, guess: g.guess, timedOut };
  if (g.mode === "life") {
    result.damage = Math.min(g.life, damageFor(score, distance, g.hardcore));
    g.life -= result.damage;
  }
  g.results.push(result);
  recordRound(g.area.id, result);

  // 置いたピンは結果表示用のものに置き換える
  if (g.guessMarker) g.guessMarker.setMap(null);
  g.guessMarker = null;
  if (g.pickShape) g.pickShape.setMap(null);
  g.pickShape = null;
  drawRoundResult(result, { showDistance: true, guessPin: true });
  state.map.setOptions({ draggableCursor: null });

  setScreen("result");
  const last = g.mode === "life" ? g.life <= 0 : g.index + 1 >= g.rounds;
  const right = g.mode === "life"
    ? `<div class="rs-big rs-damage">−${result.damage.toLocaleString()}</div>
       <div class="rs-cap">${g.hardcore ? '<span class="rs-extra">🔥EXTRA</span>' : ""}ライフ ${lifeBar(g.life, g.maxLife)} 残り ${g.life.toLocaleString()} / ${g.maxLife.toLocaleString()}${g.life <= 0 ? "（ライフ切れ）" : ""}</div>`
    : `<div class="rs-big rs-score">${score.toLocaleString()}</div>
       <div class="rs-cap">${MAX_SCORE.toLocaleString()} 点のうち</div>`;
  const roundText = g.mode === "life" ? `ラウンド ${g.index + 1}` : `ラウンド ${g.index + 1} / ${g.rounds}`;
  $("result-text").innerHTML = `
    <div class="rs-reaction"><span class="reaction${g.hardcore ? " extra" : ""}">${isRegionMode(g) ? regionReaction(g, result) : reactionFor(missed ? null : distance, g.hardcore)}</span></div>
    <div class="rs-meta"><b>${roundText}</b>${LEGEND}${mapsLink(g.answer)}</div>
    <div class="rs-side rs-left">${isRegionMode(g) && !missed ? `
      <div class="rs-big ${result.correct ? "rs-correct" : "rs-wrong"}">${result.correct ? "正解！" : "はずれ"}</div>
      <div class="rs-cap">あなた: ${escapeHtml(regionName(g.guessMode, result.guessRegion))} ・ 正解: ${escapeHtml(regionName(g.guessMode, result.answerRegion))}</div>` : `
      <div class="rs-big rs-dist">${missed ? "時間切れ" : formatDistance(distance)}</div>
      <div class="rs-cap">${missed ? "ピンを立てる前に時間切れ" : timedOut ? "正解から（時間切れで提出）" : "正解から"}</div>`}
    </div>
    <div class="rs-side rs-right">${right}</div>`;
  $("btn-next").textContent = last ? "結果を見る" : "次のラウンドへ";
  $("btn-end").hidden = last;
  setResultButtons(false, false);
  $("result").hidden = false;
  fitResults([result], { top: 70, bottom: 90, left: 60, right: 60 });
}

function mapsLink(p, label = "Google マップで見る") {
  const url = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${p.lat},${p.lng}`;
  return `<a href="${url}" target="_blank" rel="noopener">${label}</a>`;
}

function nextRound() {
  if (state.game && state.game.multi) return multiNext();
  const g = state.game;
  g.index += 1;
  const over = g.mode === "life" ? g.life <= 0 : g.index >= g.rounds;
  if (!over) return startRound();
  showFinal();
}

function showFinal() {
  const g = state.game;
  stopTimer();
  clearGameMarkers();
  if (!g.recorded) {
    recordGame(g);
    g.recorded = true;
  }
  const total = g.results.reduce((s, r) => s + r.score, 0);
  const played = g.results.length;
  setScreen("final");
  // 全ラウンドのピンと線を番号付きで並べる
  g.results.forEach((r, i) => drawRoundResult(r, { tag: i + 1, showDistance: false, guessPin: true }));
  if (played) fitResults(g.results, { top: 60, bottom: 60, left: 400, right: 60 });
  const move = rulesText(g);
  let header;
  if (g.mode === "life") {
    const reason = g.life <= 0 ? "ライフ切れ" : "途中で終了";
    // エクストラモードは、どのライフの量で挑んだかがひと目でわかる帯を出す
    const extra = g.hardcore
      ? `<div class="final-extra"><span class="flame">🔥</span><b>EXTRA</b><span>ライフ ${g.maxLife.toLocaleString()}（${DIFFICULTY_NAMES[g.difficulty]}）で挑戦</span></div>`
      : "";
    header = `
      ${extra}
      <div class="sub">${escapeHtml(g.area.name)} ・ ライフ制 ${DIFFICULTY_NAMES[g.difficulty]}（${g.maxLife.toLocaleString()}）${move}</div>
      <div class="big">${played} ラウンド</div>
      <div class="sub">${reason} ・ 合計 ${total.toLocaleString()} 点</div>
      <div class="life-line">${lifeBar(g.life, g.maxLife)} 残りライフ ${g.life.toLocaleString()} / ${g.maxLife.toLocaleString()}</div>`;
  } else {
    const ended = played < g.rounds ? `（${g.rounds}ラウンド中 ${played} で終了）` : "";
    header = `
      <div class="sub">${escapeHtml(g.area.name)} ・ ${played}ラウンド${ended}${move}</div>
      <div class="big">${total.toLocaleString()} / ${(played * MAX_SCORE).toLocaleString()} 点</div>
      ${scoreBar(total, Math.max(1, played * MAX_SCORE))}`;
  }
  $("result-text").innerHTML = `
    ${header}
    ${LEGEND}
    <table>${g.results.map((r, i) =>
      `<tr><td class="num">${i + 1}</td><td>${escapeHtml(guessResultText(g, r))}</td><td>${r.score.toLocaleString()} 点</td>` +
      (g.mode === "life" ? `<td class="damage">−${r.damage}</td>` : "") +
      `<td>${mapsLink(r.answer, "見る")}</td></tr>`).join("")}
    </table>
    <div class="play-time">プレイ時間 ${formatPlayTime(g.playMs || 0)}</div>`;
  renderSavePrompt(g);
  $("btn-next").textContent = "マップ選択に戻る";
  $("btn-end").hidden = true;
  setResultButtons(true, true);
  $("result").hidden = false;
  state.game.finished = true;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------------------------------------------------------------- 起動

function initApp() {
  defineMapLabel();
  buildHeadingTape();
  state.googleReady = true;
  $("btn-cancel-area").addEventListener("click", closeEditor);
  $("btn-undo").addEventListener("click", undoEditor);
  $("radius").addEventListener("input", () => {
    updateRadiusLabel();
    // 選んでいる円の半径を変える
    const ed = state.editor;
    const target = ed && ed.selected instanceof google.maps.Circle ? ed.selected : null;
    if (target) target.setRadius(Number($("radius").value));
  });
  document.querySelectorAll("#editor-panel .tab").forEach((t) => t.addEventListener("click", () => setTool(t.dataset.tool)));
  $("btn-guess").addEventListener("click", () => submitGuess());
  $("btn-map-zoom-in").addEventListener("click", () => state.map && state.map.setZoom(state.map.getZoom() + 1));
  $("btn-map-zoom-out").addEventListener("click", () => state.map && state.map.setZoom(state.map.getZoom() - 1));
  $("btn-dock-bigger").addEventListener("click", () => changeDock((p) => ({ dockSize: p.dockSize + 1 })));
  $("btn-dock-smaller").addEventListener("click", () => changeDock((p) => ({ dockSize: p.dockSize - 1 })));
  $("btn-dock-pin").addEventListener("click", () => changeDock((p) => ({ dockPinned: !p.dockPinned })));
  $("btn-next").addEventListener("click", () => (state.game && state.game.finished && !state.game.multi ? showHome() : nextRound()));
  $("btn-end").addEventListener("click", showFinal);
  $("btn-replay").addEventListener("click", replayGame);
  // ラウンド結果では Space キーでも次へ進める
  window.addEventListener("keydown", (e) => {
    if (e.code !== "Space" || app.className !== "screen-result" || $("result").hidden) return;
    if (e.target.closest("input, textarea, select, button")) return;
    if (!$("btn-next").disabled) { e.preventDefault(); $("btn-next").click(); }
  });
  $("btn-zoom-in").addEventListener("click", () => zoomPano(1));
  $("btn-zoom-out").addEventListener("click", () => zoomPano(-1));
  $("btn-game-settings").addEventListener("click", openGameSettings);
  $("btn-resume").addEventListener("click", closeGameSettings);
  $("btn-exit-game").addEventListener("click", exitGame);
  $("btn-back-start").addEventListener("click", () => {
    // 出発地点に戻るのは同じパノラマオブジェクト内の移動なので、新しい読み込みとしては数えない
    if (state.game && state.game.answer) state.pano.setPano(state.game.answer.panoId);
  });
  $("opt-rounds").addEventListener("change", saveSettings);
  ["opt-move", "opt-pan", "opt-zoom"].forEach((id) => $(id).addEventListener("change", saveSettings));
  $("opt-timer").addEventListener("change", () => { updateTimerSettings(); saveSettings(); });
  $("opt-time").addEventListener("input", updateTimerSettings);
  $("opt-time").addEventListener("change", saveSettings);
  $("compass").addEventListener("click", () => {
    // 見回しできるときだけ、北を向き直す
    if (state.pano && state.game && state.game.pan) state.pano.setPov({ heading: 0, pitch: state.pano.getPov().pitch });
  });
  document.querySelectorAll("#mode-tabs .tab").forEach((t) => t.addEventListener("click", () => {
    setMode(t.dataset.mode);
    saveSettings();
  }));
  $("opt-difficulty").addEventListener("change", () => { setMode(state.mode); saveSettings(); });
  $("opt-life").addEventListener("change", saveSettings);
}

// 地図は必要になったとき（ゲーム開始・範囲作成）に1回だけ作り、使い回す
// Dynamic Maps の課金は作成時の1回なので、タイトルやマップ選択を見るだけなら0回
function ensureMap() {
  if (state.map) return true;
  if (!state.googleReady) {
    showMessage("Google マップを読み込み中です。少し待ってからもう一度押してください。");
    return false;
  }
  if (getUsage().mapLoads >= CONFIG.limits.mapLoadsPerMonth) {
    showMessage("今月の地図読み込みの上限に達しました（config.js の limits）。");
    return false;
  }
  addUsage("mapLoads");
  state.map = new google.maps.Map($("map"), {
    center: { lat: 1.35, lng: 103.82 },
    zoom: 11,
    streetViewControl: false,
    mapTypeControl: false,
    fullscreenControl: false,
    clickableIcons: false,
    gestureHandling: "greedy",
    mapTypeId: state.prefs.mapType,
  });
  state.map.addListener("click", (e) => {
    if (state.editor) return editorClick(e.latLng);
    if (app.className === "screen-game" && state.game && !state.game.submitted) placeGuess(e.latLng);
  });
  state.map.addListener("idle", () => { if (state.game && state.game.multi) sendMyView(); });
  bindDockOpen();
  // 地図の大きさが変わるたびに（回答マップを広げたときなど）、引ける限界を合わせ、
  // まだ自分で地図を動かしていなければ、出題範囲が地図いっぱいに見えるように合わせ直す
  new ResizeObserver(() => { fitMinZoom(); refitArea(); }).observe($("map"));
  fitMinZoom();
  // ホイール・ドラッグ・クリック・＋－ボタンで地図を触ったら、自動で合わせ直すのをやめる
  ["wheel", "pointerdown", "dblclick"].forEach((ev) => $("map").addEventListener(ev, () => { state.mapTouched = true; }, { passive: true }));
  $("map-zoom").addEventListener("click", () => { state.mapTouched = true; });
  return true;
}

// 一番引いたときに、世界地図が横に何枚も並んだり、上下に灰色が出たりしないようにする。
// 世界地図の幅（256px × 2^ズーム）が、地図の枠の大きさとだいたい同じになるところを下限にする
// ゲーム中、まだ地図を触っていなければ、出題範囲に合わせ直す（全世界は世界地図のまま）
let refitTimer = null;
function refitArea() {
  const g = state.game;
  if (!g || g.submitted || state.mapTouched || app.className !== "screen-game" || g.area.type === "world") return;
  clearTimeout(refitTimer);
  // 広がるアニメーションが終わってから合わせる
  refitTimer = setTimeout(() => {
    if (!state.mapTouched && app.className === "screen-game") state.map.fitBounds(areaBounds(g.area), 20);
  }, 220);
}

function fitMinZoom() {
  const el = $("map");
  if (!state.map || !el.clientWidth) return;
  const z = Math.max(1, Math.round(Math.log2(Math.max(el.clientWidth, el.clientHeight) / 256)));
  if (state.map.get("minZoom") !== z) state.map.setOptions({ minZoom: z });
}

// 回答マップは、マウスを乗せている間・ドラッグしている間は広げたままにする。
// （:hover だけだと、ドラッグ中にマウスが枠の外へ出た瞬間に縮んでしまうため）
function bindDockOpen() {
  const dock = $("map-dock");
  let hover = false;
  let dragging = false;
  const update = () => {
    if (hover || dragging) dock.classList.add("open");
    else dock.classList.remove("open");
  };
  // 枠のふち（1〜2px）にマウスがあるだけでは広げない。半透明↔不透明の切り替えで枠の位置が
  // 1px 未満ずれることがあり、ふちに置いたままだと「入った・出た」をくり返して伸び縮みしてしまうため
  const wellInside = (e) => {
    const r = dock.getBoundingClientRect();
    return e.clientX > r.left + 2 && e.clientX < r.right - 2 && e.clientY > r.top + 2 && e.clientY < r.bottom - 2;
  };
  // ストリートビューを掴んで向きを変えたままマップの上に来たときは広げない（ボタンを押していないときだけ）
  dock.addEventListener("mouseenter", (e) => { hover = e.buttons === 0 && wellInside(e); update(); });
  dock.addEventListener("mousemove", (e) => { if (!hover && e.buttons === 0 && wellInside(e)) { hover = true; update(); } });
  dock.addEventListener("mouseleave", () => { hover = false; update(); });
  dock.addEventListener("pointerdown", () => { dragging = true; update(); });
  window.addEventListener("pointerup", () => { if (dragging) { dragging = false; update(); } });
  state.map.addListener("dragstart", () => { dragging = true; update(); });
  state.map.addListener("dragend", () => { dragging = false; update(); });
}

const RIPPLE_TARGETS = ".btn-hero, .btn-ghost, button.primary, button.secondary, .chip, .tab, .map-card, .btn-back, .dialog-ok";

// 押したところから光の輪が広がる
function addRipple(e) {
  if (!state.prefs.anim) return;
  const el = e.target.closest(RIPPLE_TARGETS);
  if (!el || el.disabled) return;
  const rect = el.getBoundingClientRect();
  const size = Math.max(rect.width, rect.height) * 2;
  const r = document.createElement("span");
  r.className = "ripple";
  r.style.width = r.style.height = `${size}px`;
  r.style.left = `${e.clientX - rect.left - size / 2}px`;
  r.style.top = `${e.clientY - rect.top - size / 2}px`;
  el.classList.add("ripple-host");
  el.appendChild(r);
  r.addEventListener("animationend", () => r.remove());
}

// ---------------------------------------------------------------- ゲーム中の操作と設定

const DEFAULT_PREFS = { compass: "both", mapType: "roadmap", anim: true, dockSize: 1, dockPinned: false };

// 回答マップを広げたときの大きさ（横, 縦）。1 番目が今までの大きさ
const DOCK_SIZES = [[440, 320], [600, 440], [820, 580], [1080, 760]];

// 回答マップの大きさと「開いたまま」を反映する
function applyDock() {
  const p = state.prefs;
  p.dockSize = Math.max(0, Math.min(DOCK_SIZES.length - 1, p.dockSize));
  const [w, h] = DOCK_SIZES[p.dockSize];
  const dock = $("map-dock");
  // 決定ボタンも同じ幅に伸ばすので、共通の親に持たせる
  dock.parentElement.style.setProperty("--dock-w", `${w}px`);
  dock.parentElement.style.setProperty("--dock-h", `${h}px`);
  dock.classList.toggle("pinned", !!p.dockPinned);
  $("btn-dock-pin").classList.toggle("active", !!p.dockPinned);
  $("btn-dock-pin").setAttribute("aria-pressed", String(!!p.dockPinned));
  $("btn-dock-bigger").disabled = p.dockSize >= DOCK_SIZES.length - 1;
  $("btn-dock-smaller").disabled = p.dockSize <= 0;
}

function changeDock(change) {
  Object.assign(state.prefs, change(state.prefs));
  saveJSON(STORE_PREFS, state.prefs);
  applyDock();
}
state.prefs = { ...DEFAULT_PREFS, ...loadJSON(STORE_PREFS, {}) };

function zoomPano(step) {
  if (!state.pano || !state.game || !state.game.zoom) return;
  const z = Math.round(state.pano.getZoom() || 0) + step;
  state.pano.setZoom(Math.max(0, Math.min(4, z)));
}

function openGameSettings() {
  if (app.className !== "screen-game") return;
  $("gs-timer-note").hidden = !(state.game && state.game.timeLimit);
  $("pref-fullscreen").checked = !!document.fullscreenElement;
  $("game-settings").hidden = false;
  $("btn-resume").focus();
}

function closeGameSettings() {
  $("game-settings").hidden = true;
}

function exitGame() {
  if (state.game && state.game.multi) return exitMultiGame();
  closeGameSettings();
  stopTimer();
  $("loading").hidden = true;
  showHome();
  state.game = null;
}

// 設定の値を画面に反映する（方位の表示・回答マップの種類・アニメーション）
function applyPrefs() {
  const p = state.prefs;
  app.dataset.compass = p.compass;
  document.documentElement.classList.toggle("no-anim", !p.anim);
  if (state.map) state.map.setMapTypeId(p.mapType);
  document.querySelectorAll(".seg-pills").forEach((group) => {
    group.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.v === p[group.dataset.pref]));
  });
  $("pref-anim").checked = p.anim;
  applyDock();
}

function bindPrefs() {
  document.querySelectorAll(".seg-pills").forEach((group) => {
    group.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
      state.prefs[group.dataset.pref] = b.dataset.v;
      saveJSON(STORE_PREFS, state.prefs);
      applyPrefs();
    }));
  });
  $("pref-anim").addEventListener("change", () => {
    state.prefs.anim = $("pref-anim").checked;
    saveJSON(STORE_PREFS, state.prefs);
    applyPrefs();
  });
  $("pref-fullscreen").addEventListener("change", async () => {
    try {
      if ($("pref-fullscreen").checked) await document.documentElement.requestFullscreen();
      else if (document.fullscreenElement) await document.exitFullscreen();
    } catch {
      $("pref-fullscreen").checked = !!document.fullscreenElement;
    }
  });
  document.addEventListener("fullscreenchange", () => { $("pref-fullscreen").checked = !!document.fullscreenElement; });
  applyPrefs();
}

// Google Maps を待たずに使える画面（タイトル・マップ選択・設定）のボタン
function bindStaticUi() {
  document.addEventListener("pointerdown", addRipple);
  bindProgressMap();
  $("btn-play").addEventListener("click", () => showMode());
  $("btn-quick").addEventListener("click", startQuickGame);
  $("btn-title-create").addEventListener("click", () => { showSelect(); openEditor(); });
  $("btn-back-title").addEventListener("click", () => (state.mp && state.mp.role === "host" ? hostBackToLobby() : showMode()));
  $("btn-sheet-close").addEventListener("click", closeSettings);
  $("sheet-backdrop").addEventListener("click", closeSettings);
  // ストリートビューにフォーカスがあるとキー操作が地図側で止められることがあるので、
  // いちばん外側（window）で先に受け取る
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !$("dialog").hidden) return;
    if (e.target.closest && e.target.closest("#mp-social")) return;
    closeSettings();
    // ゲーム中は Esc で設定を開閉する
    if (app.className === "screen-game") {
      e.preventDefault();
      e.stopPropagation();
      $("game-settings").hidden ? openGameSettings() : closeGameSettings();
    }
  }, true);
  bindPrefs();
  bindScoreDialog();
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Delete" || app.className !== "screen-editor" || !state.editor) return;
    // 名前などを入力している間は、文字の削除として扱う
    if (e.target.closest && e.target.closest("input, textarea, select")) return;
    e.preventDefault();
    deleteShape(state.editor.selected);
  });
  $("btn-start").addEventListener("click", startGame);
  $("btn-save-area").addEventListener("click", saveEditor);
  $("btn-cancel-area-top").addEventListener("click", closeEditor);
  $("area-category").innerHTML = CATEGORIES.filter((c) => c.id !== "all")
    .map((c) => `<option value="${c.id}">${c.id === "custom" ? "自作のみ" : c.name}</option>`).join("");
  bindAreaForm("area");
  bindShapeList();
}

// 1ラウンド 1000 点満点だったころの記録・ランキング・設定を、5000 点満点に合わせて直す（1回だけ）
const STORE_SCALE = "lg.scale";
function migrateScoreScale() {
  try {
    if (localStorage.getItem(STORE_SCALE) === String(MAX_SCORE)) return;
  } catch {
    return;
  }
  const x5 = (n) => Math.round((Number(n) || 0) * 5);
  const h = loadJSON(STORE_HISTORY, null);
  if (h) {
    (h.rounds || []).forEach((r) => { r.score = x5(r.score); });
    Object.values(h.games || {}).forEach((st) => { st.bestAvg = x5(st.bestAvg); });
    saveJSON(STORE_HISTORY, h);
  }
  const all = loadJSON(STORE_SCORES, null);
  if (all) {
    for (const areaId of Object.keys(all)) {
      const boards = {};
      for (const [key, list] of Object.entries(all[areaId] || {})) {
        // ライフ制の部門名には最初のライフが入っているので、それも 5 倍にする
        const parts = key.split("-");
        if (parts[0] === "life" && parts[2]) parts[2] = String(x5(parts[2]));
        boards[parts.join("-")] = list.map((e) => ({ ...e, score: x5(e.score), max: x5(e.max) }));
      }
      all[areaId] = boards;
    }
    saveJSON(STORE_SCORES, all);
  }
  const s = loadJSON(STORE_SETTINGS, null);
  if (s && s.customLife) {
    s.customLife = String(x5(s.customLife));
    saveJSON(STORE_SETTINGS, s);
  }
  try {
    localStorage.setItem(STORE_SCALE, String(MAX_SCORE));
  } catch {
    // 保存できなくても遊ぶのには困らない
  }
}

function boot() {
  migrateScoreScale();
  const s = loadJSON(STORE_SETTINGS, {});
  if (s.areaId && allAreas().some((a) => a.id === s.areaId)) state.selectedAreaId = s.areaId;
  if (s.rounds) $("opt-rounds").value = s.rounds;
  if (s.difficulty) $("opt-difficulty").value = s.difficulty;
  if (s.customLife) $("opt-life").value = s.customLife;
  $("opt-hardcore").checked = !!s.hardcore;
  $("opt-hardcore").addEventListener("change", saveSettings);
  $("opt-move").checked = s.move !== false;
  $("opt-pan").checked = s.pan !== false;
  $("opt-zoom").checked = s.zoom !== false;
  $("opt-timer").checked = !!s.timer;
  if (s.time) $("opt-time").value = s.time;
  updateTimerSettings();
  // 開いたときは毎回ラウンド制から始める（ライフ制は設定シートで選ぶ）
  setMode("rounds");
  bindStaticUi();
  buildTitleBackground();
  showTitle();

  if (!CONFIG.apiKey || CONFIG.apiKey === "YOUR_API_KEY") {
    $("btn-start").disabled = true;
    return showMessage("config.js に APIキーが設定されていません。\nREADME.md の手順で APIキーを作り、config.js の apiKey に貼り付けてください。", true);
  }
  window.initApp = initApp;
  const script = document.createElement("script");
  script.src = "https://maps.googleapis.com/maps/api/js" +
    `?key=${encodeURIComponent(CONFIG.apiKey)}&v=weekly&loading=async&language=ja&callback=initApp`;
  script.async = true;
  script.onerror = () => showMessage("Google Maps の読み込みに失敗しました。ネット接続と APIキーを確認してください。");
  document.head.appendChild(script);
}

window.gm_authFailure = () => {
  // いま開いているアドレスを出して、キーの制限に何を追加すればよいかわかるようにする
  showMessage(`APIキーの認証に失敗しました。キーが正しいか、Maps JavaScript API が有効か、キーの「ウェブサイトの制限」に ${location.origin}/* が入っているかを確認してください（変更の反映には数分かかることがあります）。`, true);
};

boot();
