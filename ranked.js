// ================================================================ コンペティティブ（NPC とのランク戦）
// 最初に 3 ラウンドの認定戦を 3 回戦い、その成績でランクが決まる（ゴールド 3 まで）。
// そのあとの本戦は 5 ラウンド・体力 6000 で、ラウンドごとに点数が低い側が差の分だけダメージを受ける。

const STORE_RANK = "lg.rank";
const RANK_DIVISION_RP = 100;
const RANK_TIERS = [
  { id: "bronze", name: "ブロンズ", start: 0, divs: 4 },
  { id: "silver", name: "シルバー", start: 400, divs: 4 },
  { id: "gold", name: "ゴールド", start: 800, divs: 4 },
  { id: "master", name: "マスター", start: 1200, divs: 4 },
  { id: "champion", name: "チャンピオン", start: 1600, divs: 1 },
];
const PLACEMENT_MATCHES = 3;
const PLACEMENT_ROUNDS = 3;
const PLACEMENT_MAX_RP = 1099; // 認定戦で上がれるのはゴールド 3 まで（マスターからは上級者）
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
const NPC_SKILL_POINTS = [[0, 1300], [400, 2200], [800, 3000], [1200, 3800], [1600, 4550], [2000, 4850]];
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
  const sd = npc.rp >= 1600 ? 320 : npc.rp >= 1200 ? 500 : 800;
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
  const rank = { rp: null, placement: [], wins: 0, losses: 0, ...loadJSON(STORE_RANK, {}) };
  // 各ランクが 3 段階だったころ（v1.86）の記録は、4 段階の数え方に直す
  if (rank.rp != null && !rank.divs4) rank.rp = Math.round((rank.rp * 4) / 3);
  rank.divs4 = true;
  return rank;
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

// ランクの色（style.css の .rank-c-○○）
function rankColorClass(r) {
  return `rank-c-${r ? r.tier.id : "none"}`;
}

function rankLabelHtml(rp, size = 28) {
  const r = rankOf(rp);
  return `<span class="rank-label ${rankColorClass(r)}">${rankEmblem(r ? r.tier.id : null, size)}<b>${r ? r.name : "ランクなし"}</b></span>`;
}

// プロフィールと右上の表示
function renderRankProfile() {
  const rank = loadRank();
  const r = rankOf(rank.rp);
  const box = $("pf-rank");
  if (box) {
    box.innerHTML = `${rankEmblem(r ? r.tier.id : null, 56)}
      <div><small>コンペティティブ</small><b class="${rankColorClass(r)}">${r ? r.name : "ランクなし"}</b>
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
  return Math.max(160, Math.min(1040, 530 + wins * 240 - losses * 160));
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
    <div class="rk-step rank-c-${t.id}${cur && cur.tier.id === t.id ? " current" : ""}">${rankEmblem(t.id, 44)}<b>${t.name}</b></div>`).join("")}
    <div class="rk-step rank-c-none${cur ? "" : " current"}">${rankEmblem(null, 44)}<b>ランクなし</b></div>
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
  const change = { myFrom: r.placing ? r.myTotal : r.myLife, npcFrom: r.placing ? r.npcTotal : r.npcLife };
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
  renderRankedHud(change);
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
  fitResults([mine, { guess: npc.guess, answer: g.answer }], { top: 130, bottom: 90, left: 60, right: 60 });
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
  const rp = Math.max(0, Math.min(PLACEMENT_MAX_RP, Math.round((avg / 4200) * 1050) + wins * 25));
  return { rp, avg: Math.round(avg), wins };
}

