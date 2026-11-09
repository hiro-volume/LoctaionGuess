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

// ランクごとの盾の形。outer は外形、frame は段階 2 からの二重の枠、shine は右上の光、pipY / pipGap は段階の点の位置
const EMBLEM_SHAPES = {
  shield: {
    outer: "M32 5 55 13v19c0 14-11 23-23 27C20 55 9 46 9 32V13z",
    frame: "M32 10.5 50.5 17V32c0 11-8.5 18.8-18.5 22.3C22 50.8 13.5 43 13.5 32V17z",
    shine: "M32 10 50 16.5V32c0 11-8.5 18.5-18 22", pipY: 51, pipGap: 6.5, scale: 0.86,
  },
  diamond: {
    outer: "M32 2 61 31 32 60 3 31z",
    frame: "M32 8.5 54.5 31 32 53.5 9.5 31z",
    shine: "M32 8 54 30", pipY: 43, pipGap: 5.6, scale: 0.7,
  },
  pentagon: {
    outer: "M32 3 60 23 49 60H15L4 23z",
    frame: "M32 9.5 54 25 45 54.5H19L10 25z",
    shine: "M32 9 54 24.5", pipY: 51, pipGap: 6.5, scale: 0.9,
  },
};
const TIER_SHAPES = { bronze: "shield", silver: "diamond", gold: "pentagon", none: "shield" };

// 正多角形の頂点
function polygonPoints(cx, cy, r, n, rot = 0) {
  return Array.from({ length: n }, (_, i) => {
    const t = rot + (i * 2 * Math.PI) / n;
    return `${(cx + r * Math.sin(t)).toFixed(1)},${(cy - r * Math.cos(t)).toFixed(1)}`;
  }).join(" ");
}

// マスターの本体: 左右に角ばった板、金属の太い枠、その中に宝石をはめた盾
function masterBody(u, hi, mid, lo) {
  const plate = `<path d="M15 10 3 18v29l12 10 7-6V15z" fill="url(#${u}p)" stroke="${hi}" stroke-width="1.6" stroke-linejoin="round"/><path d="M4 32h13" stroke="${hi}" stroke-width="1.2" opacity=".7"/>`;
  return `${plate}<g transform="translate(64 0) scale(-1 1)">${plate}</g>
    <path d="M32 4 53 11v23c0 13-10 21-21 26C21 55 11 47 11 34V11z" fill="url(#${u}m)" stroke="${lo}" stroke-width="1" stroke-linejoin="round"/>
    <path d="M32 11 47 16v18c0 9.5-7 15.5-15 19.5C24 49.5 17 43.5 17 34V16z" fill="url(#${u})" stroke="${lo}" stroke-width="1.2" stroke-linejoin="round"/>
    <path d="M42 14.5 47 16v8z" fill="#fff" opacity=".35"/>`;
}

