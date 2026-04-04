// ============================================================
//  WordBattle – game.js
// ============================================================

const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyClKgZxFXFo0uGk_Xj1fgCiJFGDVHaRFG8",
  authDomain:        "wordbattle-85321.firebaseapp.com",
  databaseURL:       "https://wordbattle-85321-default-rtdb.firebaseio.com",
  projectId:         "wordbattle-85321",
  storageBucket:     "wordbattle-85321.firebasestorage.app",
  messagingSenderId: "710471217297",
  appId:             "1:710471217297:web:5c0df5f083b8b5d38fcf30"
};

// ── 定数 ──────────────────────────────────────────────────
const HAND_SIZE  = 5;
const DIRS       = ['up', 'down', 'left', 'right'];
const KEY_TO_DIR = { ArrowUp:'up', ArrowDown:'down', ArrowLeft:'left', ArrowRight:'right' };

const ITEMS = [
  { id:'timer',   label:'⏱ タイムアタック', desc:'3秒以内に解答' },
  { id:'reverse', label:'🔄 逆問題',         desc:'日本語→英語で出題' },
  { id:'partial', label:'👁 3文字ヒント',     desc:'先頭3文字のみ表示' },
  { id:'half',    label:'✂ ポイント半分',     desc:'今回の獲得ポイントが半分' },
  { id:'double',  label:'💥 2問連続',         desc:'カードを2枚出題' },
  { id:'risk',    label:'⚡ ハイリスク',       desc:'正解+15 / 不正解-10' },
  { id:'flash',   label:'💨 フラッシュ',       desc:'1秒で問題が消える' },
];

// ── ローカル状態 ──────────────────────────────────────────
let db, auth;
let myId          = null;
let roomId        = null;
let myName        = '';
let listeners     = {};       // { key: { ref, cb } }
let timerHandle   = null;
let selectedItem  = null;
let selectedCards = [];
let keyLocked     = false;
let advancePending = false;
let currentHand   = [];       // ★ 手札のローカルキャッシュ
let currentGame   = null;     // ★ gameオブジェクトのローカルキャッシュ
let currentPlayers = null;    // ★ playersのローカルキャッシュ
let vocabRange    = { start: 0, end: 299 }; // ★ 単語範囲（Firebase設定と同期）

// ============================================================
//  Firebase
// ============================================================
function initFirebase() {
  firebase.initializeApp(FIREBASE_CONFIG);
  db   = firebase.database();
  auth = firebase.auth();
  auth.signInAnonymously().catch(e => alert('Firebase 接続エラー: ' + e.message));
}

// ★ リスナー登録（重複防止 + 正しいoff対応）
function listenOn(key, ref, callback) {
  if (listeners[key]) {
    listeners[key].ref.off('value', listeners[key].cb);
  }
  ref.on('value', callback);
  listeners[key] = { ref, cb: callback };
}

// ★ リスナー正しく解除
function off(key) {
  if (listeners[key]) {
    listeners[key].ref.off('value', listeners[key].cb);
    listeners[key] = null;
  }
}

// ── ユーティリティ ────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function randomCode() {
  return Math.random().toString(36).slice(2, 6).toUpperCase();
}

