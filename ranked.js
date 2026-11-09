// ================================================================ コンペティティブ（NPC とのランク戦）
// 最初に 3 ラウンドの認定戦を 3 回戦い、その成績でランクが決まる（ゴールド 3 まで）。
// そのあとの本戦は 5 ラウンド・体力 6000 で、ラウンドごとに点数が低い側が差の分だけダメージを受ける。

const STORE_RANK = "lg.rank";
const RANK_DIVISION_RP = 100;
const RANK_TIERS = [
  { id: "bronze", name: "ブロンズ", start: 0, divs: 3 },
  { id: "silver", name: "シルバー", start: 300, divs: 3 },
  { id: "gold", name: "ゴールド", start: 600, divs: 3 },
  { id: "master", name: "マスター", start: 900, divs: 3 },
  { id: "champion", name: "チャンピオン", start: 1200, divs: 1 },
];
const PLACEMENT_MATCHES = 3;
const PLACEMENT_ROUNDS = 3;
const PLACEMENT_MAX_RP = 899; // 認定戦で上がれるのはゴールド 3 まで（マスターからは上級者）
const MATCH_ROUNDS = 5;
const MATCH_LIFE = 6000;
const MATCH_TIME = 120;
const PICK_TIME = 30; // どちらかがピックしたら、残り時間がこの秒数になる
const ROUND_MULTIPLIERS = [1, 1, 1.5, 1.5, 2];

// ---- NPC（名前も強さも、このゲームのために作った架空のプレイヤー）
const NPC_NAMES = [
  "旅するカモメ", "地図好きのタヌキ", "標識ハンター", "さすらいの測量士", "夜行列車のネコ", "道ばたの賢者", "方位磁針マニア", "ピン刺し職人",
  "世界の果てのペンギン", "電柱ウォッチャー", "看板読みのフクロウ", "峠のキツネ", "赤道の渡り鳥", "国境の案内人", "路地裏の探検家", "風見鶏",
];
const NPC_GLYPHS = ["🦉", "🦊", "🐧", "🐱", "🦝", "🧭", "🗺️", "🚲", "🏔️", "⭐"];
const NPC_COLORS = ["#3b82f6", "#a855f7", "#f97316", "#ec4899", "#14b8a6", "#e5392f"];

// ランクごとの NPC の強さ。平均点はこの点を結んだ線の上。チャンピオン帯はかなり強い
const NPC_SKILL_POINTS = [[0, 1300], [300, 2200], [600, 3000], [900, 3800], [1200, 4550], [1500, 4850]];
// ピックするまでの秒数 [最短, 最長]（強いほど早い）
const NPC_PICK_DELAY = { bronze: [40, 85], silver: [35, 75], gold: [28, 65], master: [18, 50], champion: [10, 32] };