// div は 1〜4（数字が大きいほど飾りが豪華になる）。0 は段階なしの表示
function rankEmblem(tierId, size = 48, div = 0) {
  if (tierId === "champion") return championEmblem(size);
  const id = tierId || "none";
  const [hi, mid, lo] = EMBLEM_COLORS[id];
  const u = `re${++emblemSeq}`;
  const px = Math.round(size * 1.16);
  const master = id === "master";
  const shape = EMBLEM_SHAPES[TIER_SHAPES[id] || "shield"];
  const marks = {
    none: `<text x="32" y="42" text-anchor="middle" font-size="30" font-weight="900" font-family="sans-serif" fill="${hi}">?</text>`,
    bronze: `<path d="M19 34 32 23l13 11v8L32 31l-13 11z" fill="${hi}"/>`,
    silver: `<path d="M19 27 32 16l13 11v7L32 23l-13 11z" fill="${hi}"/><path d="M19 38 32 27l13 11v7L32 34l-13 11z" fill="${hi}" opacity=".8"/>`,
    gold: `<path d="M32 14l5 10.5 11.5 1.3-8.5 7.8 2.4 11.4L32 39.3 21.6 45l2.4-11.4-8.5-7.8L27 24.5z" fill="${hi}" stroke="${lo}" stroke-width="1.5" stroke-linejoin="round"/>`,
    master: `<polygon points="${polygonPoints(32, 30, 14, 8, Math.PI / 8)}" fill="${lo}" stroke="url(#${u}m)" stroke-width="3.4" stroke-linejoin="round"/><polygon points="${polygonPoints(32, 30, 8.5, 8, Math.PI / 8)}" fill="url(#${u}g)"/><path d="M32 21.5v17M23.5 30h17" stroke="#fff" stroke-width=".9" opacity=".55"/>`,
  };
  // 飾り: 2 で二重の枠、3 で翼、4 で大きな翼と冠と後光
  const frame = div >= 2 && !master ? `<path d="${shape.frame}" fill="none" stroke="${hi}" stroke-width="1.3" stroke-linejoin="round" opacity=".75"/>` : "";
  const inner = div >= 2 && master ? `<path d="M32 14.5 44 18.5V34c0 7.5-5.5 12.5-12 16-6.5-3.5-12-8.5-12-16V18.5z" fill="none" stroke="${hi}" stroke-width="1" opacity=".7"/>` : "";
  const wing = div >= 4
    ? `<path d="M11 13C1 13-7 21-8 32c4-4 9-6 15-6z" fill="${hi}"/><path d="M10 25C2 26-5 32-6 42c4-3 8-5 13-5z" fill="${mid}" stroke="${hi}" stroke-width="1"/><path d="M10 37c-6 1-10 5-12 12 4-2 8-4 13-4z" fill="${hi}" opacity=".85"/>`
    : div >= 3
      ? `<path d="M10 20C3 22-3 29-4 38c4-3 7-5 12-5z" fill="${hi}"/><path d="M10 32c-5 1-9 5-11 11 4-2 7-4 12-4z" fill="${mid}" stroke="${hi}" stroke-width="1"/>`
      : "";
  const wings = wing ? `${wing}<g transform="translate(64 0) scale(-1 1)">${wing}</g>` : "";
  const crown = div >= 4 ? `<path d="M20 11l-2-11 7 5 7-10 7 10 7-5-2 11z" fill="${hi}" stroke="${lo}" stroke-width="1.3" stroke-linejoin="round"/><circle cx="32" cy="-5" r="2.2" fill="#fff"/>` : "";
  const halo = div >= 4 ? `<circle cx="32" cy="30" r="39" fill="url(#${u}h)"/>` : "";
  const pipY = master ? 48.5 : shape.pipY;
  const pipGap = master ? 5.2 : shape.pipGap;
  const pips = div ? Array.from({ length: div }, (_, i) => `<circle cx="${32 + (i - (div - 1) / 2) * pipGap}" cy="${pipY}" r="2.1" fill="${hi}" stroke="${lo}" stroke-width=".8"/>`).join("") : "";
  const body = master
    ? masterBody(u, hi, mid, lo)
    : `<path d="${shape.outer}" fill="url(#${u})" stroke="${hi}" stroke-width="2.5" stroke-linejoin="round"/>${frame}<path d="${shape.shine}" fill="none" stroke="#fff" stroke-opacity=".22" stroke-width="2"/>`;
  const scale = master ? 0.8 : shape.scale;
  return `<svg class="rank-emblem" viewBox="-10 -10 84 84" width="${px}" height="${px}" aria-hidden="true">
    <defs><linearGradient id="${u}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${mid}"/><stop offset="1" stop-color="${lo}"/></linearGradient>
    <linearGradient id="${u}m" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset=".45" stop-color="${hi}"/><stop offset=".7" stop-color="#ffffff"/><stop offset="1" stop-color="${hi}"/></linearGradient>
    <linearGradient id="${u}p" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${hi}"/><stop offset="1" stop-color="${mid}"/></linearGradient>
    <radialGradient id="${u}g" cx=".35" cy=".3"><stop offset="0" stop-color="#ffffff"/><stop offset=".5" stop-color="${hi}"/><stop offset="1" stop-color="${mid}"/></radialGradient>
    <radialGradient id="${u}h"><stop offset=".45" stop-color="${hi}" stop-opacity=".55"/><stop offset="1" stop-color="${hi}" stop-opacity="0"/></radialGradient></defs>
    ${halo}${wings}${crown}
    ${body}${inner}
    <g transform="translate(32 ${master ? 30 : 28}) scale(${scale}) translate(-32 -30)">${marks[id]}</g>
    ${pips}
  </svg>`;
}