function placementComment(j) {
  if (j.rp >= 1000) return "どのラウンドも正確でした。認定戦で上がれるいちばん上の帯です。ここから先は実力で。";
  if (j.rp >= 800) return "安定して近くに刺せています。手がかりをしっかり読めています。";
  if (j.rp >= 400) return "国や地域の見当はついています。あと一歩、細かい手がかりを拾えると伸びます。";
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
  const verdict = forfeit ? "途中で終了" : win ? "勝利！" : "敗北";
  const verdictCls = forfeit || !win ? "lose" : "win";
  let body;
  let show = null;
  if (r.placing) {
    const avg = g.results.length ? r.myTotal / g.results.length : 0;
    rank.placement = [...rank.placement, { avg: forfeit ? 0 : avg, win }];
    if (rank.placement.length >= PLACEMENT_MATCHES) {
      const j = judgePlacement(rank.placement);
      rank.rp = j.rp;
      body = rankStageHtml("PLACEMENT COMPLETE", "判定中…", "", rankEmblem(null, 128), "？？？", "", "");
      show = { kind: "placement", to: j.rp, sub: `認定戦の平均 ${j.avg.toLocaleString()} 点 ・ ${j.wins} 勝 ${PLACEMENT_MATCHES - j.wins} 敗`, note: placementComment(j) };
    } else {
      body = `<p class="rk-eyebrow">PLACEMENT ${rank.placement.length} / ${PLACEMENT_MATCHES}</p>
        <h2 class="rk-title rk-slam ${verdictCls}">${verdict}</h2>
        <p class="rk-sub">あなた ${r.myTotal.toLocaleString()} 点 ・ ${escapeHtml(r.npc.name)} ${r.npcTotal.toLocaleString()} 点</p>`;
    }
  } else {
    const margin = g.results.length ? (win ? r.myLife : r.npcLife) / MATCH_LIFE : 1;
    const delta = rankDelta(before, win, Math.max(0, Math.min(1, margin)));
    rank.rp = Math.max(0, before + delta);
    rank[win ? "wins" : "losses"] += 1;
    const was = rankOf(before);
    body = rankStageHtml("MATCH RESULT", verdict, `体力 あなた ${r.myLife.toLocaleString()} ・ ${escapeHtml(r.npc.name)} ${r.npcLife.toLocaleString()}`,
      rankEmblem(was.tier.id, 128), was.name, verdictCls, `<p class="rk-delta ${delta >= 0 ? "up" : "down"}" id="rk-delta"></p>
      <div class="rk-progress"><i class="rk-bar"><i id="rk-fill"></i></i><span id="rk-left"></span></div>`);
    show = { kind: "match", from: before, to: rank.rp, delta };
  }
  saveRank(rank);
  renderRankProfile();
  setScreen("ranked");
  $("ranked-screen").innerHTML = `<div class="rk-main rk-result">${body}
      <div class="rk-actions${show ? " wait" : ""}" id="rk-actions">
        <button id="rk-again" class="btn-hero small">続ける</button>
        <button id="rk-back" class="btn-ghost">マップ選択に戻る</button>
      </div>
    </div>${ladderHtml(show ? (show.kind === "match" ? show.from : null) : rank.rp)}`;
  state.game = null;
  $("rk-again").addEventListener("click", showRankedLobby);
  $("rk-back").addEventListener("click", showHome);
  if (show) playRankShow(show, rank.rp);
}

function rankStageHtml(eyebrow, title, sub, emblem, name, cls, extra) {
  return `<p class="rk-eyebrow">${eyebrow}</p>
    <h2 class="rk-title rk-slam ${cls}" id="rk-head">${title}</h2>
    <p class="rk-sub" id="rk-sub">${sub}</p>
    <div class="rk-stage" id="rk-stage">
      <div class="rk-rays"></div><div class="rk-ring"></div><div class="rk-flash"></div>
      <div class="rk-emblem" id="rk-emblem">${emblem}</div>
      <canvas id="rk-fx" width="640" height="640"></canvas>
    </div>
    <p class="rk-banner" id="rk-banner"></p>
    <h3 class="rk-rankname" id="rk-name">${name}</h3>
    ${extra}
    <p class="rk-rule" id="rk-note"></p>`;
}