// Firebase は配列を object で返す場合があるため、常に配列に変換するヘルパー
function toArray(val) {
  if (!val) return [];
  return Array.isArray(val) ? [...val] : Object.values(val);
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function pickCards(deck, n) {
  const picked = [];
  const copy = [...deck];
  for (let i = 0; i < n && copy.length; i++) {
    const idx = Math.floor(Math.random() * copy.length);
    picked.push(copy.splice(idx, 1)[0]);
  }
  return { picked, remaining: copy };
}

function buildChoices(correctIdx, isReverse) {
  const correct = isReverse ? VOCAB[correctIdx].w : VOCAB[correctIdx].m;
  const pool = [];
  const { start, end } = vocabRange;
  const rangeSize = end - start + 1;
  while (pool.length < 3) {
    const r = start + Math.floor(Math.random() * rangeSize);
    if (r !== correctIdx && !pool.includes(r)) pool.push(r);
  }
  const wrong = pool.map(i => isReverse ? VOCAB[i].w : VOCAB[i].m);
  const all = [correct, ...wrong];
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  return { choices: all, correctDir: DIRS[all.indexOf(correct)] };
}

// ============================================================
//  ロビー
// ============================================================
function onCreateRoom() {
  myName = document.getElementById('inp-name').value.trim();
  if (!myName) { alert('名前を入力してください'); return; }

  myId   = 'p1';
  roomId = randomCode();

  // デッキ・手札はゲーム開始時(onStartGame)に単語範囲を確定してから生成する
  db.ref(`rooms/${roomId}`).set({
    status: 'waiting',
    players: {
      p1: { name: myName, score: 0 },
      p2: { name: '',     score: 0 }
    },
    settings: { totalTurns: 10, vocabRange: { start: 0, end: 299 } },
    game: {
      currentTurn:  1,
      activePlayer: 'p1',
      phase:        'select',
    }
  }).then(() => {
    document.getElementById('room-code-display').textContent = roomId;
    showScreen('screen-waiting');
    const ref = db.ref(`rooms/${roomId}/status`);
    listenOn('join', ref, snap => {
      if (snap.val() === 'ready') {
        off('join');
        showScreen('screen-settings');
        setupSettingsScreen();
      }
    });
  });
}

function onJoinRoom() {
  myName = document.getElementById('inp-name').value.trim();
  const code = document.getElementById('inp-code').value.trim().toUpperCase();
  if (!myName) { alert('名前を入力してください'); return; }
  if (!code)   { alert('ルームコードを入力してください'); return; }

  db.ref(`rooms/${code}`).once('value').then(snap => {
    const room = snap.val();
    if (!room)                     { alert('ルームが見つかりません'); return; }
    if (room.status !== 'waiting') { alert('このルームは既に開始しています'); return; }

    myId   = 'p2';
    roomId = code;
    db.ref(`rooms/${roomId}/players/p2/name`).set(myName).then(() => {
      db.ref(`rooms/${roomId}/status`).set('ready');
      showScreen('screen-settings');
      setupSettingsScreen();
    });
  });
}

// ============================================================
//  設定画面
// ============================================================
function setupSettingsScreen() {
  const isHost = (myId === 'p1');
  document.getElementById('settings-host-ui').classList.toggle('hidden', !isHost);
  document.getElementById('settings-guest-msg').classList.toggle('hidden', isHost);

  if (!isHost) {
    const ref = db.ref(`rooms/${roomId}/status`);
    listenOn('start', ref, snap => {
      if (snap.val() === 'playing') {
        off('start');
        startGame();
      }
    });
  }
}

function onSelectTurns(n) {
  document.querySelectorAll('.turn-btn').forEach(b =>
    b.classList.toggle('selected', parseInt(b.dataset.turns) === n)
  );
  db.ref(`rooms/${roomId}/settings/totalTurns`).set(n);
}

function onSelectRange(start, end) {
  document.querySelectorAll('.range-btn').forEach(b =>
    b.classList.toggle('selected',
      parseInt(b.dataset.start) === start && parseInt(b.dataset.end) === end)
  );
  db.ref(`rooms/${roomId}/settings/vocabRange`).set({ start, end });
}

function onStartGame() {
  // 設定された単語範囲を読み込んでからデッキ・手札を生成してゲーム開始
  db.ref(`rooms/${roomId}/settings`).once('value').then(snap => {
    const settings = snap.val() || {};
    const range = settings.vocabRange || { start: 0, end: 299 };
    vocabRange = range;

    const allIndices = [];
    for (let i = range.start; i <= range.end; i++) allIndices.push(i);
    const deck = shuffle(allIndices);
    const { picked: hand1, remaining: d1 } = pickCards(deck, HAND_SIZE);
    const { picked: hand2, remaining: d2 } = pickCards(d1, HAND_SIZE);

    db.ref(`rooms/${roomId}`).update({
      'players/p1/hand': hand1,
      'players/p2/hand': hand2,
      'deck':            d2,
      'status':          'playing',
    }).then(() => startGame());
  });
}

// ============================================================
//  ゲーム
// ============================================================
function startGame() {
  showScreen('screen-game');
  listenOn('game', db.ref(`rooms/${roomId}`), snap => {
    const room = snap.val();
    if (room) renderGame(room);
  });
}

// ============================================================
//  描画メイン
// ============================================================
function renderGame(room) {
  const { players, game, settings } = room;
  if (!game) return;

  // ★ ローカルキャッシュ更新
  currentGame    = game;
  currentPlayers = players;

  // ★ 単語範囲を Firebase 設定と同期（p2側も正しい範囲で選択肢を生成するため）
  if (settings?.vocabRange) vocabRange = settings.vocabRange;

  const oppId    = myId === 'p1' ? 'p2' : 'p1';
  const me       = players[myId];
  const opp      = players[oppId];
  const isMyTurn = game.activePlayer === myId;

  // ── スコアバー ──
  document.getElementById('score-me').querySelector('.name').textContent  = me.name  + (isMyTurn  ? ' ▶' : '');
  document.getElementById('score-opp').querySelector('.name').textContent = opp.name + (!isMyTurn ? ' ▶' : '');
  document.getElementById('score-me').querySelector('.pts').textContent   = me.score;
  document.getElementById('score-opp').querySelector('.pts').textContent  = opp.score;
  document.getElementById('score-me').classList.toggle('active', isMyTurn);
  document.getElementById('score-opp').classList.toggle('active', !isMyTurn);

  const totalTurns = settings?.totalTurns || 10;
  document.getElementById('turn-display').innerHTML =
    `ターン <span>${game.currentTurn}</span> / ${totalTurns}`;

  // ── フェーズ分岐 ──
  const phase = game.phase;

  if (phase === 'finished') {
    off('game');
    showResult(players);
    return;
  }

  const handArea    = document.getElementById('hand-area');
  const itemArea    = document.getElementById('item-area');
  const qArea       = document.getElementById('question-area');
  const choicesArea = document.getElementById('choices-area');
  const statusMsg   = document.getElementById('status-msg');

  // ── select フェーズ（アイテム選択 + カード選択を同一画面で）──
  if (phase === 'select') {
    qArea.classList.add('hidden');
    choicesArea.classList.add('hidden');

    if (isMyTurn) {
      // ★ 手札キャッシュ更新（Firebase は配列を object で返す場合があるため toArray で変換）
      currentHand = toArray(me.hand);
      itemArea.classList.remove('hidden');
      handArea.classList.remove('hidden');
      renderItemButtons(players, game);
      renderHand();
      statusMsg.textContent = '【あなたのターン】アイテムを選んでカードをクリック';
      statusMsg.className   = 'status-msg';
    } else {
      itemArea.classList.add('hidden');
      handArea.classList.add('hidden');
      statusMsg.textContent = `${game.activePlayer === 'p1' ? players.p1.name : players.p2.name} が出題を準備中...`;
      statusMsg.className   = 'status-msg';
    }
    return;
  }

  // ── answering / answering2 フェーズ ──
  if (phase === 'answering' || phase === 'answering2') {
    itemArea.classList.add('hidden');
    handArea.classList.add('hidden');
    qArea.classList.remove('hidden');
    choicesArea.classList.remove('hidden');

    renderQuestion(game, isMyTurn);

    if (!isMyTurn) {
      statusMsg.textContent = '矢印キー（↑↓←→）で解答してください';
      statusMsg.className   = 'status-msg';
    } else {
      const label = phase === 'answering2' ? '【2問目 出題中】' : '【出題中】';
      statusMsg.textContent = label + ' 相手が解答中...';
      statusMsg.className   = 'status-msg';
    }
    return;
  }

  // ── answered フェーズ ──
  if (phase === 'answered') {
    itemArea.classList.add('hidden');
    handArea.classList.add('hidden');
    qArea.classList.remove('hidden');
    choicesArea.classList.remove('hidden');

    renderQuestion(game, isMyTurn);

    const isCorrect = game.answerResult === 'correct';
    statusMsg.textContent = isCorrect ? '✓ 正解！' : '✗ 不正解';
    statusMsg.className   = 'status-msg big ' + (isCorrect ? 'correct' : 'wrong');

    // 両ブラウザからターン進行（重複呼び出し防止 + Firebase側でもガード）
    if (!advancePending) {
      advancePending = true;
      setTimeout(() => {
        advancePending = false;
        advanceTurn();
      }, 1800);
    }
  }
}

// ── 手札描画 ─────────────────────────────────────────────
function renderHand() {
  const container = document.getElementById('hand');
  container.innerHTML = '';
  const maxSel = selectedItem === 'double' ? 2 : 1;

  currentHand.forEach((cardIdx, i) => {
    const v = VOCAB[cardIdx];
    const div = document.createElement('div');
    div.className = 'card';
    div.innerHTML = `<div class="card-word">${v.w}</div><div class="card-num">${v.m.slice(0, 14)}...</div>`;
    if (selectedCards.includes(i)) div.classList.add('selected');
    div.addEventListener('click', () => onSelectCard(i, maxSel));
    container.appendChild(div);
  });
}

function onSelectCard(handPos, maxSel) {
  if (selectedCards.includes(handPos)) {
    selectedCards = selectedCards.filter(x => x !== handPos);
  } else {
    if (selectedCards.length < maxSel) selectedCards.push(handPos);
  }
  renderHand(); // ★ ローカルキャッシュから再描画（Firebase読み込み不要）

  if (selectedCards.length === maxSel) {
    setTimeout(() => submitQuestion(), 200);
  }
}

// ── アイテムボタン描画 ────────────────────────────────────
function renderItemButtons(players, game) {
  const grid = document.getElementById('items-grid');
  grid.innerHTML = '';

  // ★ アイテムクールダウン: アイテムごとに最終使用ターンを記録
  // 使用したターンから2ターン間は使用不可（例: 3ターン目使用 → 4,5ターン目は使用不可）
  const cooldowns = game.itemCooldowns || {};

  ITEMS.forEach(item => {
    const lastUsedTurn = cooldowns[item.id] || 0;
    const turnsElapsed = game.currentTurn - lastUsedTurn;
    const disabled = lastUsedTurn > 0 && turnsElapsed <= 2;

    const btn = document.createElement('button');
    btn.className   = 'btn btn-item' + (selectedItem === item.id ? ' selected' : '');
    btn.textContent = item.label;
    btn.disabled    = disabled;
    btn.title       = disabled
      ? `クールダウン中（あと ${2 - turnsElapsed + 1} ターン）`
      : item.desc;

    btn.addEventListener('click', () => {
      // ★ Firebase書き込みなし・ローカル状態のみ更新
      selectedItem  = (selectedItem === item.id) ? null : item.id;
      selectedCards = []; // 選択数が変わる場合があるのでリセット
      renderItemButtons(players, game);
      renderHand();
    });
    grid.appendChild(btn);
  });
}

// ── 出題送信 ─────────────────────────────────────────────
function submitQuestion() {
  db.ref(`rooms/${roomId}`).once('value').then(snap => {
    const room    = snap.val();
    const hand    = toArray(room.players[myId].hand);
    const item    = selectedItem;
    const isDouble   = item === 'double';
    const isReverse  = item === 'reverse';
    const isPartial  = item === 'partial';

    const cardIndices  = selectedCards.slice();
    const vocabIndices = cardIndices.map(i => hand[i]);

    // 1問目
    const v1 = vocabIndices[0];
    const { choices: c1, correctDir: cd1 } = buildChoices(v1, isReverse);
    const word1 = isPartial
      ? VOCAB[v1].w.slice(0, 3) + '_'.repeat(Math.max(0, VOCAB[v1].w.length - 3))
      : isReverse ? VOCAB[v1].m : VOCAB[v1].w;

    // 2問目（double のみ）
    let pendingQuestion = null;
    if (isDouble && vocabIndices[1] !== undefined) {
      const v2 = vocabIndices[1];
      const { choices: c2, correctDir: cd2 } = buildChoices(v2, isReverse);
      const word2 = isPartial
        ? VOCAB[v2].w.slice(0, 3) + '_'.repeat(Math.max(0, VOCAB[v2].w.length - 3))
        : isReverse ? VOCAB[v2].m : VOCAB[v2].w;
      pendingQuestion = { vocabIdx: v2, word: word2, choices: c2, correctDir: cd2, item };
    }

    // 手札補充
    [...cardIndices].sort((a, b) => b - a).forEach(i => hand.splice(i, 1));
    const { picked, remaining } = pickCards(toArray(room.deck), cardIndices.length);
    const newHand = [...hand, ...picked];

    const updates = {
      [`players/${myId}/hand`]: newHand,
      'deck':                   remaining,
      'game/phase':             'answering',
      'game/selectedItem':      item || null,
      'game/question': {
        vocabIdx: v1, word: word1, choices: c1, correctDir: cd1, item: item || null,
      },
      'game/pendingQuestion':   pendingQuestion,
      'game/answer':            null,
      'game/answerResult':      null,
    };

    db.ref(`rooms/${roomId}`).update(updates);
    selectedCards = [];
    selectedItem  = null;
  });
}

// ── 問題描画 ─────────────────────────────────────────────
function renderQuestion(game, isQuestioner) {
  const q = game.question;
  if (!q) return;

  const wordEl  = document.getElementById('q-word');
  const labelEl = document.getElementById('q-label');

  wordEl.textContent = q.word;
  wordEl.classList.remove('hidden');

  const isQ2 = game.phase === 'answering2';
  labelEl.textContent = isQuestioner
    ? (isQ2 ? '【2問目 出題中】' : '【出題中】')
    : (isQ2 ? '【2問目】解答してください' : '【解答してください】');

  // フラッシュ: 解答側のみ、answeringフェーズのみ起動
  if (q.item === 'flash' && !isQuestioner && game.answer === null) {
    clearTimeout(timerHandle);
    timerHandle = setTimeout(() => wordEl.classList.add('hidden'), 1000);
  }

  // タイマーバー
  const timerBar  = document.getElementById('timer-bar');
  const timerFill = document.getElementById('timer-fill');
  const showTimer = q.item === 'timer' && !isQuestioner && game.answer === null;

  if (showTimer) {
    timerBar.classList.remove('hidden');
    timerFill.style.transition = 'none';
    timerFill.style.width = '100%';
    requestAnimationFrame(() => {
      timerFill.style.transition = 'width 3s linear';
      timerFill.style.width = '0%';
    });
    clearTimeout(timerHandle);
    timerHandle = setTimeout(() => {
      if (currentGame?.phase === 'answering' || currentGame?.phase === 'answering2') {
        submitAnswer('timeout', currentGame);
      }
    }, 3000);
  } else {
    timerBar.classList.add('hidden');
  }

  // 4択描画（タップ操作は choices-area の委譲リスナーで一元管理）
  DIRS.forEach(dir => {
    const el = document.getElementById(`choice-${dir}`);
    el.querySelector('.choice-text').textContent = q.choices[DIRS.indexOf(dir)];
    el.classList.remove('correct', 'wrong', 'selected', 'disabled');
  });

  // 解答済みなら色付け
  if (game.answer) {
    DIRS.forEach(dir => {
      const el = document.getElementById(`choice-${dir}`);
      if (dir === q.correctDir)                                 el.classList.add('correct');
      if (dir === game.answer && game.answer !== q.correctDir)  el.classList.add('wrong');
      if (dir === game.answer)                                  el.classList.add('selected');
    });
  }
}

// ── キー入力（解答） ──────────────────────────────────────
function onKeyDown(e) {
  const dir = KEY_TO_DIR[e.key];
  if (!dir || !currentGame || !currentPlayers) return;

  e.preventDefault(); // 矢印キーによるページスクロールを防止

  const game = currentGame;
  if (game.phase !== 'answering' && game.phase !== 'answering2') return;
  if (game.activePlayer === myId) return; // 出題側は解答しない
  if (game.answer) return;               // 解答済み
  if (keyLocked)   return;

  keyLocked = true;
  submitAnswer(dir, game);
}

// ── 解答送信 ─────────────────────────────────────────────
function submitAnswer(dir, game) {
  clearTimeout(timerHandle);

  const q         = game.question;
  const isCorrect = (dir === q.correctDir);
  const item      = q.item;

  let delta = 0;
  if (isCorrect) {
    delta = item === 'half' ? 5 : item === 'risk' ? 15 : 10;
  } else {
    if (item === 'risk') delta = -10;
  }

  // 解答者 = アクティブプレイヤー（出題者）の相手
  const ansId = game.activePlayer === 'p1' ? 'p2' : 'p1';

  db.ref(`rooms/${roomId}`).once('value').then(snap => {
    const room      = snap.val();
    const curScore  = room.players[ansId]?.score || 0;
    const newScore  = Math.max(0, curScore + delta);
    const hasPending = !!room.game.pendingQuestion;

    const updates = {
      [`players/${ansId}/score`]: newScore,
      'game/answer':              dir,
      'game/answerResult':        isCorrect ? 'correct' : 'wrong',
    };

    if (hasPending && game.phase === 'answering') {
      // ★ 2問連続: 1問目完了 → 2問目へ遷移
      updates['game/phase']           = 'answering2';
      updates['game/question']        = room.game.pendingQuestion;
      updates['game/pendingQuestion'] = null;
      updates['game/answer']          = null;
      updates['game/answerResult']    = null;
    } else {
      // 通常終了
      updates['game/phase'] = 'answered';
    }

    db.ref(`rooms/${roomId}`).update(updates).then(() => { keyLocked = false; });
  });
}

// ── ターン進行（p1が担当） ────────────────────────────────
function advanceTurn() {
  db.ref(`rooms/${roomId}`).once('value').then(snap => {
    const room = snap.val();
    if (!room?.game || room.game.phase !== 'answered') return; // 二重実行ガード

    const { game, settings } = room;
    const totalTurns = settings?.totalTurns || 10;

    if (game.currentTurn >= totalTurns) {
      db.ref(`rooms/${roomId}/game/phase`).set('finished');
      return;
    }

    const nextPlayer = game.activePlayer === 'p1' ? 'p2' : 'p1';
    const updates = {
      'game/currentTurn':     game.currentTurn + 1,
      'game/activePlayer':    nextPlayer,
      'game/phase':           'select',
      'game/question':        null,
      'game/pendingQuestion': null,
      'game/answer':          null,
      'game/answerResult':    null,
      'game/selectedItem':    null,
    };

    // ★ 使用されたアイテムのクールダウンを記録（アイテムごとに独立管理）
    if (game.selectedItem) {
      updates[`game/itemCooldowns/${game.selectedItem}`] = game.currentTurn;
    }

    db.ref(`rooms/${roomId}`).update(updates);
  });
}

// ── 結果画面 ─────────────────────────────────────────────
function showResult(players) {
  showScreen('screen-result');
  const me  = players[myId];
  const oppId = myId === 'p1' ? 'p2' : 'p1';
  const opp = players[oppId];
  const p1  = players.p1;
  const p2  = players.p2;

  let title, cls;
  if (p1.score === p2.score) {
    title = '引き分け！'; cls = 'draw';
  } else if ((myId === 'p1') === (p1.score > p2.score)) {
    title = 'あなたの勝利！'; cls = 'win';
  } else {
    title = '敗北...'; cls = 'lose';
  }

  document.getElementById('result-title').textContent = title;
  document.getElementById('result-title').className   = `result-title ${cls}`;
  document.getElementById('result-me-name').textContent   = me.name;
  document.getElementById('result-me-score').textContent  = me.score;
  document.getElementById('result-opp-name').textContent  = opp.name;
  document.getElementById('result-opp-score').textContent = opp.score;
  document.getElementById('result-me').classList.toggle('winner',  me.score > opp.score);
  document.getElementById('result-opp').classList.toggle('winner', opp.score > me.score);
}

function onPlayAgain() {
  off('game');
  db.ref(`rooms/${roomId}`).remove().then(() => location.reload());
}

// ── DOM Ready ────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initFirebase();
  document.getElementById('btn-create').addEventListener('click', onCreateRoom);
  document.getElementById('btn-join').addEventListener('click', onJoinRoom);
  document.querySelectorAll('.turn-btn').forEach(btn =>
    btn.addEventListener('click', () => onSelectTurns(parseInt(btn.dataset.turns)))
  );
  document.querySelectorAll('.range-btn').forEach(btn =>
    btn.addEventListener('click', () =>
      onSelectRange(parseInt(btn.dataset.start), parseInt(btn.dataset.end)))
  );
  document.getElementById('btn-start-game').addEventListener('click', onStartGame);
  document.addEventListener('keydown', onKeyDown);
  document.getElementById('btn-again').addEventListener('click', onPlayAgain);

  // ★ 選択肢タップ/クリック（イベント委譲: 一度だけ登録して確実に動作させる）
  document.getElementById('choices-area').addEventListener('pointerdown', (e) => {
    // タップ/クリックされた要素、またはその親が .choice かを調べる
    const choice = e.target.closest('.choice');
    if (!choice) return;

    const dir = choice.dataset.dir;
    if (!dir) return;

    // ゲーム状態チェック
    if (!currentGame) return;
    if (currentGame.phase !== 'answering' && currentGame.phase !== 'answering2') return;
    if (currentGame.activePlayer === myId) return; // 出題側は解答しない
    if (currentGame.answer) return;                // 解答済み
    if (keyLocked) return;

    e.preventDefault(); // スクロール・ズーム防止
    keyLocked = true;
    submitAnswer(dir, currentGame);
  });
});
