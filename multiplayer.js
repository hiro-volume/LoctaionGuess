"use strict";

// ================================================================ マルチプレイ
// ホストのブラウザが「部屋」になり、参加者は PeerJS（WebRTC）でホストに直接つながる。
// 出題地点はホストが決めて配り、各自の回答をホストが集めて採点し、結果を全員に配る。
// 参加者には正解の座標をラウンドが終わるまで送らない（パノラマの ID だけを送る）。

const MP_PREFIX = "locationguess-room-";
const MP_MAX_PLAYERS = 8;
const MP_COLORS = ["#e5392f", "#3b82f6", "#f5c542", "#a855f7", "#14b8a6", "#f97316", "#ec4899", "#84cc16"];
const MP_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 見間違えやすい 0/O・1/I は使わない

state.mp = null;

// ---------------------------------------------------------------- 遊び方の選択画面

function showMode() {
  closeSettings();
  setScreen("mode");
}

function startSingle() {
  leaveRoom();
  showSelect();
}

// ---------------------------------------------------------------- 部屋を作る（ホスト）

function randomRoomCode() {
  const buf = new Uint32Array(6);
  crypto.getRandomValues(buf);
  return [...buf].map((n) => MP_CODE_CHARS[n % MP_CODE_CHARS.length]).join("");
}

function peerAvailable() {
  if (window.Peer) return true;
  showMessage("マルチプレイの部品（PeerJS）を読み込めませんでした。ネット接続を確認して、ページを再読み込みしてください。");
  return false;
}

function hostRoom() {
  if (!peerAvailable()) return;
  leaveRoom();
  const code = randomRoomCode();
  const peer = new window.Peer(MP_PREFIX + code);
  const profile = loadJSON(STORE_PROFILE, {});
  state.mp = {
    role: "host", code, peer, conns: new Map(), me: "host", phase: "lobby", connecting: true,
    players: [{ id: "host", name: profile.name || "", ready: false, color: MP_COLORS[0], isHost: true, team: "red" }],
    config: defaultMatchConfig(),
  };
  showLobby();
  peer.on("open", () => {
    state.mp.connecting = false;
    renderLobby();
  });
  peer.on("connection", hostAccept);
  peer.on("error", (err) => {
    if (err.type === "unavailable-id") return hostRoom(); // まれにコードがかぶったら作り直す
    showMessage(`部屋を作れませんでした（${err.type || err.message}）。少し待ってからもう一度試してください。`);
  });
}

function nextPlayerColor() {
  const used = new Set(state.mp.players.map((p) => p.color));
  return MP_COLORS.find((c) => !used.has(c)) || MP_COLORS[state.mp.players.length % MP_COLORS.length];
}

function hostAccept(conn) {
  const mp = state.mp;
  conn.on("open", () => {
    if (!state.mp || state.mp !== mp) return conn.close();
    let reason = null;
    if (mp.players.length >= MP_MAX_PLAYERS) reason = `部屋がいっぱいです（最大 ${MP_MAX_PLAYERS} 人）。`;
    else if (mp.phase !== "lobby") reason = "ゲームが始まっているため、今は参加できません。";
    if (reason) {
      conn.send({ type: "reject", reason });
      setTimeout(() => conn.close(), 500);
      return;
    }
    mp.conns.set(conn.peer, conn);
    mp.players.push({ id: conn.peer, name: "", ready: false, color: nextPlayerColor(), isHost: false, team: smallerTeam() });
    conn.on("data", (msg) => hostOnMessage(conn.peer, msg));
    conn.on("close", () => hostRemovePlayer(conn.peer));
    broadcastLobby();
  });
}

function hostRemovePlayer(id) {
  const mp = state.mp;
  if (!mp || mp.role !== "host") return;
  mp.conns.delete(id);
  mp.players = mp.players.filter((p) => p.id !== id);
  broadcastLobby();
  // ラウンド中に抜けた人がいたら、残りの全員が答えていれば結果に進む
  if (mp.phase === "game") checkAllGuessed();
}

function hostOnMessage(id, msg) {
  const mp = state.mp;
  const player = mp && mp.players.find((p) => p.id === id);
  if (!player || !msg || typeof msg !== "object") return;
  if (msg.type === "name") {
    player.name = String(msg.name || "").trim().slice(0, 16) || "名無しの旅人";
    player.ready = true;
    broadcastLobby();
  } else if (msg.type === "unready") {
    player.ready = false;
    broadcastLobby();
  } else if (msg.type === "guess") {
    recordGuess(id, msg);
  } else if (msg.type === "view") {
    hostReceiveView(id, msg.view);
  } else if (msg.type === "team") {
    if (TEAMS[msg.team] && mp.phase === "lobby") {
      player.team = msg.team;
      broadcastLobby();
    }
  } else if (msg.type === "react") {
    hostRelaySocial(player, { type: "react", emoji: msg.emoji });
  } else if (msg.type === "chat") {
    hostRelaySocial(player, { type: "chat", text: msg.text });
  } else if (msg.type === "usage") {
    // 参加者のブラウザが読み込んだ分も、同じ APIキーの消費としてホストのグラフに足す
    const kinds = ["streetView", "mapLoads", "metadata", "staticMaps"];
    const n = Math.round(Number(msg.n));
    if (kinds.includes(msg.kind) && n >= 1 && n <= 10) addUsage(msg.kind, n);
  }
}

function broadcast(msg) {
  state.mp.conns.forEach((conn) => { if (conn.open) conn.send(msg); });
}

function publicPlayers() {
  return state.mp.players.map(({ id, name, ready, color, isHost, team }) => ({ id, name, ready, color, isHost, team }));
}

function broadcastLobby() {
  const mp = state.mp;
  mp.conns.forEach((conn, id) => {
    if (conn.open) conn.send({ type: "lobby", players: publicPlayers(), phase: mp.phase, you: id, config: mp.config });
  });
  renderLobby();
}

// ---------------------------------------------------------------- 部屋に入る（参加者）

function joinRoom(code) {
  if (!peerAvailable()) return;
  leaveRoom();
  const profile = loadJSON(STORE_PROFILE, {});
  const peer = new window.Peer();
  state.mp = {
    role: "guest", code, peer, conn: null, me: null, phase: "lobby", connecting: true,
    players: [], myName: profile.name || "", config: defaultMatchConfig(),
  };
  showLobby();
  peer.on("open", () => {
    const conn = peer.connect(MP_PREFIX + code, { reliable: true });
    state.mp.conn = conn;
    conn.on("open", () => {
      state.mp.connecting = false;
      renderLobby();
    });
    conn.on("data", guestOnMessage);
    conn.on("close", () => {
      if (!state.mp || state.mp.leaving) return;
      leaveRoom();
      showTitle();
      showMessage("ホストとの接続が切れました。");
    });
  });
  peer.on("error", (err) => {
    if (!state.mp) return;
    const text = err.type === "peer-unavailable"
      ? `ルーム「${code}」が見つかりませんでした。コードが正しいか、ホストが部屋を開いているか確認してください。`
      : `ルームに接続できませんでした（${err.type || err.message}）。`;
    leaveRoom();
    showMode();
    showMessage(text);
  });
}

function guestSend(msg) {
  const conn = state.mp && state.mp.conn;
  if (conn && conn.open) conn.send(msg);
}