// ---- ランクが決まる・上がる・下がるときの演出

// 紙吹雪（down は灰色の破片が落ちる）
function rankParticles(colors, count, power, down) {
  const canvas = $("rk-fx");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const c = canvas.width / 2;
  const list = Array.from({ length: count }, () => {
    const angle = down ? Math.PI / 2 + (rand() - 0.5) * 2 : rand() * Math.PI * 2;
    const speed = power * (0.35 + rand() * 0.75);
    return {
      x: c, y: c, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - (down ? 0 : 2),
      size: 4 + rand() * 8, rot: rand() * 6, spin: (rand() - 0.5) * 0.4, color: colors[Math.floor(rand() * colors.length)], life: 1,
    };
  });
  const started = performance.now();
  const step = (now) => {
    if (!canvas.isConnected) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const fade = 1 - (now - started) / 2000;
    if (fade <= 0) return;
    list.forEach((p) => {
      p.vy += 0.16;
      p.vx *= 0.985;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.spin;
      ctx.save();
      ctx.globalAlpha = Math.min(1, fade * 1.6);
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 3, p.size, p.size * 0.66);
      ctx.restore();
    });
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function rankBurst(tierId, big) {
  const stage = $("rk-stage");
  if (!stage) return;
  const [hi, mid] = EMBLEM_COLORS[tierId];
  stage.style.setProperty("--rk-c", mid);
  stage.style.setProperty("--rk-hi", hi);
  stage.classList.remove("burst", "big");
  void stage.offsetWidth;
  stage.classList.add("burst");
  if (big) stage.classList.add("big");
  rankParticles([hi, mid, "#ffffff", "#ffd23f"], big ? 260 : 130, big ? 15 : 10, false);
}

// 演出の中のランク名: 文字をランクの色にする
function paintRankName(r) {
  const el = $("rk-name");
  el.textContent = r.name;
  el.className = `rk-rankname ${el.classList.contains("reveal") ? "reveal " : ""}${rankColorClass(r)}`;
}

function slamEmblem(tierId, cls = "slam") {
  const box = $("rk-emblem");
  box.innerHTML = rankEmblem(tierId, 128);
  box.classList.remove("slam", "drop", "pulse");
  void box.offsetWidth;
  box.classList.add(cls);
}

function setRankBar(pct, ms) {
  const fill = $("rk-fill");
  if (!fill) return;
  fill.style.transition = ms ? `width ${ms}ms cubic-bezier(.3,.8,.3,1)` : "none";
  fill.style.width = `${pct}%`;
}

const rankPct = (r) => (r.next ? (r.into / r.next) * 100 : 100);

function showRankBanner(text, cls) {
  const b = $("rk-banner");
  b.textContent = text;
  b.className = `rk-banner show ${cls}`;
}

function finishRankShow(rp) {
  const act = $("rk-actions");
  if (act) act.classList.remove("wait");
  // 右のランク表を、新しいランクに合わせる
  const cur = rankOf(rp);
  document.querySelectorAll("#ranked-screen .rk-step").forEach((el, i) => {
    const ids = [...RANK_TIERS].reverse().map((t) => t.id);
    el.classList.toggle("current", ids[i] === cur.tier.id);
  });
}

// ---- チャンピオンに到達したときの、全画面のお祝い

// 打ち上げ花火と紙吹雪。止めるときは返した関数を呼ぶ
function startChampionFireworks(canvas) {
  const ctx = canvas.getContext("2d");
  const fit = () => {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  };
  fit();
  window.addEventListener("resize", fit);
  const COLORS = ["#62d6ff", "#c6f7ff", "#ffffff", "#ffd23f", "#28b4ff", "#ff6fa3"];
  const pick = () => COLORS[Math.floor(rand() * COLORS.length)];
  const sparks = [];
  const confetti = Array.from({ length: 150 }, () => ({
    x: rand() * canvas.width, y: -rand() * canvas.height * 1.4, vy: 1.6 + rand() * 2.6, sway: rand() * 6, size: 5 + rand() * 7, rot: rand() * 6, spin: (rand() - 0.5) * 0.25, color: pick(),
  }));
  const shell = () => {
    const x = canvas.width * (0.12 + rand() * 0.76);
    const y = canvas.height * (0.12 + rand() * 0.48);
    const color = pick();
    const count = 90 + Math.floor(rand() * 60);
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2;
      const speed = 2 + rand() * 6.5;
      sparks.push({ x, y, px: x, py: y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, life: 1, fade: 0.008 + rand() * 0.012, color: rand() < 0.25 ? "#ffffff" : color });
    }
  };
  let running = true;
  let nextShell = 0;
  const begin = performance.now();
  const step = (now) => {
    if (!running) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (now >= nextShell) {
      shell();
      if (now - begin < 900) shell();
      nextShell = now + 260 + rand() * 520;
    }
    ctx.globalCompositeOperation = "lighter";
    ctx.lineCap = "round";
    for (let i = sparks.length - 1; i >= 0; i--) {
      const p = sparks[i];
      p.px = p.x;
      p.py = p.y;
      p.vx *= 0.985;
      p.vy = p.vy * 0.985 + 0.05;
      p.x += p.vx;
      p.y += p.vy;
      p.life -= p.fade;
      if (p.life <= 0) {
        sparks.splice(i, 1);
        continue;
      }
      ctx.globalAlpha = p.life;
      ctx.strokeStyle = p.color;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(p.px, p.py);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 0.95;
    confetti.forEach((c) => {
      c.y += c.vy;
      c.rot += c.spin;
      if (c.y > canvas.height + 20) c.y = -20;
      ctx.save();
      ctx.translate(c.x + Math.sin(c.y / 40 + c.sway) * 16, c.y);
      ctx.rotate(c.rot);
      ctx.fillStyle = c.color;
      ctx.fillRect(-c.size / 2, -c.size / 3, c.size, c.size * 0.62);
      ctx.restore();
    });
    ctx.globalAlpha = 1;
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  return () => {
    running = false;
    window.removeEventListener("resize", fit);
  };
}

function playChampionShow(rp) {
  return new Promise((resolve) => {
    const me = myProfile();
    const box = document.createElement("div");
    box.id = "champion-show";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-label", "チャンピオンに到達しました");
    box.innerHTML = `
      <div class="cs-rays"></div>
      <canvas class="cs-fx"></canvas>
      <div class="cs-flash"></div>
      <div class="cs-body">
        <div class="cs-emblem">${rankEmblem("champion", 300)}</div>
        <h1 class="cs-title" aria-label="CHAMPION">${[..."CHAMPION"].map((ch, i) => `<span style="--i:${i}">${ch}</span>`).join("")}</h1>
        <p class="cs-rankname rank-c-champion">チャンピオン到達</p>
        <p class="cs-player">${escapeHtml(me.name)} ・ ${rp.toLocaleString()} RP</p>
        <p class="cs-line">最高ランクの頂点へ。世界はもう、あなたの庭です。</p>
        <button type="button" class="btn-hero small cs-ok">続ける</button>
      </div>`;
    document.body.appendChild(box);
    const stop = state.prefs && state.prefs.anim ? startChampionFireworks(box.querySelector(".cs-fx")) : () => {};
    const ok = box.querySelector(".cs-ok");
    ok.addEventListener("click", () => {
      stop();
      box.remove();
      resolve();
    }, { once: true });
  });
}

async function playRankShow(show, rp) {
  const now = rankOf(rp);
  const animate = !!(state.prefs && state.prefs.anim);
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, animate ? ms : 0));
  const alive = () => !!$("rk-stage");

  if (show.kind === "placement") {
    if (animate) {
      // ルーレットのようにランクのマークを切り替えて、だんだん遅くする
      const order = [...RANK_TIERS.map((t) => t.id).slice(0, 3)];
      const spins = 14;
      for (let i = 0; i < spins; i++) {
        if (!alive()) return;
        $("rk-emblem").innerHTML = rankEmblem(order[i % order.length], 128);
        await wait(70 + i * i * 2.2);
      }
    }
    if (!alive()) return;
    $("rk-head").textContent = "ランク決定";
    $("rk-head").classList.add("win");
    $("rk-sub").textContent = show.sub;
    slamEmblem(now.tier.id);
    paintRankName(now);
    $("rk-name").classList.add("reveal");
    if (animate) rankBurst(now.tier.id, true);
    showRankBanner("PLACED!", "up");
    $("rk-note").textContent = show.note;
    await wait(1400);
    if (alive()) finishRankShow(rp);
    return;
  }

  const was = rankOf(show.from);
  const delta = $("rk-delta");
  const left = $("rk-left");
  const leftText = (r, value) => (r.next ? `次のランクまで ${r.next - r.into} RP` : `${value.toLocaleString()} RP`);
  paintRankName(was);
  setRankBar(rankPct(was), 0);
  left.textContent = leftText(was, show.from);
  delta.innerHTML = `<span id="rk-num">0</span> RP`;
  const sign = show.delta >= 0 ? "+" : "−";
  await wait(650);
  if (!alive()) return;
  // RP を数えながら増減させる
  const num = $("rk-num");
  if (animate) {
    tweenNumber(num, 0, Math.abs(show.delta), 800, sign);
  } else {
    num.textContent = `${sign}${Math.abs(show.delta)}`;
  }
  const changed = was.name !== now.name;
  const up = show.delta >= 0;
  if (!changed) {
    setRankBar(rankPct(now), 900);
    if (animate) {
      $("rk-emblem").classList.remove("pulse");
      void $("rk-emblem").offsetWidth;
      $("rk-emblem").classList.add("pulse");
      if (up) rankParticles([EMBLEM_COLORS[now.tier.id][0], "#ffffff"], 40, 7, false);
    }
    await wait(1000);
  } else if (up) {
    setRankBar(100, 700);
    await wait(760);
    if (!alive()) return;
    const tierUp = was.tier.id !== now.tier.id;
    // チャンピオンは、ゲージが満タンになった瞬間に全画面のお祝いを出す（マークはその後で切り替える）
    const toChampion = now.tier.id === "champion";
    if (toChampion) await playChampionShow(rp);
    if (!alive()) return;
    slamEmblem(now.tier.id);
    paintRankName(now);
    $("rk-name").classList.add("reveal");
    if (animate) rankBurst(now.tier.id, tierUp && !toChampion);
    showRankBanner(tierUp ? "TIER UP!" : "RANK UP!", "up");
    setRankBar(0, 0);
    await wait(120);
    if (!alive()) return;
    // お祝いのあとに、ポイントがたまっていくところを見せる
    if (toChampion) {
      left.innerHTML = `<span id="rk-charge">${now.tier.start.toLocaleString()}</span> RP`;
      if (animate) tweenNumber($("rk-charge"), now.tier.start, rp, 1000);
      setRankBar(100, 1000);
      await wait(1300);
    } else {
      setRankBar(rankPct(now), 700);
      await wait(1100);
    }
  } else {
    setRankBar(0, 700);
    await wait(760);
    if (!alive()) return;
    slamEmblem(now.tier.id, "drop");
    paintRankName(now);
    $("rk-stage").classList.add("hurt");
    if (animate) rankParticles(["#6b7280", "#9ca3af", "#374151"], 70, 5, true);
    showRankBanner("RANK DOWN", "down");
    setRankBar(100, 0);
    await wait(120);
    if (!alive()) return;
    setRankBar(rankPct(now), 700);
    await wait(1000);
  }
  if (!alive()) return;
  left.textContent = leftText(now, rp);
  finishRankShow(rp);
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

// 体力バー1本分（チーム戦と同じ部品）
function rankedSideHtml(cls, mine, glyph, color, name, rp) {
  return `<div class="tg ${cls}${mine ? " mine" : ""}">
    <span class="tg-badge" style="background:${color}">${glyph}</span>
    <div class="tg-main">
      <div class="tg-bar"><i class="tg-ghost"></i><i class="tg-fill"></i><b class="tg-life">0</b></div>
      <div class="tg-meta"><small class="tg-name">${escapeHtml(name)}</small>${rankLabelHtml(rp, 16)}<span class="tg-you">あなた</span></div>
    </div>
    <span class="tg-dmg"></span>
  </div>`;
}

// 試合中の上: 左に相手、右に自分の体力（認定戦は合計点）。change があれば、結果の画面で減るところを見せる
function renderRankedHud(change) {
  const g = state.game;
  const hud = $("ranked-hud");
  const r = g && g.ranked;
  hud.hidden = !r;
  if (!r) return;
  const me = myProfile();
  const rank = loadRank();
  const mult = r.placing ? "" : `<em class="rh-mult">×${ROUND_MULTIPLIERS[Math.min(g.index, ROUND_MULTIPLIERS.length - 1)]}</em>`;
  hud.innerHTML = `
    ${rankedSideHtml("red", false, r.npc.glyph, r.npc.color, r.npc.name, r.npc.rp)}
    <div class="rh-round"><b>${r.placing ? `認定戦 ${r.matchNo} / ${PLACEMENT_MATCHES}` : "コンペティティブ"}</b><span>ラウンド ${g.index + 1} / ${g.rounds}</span>${mult}</div>
    ${rankedSideHtml("blue", true, me.avatar.glyph, me.avatar.color, me.name, rank.rp)}`;
  const max = r.placing ? g.rounds * MAX_SCORE : MATCH_LIFE;
  const sides = [
    { el: hud.querySelector(".tg.red"), now: r.placing ? r.npcTotal : r.npcLife, from: change ? change.npcFrom : null, color: "#e5392f" },
    { el: hud.querySelector(".tg.blue"), now: r.placing ? r.myTotal : r.myLife, from: change ? change.myFrom : null, color: "#2563eb" },
  ];
  const paint = (s, ratio) => (r.placing ? `linear-gradient(180deg, ${s.color}, ${s.color}cc)` : lifeColor(ratio));
  sides.forEach((s) => {
    const from = s.from == null ? s.now : s.from;
    const fill = s.el.querySelector(".tg-fill");
    const ghost = s.el.querySelector(".tg-ghost");
    const num = s.el.querySelector(".tg-life");
    const dmg = s.el.querySelector(".tg-dmg");
    fill.style.transition = ghost.style.transition = "none";
    fill.style.width = ghost.style.width = `${(from / max) * 100}%`;
    fill.style.background = paint(s, from / max);
    num.textContent = from.toLocaleString();
    if (from === s.now) return;
    dmg.classList.toggle("gain", r.placing);
    dmg.textContent = r.placing ? `+${(s.now - from).toLocaleString()}` : `−${(from - s.now).toLocaleString()}`;
    setTimeout(() => {
      if (!s.el.isConnected) return;
      fill.style.transition = "";
      fill.style.width = `${(s.now / max) * 100}%`;
      fill.style.background = paint(s, s.now / max);
      ghost.style.transition = r.placing ? "none" : "width .9s ease .5s";
      ghost.style.width = `${(s.now / max) * 100}%`;
      countNumber(num, from, s.now);
      dmg.classList.add("show");
      if (!r.placing) {
        s.el.classList.remove("hit");
        void s.el.offsetWidth;
        s.el.classList.add("hit");
      }
    }, 700);
  });
}