function npcMeanScore(rp) {
  const pts = NPC_SKILL_POINTS;
  if (rp <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (rp <= pts[i][0]) {
      const [x0, y0] = pts[i - 1];
      const [x1, y1] = pts[i];
      return y0 + ((rp - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return pts[pts.length - 1][1];
}

function randomBetween(a, b) {
  return a + rand() * (b - a);
}

function randomNormal() {
  return Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
}

function makeNpc(rp) {
  return {
    name: NPC_NAMES[Math.floor(rand() * NPC_NAMES.length)],
    glyph: NPC_GLYPHS[Math.floor(rand() * NPC_GLYPHS.length)],
    color: NPC_COLORS[Math.floor(rand() * NPC_COLORS.length)],
    rp: Math.max(0, Math.round(rp)),
  };
}

// NPC の答え: まず取れそうな点を決めて、その点になる距離だけ正解からずらす
function makeNpcGuess(g) {
  const { npc } = g.ranked;
  const sd = npc.rp >= 1200 ? 320 : npc.rp >= 900 ? 500 : 800;
  const target = Math.max(150, Math.min(4990, npcMeanScore(npc.rp) + randomNormal() * sd));
  const decay = areaSizeMeters(g.area) * 0.07;
  const distance = -Math.log(target / MAX_SCORE) * decay;
  const bearing = rand() * 2 * Math.PI;
  const lat = Math.max(-85, Math.min(85, g.answer.lat + ((distance * Math.cos(bearing)) / 111320)));
  const cos = Math.max(0.05, Math.cos((g.answer.lat * Math.PI) / 180));
  let lng = g.answer.lng + ((distance * Math.sin(bearing)) / (111320 * cos));
  if (lng > 180) lng -= 360;
  if (lng < -180) lng += 360;
  const guess = { lat, lng };
  const real = distanceMeters(g.answer, guess);
  return { guess, distance: real, score: scoreFor(real, g.area) };
}

// ---- ランクの保存と表示

function loadRank() {
  return { rp: null, placement: [], wins: 0, losses: 0, ...loadJSON(STORE_RANK, {}) };
}

function saveRank(r) {
  saveJSON(STORE_RANK, r);
}

// rp からランクを求める。null はランクなし
function rankOf(rp) {
  if (rp == null) return null;
  const tier = [...RANK_TIERS].reverse().find((t) => rp >= t.start);
  if (tier.divs === 1) return { tier, div: 0, name: tier.name, into: rp - tier.start, next: null };
  const div = Math.min(tier.divs, Math.floor((rp - tier.start) / RANK_DIVISION_RP) + 1);
  return { tier, div, name: `${tier.name} ${div}`, into: (rp - tier.start) % RANK_DIVISION_RP, next: RANK_DIVISION_RP };
}

// ランクのマーク（すべて SVG で描いたオリジナル）
const EMBLEM_COLORS = {
  none: ["#9aa3b5", "#555e70", "#262c3a"],
  bronze: ["#f6c08a", "#b0662f", "#54290f"],
  silver: ["#ffffff", "#aeb9ca", "#4b5668"],
  gold: ["#fff3b0", "#f2b632", "#7f5005"],
  master: ["#ff9dbd", "#d01c66", "#470a39"],
  champion: ["#c6f7ff", "#28b4ff", "#0a2f7d"],
};
let emblemSeq = 0;

function rankEmblem(tierId, size = 48) {
  const id = tierId || "none";
  const [hi, mid, lo] = EMBLEM_COLORS[id];
  const u = `re${++emblemSeq}`;
  const marks = {
    none: `<text x="32" y="43" text-anchor="middle" font-size="32" font-weight="900" font-family="sans-serif" fill="${hi}">?</text>`,
    bronze: `<path d="M19 36 32 25l13 11v8L32 33l-13 11z" fill="${hi}"/>`,
    silver: `<path d="M19 30 32 19l13 11v7L32 26l-13 11z" fill="${hi}"/><path d="M19 42 32 31l13 11v7L32 38l-13 11z" fill="${hi}" opacity=".8"/>`,
    gold: `<path d="M32 15l5 11 12 1.3-9 8 2.7 11.7L32 41l-10.7 6 2.7-11.7-9-8 12-1.3z" fill="${hi}" stroke="${lo}" stroke-width="1.5" stroke-linejoin="round"/>`,
    master: `<path d="M32 13l13 12-13 26-13-26z" fill="${hi}"/><path d="M32 13v38M19 25h26" stroke="${lo}" stroke-width="1.8" opacity=".6"/><path d="M14 22c-6 4-8 12-5 20 2-5 4-7 9-9zM50 22c6 4 8 12 5 20-2-5-4-7-9-9z" fill="${hi}" opacity=".9"/>`,
    champion: `<path d="M15 41l-3-20 11 8 9-16 9 16 11-8-3 20z" fill="${hi}" stroke="${lo}" stroke-width="1.5" stroke-linejoin="round"/><rect x="15" y="43" width="34" height="6" rx="2" fill="${hi}"/><circle cx="32" cy="32" r="4.5" fill="${mid}" stroke="${lo}" stroke-width="1.5"/>`,
  };
  const burst = id === "champion"
    ? `<path d="M32 1l5 7 8-3 2 8 8 1-1 8 7 4-4 7 4 7-7 4 1 8-8 1-2 8-8-3-5 7-5-7-8 3-2-8-8-1 1-8-7-4 4-7-4-7 7-4-1-8 8-1 2-8 8 3z" fill="${mid}" opacity=".35"/>`
    : "";
  return `<svg class="rank-emblem" viewBox="0 0 64 64" width="${size}" height="${size}" aria-hidden="true">
    <defs><linearGradient id="${u}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${mid}"/><stop offset="1" stop-color="${lo}"/></linearGradient></defs>
    ${burst}
    <path d="M32 5 55 13v19c0 14-11 23-23 27C20 55 9 46 9 32V13z" fill="url(#${u})" stroke="${hi}" stroke-width="2.5" stroke-linejoin="round"/>
    <path d="M32 10 50 16.5V32c0 11-8.5 18.5-18 22" fill="none" stroke="#fff" stroke-opacity=".22" stroke-width="2"/>
    ${marks[id]}
  </svg>`;
}

function rankLabelHtml(rp, size = 28) {
  const r = rankOf(rp);
  return `<span class="rank-label">${rankEmblem(r ? r.tier.id : null, size)}<b>${r ? r.name : "ランクなし"}</b></span>`;
}

// プロフィールと右上の表示
function renderRankProfile() {
  const rank = loadRank();
  const r = rankOf(rank.rp);
  const box = $("pf-rank");
  if (box) {
    box.innerHTML = `${rankEmblem(r ? r.tier.id : null, 56)}
      <div><small>コンペティティブ</small><b>${r ? r.name : "ランクなし"}</b>
      <span>${r ? `${rank.rp.toLocaleString()} RP ・ ${rank.wins} 勝 ${rank.losses} 敗` : `認定戦 ${rank.placement.length} / ${PLACEMENT_MATCHES}`}</span></div>`;
  }
  const mini = $("tb-rank");
  if (mini) {
    mini.innerHTML = rankEmblem(r ? r.tier.id : null, 22);
    mini.title = r ? r.name : "ランクなし";
  }
}

// マップの設定シートのルール説明
function renderRankedSheet() {
  const box = $("ranked-info");
  if (!box) return;
  const rank = loadRank();
  const placing = rank.rp == null;
  box.innerHTML = `<div class="ri-rank">${rankLabelHtml(rank.rp, 40)}${placing ? `<small>認定戦 ${rank.placement.length} / ${PLACEMENT_MATCHES}</small>` : `<small>${rank.rp.toLocaleString()} RP</small>`}</div>
    <p class="help">${placing
      ? `まず <b>3 ラウンドの認定戦を ${PLACEMENT_MATCHES} 回</b>戦います。成績でランクが決まります（最高でゴールド 3）。`
      : `<b>${MATCH_ROUNDS} ラウンド・体力 ${MATCH_LIFE.toLocaleString()}</b> の 1 対 1。点数が低い側が、差の分だけダメージを受けます。`}
    相手は NPC です。どちらかがピックすると、残り時間は ${PICK_TIME} 秒になります。</p>`;
}

// ---- マッチの前と後の画面

function opponentRpForNext(rank) {
  if (rank.rp != null) return rank.rp + randomBetween(-40, 60);
  // 認定戦: 勝つと相手が強く、負けると弱くなる
  const wins = rank.placement.filter((m) => m.win).length;
  const losses = rank.placement.length - wins;
  return Math.max(120, Math.min(780, 400 + wins * 180 - losses * 120));
}

function openRanked(area) {
  if (!ensureMap()) return;
  closeSettings();
  state.rankedArea = area;
  showRankedLobby();
}

function ladderHtml(rp) {
  const cur = rankOf(rp);
  return `<div class="rk-ladder">${[...RANK_TIERS].reverse().map((t) => `
    <div class="rk-step${cur && cur.tier.id === t.id ? " current" : ""}">${rankEmblem(t.id, 44)}<b>${t.name}</b></div>`).join("")}
    <div class="rk-step${cur ? "" : " current"}">${rankEmblem(null, 44)}<b>ランクなし</b></div>
  </div>`;
}

function showRankedLobby() {
  const rank = loadRank();
  const me = myProfile();
  const placing = rank.rp == null;
  state.rankedNpc = makeNpc(opponentRpForNext(rank));
  const pips = placing
    ? `<div class="rk-pips">${Array.from({ length: PLACEMENT_MATCHES }, (_, i) => {
      const m = rank.placement[i];
      return `<span class="${m ? (m.win ? "win" : "lose") : i === rank.placement.length ? "now" : ""}">認定 ${i + 1}</span>`;
    }).join("")}</div>`
    : `<div class="rk-progress">${rankProgressHtml(rank.rp)}</div>`;
  setScreen("ranked");
  $("ranked-screen").innerHTML = `
    <div class="rk-main">
      <p class="rk-eyebrow">COMPETITIVE</p>
      <h2 class="rk-title">コンペティティブ</h2>
      <p class="rk-sub">${placing ? `ランクを決めるために、認定戦を ${PLACEMENT_MATCHES} 回戦いましょう` : `${escapeHtml(state.rankedArea.name)} で 1 対 1`}</p>
      <div class="rk-versus">
        <div class="rk-player">${playerAvatarHtml({ name: me.name, avatar: me.avatar, color: me.avatar.color }, "huge")}<b>${escapeHtml(me.name)}</b>${rankLabelHtml(rank.rp, 26)}</div>
        <div class="rk-vs">VS</div>
        <div class="rk-player rk-unknown"><span class="rk-silhouette">?</span><b>対戦相手をさがす</b><span class="rank-label muted">NPC</span></div>
      </div>
      ${pips}
      <p class="rk-rule">${placing ? `3 ラウンド ・ 合計点で勝負` : `${MATCH_ROUNDS} ラウンド ・ 体力 ${MATCH_LIFE.toLocaleString()}`} ・ どちらかのピックで残り ${PICK_TIME} 秒</p>
      <div class="rk-actions">
        <button id="rk-start" class="btn-hero small">マッチ開始</button>
        <button id="rk-back" class="btn-ghost">マップ選択に戻る</button>
      </div>
    </div>
    ${ladderHtml(rank.rp)}`;
  $("rk-start").addEventListener("click", startRankedMatch);
  $("rk-back").addEventListener("click", showHome);
}

function rankProgressHtml(rp) {
  const r = rankOf(rp);
  if (!r.next) return `<span>${rp.toLocaleString()} RP</span>`;
  return `<i class="rk-bar"><i style="width:${(r.into / r.next) * 100}%"></i></i><span>次のランクまで ${r.next - r.into} RP</span>`;
}

async function startRankedMatch() {
  const rank = loadRank();
  const placing = rank.rp == null;
  const rounds = placing ? PLACEMENT_ROUNDS : MATCH_ROUNDS;
  if (remainingStreetView() < rounds) {
    return showMessage("今月の無料枠の上限に達しました（config.js の limits）。来月まで待つか、上限を見直してください。");
  }
  const area = state.rankedArea;
  state.game = {
    area, move: true, pan: true, zoom: true, timeLimit: MATCH_TIME, mode: "rounds", difficulty: "normal",
    guessMode: "pin", famous: false, hardcore: false, maxLife: MATCH_LIFE, life: MATCH_LIFE, rounds, index: 0,
    results: [], overlays: [], usedPanos: new Set(), usedSpots: [],
    ranked: {
      placing, matchNo: rank.placement.length + 1, npc: state.rankedNpc,
      myLife: MATCH_LIFE, npcLife: MATCH_LIFE, myTotal: 0, npcTotal: 0,
    },
  };
  state.lifeShown = null;
  setScreen("game");
  await startRound();
}

// ---- 試合中

function rankedRoundReset(g) {
  const r = g.ranked;
  clearTimeout(r.npcTimer);
  r.npcPick = null;
  r.myPick = null;
  r.done = false;
  g.submitted = false;
  $("hurry-note").hidden = true;
  renderRankedHud();
}

// 3・2・1 が終わって、制限時間が動き出したとき
function rankedRoundStart(g) {
  const tier = rankOf(g.ranked.npc.rp).tier.id;
  const [a, b] = NPC_PICK_DELAY[tier];
  scheduleNpcPick(g, randomBetween(a, b));
}

function scheduleNpcPick(g, seconds) {
  clearTimeout(g.ranked.npcTimer);
  g.ranked.npcTimer = setTimeout(() => npcPicks(g), seconds * 1000);
}

function rankedNote(text) {
  const note = $("hurry-note");
  note.textContent = text;
  note.hidden = false;
  note.classList.remove("show");
  void note.offsetWidth;
  note.classList.add("show");
  clearTimeout(state.hurryTimer);
  state.hurryTimer = setTimeout(() => { note.hidden = true; }, 3500);
}

// 残り時間が PICK_TIME より長ければ、PICK_TIME にする
function shortenRankedTimer() {
  const left = state.timerDeadline ? (state.timerDeadline - Date.now()) / 1000 : Infinity;
  if (left > PICK_TIME) startTimer(PICK_TIME);
}

function npcPicks(g) {
  const r = g.ranked;
  if (state.game !== g || r.done || r.npcPick || !g.answer || app.className !== "screen-game") return;
  r.npcPick = makeNpcGuess(g);
  if (r.myPick) return finishRankedRound(g);
  shortenRankedTimer();
  rankedNote(`⚡ ${r.npc.name} がピックしました！ 残り ${PICK_TIME} 秒`);
  renderRankedHud();
}

// 決定ボタン、または時間切れ（submitGuess から呼ばれる）
function rankedSubmit(timedOut) {
  const g = state.game;
  const r = g.ranked;
  if (!g.answer || r.done || r.myPick || app.className !== "screen-game") return;
  if (!g.guess && !timedOut) return;
  r.myPick = { ...judgeGuess(g, g.guess, g.answer), answer: g.answer, guess: g.guess, timedOut };
  g.submitted = true;
  $("btn-guess").disabled = true;
  $("btn-guess").textContent = "相手を待っています…";
  if (timedOut && !r.npcPick) r.npcPick = makeNpcGuess(g);
  if (r.npcPick) return finishRankedRound(g);
  shortenRankedTimer();
  rankedNote(`ピックしました。${r.npc.name} を待っています…`);
  scheduleNpcPick(g, randomBetween(1.5, 7));
  renderRankedHud();
}

function finishRankedRound(g) {
  const r = g.ranked;
  r.done = true;
  clearTimeout(r.npcTimer);
  stopTimer();
  $("hurry-note").hidden = true;
  g.playMs = (g.playMs || 0) + (Date.now() - (g.roundStartedAt || Date.now()));
  const mine = r.myPick;
  const npc = r.npcPick;
  g.results.push(mine);
  recordRound(g.area.id, mine);
  r.myTotal += mine.score;
  r.npcTotal += npc.score;
  const diff = mine.score - npc.score;
  const mult = r.placing ? 1 : ROUND_MULTIPLIERS[Math.min(g.index, ROUND_MULTIPLIERS.length - 1)];
  let damage = 0;
  if (!r.placing && diff) {
    damage = Math.round(Math.abs(diff) * mult);
    if (diff > 0) {
      damage = Math.min(damage, r.npcLife);
      r.npcLife -= damage;
    } else {
      damage = Math.min(damage, r.myLife);
      r.myLife -= damage;
    }
  }
  const missed = !mine.guess;
  if (g.guessMarker) g.guessMarker.setMap(null);
  g.guessMarker = null;
  drawRoundResult(mine, { showDistance: true, guessPin: true });
  addOverlay(new google.maps.Marker({ position: npc.guess, icon: pinIcon(r.npc.color, "guess", 0.85), title: r.npc.name, zIndex: 2 }));
  addOverlay(new MapLabel(npc.guess, r.npc.name, "tag"));
  state.map.setOptions({ draggableCursor: null });
  setScreen("result");
  renderRankedHud();
  const last = g.index + 1 >= g.rounds || (!r.placing && (r.myLife <= 0 || r.npcLife <= 0));
  const headline = diff === 0 ? "引き分け！"
    : r.placing ? (diff > 0 ? "このラウンドはあなたの勝ち！" : `${r.npc.name} の勝ち`)
      : diff > 0 ? `相手に −${damage.toLocaleString()} ダメージ！` : `−${damage.toLocaleString()} ダメージを受けた…`;
  $("result-text").innerHTML = `
    <div class="rs-reaction"><span class="reaction">${escapeHtml(headline)}</span></div>
    <div class="rs-meta"><b>${r.placing ? `認定戦 ${r.matchNo}` : "本戦"} ・ ラウンド ${g.index + 1} / ${g.rounds}${!r.placing ? ` ・ ×${mult}` : ""}</b>${LEGEND}${mapsLink(g.answer)}</div>
    <div class="rs-side rs-left">
      <div class="rs-big rs-score" data-count="${mine.score}">0</div>
      <div class="rs-cap">あなた ・ ${missed ? "時間切れ" : formatDistance(mine.distance)}</div>
      ${answerCountryHtml(g, g.answer)}
    </div>
    <div class="rs-side rs-right">
      <div class="rs-big rs-score">${npc.score.toLocaleString()}</div>
      <div class="rs-cap">${escapeHtml(r.npc.name)} ・ ${formatDistance(npc.distance)}</div>
    </div>`;
  $("btn-next").textContent = last ? "結果を見る" : "次のラウンドへ";
  $("btn-end").hidden = true;
  setResultButtons(false, false);
  $("result").hidden = false;
  animateCounts($("result-text"));
  fitResults([mine, { guess: npc.guess, answer: g.answer }], { top: 70, bottom: 90, left: 60, right: 60 });
}

function rankedOver(g) {
  const r = g.ranked;
  return g.index >= g.rounds || (!r.placing && (r.myLife <= 0 || r.npcLife <= 0));
}

function rankedDidWin(g) {
  const r = g.ranked;
  if (r.placing) return r.myTotal >= r.npcTotal;
  if (r.myLife <= 0) return false;
  if (r.npcLife <= 0) return true;
  return r.myLife > r.npcLife || (r.myLife === r.npcLife && r.myTotal >= r.npcTotal);
}

// 本戦のランクポイントの増減
function rankDelta(rp, win, margin) {
  const tier = rankOf(rp).tier.id;
  const hard = tier === "champion" ? 2 : tier === "master" ? 1 : 0;
  return win ? 24 + Math.round(8 * margin) - hard * 4 : -(20 + Math.round(8 * margin) + hard * 5);
}

// 認定戦 3 回の成績からランクを決める（ゴールド 3 まで）
function judgePlacement(list) {
  const avg = list.reduce((s, m) => s + m.avg, 0) / list.length;
  const wins = list.filter((m) => m.win).length;
  const rp = Math.max(0, Math.min(PLACEMENT_MAX_RP, Math.round((avg / 4200) * 800) + wins * 20));
  return { rp, avg: Math.round(avg), wins };
}

function placementComment(j) {
  if (j.rp >= 800) return "どのラウンドも正確でした。認定戦で上がれるいちばん上の帯です。ここから先は実力で。";
  if (j.rp >= 600) return "安定して近くに刺せています。手がかりをしっかり読めています。";
  if (j.rp >= 300) return "国や地域の見当はついています。あと一歩、細かい手がかりを拾えると伸びます。";
  return "まずは文字と道路の特徴から覚えていきましょう。伸びしろはたっぷりあります。";
}

// 試合の結果を記録して、結果の画面を出す
function rankedFinish(g, forfeit = false) {
  const r = g.ranked;
  stopTimer();
  clearTimeout(r.npcTimer);
  clearGameMarkers();
  $("result").hidden = true;
  r.finished = true;
  if (!g.recorded) {
    recordGame(g);
    g.recorded = true;
  }
  const win = !forfeit && rankedDidWin(g);
  const rank = loadRank();
  const before = rank.rp;
  let body;
  if (r.placing) {
    const avg = g.results.length ? r.myTotal / g.results.length : 0;
    rank.placement = [...rank.placement, { avg: forfeit ? 0 : avg, win }];
    if (rank.placement.length >= PLACEMENT_MATCHES) {
      const j = judgePlacement(rank.placement);
      rank.rp = j.rp;
      const named = rankOf(j.rp);
      body = `<p class="rk-eyebrow">PLACEMENT COMPLETE</p>
        <div class="rk-reveal">${rankEmblem(named.tier.id, 132)}</div>
        <h2 class="rk-title">${named.name}</h2>
        <p class="rk-sub">認定戦の平均 ${j.avg.toLocaleString()} 点 ・ ${j.wins} 勝 ${PLACEMENT_MATCHES - j.wins} 敗</p>
        <p class="rk-rule">${placementComment(j)}</p>`;
    } else {
      body = `<p class="rk-eyebrow">PLACEMENT ${rank.placement.length} / ${PLACEMENT_MATCHES}</p>
        <h2 class="rk-title ${win ? "win" : "lose"}">${forfeit ? "途中で終了" : win ? "勝利！" : "敗北"}</h2>
        <p class="rk-sub">あなた ${r.myTotal.toLocaleString()} 点 ・ ${escapeHtml(r.npc.name)} ${r.npcTotal.toLocaleString()} 点</p>`;
    }
  } else {
    const margin = g.results.length ? (win ? r.myLife : r.npcLife) / MATCH_LIFE : 1;
    const delta = rankDelta(before, win, Math.max(0, Math.min(1, margin)));
    rank.rp = Math.max(0, before + delta);
    rank[win ? "wins" : "losses"] += 1;
    const was = rankOf(before);
    const now = rankOf(rank.rp);
    const moved = was.name === now.name ? "" : rank.rp > before ? `<p class="rk-move up">▲ ${now.name} に昇格！</p>` : `<p class="rk-move down">▼ ${now.name} に降格</p>`;
    body = `<p class="rk-eyebrow">MATCH RESULT</p>
      <h2 class="rk-title ${win ? "win" : "lose"}">${forfeit ? "途中で終了" : win ? "勝利！" : "敗北"}</h2>
      <p class="rk-sub">体力 あなた ${r.myLife.toLocaleString()} ・ ${escapeHtml(r.npc.name)} ${r.npcLife.toLocaleString()}</p>
      <div class="rk-reveal small">${rankEmblem(now.tier.id, 96)}</div>
      <h3 class="rk-rankname">${now.name}</h3>
      <p class="rk-delta ${delta >= 0 ? "up" : "down"}">${delta >= 0 ? "+" : ""}${delta} RP（${rank.rp.toLocaleString()} RP）</p>
      ${moved}
      <div class="rk-progress">${rankProgressHtml(rank.rp)}</div>`;
  }
  saveRank(rank);
  renderRankProfile();
  setScreen("ranked");
  $("ranked-screen").innerHTML = `<div class="rk-main rk-result">${body}
      <div class="rk-actions">
        <button id="rk-again" class="btn-hero small">続ける</button>
        <button id="rk-back" class="btn-ghost">マップ選択に戻る</button>
      </div>
    </div>${ladderHtml(rank.rp)}`;
  state.game = null;
  $("rk-again").addEventListener("click", showRankedLobby);
  $("rk-back").addEventListener("click", showHome);
}

// 設定の「ゲームを終了する」: ランク戦では負け扱いになる
async function confirmRankedExit() {
  const g = state.game;
  const ok = await askConfirm({
    title: "試合をやめますか？",
    text: "途中でやめると、この試合は負け扱いになります。",
    okText: "やめる",
    danger: true,
  });
  if (!ok || state.game !== g) return;
  closeGameSettings();
  $("loading").hidden = true;
  rankedFinish(g, true);
}

function hpRow(cls, avatar, name, rankHtml, life, total, placing) {
  const value = placing
    ? `<b class="rh-num">${total.toLocaleString()}</b>`
    : `<i class="rh-bar"><i style="width:${(life / MATCH_LIFE) * 100}%;background:${lifeColor(life / MATCH_LIFE)}"></i></i><b class="rh-num">${life.toLocaleString()}</b>`;
  return `<div class="rh-row ${cls}">${avatar}<div class="rh-who"><b>${escapeHtml(name)}</b>${rankHtml}</div>${value}</div>`;
}

// 試合中の右上: 自分と相手の体力（認定戦は合計点）
function renderRankedHud() {
  const g = state.game;
  const hud = $("ranked-hud");
  const r = g && g.ranked;
  hud.hidden = !r;
  if (!r) return;
  const me = myProfile();
  const rank = loadRank();
  const mult = r.placing ? "" : ` ・ ×${ROUND_MULTIPLIERS[Math.min(g.index, ROUND_MULTIPLIERS.length - 1)]}`;
  hud.innerHTML = `
    <div class="rh-head"><b>${r.placing ? `認定戦 ${r.matchNo} / ${PLACEMENT_MATCHES}` : "コンペティティブ"}</b><span>ラウンド ${g.index + 1} / ${g.rounds}${mult}</span></div>
    ${hpRow("me", playerAvatarHtml({ name: me.name, avatar: me.avatar, color: me.avatar.color }), me.name, rankLabelHtml(rank.rp, 16), r.myLife, r.myTotal, r.placing)}
    ${hpRow("npc", `<span class="p-avatar glyph" style="--c:${r.npc.color};--pc:${r.npc.color}">${r.npc.glyph}</span>`, r.npc.name, rankLabelHtml(r.npc.rp, 16), r.npcLife, r.npcTotal, r.placing)}`;
}