function guestOnMessage(msg) {
  const mp = state.mp;
  if (!mp || !msg || typeof msg !== "object") return;
  switch (msg.type) {
    case "reject":
      mp.leaving = true;
      leaveRoom();
      showMode();
      showMessage(msg.reason);
      break;
    case "lobby": {
      const backToLobby = mp.phase !== "lobby" && msg.phase === "lobby";
      mp.players = msg.players;
      mp.me = msg.you;
      if (msg.config) mp.config = msg.config;
      mp.phase = msg.phase;
      if (backToLobby || app.className === "screen-lobby") showLobby();
      else renderLobby();
      break;
    }
    case "start":
      prepareMultiGame(msg.area, msg.settings);
      break;
    case "round":
      beginMultiRound(msg);
      break;
    case "progress":
      mp.done = msg.done;
      renderWaiting(msg.done);
      break;
    case "view":
      receiveView(msg.id, msg.view);
      break;
    case "views":
      (msg.views || []).forEach(([id, view]) => receiveView(id, view));
      break;
    case "result":
      showMultiResult(msg);
      break;
    case "final":
      showMultiFinal(msg);
      break;
    case "react":
      showReaction(msg);
      break;
    case "chat":
      addChatMessage(msg);
      break;
    case "error":
      showLobby();
      showMessage(msg.text);
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------- 部屋を出る

function leaveRoom() {
  const mp = state.mp;
  if (!mp) return;
  mp.leaving = true;
  stopTimer();
  try {
    if (mp.role === "host") mp.conns.forEach((c) => c.close());
    else if (mp.conn) mp.conn.close();
    mp.peer.destroy();
  } catch {
    // 閉じるときのエラーは気にしない
  }
  state.mp = null;
  if (state.game && state.game.multi) state.game = null;
  resetSocial();
  document.body.classList.remove("team-game");
  // 招待リンクで開いた場合、URL のルームコードを消しておく（再読み込みで勝手に入り直さないように）
  if (location.search.includes("room=")) history.replaceState(null, "", location.pathname);
}

async function confirmLeaveRoom() {
  const mp = state.mp;
  if (mp) {
    const ok = await askConfirm(mp.role === "host"
      ? { title: "部屋を閉じますか？", text: "参加している全員が退出します。", okText: "部屋を閉じる", danger: true }
      : { title: "部屋から抜けますか？", text: "もう一度入るには、招待リンクかルームコードが必要です。", okText: "抜ける", danger: true });
    if (!ok) return;
  }
  leaveRoom();
  showMode();
}

// ---------------------------------------------------------------- ロビー画面

function inviteLink(code) {
  return `${location.origin}${location.pathname}?room=${code}`;
}

function showLobby() {
  closeSettings();
  stopTimer();
  $("result").hidden = true;
  setScreen("lobby");
  renderLobby();
}

function renderLobby() {
  updateSocial();
  const mp = state.mp;
  if (!mp) return;
  const host = mp.role === "host";
  const me = mp.players.find((p) => p.id === mp.me);

  $("lobby-title").textContent = host ? "部屋を作りました" : "ルームに参加";
  $("invite-card").hidden = !host;
  $("join-card").hidden = host;

  if (host) {
    const link = inviteLink(mp.code);
    $("room-code").textContent = mp.connecting ? "準備中…" : mp.code;
    $("invite-link").value = mp.connecting ? "" : link;
    if (!mp.connecting && $("invite-qr").dataset.link !== link) {
      $("invite-qr").dataset.link = link;
      $("invite-qr").innerHTML = qrSvg(link);
    }
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
    $("invite-warning").hidden = !local;
    $("btn-share-link").hidden = !navigator.share;
  } else {
    $("join-code").textContent = mp.code;
    $("join-state").textContent = mp.connecting ? "ルームに接続しています…" : "接続しました";
    $("join-state").classList.toggle("ok", !mp.connecting);
  }

  // プレイヤー一覧
  $("player-count").textContent = `${mp.players.length} / ${MP_MAX_PLAYERS}`;
  $("player-list").innerHTML = mp.players.map((p) => `
    <li class="${p.id === mp.me ? "me" : ""}">
      <span class="p-avatar" style="--c:${p.color}">${escapeHtml((p.name || "?").slice(0, 1))}</span>
      <span class="p-name">${p.name ? escapeHtml(p.name) : '<i class="typing">名前を入力中…</i>'}${p.id === mp.me ? '<small>あなた</small>' : ""}</span>
      ${p.isHost ? '<span class="tag host">ホスト</span>' : ""}
      ${mp.config.mode === "team" && TEAMS[p.team] ? `<span class="tag team-${p.team}">${TEAMS[p.team].short}</span>` : ""}
      <span class="tag ${p.ready ? "ready" : "wait"}">${p.ready ? "準備OK" : "準備中"}</span>
    </li>`).join("") || '<li class="empty">接続しています…</li>';

  // 自分の名前の欄（決定すると準備OK）
  const ready = !!(me && me.ready);
  const nameInput = $("my-name");
  if (document.activeElement !== nameInput && !ready) nameInput.value = (me && me.name) || mp.myName || loadJSON(STORE_PROFILE, {}).name || "";
  if (ready) nameInput.value = me.name;
  nameInput.disabled = ready || mp.connecting || (!host && !me);
  $("btn-ready").textContent = ready ? "名前を変更" : "決定";
  $("btn-ready").classList.toggle("primary", !ready);
  $("btn-ready").classList.toggle("secondary", ready);
  $("btn-ready").disabled = mp.connecting || (!host && !me);

  // ホストは全員の準備ができたらマップ選択へ進める
  const others = mp.players.filter((p) => !p.isHost);
  const allReady = mp.players.every((p) => p.ready);
  const teamsOk = mp.config.mode !== "team" || Object.keys(TEAMS).every((t) => mp.players.some((p) => p.team === t));
  $("btn-lobby-go").hidden = !host;
  $("btn-lobby-go").disabled = !(allReady && others.length >= 1 && teamsOk);
  let status;
  if (host) {
    if (!others.length) status = "友達が参加するのを待っています。";
    else if (!teamsOk) status = "チーム戦は、赤と青の両方に 1 人以上必要です。";
    else if (!allReady) status = `全員の準備ができたら進めます（${mp.players.filter((p) => p.ready).length} / ${mp.players.length} 人）`;
    else status = "全員の準備ができました！マップを選びましょう。";
  } else {
    status = ready ? "準備OK！ホストが始めるのを待っています。" : "名前を決めて「決定」を押すと準備OKになります。";
  }
  $("lobby-status").textContent = status;

  // 参加者は、ホストがマップを選んでいる間は待ち画面
  $("lobby-waiting").hidden = host || mp.phase !== "select";
  renderMatchCard();
}

function submitMyName() {
  const mp = state.mp;
  if (!mp) return;
  const me = mp.players.find((p) => p.id === mp.me);
  const ready = me && me.ready;
  const name = $("my-name").value.trim().slice(0, 16);
  if (!ready && !name) {
    $("my-name").focus();
    return showMessage("名前を入力してください。");
  }
  // 次回のために名前を覚えておく
  saveJSON(STORE_PROFILE, { ...loadJSON(STORE_PROFILE, {}), name: name || (me && me.name) });
  if (mp.role === "host") {
    me.name = name || me.name;
    me.ready = !ready;
    broadcastLobby();
  } else {
    mp.myName = name;
    guestSend(ready ? { type: "unready" } : { type: "name", name });
  }
}

function qrSvg(text) {
  if (!window.qrcode) return '<p class="muted">QRコードを表示できませんでした</p>';
  const qr = window.qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

async function copyInviteLink() {
  const input = $("invite-link");
  try {
    await navigator.clipboard.writeText(input.value);
  } catch {
    // http で開いているときなどはクリップボード API が使えないので、昔ながらの方法でコピーする
    input.select();
    document.execCommand("copy");
  }
  $("btn-copy-link").textContent = "コピーしました";
  setTimeout(() => { $("btn-copy-link").textContent = "コピー"; }, 1500);
}

function joinByCode() {
  const code = $("join-code-input").value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (code.length !== 6) return showMessage("6文字のルームコードを入力してください。");
  joinRoom(code);
}

// ホストが「マップ選択へ進む」を押したとき
function hostGoSelect() {
  const mp = state.mp;
  if (mp.config.mode === "team" && !Object.keys(TEAMS).every((t) => mp.players.some((p) => p.team === t))) {
    return showMessage("チーム戦は、赤と青の両方に 1 人以上必要です。");
  }
  // みんなで遊ぶときは、移動できる設定から始める（前に一人で遊んだときの設定を引き継がない）
  $("opt-move").checked = true;
  saveSettings();
  mp.phase = "select";
  broadcastLobby();
  showSelect();
}

// マップ選択画面から戻るときは、ホストはロビーへ
function hostBackToLobby() {
  const mp = state.mp;
  mp.phase = "lobby";
  broadcastLobby();
  showLobby();
}

// マップ選択・設定シートをマルチプレイ用にする
function decorateSelectForMulti() {
  const mp = state.mp;
  $("mp-banner").hidden = !(mp && mp.role === "host");
  if (mp) $("mp-banner-count").textContent = `${mp.players.length}人`;
}

function decorateSheetForMulti() {
  const multi = !!(state.mp && state.mp.role === "host");
  const team = multi && state.mp.config.mode === "team";
  // マルチプレイの個人戦はラウンド制だけ（ライフ制は人によって終わる時間が違うため）。
  // チーム戦はロビーで決めたライフで戦うので、モードの選択を出さない
  document.querySelector('#mode-tabs [data-mode="life"]').hidden = multi;
  if (multi && state.mode === "life") setMode("rounds");
  else setMode(state.mode);
  $("mode-tabs").hidden = team;
  $("team-note").hidden = !team;
  if (team) $("rounds-row").hidden = true;
  updateTimerSettings();
  $("btn-start").textContent = team ? `${state.mp.players.length}人でチーム戦を始める` : multi ? `${state.mp.players.length}人で始める` : "このマップで始める";
  $("ranking").hidden = multi;
  $("btn-to-ranking").hidden = multi;
}

// ---------------------------------------------------------------- ゲーム（全員で同じ地点を当てる）

function hostStartGame() {
  const mp = state.mp;
  if (!ensureMap()) return;
  const area = findArea(state.selectedAreaId);
  const settings = {
    rounds: Number($("opt-rounds").value),
    move: $("opt-move").checked,
    pan: $("opt-pan").checked,
    zoom: $("opt-zoom").checked,
    guessMode: state.guessMode || "pin",
    timeLimit: mp.config.mode === "team"
      ? (mp.config.timer.on ? mp.config.timer.seconds : 0)
      : $("opt-timer").checked ? Number($("opt-time").value) : 0,
    // チーム戦: 始めた時点のチーム分けと、チームごとのライフ・エクストラ
    team: mp.config.mode === "team"
      ? { teams: JSON.parse(JSON.stringify(mp.config.teams)), members: Object.fromEntries(mp.players.map((p) => [p.id, p.team])) }
      : null,
  };
  saveSettings();
  startMultiGame(area, settings);
}

// 全員で、同じ範囲・同じ設定のゲームを始める（最初の1回も、「もう一度」も）
function startMultiGame(area, settings) {
  const mp = state.mp;
  mp.lastGame = { area, settings };
  mp.phase = "game";
  mp.totals = new Map(mp.players.map((p) => [p.id, 0]));
  broadcastLobby();
  // 範囲のデータごと送る（自作の範囲は参加者のブラウザにないため）
  broadcast({ type: "start", area, settings });
  prepareMultiGame(area, settings);
  hostNextRound();
}

// 最終結果の「もう一度遊ぶ」（ホストだけ）: 部屋にいる全員で、同じ設定のままもう一度
function hostReplay() {
  const mp = state.mp;
  if (!mp || mp.role !== "host" || !mp.lastGame) return;
  if (mp.players.length < 2) return showMessage("一緒に遊ぶ人がいません。ロビーに戻って、友達を招待してください。");
  startMultiGame(mp.lastGame.area, mp.lastGame.settings);
}

function prepareMultiGame(area, settings) {
  if (!ensureMap()) return;
  closeSettings();
  stopTimer();
  clearGameMarkers();
  const team = settings.team || null;
  const myTeam = team ? team.members[state.mp.me] : null;
  state.game = {
    area, multi: true, mode: "rounds", rounds: team ? Infinity : settings.rounds,
    move: settings.move, pan: settings.pan, zoom: settings.zoom, timeLimit: settings.timeLimit,
    index: -1, results: [], overlays: [], usedPanos: new Set(), usedSpots: [], total: 0,
    team, myTeam,
    guessMode: settings.guessMode || "pin",
    // リアクションの厳しさは、自分のチームのエクストラに合わせる（国・都道府県当てでは使わない）
    hardcore: !!(team && myTeam && team.teams[myTeam].extra) && (settings.guessMode || "pin") === "pin",
    teamLife: team ? { red: team.teams.red.life, blue: team.teams.blue.life } : null,
    history: [],
  };
  document.body.classList.toggle("team-game", !!team);
  setScreen("game");
  $("loading").hidden = false;
}

async function hostNextRound() {
  const mp = state.mp;
  const g = state.game;
  const index = g.index + 1;
  $("loading").hidden = false;
  let answer;
  try {
    answer = await findLocation(g.area, g.usedPanos, g.usedSpots);
  } catch (e) {
    $("loading").hidden = true;
    broadcast({ type: "error", text: `出題地点を見つけられませんでした: ${e.message}` });
    mp.phase = "lobby";
    broadcastLobby();
    showLobby();
    return showMessage(e.message);
  }
  if (state.mp !== mp) return;
  mp.answer = answer;
  mp.guesses = new Map();
  const heading = Math.random() * 360;
  broadcast({ type: "round", index, panoId: answer.panoId, heading });
  beginMultiRound({ index, panoId: answer.panoId, heading });
}

function beginMultiRound(msg) {
  const g = state.game;
  if (!g || !g.multi) return;
  stopTimer();
  clearGameMarkers();
  g.index = msg.index;
  g.guess = null;
  g.answer = { panoId: msg.panoId };
  g.usedPanos.add(msg.panoId);
  g.submitted = false;
  stopSpectate(false);
  state.mp.views = new Map();
  state.mp.done = [];
  $("loading").hidden = true;
  $("result").hidden = true;
  $("mp-wait").hidden = true;
  $("btn-guess").disabled = true;
  $("btn-guess").textContent = guessIdleText(g);
  $("btn-back-start").hidden = !g.move;
  $("btn-zoom-in").disabled = $("btn-zoom-out").disabled = !g.zoom;
  $("info-area").textContent = g.area.name;
  $("info-round").textContent = g.team ? `${g.index + 1}` : `${g.index + 1} / ${g.rounds}`;
  $("info-score").textContent = g.total.toLocaleString();
  renderHudLife();
  renderTeamHud();
  setScreen("game");
  drawArea(g.area);
  state.map.setOptions({ draggableCursor: "crosshair" });
  showPanorama(msg.panoId, g);
  if (state.pano && typeof msg.heading === "number") {
    state.lockPov = { heading: msg.heading, pitch: 0 };
    state.pano.setPov(state.lockPov);
  }
  updateHeadingTape(state.pano.getPov().heading);
  g.roundStartedAt = Date.now();
  startTimer();
  sendMyView();
}

// submitGuess の代わり: 自分の回答をホストに送って、全員がそろうのを待つ
function submitMultiGuess(timedOut) {
  const g = state.game;
  if (!g || g.submitted || app.className !== "screen-game") return;
  if (!g.guess && !timedOut) return;
  stopTimer();
  g.submitted = true;
  const msg = { type: "guess", index: g.index, guess: g.guess, ms: Date.now() - (g.roundStartedAt || Date.now()) };
  $("btn-guess").disabled = true;
  $("btn-guess").textContent = "回答しました";
  state.map.setOptions({ draggableCursor: null });
  if (state.mp.role === "host") recordGuess("host", msg);
  else guestSend(msg);
  // ホストが最後に答えたときは、ここまでにラウンドが終わって回答の一覧が片付いている
  if (state.mp.role !== "host") renderWaiting([state.mp.me]);
  else if (state.mp.guesses) renderWaiting([...state.mp.guesses.keys()]);
}

function recordGuess(id, msg) {
  const mp = state.mp;
  const g = state.game;
  if (!mp || mp.phase !== "game" || !g || msg.index !== g.index || !mp.guesses || mp.guesses.has(id)) return;
  const guess = msg.guess && Number.isFinite(msg.guess.lat) && Number.isFinite(msg.guess.lng)
    ? { lat: msg.guess.lat, lng: msg.guess.lng } : null;
  mp.guesses.set(id, { guess, ms: Number(msg.ms) || 0 });
  if (id !== "host") {
    const conn = mp.conns.get(id);
    if (conn && conn.open) conn.send({ type: "views", views: [...mp.views].filter(([vid]) => vid !== id) });
  }
  const done = [...mp.guesses.keys()];
  broadcast({ type: "progress", done });
  if (g.submitted) renderWaiting(done);
  checkAllGuessed();
}

function checkAllGuessed() {
  const mp = state.mp;
  if (!mp || !mp.guesses || !mp.answer) return;
  if (mp.players.every((p) => mp.guesses.has(p.id))) finishMultiRound();
}

function finishMultiRound() {
  const mp = state.mp;
  const g = state.game;
  const answer = { lat: mp.answer.lat, lng: mp.answer.lng, panoId: mp.answer.panoId };
  const results = mp.players.map((p) => {
    const sub = mp.guesses.get(p.id) || { guess: null, ms: 0 };
    const judged = judgeGuess(g, sub.guess, answer);
    mp.totals.set(p.id, (mp.totals.get(p.id) || 0) + judged.score);
    return { id: p.id, name: p.name, color: p.color, guess: sub.guess, ...judged, total: mp.totals.get(p.id), ms: sub.ms };
  });
  mp.answer = null;
  mp.guesses = null;
  const team = g.team ? hostTeamRound(results) : null;
  const msg = { type: "result", index: g.index, answer, results, team, last: team ? !!team.winner : g.index + 1 >= g.rounds };
  broadcast(msg);
  showMultiResult(msg);
}

// 「他のプレイヤーを待っています」
function renderWaiting(done) {
  const mp = state.mp;
  const g = state.game;
  if (!mp || !g || !g.submitted || app.className !== "screen-game") return;
  const set = new Set(done);
  mp.done = [...set];
  $("mp-wait").hidden = false;
  $("mp-wait-title").textContent = `回答しました！ 他の人を待っています（${set.size} / ${mp.players.length}）`;
  // 1人ずつの行: 色つきのアイコン・名前・回答したかどうか・「見る」ボタン
  $("mp-wait-list").innerHTML = mp.players.map((p) => {
    const me = p.id === mp.me;
    const done = set.has(p.id);
    const watching = state.spectating === p.id;
    const teamId = g.team ? g.team.members[p.id] : null;
    const cls = ["pl-row", done ? "done" : "", me ? "me" : "", watching ? "watching" : ""].join(" ");
    return `<button class="${cls}" data-id="${escapeHtml(p.id)}" style="--c:${p.color}" ${me ? "disabled" : ""}>
      <span class="p-avatar" style="--c:${p.color}">${escapeHtml((p.name || "?").slice(0, 1))}</span>
      <span class="pl-name">${TEAMS[teamId] ? `<i class="pl-team ${teamId}">${TEAMS[teamId].short}</i>` : ""}${escapeHtml(p.name || "?")}</span>
      <span class="pl-state">${done ? "✓ 回答済み" : '<i class="dots">考え中</i>'}</span>
      <span class="pl-watch">${me ? "あなた" : watching ? "👀 見ています" : "👀 見る"}</span>
    </button>`;
  }).join("");
  $("mp-wait-list").querySelectorAll(".pl-row:not(.me)").forEach((b) => b.addEventListener("click", () => startSpectate(b.dataset.id)));
  if (state.spectating) renderSpectateBar();
}

// ---------------------------------------------------------------- 観戦（回答したあと、他の人の画面を見る）
// 各プレイヤーは自分の画面（パノラマの場所・向き・地図・ピン）をホストに送り、
// ホストは「もう回答した人」にだけ配る。まだ回答中の人には、他人のピンは見えない。

let viewTimer = null;

function currentView() {
  const g = state.game;
  if (!g || !state.pano || !state.map) return null;
  const pov = state.pano.getPov();
  const c = state.map.getCenter();
  return {
    index: g.index,
    pano: state.pano.getPano(),
    heading: pov.heading, pitch: pov.pitch, zoom: state.pano.getZoom(),
    guess: g.guess || null,
    mapCenter: c ? { lat: c.lat(), lng: c.lng() } : null,
    mapZoom: state.map.getZoom(),
  };
}

// 自分の画面が変わったら、少し間引いて（0.25秒に1回まで）送る
function sendMyView() {
  const mp = state.mp;
  const g = state.game;
  if (!mp || !g || !g.multi || state.spectating || app.className !== "screen-game" || viewTimer) return;
  viewTimer = setTimeout(() => {
    viewTimer = null;
    if (state.spectating) return;
    const view = currentView();
    if (!view) return;
    if (mp.role === "host") hostReceiveView("host", view);
    else guestSend({ type: "view", view });
  }, 250);
}

function cleanView(v) {
  const num = (x) => (Number.isFinite(x) ? x : 0);
  const pt = (p) => (p && Number.isFinite(p.lat) && Number.isFinite(p.lng) ? { lat: p.lat, lng: p.lng } : null);
  if (!v || typeof v.pano !== "string") return null;
  return {
    index: num(v.index), pano: v.pano.slice(0, 200), heading: num(v.heading), pitch: num(v.pitch), zoom: num(v.zoom),
    guess: pt(v.guess), mapCenter: pt(v.mapCenter), mapZoom: num(v.mapZoom),
  };
}

function hostReceiveView(id, raw) {
  const mp = state.mp;
  const g = state.game;
  const view = cleanView(raw);
  if (!mp || !view || !g || view.index !== g.index || !mp.views) return;
  mp.views.set(id, view);
  // もう回答した人にだけ配る
  mp.conns.forEach((conn, cid) => {
    if (conn.open && cid !== id && mp.guesses && mp.guesses.has(cid)) conn.send({ type: "view", id, view });
  });
  if (id !== "host") receiveView(id, view, true);
}

function receiveView(id, raw, already) {
  const mp = state.mp;
  const view = already ? raw : cleanView(raw);
  if (!mp || !view) return;
  if (!mp.views) mp.views = new Map();
  mp.views.set(id, view);
  if (state.spectating === id) applySpectateView(view);
}

function startSpectate(id) {
  const mp = state.mp;
  const g = state.game;
  if (!mp || !g || !g.submitted || id === mp.me) return;
  if (state.spectating === id) return stopSpectate(true);
  if (!state.spectating) {
    // 戻るときのために、自分の画面を覚えておく
    const pov = state.pano.getPov();
    state.mySpot = { pano: state.pano.getPano(), heading: pov.heading, pitch: pov.pitch, zoom: state.pano.getZoom() };
  }
  state.spectating = id;
  renderSpectateBar();
  renderWaiting(mp.done || []);
  const view = mp.views && mp.views.get(id);
  if (view) applySpectateView(view);
  else $("spectate-state").textContent = "（画面の情報を待っています…）";
}

function applySpectateView(view) {
  const p = state.mp.players.find((x) => x.id === state.spectating);
  if (!p || !state.pano) return;
  if (state.pano.getPano() !== view.pano) state.pano.setPano(view.pano);
  state.pano.setPov({ heading: view.heading, pitch: view.pitch });
  state.pano.setZoom(view.zoom);
  if (view.mapCenter) {
    state.map.setCenter(view.mapCenter);
    if (view.mapZoom) state.map.setZoom(view.mapZoom);
  }
  // 相手のピン（まだ刺していなければ消す）
  if (view.guess) {
    if (!state.spectateMarker) {
      state.spectateMarker = new google.maps.Marker({ map: state.map, clickable: false, zIndex: 3 });
    }
    state.spectateMarker.setIcon(pinIcon(p.color, "guess"));
    state.spectateMarker.setPosition(view.guess);
    state.spectateMarker.setMap(state.map);
  } else if (state.spectateMarker) {
    state.spectateMarker.setMap(null);
  }
  renderSpectateBar();
}

function renderSpectateBar() {
  const mp = state.mp;
  const p = mp && mp.players.find((x) => x.id === state.spectating);
  if (!p) return stopSpectate(true);
  const done = (mp.done || []).includes(p.id);
  $("spectate-bar").hidden = false;
  $("spectate-frame").hidden = false;
  $("spectate-bar").style.setProperty("--c", p.color);
  $("spectate-frame").style.setProperty("--c", p.color);
  $("spectate-avatar").style.setProperty("--c", p.color);
  $("spectate-avatar").textContent = (p.name || "?").slice(0, 1);
  $("spectate-name").textContent = p.name || "?";
  $("spectate-state").textContent = done ? "回答済み" : "考え中…";
}

function stopSpectate(restore) {
  const spot = state.mySpot;
  state.spectating = null;
  state.mySpot = null;
  $("spectate-bar").hidden = true;
  $("spectate-frame").hidden = true;
  if (state.spectateMarker) {
    state.spectateMarker.setMap(null);
    state.spectateMarker = null;
  }
  if (restore && spot && state.pano) {
    state.pano.setPano(spot.pano);
    state.pano.setPov({ heading: spot.heading, pitch: spot.pitch });
    state.pano.setZoom(spot.zoom);
    if (state.game && state.game.guess) state.map.panTo(state.game.guess);
  }
  if (state.mp && state.game && state.game.submitted && app.className === "screen-game") renderWaiting(state.mp.done || []);
}

function showMultiResult(msg) {
  const mp = state.mp;
  const g = state.game;
  if (!g || !g.multi) return;
  stopTimer();
  stopSpectate(false);
  $("mp-wait").hidden = true;
  clearGameMarkers();
  g.lastResult = msg;
  const answer = msg.answer;

  // 正解と、全員のピン・線を描く（国・都道府県当てでは、正解の区画も塗る）
  if (isRegionMode(g)) {
    const shape = regionPolygon(g.guessMode, regionAt(g.guessMode, answer.lat, answer.lng), ANSWER_COLOR, 0.3);
    if (shape) addOverlay(shape);
  }
  addOverlay(new google.maps.Marker({ position: answer, icon: pinIcon(ANSWER_COLOR, "answer"), title: "正解", zIndex: 10 }));
  addOverlay(new MapLabel(answer, "正解", "tag answer"));
  const bounds = new google.maps.LatLngBounds();
  bounds.extend(answer);
  msg.results.forEach((r) => {
    if (!r.guess) return;
    bounds.extend(r.guess);
    addOverlay(new google.maps.Polyline({ path: [r.guess, answer], strokeColor: r.color, strokeOpacity: 0.85, strokeWeight: 3, zIndex: 1 }));
    addOverlay(new google.maps.Marker({ position: r.guess, icon: pinIcon(r.color, "guess"), title: r.name, zIndex: 5 }));
    addOverlay(new MapLabel(r.guess, escapeHtml(r.name), "tag player"));
  });
  setScreen("result");
  setTimeout(() => state.map.fitBounds(bounds, { top: 70, bottom: 40, left: 60, right: 60 }), 50);

  // 自分の結果は、プレイ記録（世界地図）にも残す
  const mine = msg.results.find((r) => r.id === mp.me);
  if (mine) {
    g.total = mine.total;
    recordRound(g.area.id, { answer, score: mine.score });
  }

  const rows = [...msg.results].sort((a, b) => b.score - a.score || a.ms - b.ms);
  const missed = !mine || !mine.guess;
  if (g.team && msg.team) {
    g.teamLife = { red: msg.team.teams.red.life, blue: msg.team.teams.blue.life };
    g.history.push({ index: msg.index, ...msg.team });
  }
  renderTeamHud(msg.team);
  $("result-text").innerHTML = `
    ${mine ? `<div class="rs-reaction"><span class="reaction${g.hardcore ? " extra" : ""}">${isRegionMode(g) ? regionReaction(g, mine) : reactionFor(missed ? null : mine.distance, g.hardcore)}</span></div>` : ""}
    <div class="rs-meta"><b>ラウンド ${msg.index + 1}${g.team ? "" : ` / ${g.rounds}`}</b>${mapsLink(answer)}</div>
    <div class="rs-side rs-left">
${isRegionMode(g) && !missed ? `
      <div class="rs-big ${mine.correct ? "rs-correct" : "rs-wrong"}">${mine.correct ? "正解！" : "はずれ"}</div>
      <div class="rs-cap">あなた: ${escapeHtml(regionName(g.guessMode, mine.guessRegion))} ・ 正解: ${escapeHtml(regionName(g.guessMode, regionAt(g.guessMode, answer.lat, answer.lng)))}</div>` : `
      <div class="rs-big rs-dist">${missed ? "時間切れ" : formatDistance(mine.distance)}</div>
      <div class="rs-cap">${missed ? "ピンを立てる前に時間切れ" : "正解から"}</div>`}
    </div>
    <div class="rs-side rs-right">${g.team && msg.team ? teamResultSide(msg.team) : `
      <div class="rs-big rs-score">${mine ? mine.score.toLocaleString() : 0}</div>
      <div class="rs-cap">${MAX_SCORE.toLocaleString()} 点のうち ・ 合計 ${mine ? mine.total.toLocaleString() : 0}</div>`}
    </div>
    <table class="mp-table rs-board">${rows.map((r, i) => `
      <tr class="${r.id === mp.me ? "me" : ""}">
        <td class="num">${i + 1}</td>
        <td class="pl"><i class="dot" style="background:${r.color}"></i>${escapeHtml(r.name)}</td>
        <td>${escapeHtml(guessResultText(g, r))}</td>
        <td class="gain">+${r.score}</td>
        <td><b>${r.total.toLocaleString()}</b></td>
      </tr>`).join("")}
    </table>`;
  const host = mp.role === "host";
  $("btn-next").textContent = host ? (msg.last ? "最終結果へ" : "次のラウンドへ") : "ホストが進めるのを待っています…";
  $("btn-next").disabled = !host;
  $("btn-end").hidden = true;
  setResultButtons(false, false);
  $("result").hidden = false;
}

// 結果画面の「次へ」（ホストだけが押せる）
function multiNext() {
  const mp = state.mp;
  const g = state.game;
  if (!mp || !g) return;
  if (g.finished) {
    // 最終結果からロビーへ
    if (mp.role === "host") return hostBackToLobby();
    return showLobby();
  }
  if (mp.role !== "host") return;
  if (g.lastResult && g.lastResult.last) return hostFinal();
  hostNextRound();
}

function hostFinal() {
  const mp = state.mp;
  const standings = mp.players
    .map((p) => ({ id: p.id, name: p.name, color: p.color, total: mp.totals.get(p.id) || 0 }))
    .sort((a, b) => b.total - a.total);
  const g = state.game;
  const msg = { type: "final", standings, rounds: g.team ? g.index + 1 : g.rounds };
  if (g.team && g.lastResult && g.lastResult.team) msg.winner = g.lastResult.team.winner;
  broadcast(msg);
  showMultiFinal(msg);
}

function showMultiFinal(msg) {
  const mp = state.mp;
  const g = state.game;
  if (!g) return;
  stopTimer();
  clearGameMarkers();
  g.finished = true;
  setScreen("final");
  if (g.team) return showTeamFinal(msg);
  const max = msg.rounds * MAX_SCORE;
  const medals = ["gold", "silver", "bronze"];
  const podium = [1, 0, 2].map((i) => {
    const s = msg.standings[i];
    if (!s) return `<div class="podium-slot empty ${medals[i]}"><div class="step"></div></div>`;
    return `<div class="podium-slot ${medals[i]}" style="--d:${i}">
      ${i === 0 ? '<div class="crown">👑</div>' : ""}
      <div class="avatar ring"><span class="p-avatar big" style="--c:${s.color}">${escapeHtml(s.name.slice(0, 1))}</span><span class="medal">${i + 1}</span></div>
      <b class="p-name">${escapeHtml(s.name)}</b>
      <span class="p-score">${s.total.toLocaleString()} 点</span>
      <div class="step"><span>${i + 1}</span></div>
    </div>`;
  }).join("");
  const rest = msg.standings.slice(3).map((s, i) => `
    <li class="${s.id === mp.me ? "me" : ""}"><span class="r-rank">${i + 4}</span>
      <span class="p-avatar" style="--c:${s.color}">${escapeHtml(s.name.slice(0, 1))}</span>
      <span class="r-name">${escapeHtml(s.name)}</span><span class="r-score">${s.total.toLocaleString()} 点</span></li>`).join("");
  const myRank = msg.standings.findIndex((s) => s.id === mp.me) + 1;
  $("result-text").innerHTML = `
    <div class="sub">${escapeHtml(g.area.name)} ・ ${msg.rounds}ラウンド ・ ${msg.standings.length}人</div>
    <div class="big">最終結果</div>
    <div class="sub">あなたは <b>${myRank} 位</b>（${(msg.standings[myRank - 1] || { total: 0 }).total.toLocaleString()} / ${max.toLocaleString()} 点）</div>
    <div class="podium mp-podium">${podium}</div>
    <ol class="ranking-list">${rest}</ol>`;
  $("btn-next").textContent = "ロビーに戻る";
  $("btn-next").disabled = false;
  $("btn-end").hidden = true;
  // もう一度遊ぶのはホストが決める（参加者には、始まるまで待ってもらう）
  setResultButtons(true, mp.role === "host");
  if (mp.role !== "host") $("result-text").insertAdjacentHTML("beforeend", '<p class="sub">ホストが「もう一度遊ぶ」を押すと、同じ設定ですぐに始まります。</p>');
  $("result").hidden = false;
}

// 設定画面の「ゲームを終了する」
async function exitMultiGame() {
  const mp = state.mp;
  closeGameSettings();
  if (mp.role === "host") {
    const ok = await askConfirm({ title: "ゲームを終了しますか？", text: "全員がロビーに戻ります。", okText: "終了する", danger: true });
    if (!ok) return;
    stopTimer();
    mp.answer = mp.guesses = null;
    hostBackToLobby();
  } else {
    const ok = await askConfirm({ title: "部屋から抜けますか？", text: "ゲームの途中で抜けると、もう一度入るには招待が必要です。", okText: "抜ける", danger: true });
    if (!ok) return;
    leaveRoom();
    showMode();
  }
}

// ---------------------------------------------------------------- 起動

// ---------------------------------------------------------------- チーム戦
// 毎ラウンド、各チームでいちばん正解に近かった人の得点を比べ、点差 × 倍率を相手チームのライフから引く。
// エクストラモードのチームは、ずれを厳しく判定した得点（5000 − エクストラのダメージ）で比べる。

const TEAMS = {
  red: { name: "チーム赤", short: "赤", color: "#e5392f" },
  blue: { name: "チーム青", short: "青", color: "#3b82f6" },
};
const TEAM_LIFE_MIN = 1000;
const TEAM_LIFE_MAX = 100000;

function defaultMatchConfig() {
  return {
    mode: "solo",
    teams: { red: { life: 10000, extra: false }, blue: { life: 10000, extra: false } },
    timer: { on: false, seconds: 60 }, // チーム戦の制限時間（両チーム共通）
  };
}

// 人数の少ないチームに入れる（同じなら赤）
function smallerTeam() {
  const count = (t) => state.mp.players.filter((p) => p.team === t).length;
  return count("blue") < count("red") ? "blue" : "red";
}

// ラウンドが進むほどダメージが大きくなる（1・2 ラウンド目 ×1、3・4 ×1.5 … 最大 ×3）
function teamMultiplier(index) {
  return Math.min(3, 1 + 0.5 * Math.floor(index / 2));
}

function hostTeamRound(results) {
  const g = state.game;
  const multiplier = teamMultiplier(g.index);
  const teams = {};
  for (const t of Object.keys(TEAMS)) {
    const best = results
      .filter((r) => g.team.members[r.id] === t && r.guess)
      .sort((a, b) => b.score - a.score || a.distance - b.distance)[0];
    const extra = g.team.teams[t].extra && !isRegionMode(g);
    const points = best ? Math.max(0, MAX_SCORE - damageFor(best.score, best.distance, extra)) : 0;
    teams[t] = {
      points, before: g.teamLife[t],
      best: best ? { id: best.id, name: best.name, distance: best.distance, guess: best.guess, guessRegion: best.guessRegion, correct: best.correct } : null,
    };
  }
  const diff = teams.red.points - teams.blue.points;
  const loser = diff > 0 ? "blue" : diff < 0 ? "red" : null;
  for (const t of Object.keys(TEAMS)) {
    const damage = t === loser ? Math.min(g.teamLife[t], Math.round(Math.abs(diff) * multiplier)) : 0;
    g.teamLife[t] -= damage;
    Object.assign(teams[t], { damage, life: g.teamLife[t] });
  }
  const winner = g.teamLife.red <= 0 ? "blue" : g.teamLife.blue <= 0 ? "red" : null;
  return { multiplier, teams, winner };
}

// 数字を、前の値から新しい値までカウントダウンさせる
function countNumber(el, from, to, ms = 900) {
  const start = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - start) / ms);
    el.textContent = Math.round(from + (to - from) * (1 - (1 - k) ** 3)).toLocaleString();
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ゲーム中は左上・右上のゲージ、結果では上の帯（round を渡すと、ダメージを受けて減る様子を見せる）
function renderTeamHud(round) {
  const g = state.game;
  const hud = $("team-hud");
  hud.hidden = !(g && g.team);
  if (hud.hidden) return;
  for (const t of Object.keys(TEAMS)) {
    const el = hud.querySelector(`.tg.${t}`);
    const max = g.team.teams[t].life;
    const now = g.teamLife[t];
    const from = round ? round.teams[t].before : now;
    el.classList.toggle("mine", g.myTeam === t);
    el.querySelector(".tg-extra").hidden = !g.team.teams[t].extra;
    // そのチームのメンバー（色つきのアイコンと名前）をゲージの下に並べる
    const mp = state.mp;
    el.querySelector(".tg-members").innerHTML = (mp ? mp.players : [])
      .filter((p) => g.team.members[p.id] === t)
      .map((p) => `<span class="tg-member${p.id === mp.me ? " me" : ""}" style="--c:${p.color}"><i>${escapeHtml((p.name || "?").slice(0, 1))}</i>${escapeHtml(p.name || "?")}</span>`)
      .join("");
    const fill = el.querySelector(".tg-fill");
    const num = el.querySelector(".tg-life");
    fill.style.transition = "none";
    fill.style.width = `${(from / max) * 100}%`;
    fill.style.background = lifeColor(from / max);
    num.textContent = from.toLocaleString();
    el.querySelector(".tg-points").textContent = round ? round.teams[t].points.toLocaleString() : "";
    const dmg = el.querySelector(".tg-dmg");
    dmg.classList.remove("show");
    dmg.textContent = round && round.teams[t].damage ? `−${round.teams[t].damage.toLocaleString()}` : "";
    if (round && from !== now) {
      setTimeout(() => {
        fill.style.transition = "";
        fill.style.width = `${(now / max) * 100}%`;
        fill.style.background = lifeColor(now / max);
        countNumber(num, from, now);
        dmg.classList.add("show");
        el.classList.remove("hit");
        void el.offsetWidth;
        el.classList.add("hit");
      }, 700);
    }
  }
  hud.querySelector(".th-round").textContent = `ラウンド ${g.index + 1}`;
  hud.querySelector(".th-mult").textContent = `×${teamMultiplier(Math.max(0, g.index))}`;
  const dist = (t) => {
    const b = round && round.teams[t].best;
    return b ? guessResultText(g, b) : "—";
  };
  hud.querySelector(".th-dist").hidden = !round;
  hud.querySelector(".d-red").textContent = dist("red");
  hud.querySelector(".d-blue").textContent = dist("blue");
}

// 結果の下のバーの右側: 自分のチームの得点と、与えた・受けたダメージ
function teamResultSide(round) {
  const g = state.game;
  const mine = g.myTeam || "red";
  const opp = mine === "red" ? "blue" : "red";
  const dealt = round.teams[opp].damage;
  const taken = round.teams[mine].damage;
  const text = dealt ? `相手に −${dealt.toLocaleString()} ダメージ！` : taken ? `−${taken.toLocaleString()} ダメージを受けた…` : "引き分け（ダメージなし）";
  return `
      <div class="rs-big rs-score">${round.teams[mine].points.toLocaleString()}</div>
      <div class="rs-cap">チームの得点 ×${round.multiplier} ・ ${text}</div>`;
}

function showTeamFinal(msg) {
  const mp = state.mp;
  const g = state.game;
  const win = msg.winner || (g.teamLife.red >= g.teamLife.blue ? "red" : "blue");
  const members = (t) => mp.players.filter((p) => g.team.members[p.id] === t)
    .map((p) => `<li class="${p.id === mp.me ? "me" : ""}"><span class="p-avatar" style="--c:${p.color}">${escapeHtml((p.name || "?").slice(0, 1))}</span>${escapeHtml(p.name || "?")}</li>`).join("");
  const side = (t) => `
    <div class="tf-team ${t}${t === win ? " won" : ""}">
      <header><span class="tg-badge">${TEAMS[t].short}</span><b>${TEAMS[t].name}</b>${g.team.teams[t].extra ? '<span class="tg-extra">🔥EXTRA</span>' : ""}</header>
      <div class="tf-life">${lifeBar(Math.max(0, g.teamLife[t]), g.team.teams[t].life)}<span>${Math.max(0, g.teamLife[t]).toLocaleString()} / ${g.team.teams[t].life.toLocaleString()}</span></div>
      <ul>${members(t)}</ul>
    </div>`;
  const rows = g.history.map((h) => `<tr>
      <td class="num">${h.index + 1}</td>
      <td class="red">${h.teams.red.best ? escapeHtml(guessResultText(g, h.teams.red.best)) : "—"}</td>
      <td class="blue">${h.teams.blue.best ? escapeHtml(guessResultText(g, h.teams.blue.best)) : "—"}</td>
      <td class="num">×${h.multiplier}</td>
      <td class="damage">${h.teams.red.damage ? `赤 −${h.teams.red.damage.toLocaleString()}` : h.teams.blue.damage ? `青 −${h.teams.blue.damage.toLocaleString()}` : "—"}</td>
    </tr>`).join("");
  const mineWon = g.myTeam === win;
  $("result-text").innerHTML = `
    <div class="team-final ${win}">
      <div class="tf-trophy">🏆</div>
      <b>${TEAMS[win].name}の勝利！</b>
      <span>${g.myTeam ? (mineWon ? "あなたのチームの勝ち！おめでとう🎉" : "あなたのチームの負け…次こそ！") : ""}</span>
    </div>
    <div class="sub">${escapeHtml(g.area.name)} ・ ${msg.rounds} ラウンドで決着</div>
    <div class="tf-teams">${side("red")}${side("blue")}</div>
    <table class="tf-table"><tr><th>R</th><th class="red">赤のベスト</th><th class="blue">青のベスト</th><th>倍率</th><th>ダメージ</th></tr>${rows}</table>`;
  $("btn-next").textContent = "ロビーに戻る";
  $("btn-next").disabled = false;
  $("btn-end").hidden = true;
  setResultButtons(true, mp.role === "host");
  if (mp.role !== "host") $("result-text").insertAdjacentHTML("beforeend", '<p class="sub">ホストが「もう一度遊ぶ」を押すと、同じチームですぐに始まります。</p>');
  $("result").hidden = false;
}

// ロビーの「対戦形式」カード（設定を変えられるのはホストだけ。チームは各自が選ぶ）
function renderMatchCard() {
  const mp = state.mp;
  if (!mp) return;
  const host = mp.role === "host";
  const cfg = mp.config;
  const team = cfg.mode === "team";
  document.querySelectorAll("#match-mode .tab").forEach((b) => {
    b.classList.toggle("active", b.dataset.m === cfg.mode);
    b.disabled = !host;
  });
  $("match-host-note").textContent = host ? "" : "（ホストが決めます）";
  $("team-setup").hidden = !team;
  const me = mp.players.find((p) => p.id === mp.me);
  for (const t of Object.keys(TEAMS)) {
    const list = mp.players.filter((p) => p.team === t);
    $(`team-${t}-count`).textContent = `${list.length}人`;
    $(`team-${t}-members`).innerHTML = list.map((p) => `<li class="${p.id === mp.me ? "me" : ""}">
      <span class="p-avatar" style="--c:${p.color}">${escapeHtml((p.name || "?").slice(0, 1))}</span>${p.name ? escapeHtml(p.name) : "名前を入力中…"}${p.id === mp.me ? "<small>あなた</small>" : ""}</li>`).join("")
      || '<li class="empty">まだ誰もいません</li>';
    const life = $(`team-${t}-life`);
    if (document.activeElement !== life) life.value = cfg.teams[t].life;
    life.disabled = !host;
    $(`team-${t}-extra`).checked = !!cfg.teams[t].extra;
    $(`team-${t}-extra`).disabled = !host;
    const join = document.querySelector(`.join-team[data-team="${t}"]`);
    join.hidden = !me || me.team === t;
  }
  const timer = cfg.timer || { on: false, seconds: 60 };
  $("team-timer").checked = timer.on;
  $("team-timer").disabled = !host;
  $("team-timer-row").hidden = !timer.on;
  if (document.activeElement !== $("team-time")) $("team-time").value = timer.seconds;
  $("team-time").disabled = !host;
  $("team-time-label").textContent = `${timer.seconds}秒`;
}

function bindMatchCard() {
  const hostOnly = (fn) => () => {
    const mp = state.mp;
    if (!mp || mp.role !== "host" || mp.phase !== "lobby") return;
    fn(mp.config);
    broadcastLobby();
  };
  document.querySelectorAll("#match-mode .tab").forEach((b) => b.addEventListener("click", hostOnly((cfg) => { cfg.mode = b.dataset.m; })));
  for (const t of Object.keys(TEAMS)) {
    $(`team-${t}-life`).addEventListener("change", hostOnly((cfg) => {
      const v = Math.round(Number($(`team-${t}-life`).value) / 500) * 500;
      cfg.teams[t].life = Number.isFinite(v) ? Math.min(TEAM_LIFE_MAX, Math.max(TEAM_LIFE_MIN, v)) : 10000;
      $(`team-${t}-life`).value = cfg.teams[t].life;
    }));
    $(`team-${t}-extra`).addEventListener("change", hostOnly((cfg) => { cfg.teams[t].extra = $(`team-${t}-extra`).checked; }));
  }
  $("team-timer").addEventListener("change", hostOnly((cfg) => { cfg.timer.on = $("team-timer").checked; }));
  // スライダーを動かしている間も、秒数の表示はすぐ変える（配るのは離したとき）
  $("team-time").addEventListener("input", () => { $("team-time-label").textContent = `${$("team-time").value}秒`; });
  $("team-time").addEventListener("change", hostOnly((cfg) => {
    cfg.timer.seconds = Math.min(300, Math.max(10, Math.round(Number($("team-time").value) / 10) * 10 || 60));
  }));
  document.querySelectorAll(".join-team").forEach((b) => b.addEventListener("click", () => {
    const mp = state.mp;
    if (!mp || mp.phase !== "lobby") return;
    if (mp.role === "host") {
      mp.players.find((p) => p.id === "host").team = b.dataset.team;
      broadcastLobby();
    } else {
      guestSend({ type: "team", team: b.dataset.team });
    }
  }));
}

// ---------------------------------------------------------------- リアクションとチャット

const REACTION_EMOJIS = ["👍", "😂", "😮", "😭", "🔥", "👏", "🤔", "😱", "🎉", "❤️", "🙏", "💀"];
const CHAT_MAX = 120;
const CHAT_HISTORY = 100;
let lastSocialSend = 0;

// 部屋につながっている間だけ、左端のボタンを出す
function updateSocial() {
  const mp = state.mp;
  $("mp-social").hidden = !mp || mp.connecting || !mp.me;
}

function resetSocial() {
  $("mp-social").hidden = true;
  $("chat-log").innerHTML = "";
  $("react-layer").innerHTML = "";
  toggleReactPicker(false);
  toggleChat(false);
  setUnread(0);
}

// 自分の操作: ホストなら自分で配り、参加者ならホストに送る
function sendSocial(msg) {
  const mp = state.mp;
  if (!mp) return;
  // 連打で相手の画面が埋まらないように、少し間をあける
  const now = Date.now();
  if (now - lastSocialSend < 350) return;
  lastSocialSend = now;
  if (mp.role === "host") hostRelaySocial(mp.players.find((p) => p.id === "host"), msg);
  else guestSend(msg);
}

function hostRelaySocial(player, msg) {
  if (!player) return;
  const now = Date.now();
  if (now - (player.lastSocial || 0) < 300) return; // ホスト側でも連打を間引く
  player.lastSocial = now;
  const base = { id: player.id, name: player.name || "名無しの旅人", color: player.color };
  let out = null;
  if (msg.type === "react" && REACTION_EMOJIS.includes(msg.emoji)) {
    out = { ...base, type: "react", emoji: msg.emoji };
  } else if (msg.type === "chat") {
    const text = String(msg.text || "").replace(/\s+/g, " ").trim().slice(0, CHAT_MAX);
    if (text) out = { ...base, type: "chat", text };
  }
  if (!out) return;
  broadcast(out);
  if (out.type === "react") showReaction(out);
  else addChatMessage(out);
}

// 届いたリアクションを、左のボタン列のすぐ右で、下からふわっと浮かべて消す（クリックは素通り）
function showReaction(msg) {
  if (!REACTION_EMOJIS.includes(msg.emoji)) return;
  const el = document.createElement("div");
  el.className = "float-react";
  el.style.left = `${Math.round(Math.random() * 56)}px`;
  el.style.setProperty("--drift", `${Math.round(Math.random() * 40 - 10)}px`);
  el.innerHTML = `<span class="fr-emoji">${msg.emoji}</span><span class="fr-name" style="--pc:${escapeHtml(msg.color || "#fff")}"></span>`;
  el.querySelector(".fr-name").textContent = msg.name;
  $("react-layer").appendChild(el);
  setTimeout(() => el.remove(), state.prefs && !state.prefs.anim ? 1800 : 3200);
}

function addChatMessage(msg) {
  const mp = state.mp;
  if (!mp) return;
  const mine = msg.id === mp.me;
  const li = document.createElement("li");
  li.className = mine ? "me" : "";
  li.innerHTML = `<b style="color:${escapeHtml(msg.color || "#fff")}"></b><span></span>`;
  li.querySelector("b").textContent = msg.name;
  li.querySelector("span").textContent = msg.text;
  const log = $("chat-log");
  log.appendChild(li);
  while (log.children.length > CHAT_HISTORY) log.firstElementChild.remove();
  log.scrollTop = log.scrollHeight;
  if (!$("mp-chat").hidden || mine) return;
  // 閉じているときは、ボタンに未読の数と、ひとことプレビューを出す
  setUnread((mp.unread || 0) + 1);
  const toast = $("chat-toast");
  toast.innerHTML = `<b style="color:${escapeHtml(msg.color || "#fff")}"></b><span></span>`;
  toast.querySelector("b").textContent = msg.name;
  toast.querySelector("span").textContent = msg.text;
  toast.hidden = false;
  toast.classList.remove("show");
  void toast.offsetWidth;
  toast.classList.add("show");
  clearTimeout(mp.toastTimer);
  mp.toastTimer = setTimeout(() => { toast.hidden = true; }, 4000);
}

function setUnread(n) {
  if (state.mp) state.mp.unread = n;
  $("chat-badge").hidden = !n;
  $("chat-badge").textContent = n > 9 ? "9+" : n;
}

function toggleReactPicker(open = $("react-picker").hidden) {
  $("react-picker").hidden = !open;
  $("btn-react").setAttribute("aria-expanded", String(open));
  if (open) toggleChat(false);
}

function toggleChat(open = $("mp-chat").hidden) {
  $("mp-chat").hidden = !open;
  $("btn-chat").setAttribute("aria-expanded", String(open));
  if (!open) return;
  toggleReactPicker(false);
  setUnread(0);
  $("chat-toast").hidden = true;
  $("chat-log").scrollTop = $("chat-log").scrollHeight;
  $("chat-input").focus();
}

function bindSocial() {
  $("react-picker").innerHTML = REACTION_EMOJIS.map((e) => `<button class="react-pick" data-emoji="${e}" aria-label="${e} を送る">${e}</button>`).join("");
  $("react-picker").addEventListener("click", (e) => {
    const btn = e.target.closest(".react-pick");
    if (!btn) return;
    sendSocial({ type: "react", emoji: btn.dataset.emoji });
    // 押したボタンも小さく弾ませる
    btn.classList.remove("sent");
    void btn.offsetWidth;
    btn.classList.add("sent");
  });
  $("btn-react").addEventListener("click", () => toggleReactPicker());
  $("btn-chat").addEventListener("click", () => toggleChat());
  $("btn-chat-close").addEventListener("click", () => toggleChat(false));
  $("chat-toast").addEventListener("click", () => toggleChat(true));
  $("chat-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = $("chat-input").value.trim();
    if (!text) return;
    sendSocial({ type: "chat", text });
    $("chat-input").value = "";
  });
  $("mp-social").addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    toggleReactPicker(false);
    toggleChat(false);
    e.target.blur && e.target.blur();
  });
  // 外側をクリックしたら、リアクションの一覧は閉じる
  document.addEventListener("pointerdown", (e) => {
    if (!$("react-picker").hidden && !e.target.closest("#mp-social")) toggleReactPicker(false);
  });
}