// チャンピオンだけの特別なマーク（金の縁、二段の翼、宝石の冠、控えめな後光）
function championEmblem(size) {
  const u = `re${++emblemSeq}`;
  const px = Math.round(size * 1.16);
  const star = (cx, cy, outer, inner, n, rot = 0) => Array.from({ length: n * 2 }, (_, i) => {
    const r = i % 2 ? inner : outer;
    const t = rot + (i * Math.PI) / n;
    return `${(cx + r * Math.sin(t)).toFixed(1)},${(cy - r * Math.cos(t)).toFixed(1)}`;
  }).join(" ");
  const feather = `<path d="M11 10C0 9-9 18-11 31c5-5 11-7 18-7z" fill="url(#${u}g)" stroke="#7f5005" stroke-width=".7"/><path d="M10 22C0 23-8 31-10 42c5-4 10-6 17-6z" fill="url(#${u}b)" stroke="#fff3b0" stroke-width="1"/>`;
  return `<svg class="rank-emblem" viewBox="-14 -14 92 92" width="${px}" height="${px}" aria-hidden="true">
    <defs>
      <linearGradient id="${u}b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7fe3ff"/><stop offset=".5" stop-color="#1ea2f2"/><stop offset="1" stop-color="#0a2a78"/></linearGradient>
      <linearGradient id="${u}g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff6c2"/><stop offset=".5" stop-color="#f7c23a"/><stop offset="1" stop-color="#b9770e"/></linearGradient>
      <radialGradient id="${u}h"><stop offset=".3" stop-color="#8fe8ff" stop-opacity=".45"/><stop offset="1" stop-color="#28b4ff" stop-opacity="0"/></radialGradient>
      <linearGradient id="${u}d" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#7fdcff"/></linearGradient>
    </defs>
    <circle cx="32" cy="30" r="45" fill="url(#${u}h)"/>
    <polygon points="${star(32, 30, 41, 34, 16)}" fill="#28b4ff" opacity=".32"/>
    ${feather}<g transform="translate(64 0) scale(-1 1)">${feather}</g>
    <path d="M32 3 57 12v20c0 15-12 25-25 29C19 57 7 47 7 32V12z" fill="url(#${u}g)" stroke="#7f5005" stroke-width=".8" stroke-linejoin="round"/>
    <path d="M32 7 53.5 14.8V32c0 12.7-10.2 21.5-21.5 25.3C20.7 53.5 10.5 44.7 10.5 32V14.8z" fill="url(#${u}b)" stroke="#fff3b0" stroke-width=".8"/>
    <path d="M32 7 53.5 14.8V27C42 22 22 22 10.5 27V14.8z" fill="#fff" opacity=".13"/>
    <path d="M16 39 13 19l9 7.5L32 11l10 15.5 9-7.5-3 20z" fill="url(#${u}g)" stroke="#7f5005" stroke-width="1" stroke-linejoin="round"/>
    <circle cx="13" cy="18" r="2.6" fill="#fff" stroke="#b9770e" stroke-width=".8"/><circle cx="32" cy="9.5" r="3" fill="#fff" stroke="#b9770e" stroke-width=".8"/><circle cx="51" cy="18" r="2.6" fill="#fff" stroke="#b9770e" stroke-width=".8"/>
    <rect x="16" y="40.5" width="32" height="6" rx="2" fill="url(#${u}g)" stroke="#7f5005" stroke-width=".8"/>
    <circle cx="23" cy="43.5" r="1.7" fill="#28b4ff"/><circle cx="32" cy="43.5" r="1.9" fill="#e5392f"/><circle cx="41" cy="43.5" r="1.7" fill="#28b4ff"/>
    <path d="M32 21l7.5 6.5L32 38l-7.5-10.5z" fill="url(#${u}d)" stroke="#0a2a78" stroke-width="1"/><path d="M24.5 27.5h15M32 21v17" stroke="#28b4ff" stroke-width=".8" opacity=".8"/>
    <polygon points="${star(32, -3, 5.5, 1.6, 4)}" fill="#fff"/>
  </svg>`;
}

// ランクの色（style.css の .rank-c-○○）
function rankColorClass(r) {
  return `rank-c-${r ? r.tier.id : "none"}`;
}

function rankLabelHtml(rp, size = 28) {
  const r = rankOf(rp);
  return `<span class="rank-label ${rankColorClass(r)}">${rankEmblem(r ? r.tier.id : null, size, r ? r.div : 0)}<b>${r ? r.name : "ランクなし"}</b></span>`;
}

// プロフィールと右上の表示
function renderRankProfile() {
  const rank = loadRank();
  const r = rankOf(rank.rp);
  const box = $("pf-rank");
  if (box) {
    box.innerHTML = `${rankEmblem(r ? r.tier.id : null, 56, r ? r.div : 0)}
      <div><small>コンペティティブ ・ 押すと全ランクを表示</small><b class="${rankColorClass(r)}">${r ? r.name : "ランクなし"}</b>
      <span>${r ? `${rank.rp.toLocaleString()} RP ・ ${rank.wins} 勝 ${rank.losses} 敗` : `認定戦 ${rank.placement.length} / ${PLACEMENT_MATCHES}`}</span></div>`;
  }
  const mini = $("tb-rank");
  if (mini) {
    mini.innerHTML = rankEmblem(r ? r.tier.id : null, 22, r ? r.div : 0);
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
  const curIndex = cur ? RANK_TIERS.indexOf(cur.tier) : -1;
  return `<div class="rk-ladder">${[...RANK_TIERS].reverse().map((t) => {
    const here = !!cur && cur.tier.id === t.id;
    const index = RANK_TIERS.indexOf(t);
    // 点は、そのランクで到達した段階まで光る（下のランクは全部、上のランクは消えたまま）
    const lit = index < curIndex ? 4 : here ? cur.div : 0;
    const dots = t.divs > 1 ? `<span class="rk-dots">${[1, 2, 3, 4].map((n) => `<i class="${n <= lit ? "on" : ""}"></i>`).join("")}</span>` : "";
    return `<div class="rk-step rank-c-${t.id}${here ? " current" : ""}">${rankEmblem(t.id, 44, t.divs > 1 ? (here ? cur.div : 1) : 0)}<div class="rk-step-text"><b>${t.name}</b>${dots}</div></div>`;
  }).join("")}
    <div class="rk-step rank-c-none${cur ? "" : " current"}">${rankEmblem(null, 44)}<div class="rk-step-text"><b>ランクなし</b></div></div>
  </div>`;
}

// ---- 全ランクの一覧（プロフィールのランクを押すと開く）

function openRankChart() {
  closeRankChart();
  const rank = loadRank();
  const cur = rankOf(rank.rp);
  const isNow = (t, d) => !!cur && cur.tier.id === t.id && cur.div === d;
  const box = document.createElement("div");
  box.id = "rank-chart";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("aria-label", "コンペティティブのランク");
  const tiers = RANK_TIERS.filter((t) => t.divs > 1).map((t) => `
    <section class="rc-tier rank-c-${t.id}">
      <h4>${t.name}</h4>
      ${[4, 3, 2, 1].map((d) => `<div class="rc-rank${isNow(t, d) ? " now" : ""}">${rankEmblem(t.id, 58, d)}<small>${t.name} ${d}</small>${isNow(t, d) ? "<em>いま</em>" : ""}</div>`).join("")}
    </section>`).join("");
  const champ = RANK_TIERS.find((t) => t.id === "champion");
  box.innerHTML = `
    <div class="rc-panel">
      <button type="button" class="rc-close" aria-label="閉じる">×</button>
      <h3>コンペティティブのランク</h3>
      <p class="rc-lead">最初に 3 ラウンドの認定戦を ${PLACEMENT_MATCHES} 回戦うと、ランクが決まります（認定戦で上がれるのはゴールド 3 まで）。そのあとは本戦に勝つとランクポイント（RP）が増え、負けると減ります。各ランクは 1〜4 の 4 段階で、数字が大きいほど上です。100 RP ごとに次の段階へ上がり、マークの飾りも豪華になります。マスターからは上級者の帯で、チャンピオンに段階はなく、RP に上限もありません。</p>
      <div class="rc-grid">
        ${tiers}
        <section class="rc-tier rc-champ rank-c-champion">
          <h4>${champ.name}</h4>
          <div class="rc-rank${cur && cur.tier.id === "champion" ? " now" : ""}">${rankEmblem("champion", 116)}<small>${champ.name}</small>${cur && cur.tier.id === "champion" ? "<em>いま</em>" : ""}</div>
        </section>
      </div>
      <div class="rc-none rank-c-none${cur ? "" : " now"}">${rankEmblem(null, 40)}<small>ランクなし（認定戦の前）</small>${cur ? "" : "<em>いま</em>"}</div>
    </div>`;
  document.body.appendChild(box);
  box.addEventListener("click", (e) => {
    if (e.target === box || e.target.closest(".rc-close")) closeRankChart();
  });
  box.querySelector(".rc-close").focus();
}

function closeRankChart() {
  const box = document.getElementById("rank-chart");
  if (box) box.remove();
}

document.addEventListener("click", (e) => {
  if (e.target.closest && e.target.closest("#pf-rank")) openRankChart();
});
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.getElementById("rank-chart")) {
    e.stopImmediatePropagation();
    closeRankChart();
  }
}, true);

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
  scheduleNpcPick(g, randomBetween(1, 4));
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
  addOverlay(new MapLabel(npc.guess, r.npc.name, "tag player"));
  state.map.setOptions({ draggableCursor: null });
  setScreen("result");
  renderRankedHud(change);
  renderRoundStrip();
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
      ${r.placing ? "" : lifeDrainHtml(change.myFrom, r.myLife, MATCH_LIFE)}
      ${answerCountryHtml(g, g.answer)}
    </div>
    <div class="rs-side rs-right">
      <div class="rs-big rs-score">${npc.score.toLocaleString()}</div>
      <div class="rs-cap">${escapeHtml(r.npc.name)} ・ ${formatDistance(npc.distance)}</div>
      ${r.placing ? "" : lifeDrainHtml(change.npcFrom, r.npcLife, MATCH_LIFE)}
    </div>`;
  $("btn-next").textContent = last ? "結果を見る" : "次のラウンドへ";
  $("btn-end").hidden = true;
  setResultButtons(false, false);
  $("result").hidden = false;
  animateLifeDrain($("result-text"));
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
      rankEmblem(was.tier.id, 128, was.div), was.name, verdictCls, `<p class="rk-delta ${delta >= 0 ? "up" : "down"}" id="rk-delta"></p>
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