function bindMultiplayerUi() {
  $("btn-mode-single").addEventListener("click", startSingle);
  $("btn-mode-multi").addEventListener("click", hostRoom);
  $("btn-mode-back").addEventListener("click", showTitle);
  $("btn-mode-join").addEventListener("click", joinByCode);
  $("join-code-input").addEventListener("keydown", (e) => { if (e.key === "Enter") joinByCode(); });
  $("btn-lobby-back").addEventListener("click", confirmLeaveRoom);
  $("btn-ready").addEventListener("click", submitMyName);
  $("my-name").addEventListener("keydown", (e) => { if (e.key === "Enter") submitMyName(); });
  $("btn-copy-link").addEventListener("click", copyInviteLink);
  $("btn-share-link").addEventListener("click", () => {
    navigator.share({ title: "LocationGuess", text: `ルームコード ${state.mp.code} で一緒に遊ぼう！`, url: inviteLink(state.mp.code) }).catch(() => {});
  });
  $("btn-lobby-go").addEventListener("click", hostGoSelect);
  $("btn-spectate-stop").addEventListener("click", () => stopSpectate(true));
  bindSocial();
  bindMatchCard();
  // ページを閉じるときは部屋も閉じる
  window.addEventListener("beforeunload", () => leaveRoom());
}

bindMultiplayerUi();

// 招待リンク（?room=XXXXXX）で開いたら、そのまま部屋に入る
(() => {
  const code = new URLSearchParams(location.search).get("room");
  if (code && /^[A-Z0-9]{6}$/i.test(code)) joinRoom(code.toUpperCase());
})();