function slamEmblem(r, cls = "slam") {
  const box = $("rk-emblem");
  box.innerHTML = rankEmblem(r.tier.id, 128, r.div);
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
  const ladder = document.querySelector("#ranked-screen .rk-ladder");
  if (ladder) ladder.outerHTML = ladderHtml(rp);
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
        $("rk-emblem").innerHTML = rankEmblem(order[i % order.length], 128, (i % 4) + 1);
        await wait(70 + i * i * 2.2);
      }
    }
    if (!alive()) return;
    $("rk-head").textContent = "ランク決定";
    $("rk-head").classList.add("win");
    $("rk-sub").textContent = show.sub;
    slamEmblem(now);
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
    slamEmblem(now);
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
    slamEmblem(now, "drop");
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

// 試合中の上: 左に自分、右に相手の体力（認定戦は合計点）。change があれば、結果の画面で減るところを見せる
function renderRankedHud(change) {
  const g = state.game;
  const hud = $("ranked-hud");
  const r = g && g.ranked;
  hud.hidden = !r;
  if (!r) return;
  const me = myProfile();
  const rank = loadRank();
  const mult = r.placing ? "" : `<em class="rh-mult"><b>×${ROUND_MULTIPLIERS[Math.min(g.index, ROUND_MULTIPLIERS.length - 1)]}</b></em>`;
  hud.innerHTML = `
    ${rankedSideHtml("red", true, me.avatar.glyph, me.avatar.color, me.name, rank.rp)}
    ${mult}
    ${rankedSideHtml("blue", false, r.npc.glyph, r.npc.color, r.npc.name, r.npc.rp)}`;
  const max = r.placing ? g.rounds * MAX_SCORE : MATCH_LIFE;
  const sides = [
    { el: hud.querySelector(".tg.red"), now: r.placing ? r.myTotal : r.myLife, from: change ? change.myFrom : null, color: "#2563eb" },
    { el: hud.querySelector(".tg.blue"), now: r.placing ? r.npcTotal : r.npcLife, from: change ? change.npcFrom : null, color: "#e5392f" },
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
