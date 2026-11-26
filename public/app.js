'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const SESSION_KEY = 'swtt_online_session_v1';

  const app = {
    config: null,
    socket: null,
    state: null,
    session: loadSession(),
    meId: null,
    selectedChar: null,
    taken: new Set(),
    roomInfo: null,
    checkSeq: 0,
    seenMoveSeq: 0,
    seenEffectId: null,
    seenDiceSeq: 0,
    tokenEls: new Map(),
    displayPos: new Map(),
    animations: new Map(),
    pendingId: null,
    pendingSubmitting: false,
    hiddenPendingId: null,
    divineMinimized: false,
    bannerTimer: null,
    feedRendered: '',
    rejoining: false,
    rejoinTimer: null,
    rejoinAttempt: 0,
    modalLocked: false,
    initialized: false,
  };

  const cardByKey = new Map();
  const CHARACTER_PICK_ORDER = [
    'zhangbenzhiyao',
    'zhangbenmeiyao',
    'aolikeyou',
    'feilikeyou',
    'yunshuimu',
    'tunlusi',
    'yuguogui',
    'bulugui',
  ];

  function loadSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data?.code || !data?.token) return null;
      return data;
    } catch {
      return null;
    }
  }

  function saveSession(session) {
    app.session = session;
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    } catch {
      // 忽略浏览器隐私模式下的存储失败
    }
  }

  function forgetSession() {
    app.session = null;
    try {
      localStorage.removeItem(SESSION_KEY);
    } catch {
      // ignore
    }
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[ch]));
  }

  function showToast(message, type = 'info') {
    if (!message) return;
    const stack = $('toastStack');
    const el = document.createElement('div');
    el.className = `toast${type === 'error' ? ' error' : ''}`;
    el.textContent = message;
    stack.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translateX(18px)';
      setTimeout(() => el.remove(), 220);
    }, 3200);
  }

  function copyText(text) {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(
        () => showToast('房间码已复制'),
        () => fallbackCopy(text)
      );
    } else {
      fallbackCopy(text);
    }
  }

  function fallbackCopy(text) {
    const input = document.createElement('textarea');
    input.value = text;
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.appendChild(input);
    input.select();
    try {
      document.execCommand('copy');
      showToast('房间码已复制');
    } catch {
      showToast('复制失败，请手动记录房间码', 'error');
    }
    input.remove();
  }

  async function init() {
    try {
      const res = await fetch('/api/config');
      if (!res.ok) throw new Error('配置加载失败');
      app.config = await res.json();
      app.config.cards = app.config.cards || {};
      Object.values(app.config.cards).flat().forEach((card) => cardByKey.set(card.key, card));
    } catch (error) {
      showToast('页面资源加载失败，请刷新重试', 'error');
      return;
    }

    app.selectedChar = app.config.characters[0]?.key || null;
    renderCharPicker();
    bindStaticEvents();
    setupSocket();
    app.initialized = true;

    if (app.session) {
      // 等 socket 连接后再尝试回到原座位
      if (app.socket.connected) rejoinRoom();
    }
  }

  function renderCharPicker() {
    const wrap = $('charPicker');
    if (!app.config) return;
    const order = (char) => {
      const index = CHARACTER_PICK_ORDER.indexOf(char.key);
      return index < 0 ? CHARACTER_PICK_ORDER.length : index;
    };
    const characters = [...app.config.characters].sort((a, b) => order(a) - order(b));
    wrap.innerHTML = characters.map((char) => {
      const taken = app.taken.has(char.key);
      const selected = app.selectedChar === char.key;
      return `
        <button type="button" class="char-choice${selected ? ' selected' : ''}${taken ? ' taken' : ''}"
                data-char="${escapeHtml(char.key)}" ${taken ? 'disabled' : ''}
                title="${escapeHtml(`${char.name}：${(char.ability || []).join('；')}`)}">
          <img src="${escapeHtml(char.avatar)}" alt="${escapeHtml(char.name)}" draggable="false">
          <span>${escapeHtml(char.name)}</span>
        </button>
      `;
    }).join('');
    const createBtn = $('createBtn');
    if (createBtn) createBtn.disabled = !(app.config?.characters?.length);
  }

  function selectCharacter(key) {
    if (app.taken.has(key)) return;
    app.selectedChar = key;
    renderCharPicker();
  }

  function bindStaticEvents() {
    $('charPicker').addEventListener('click', (event) => {
      const button = event.target.closest('[data-char]');
      if (!button || button.disabled) return;
      selectCharacter(button.dataset.char);
    });

    $('createBtn').addEventListener('click', createRoom);
    $('joinBtn').addEventListener('click', joinRoom);

    const codeInput = $('joinCodeInput');
    codeInput.addEventListener('input', () => {
      const cursor = codeInput.selectionStart;
      codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
      if (cursor !== null) codeInput.setSelectionRange(codeInput.value.length, codeInput.value.length);
      if (codeInput.value.length === 4) {
        checkRoom(codeInput.value);
      } else {
        app.roomInfo = null;
        app.taken = new Set();
        setJoinHint('');
        $('joinBtn').disabled = true;
        if (!app.selectedChar) app.selectedChar = app.config.characters[0]?.key || null;
        renderCharPicker();
      }
    });
    codeInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        joinRoom();
      }
    });

    $('landingRulesBtn').addEventListener('click', openRules);
    $('lobbyRulesBtn').addEventListener('click', openRules);
    $('gameRulesBtn').addEventListener('click', openRules);
    document.querySelectorAll('.fullscreen-btn').forEach((button) => {
      button.addEventListener('click', toggleFullscreen);
    });
    document.addEventListener('fullscreenchange', updateFullscreenButtons);
    document.addEventListener('webkitfullscreenchange', updateFullscreenButtons);
    $('copyCodeBtn').addEventListener('click', () => copyText(app.state?.code || ''));
    $('lobbyLeaveBtn').addEventListener('click', () => confirmLeave());
    $('gameLeaveBtn').addEventListener('click', () => confirmLeave());
    $('endLeaveBtn').addEventListener('click', leaveRoom);
    $('resumeActionBtn').addEventListener('click', resumeAction);
    $('startBtn').addEventListener('click', startGame);
    $('finishBtn').addEventListener('click', confirmFinish);

    $('controlActions').addEventListener('click', handleControlAction);
    $('leftStack').addEventListener('click', handlePanelClick);
    $('rightStack').addEventListener('click', handlePanelClick);
    $('lobbySeats').addEventListener('click', (event) => {
      const holder = event.target.closest('[data-card-key]');
      if (holder) openCharacterCard(holder.dataset.cardKey);
    });
    $('boardTokens').addEventListener('click', (event) => {
      const token = event.target.closest('[data-player-id]');
      if (!token) return;
      const player = app.state?.players.find((p) => p.id === token.dataset.playerId);
      if (player) {
        const count = player.trophies.reduce((sum, trophy) => sum + (trophy.streak || 1), 0);
        showToast(`${player.name} · ${player.points} 积分 · ${count} 个奖杯`);
      }
    });

    $('modalBackdrop').addEventListener('click', (event) => {
      if (event.target === $('modalBackdrop') && !app.modalLocked) closeModal();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (!$('modalBackdrop').classList.contains('hidden')) {
        if (!app.modalLocked) closeModal();
        return;
      }
      const fsElement = document.fullscreenElement || document.webkitFullscreenElement;
      if (fsElement) exitFullscreen();
    });
  }

  function setupSocket() {
    app.socket = io({ transports: ['websocket', 'polling'] });

    app.socket.on('connect', () => {
      if (app.session) rejoinRoom();
    });

    app.socket.on('room:state', (state) => {
      if (!app.session) return;
      applyState(state);
    });

    app.socket.on('toast', (payload) => {
      showToast(payload?.message || '操作失败', payload?.type || 'error');
      app.pendingSubmitting = false;
    });

    app.socket.on('room:left', () => {
      forgetSession();
      clearToLanding();
    });

    app.socket.on('room:closed', () => {
      forgetSession();
      showToast('房间已关闭', 'error');
      clearToLanding();
    });

    app.socket.on('disconnect', () => {
      app.rejoinAttempt += 1;
      clearTimeout(app.rejoinTimer);
      app.rejoinTimer = null;
      app.rejoining = false;
      if (app.state) showToast('连接暂时中断，正在重连…', 'error');
    });
  }

  async function checkRoom(code) {
    const seq = ++app.checkSeq;
    setJoinHint('');
    $('joinBtn').disabled = true;
    try {
      const res = await fetch(`/api/rooms/${encodeURIComponent(code)}`);
      if (seq !== app.checkSeq) return;
      if (!res.ok) {
        app.roomInfo = null;
        app.taken = new Set();
        setJoinHint('房间不存在');
        renderCharPicker();
        return;
      }
      const info = await res.json();
      if (seq !== app.checkSeq) return;
      app.roomInfo = info;
      const takenKeys = new Set(
        app.config.characters
          .filter((char) => !info.availableCharacters.some((available) => available.key === char.key))
          .map((char) => char.key)
      );
      app.taken = takenKeys;
      if (!app.selectedChar || app.taken.has(app.selectedChar)) {
        app.selectedChar = info.availableCharacters[0]?.key || null;
      }
      renderCharPicker();

      if (info.status !== 'waiting') {
        setJoinHint('游戏已开始');
        $('joinBtn').disabled = true;
      } else if (info.playerCount >= info.maxPlayers) {
        setJoinHint('房间已满');
        $('joinBtn').disabled = true;
      } else {
        setJoinHint(`${info.code} · ${info.playerCount}/${info.maxPlayers}`);
        $('joinBtn').disabled = !app.selectedChar;
      }
    } catch {
      if (seq !== app.checkSeq) return;
      setJoinHint('无法连接房间');
    }
  }

  function setJoinHint(text) {
    $('joinHint').textContent = text;
  }

  async function createRoom() {
    // 新建房间不受当前查看的加入房间角色占用影响
    app.taken = new Set();
    if (!app.selectedChar || app.taken.has(app.selectedChar)) {
      app.selectedChar = app.config.characters[0]?.key || null;
    }
    renderCharPicker();
    if (!app.selectedChar) {
      showToast('请先选择角色', 'error');
      return;
    }
    const button = $('createBtn');
    button.disabled = true;
    app.socket.emit('room:create', { charKey: app.selectedChar }, (result) => {
      button.disabled = false;
      if (!result?.ok) {
        showToast(result?.error || '创建失败', 'error');
        return;
      }
      saveSession({
        code: result.code,
        token: result.token,
        playerId: result.playerId,
      });
      applyState(result.state);
    });
  }

  async function joinRoom() {
    const code = $('joinCodeInput').value.trim().toUpperCase();
    if (code.length !== 4) {
      showToast('请输入 4 位房间码', 'error');
      return;
    }
    if (!app.selectedChar) {
      showToast('请先选择角色', 'error');
      return;
    }
    const button = $('joinBtn');
    button.disabled = true;
    app.socket.emit('room:join', { code, charKey: app.selectedChar }, (result) => {
      button.disabled = false;
      if (!result?.ok) {
        showToast(result?.error || '加入失败', 'error');
        checkRoom(code);
        return;
      }
      saveSession({
        code: result.code,
        token: result.token,
        playerId: result.playerId,
      });
      applyState(result.state);
    });
  }

  function rejoinRoom() {
    if (!app.session || app.rejoining) return;
    app.rejoining = true;
    const attempt = ++app.rejoinAttempt;
    clearTimeout(app.rejoinTimer);
    app.rejoinTimer = setTimeout(() => {
      if (attempt !== app.rejoinAttempt) return;
      app.rejoinTimer = null;
      app.rejoining = false;
      if (app.socket?.connected) setTimeout(rejoinRoom, 600);
    }, 6000);
    app.socket.emit('room:rejoin', { code: app.session.code, token: app.session.token }, (result) => {
      if (attempt !== app.rejoinAttempt) return;
      clearTimeout(app.rejoinTimer);
      app.rejoinTimer = null;
      app.rejoining = false;
      if (!result?.ok) {
        const message = result?.error || '';
        forgetSession();
        clearToLanding();
        if (message && message !== '房间已关闭') showToast(message, 'error');
        return;
      }
      saveSession({
        code: result.code,
        token: result.token,
        playerId: result.playerId,
      });
      applyState(result.state);
    });
  }

  function applyState(state) {
    if (!state) return;
    const me = state.players.find((player) => player.id === app.session?.playerId);
    if (!me) {
      forgetSession();
      clearToLanding();
      return;
    }
    const firstState = app.state === null;
    app.meId = me.id;
    app.state = state;
    if (firstState && state.lastMove?.seq) app.seenMoveSeq = state.lastMove.seq;
    if (firstState && state.lastDice?.seq) app.seenDiceSeq = state.lastDice.seq;
    if (firstState) app.seenEffectId = state.lastEffect?.id || '__none__';

    if (state.status === 'waiting') {
      showScreen('lobby');
      renderLobby();
    } else {
      showScreen('game');
      renderGame();
    }
  }

  function showScreen(name) {
    $('landing').classList.toggle('hidden', name !== 'landing');
    $('lobby').classList.toggle('hidden', name !== 'lobby');
    $('game').classList.toggle('hidden', name !== 'game');
  }

  function clearToLanding() {
    app.state = null;
    app.meId = null;
    app.pendingId = null;
    app.pendingSubmitting = false;
    app.hiddenPendingId = null;
    app.divineMinimized = false;
    $('resumeActionBtn').classList.add('hidden');
    app.displayPos.clear();
    app.animations.forEach((animation) => clearTimeout(animation.timer));
    app.animations.clear();
    app.tokenEls.forEach((el) => el.remove());
    app.tokenEls.clear();
    app.taken = new Set();
    app.roomInfo = null;
    app.seenMoveSeq = 0;
    app.seenEffectId = null;
    app.seenDiceSeq = 0;
    app.feedRendered = '';
    closeModal();
    $('pendingBackdrop').classList.add('hidden');
    $('endOverlay').classList.add('hidden');
    $('waitingPill').classList.add('hidden');
    $('joinCodeInput').value = '';
    setJoinHint('');
    renderCharPicker();
    showScreen('landing');
  }

  function renderLobby() {
    const state = app.state;
    if (!state) return;
    $('lobbyCode').textContent = state.code;

    const me = state.players.find((player) => player.id === app.meId);
    const slots = [];
    for (let i = 0; i < app.config.maxPlayers; i += 1) {
      const player = state.players[i];
      if (player) {
        slots.push(`
          <div class="seat filled ${player.online ? '' : 'offline'}" data-card-key="${escapeHtml(player.charKey)}" title="查看角色卡">
            ${player.online ? '' : '<span class="seat-offline">离线</span>'}
            <img src="${escapeHtml(player.avatar)}" alt="${escapeHtml(player.name)}" draggable="false">
            <span class="seat-name">${escapeHtml(player.name)}</span>
            <span class="seat-tag">${player.isHost ? '房主' : '选手'}</span>
          </div>
        `);
      } else {
        slots.push(`
          <div class="seat">
            <span class="seat-empty">+</span>
            <span class="seat-name" style="color:rgba(255,247,227,.3)">空位</span>
          </div>
        `);
      }
    }
    $('lobbySeats').innerHTML = slots.join('');

    const onlineCount = state.players.filter((player) => player.online).length;
    const isHost = me?.isHost;
    const startBtn = $('startBtn');
    if (isHost) {
      startBtn.classList.remove('hidden');
      startBtn.disabled = onlineCount < 2;
      startBtn.textContent = '开始游戏';
      $('lobbyStatus').textContent =
        onlineCount < 2 ? '至少需要 2 名在线玩家' : `${onlineCount}/${app.config.maxPlayers} 在线`;
    } else {
      startBtn.classList.add('hidden');
      $('lobbyStatus').textContent = '等待房主开始';
    }
  }

  function renderGame() {
    const state = app.state;
    if (!state) return;
    $('gameCode').textContent = state.code;
    $('roundPill').textContent = `第 ${state.round} 回合`;

    const me = state.players.find((player) => player.id === app.meId);
    const current = state.players.find((player) => player.id === state.turnPlayerId);
    const pendingPlayer = state.pending
      ? state.players.find((player) => player.id === state.pending.playerId)
      : null;

    renderSidePanels();

    // 位置同步 + 移动动画
    syncDisplayPositions();
    if (state.lastMove) handleMove(state.lastMove);
    renderTokens();

    const turnFlag = $('turnFlag');
    if (current && state.status === 'playing') {
      const tile = tileOf(current.pos);
      turnFlag.style.left = `${tile.x}%`;
      turnFlag.style.top = `${tile.y}%`;
      turnFlag.classList.remove('hidden');
    } else {
      turnFlag.classList.add('hidden');
    }

    renderTurnInfo(me, current, pendingPlayer);
    renderDice(state);
    renderControls(me, current, pendingPlayer);
    renderFeed(state);
    renderPending();
    updateResumeAction();
    renderEnd(state);
    updateEffectBanner(state);

    $('finishBtn').classList.toggle('hidden', !(me?.isHost && state.status === 'playing'));

    const waitingPill = $('waitingPill');
    if (state.pending && state.pending.playerId !== app.meId) {
      waitingPill.textContent = `等待 ${pendingPlayer?.name || '玩家'} 操作…`;
      waitingPill.classList.remove('hidden');
    } else {
      waitingPill.classList.add('hidden');
    }
  }

  function renderSidePanels() {
    const state = app.state;
    if (!state) return;
    const players = state.players;
    const split = Math.ceil(players.length / 2);
    const left = players.slice(0, split);
    const right = players.slice(split);
    $('leftStack').innerHTML = left.map(playerPanelHtml).join('');
    $('rightStack').innerHTML = right.map(playerPanelHtml).join('');
  }

  function playerPanelHtml(player) {
    const isTurn = app.state.turnPlayerId === player.id && app.state.status === 'playing';
    const isMe = player.id === app.meId;
    const badges = [];
    if (isMe) badges.push('<span class="pp-badge mint">你</span>');
    if (player.isHost) badges.push('<span class="pp-badge">房主</span>');
    if (player.skipTurns > 0) badges.push(`<span class="pp-badge red">暂停×${player.skipTurns}</span>`);
    if (player.eliminated) badges.push('<span class="pp-badge red">已退出</span>');
    if (player.charKey === 'yunshuimu' && player.points <= 2500 && !player.eliminated) {
      badges.push('<span class="pp-badge">蛰伏中</span>');
    }
    if (player.charKey === 'tunlusi' && !player.eliminated) {
      if (player.divineValue) {
        badges.push(`<span class="pp-badge">神谕 ${player.divineValue}</span>`);
      } else if (!player.divineUsed && isMe) {
        badges.push('<button class="pp-badge ability-btn" type="button" data-divine>神谕</button>');
      }
    }
    badges.push(`<button class="pp-badge card-badge" type="button" data-card-key="${escapeHtml(player.charKey)}" title="${escapeHtml((player.ability || []).join('；'))}">角色卡</button>`);

    const trophies = player.trophies.length
      ? player.trophies.map((trophy) => {
          const count = Math.max(1, trophy.streak || 1);
          const pips = [1, 2, 3].map((n) => `<i class="${n <= count ? 'on' : ''}"></i>`).join('');
          return `
            <span class="trophy-chip" title="${escapeHtml(trophy.name)} · ${trophy.points} 积分 · ${count}/3 个奖杯">
              <span class="trophy-name">${escapeHtml(trophy.short || trophy.name)}</span>
              <span class="trophy-pips">${pips}</span>
            </span>
          `;
        }).join('')
      : '<span class="pp-empty">—</span>';

    const effects = player.effects.length
      ? player.effects.map((effect) => `
          <span class="effect-chip" title="${escapeHtml(effect.name)}">
            ${effect.image ? `<img src="${escapeHtml(effect.image)}" alt="">` : ''}${escapeHtml(effect.name)}
          </span>
        `).join('')
      : '<span class="pp-empty">—</span>';

    const items = player.items.length
      ? player.items.map((item) => {
          const card = cardByKey.get(item.key);
          if (!card) return '';
          return `
            <button class="item-btn usable"
              data-player-id="${escapeHtml(player.id)}"
              data-item-uid="${escapeHtml(item.uid)}"
              title="${escapeHtml(card.name)}：${escapeHtml(card.desc)}（点击查看大图）">
              <img src="${escapeHtml(card.image)}" alt="${escapeHtml(card.name)}" draggable="false">
            </button>
          `;
        }).join('')
      : '<span class="pp-empty">—</span>';

    const loans = activeLoansFor(player.id);

    return `
      <article class="player-panel${isTurn ? ' is-turn' : ''}${isMe ? ' is-me' : ''}${player.eliminated ? ' eliminated' : ''}"
               style="--p-color:${escapeHtml(player.color)}">
        ${player.online ? '' : '<span class="pp-offline" title="离线"></span>'}
        <div class="pp-head">
          <div class="pp-avatar"><img src="${escapeHtml(player.avatar)}" alt="${escapeHtml(player.name)}" draggable="false"></div>
          <div class="pp-identity">
            <div class="pp-name">${escapeHtml(player.name)}</div>
            <div class="pp-sub">${escapeHtml(player.country)} · ${escapeHtml(player.language)}</div>
          </div>
          <div class="pp-points">
            <strong class="${player.points <= 500 ? 'low' : ''}">${formatPoints(player.points)}</strong>
            <span>积分</span>
          </div>
        </div>
        ${badges.length ? `<div class="pp-badges">${badges.join('')}</div>` : ''}
        <div class="pp-section">
          <span class="pp-section-label">奖杯</span>
          <div class="trophy-list">${trophies}</div>
        </div>
        <div class="pp-section">
          <span class="pp-section-label">效果</span>
          <div class="effect-list">${effects}</div>
        </div>
        <div class="pp-section">
          <span class="pp-section-label">道具</span>
          <div class="item-list">${items}</div>
        </div>
        ${loans ? `<div class="pp-loan" title="${escapeHtml(loans.title)}">${escapeHtml(loans.text)}</div>` : ''}
      </article>
    `;
  }

  function activeLoansFor(playerId) {
    const state = app.state;
    if (!state?.loans?.length) return null;
    const active = state.loans.filter((loan) => loan.status === 'active' && (loan.borrowerId === playerId || loan.lenderId === playerId));
    if (!active.length) return null;
    const parts = [];
    const titles = [];
    for (const loan of active) {
      const otherId = loan.borrowerId === playerId ? loan.lenderId : loan.borrowerId;
      const other = state.players.find((player) => player.id === otherId);
      const total = Math.ceil(loan.principal * (1 + loan.interest / 100));
      const due = Math.max(0, loan.dueRound - state.round);
      if (loan.borrowerId === playerId) {
        parts.push(`欠 ${other?.name || '未知'} ${total}（${due} 回合）`);
        titles.push(`借款 ${loan.principal}，利息 ${loan.interest}%，到期需还 ${total}`);
      } else {
        parts.push(`贷出 ${other?.name || '未知'} ${loan.principal}`);
        titles.push(`利息 ${loan.interest}%，${due} 回合后到期`);
      }
    }
    return { text: parts.join(' / '), title: titles.join('；') };
  }

  function formatPoints(points) {
    return Number.isInteger(points) ? String(points) : Number(points).toFixed(1);
  }

  function tileOf(pos) {
    return app.config.tiles[((pos % app.config.tiles.length) + app.config.tiles.length) % app.config.tiles.length];
  }

  function syncDisplayPositions() {
    if (!app.state) return;
    const seen = new Set();
    for (const player of app.state.players) {
      seen.add(player.id);
      if (!app.animations.has(player.id)) {
        app.displayPos.set(player.id, player.pos);
      }
    }
    for (const id of [...app.displayPos.keys()]) {
      if (!seen.has(id)) app.displayPos.delete(id);
    }
  }

  function handleMove(move) {
    if (!move || !move.playerId || move.seq === app.seenMoveSeq) return;
    app.seenMoveSeq = move.seq;
    const player = app.state.players.find((p) => p.id === move.playerId);
    if (!player) return;
    if (app.animations.has(move.playerId)) {
      clearTimeout(app.animations.get(move.playerId).timer);
      app.animations.delete(move.playerId);
    }
    app.displayPos.set(move.playerId, Number.isInteger(move.from) ? move.from : player.pos);
    renderTokenPositions();

    const path = Array.isArray(move.path) && move.path.length ? move.path : [move.to];
    let index = 0;
    const animation = { timer: null };
    const step = () => {
      if (index < path.length) {
        app.displayPos.set(move.playerId, path[index]);
        index += 1;
        renderTokenPositions();
        animation.timer = setTimeout(step, 105);
      } else {
        app.displayPos.set(move.playerId, player.pos);
        app.animations.delete(move.playerId);
        renderTokenPositions();
      }
    };
    app.animations.set(move.playerId, animation);
    animation.timer = setTimeout(step, 60);
  }

  function renderTokens() {
    if (!app.state) return;
    const wrap = $('boardTokens');
    const state = app.state;
    const seen = new Set();
    for (const player of state.players) {
      seen.add(player.id);
      let el = app.tokenEls.get(player.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'token';
        el.dataset.playerId = player.id;
        el.innerHTML = `<img src="${escapeHtml(player.avatar)}" alt="${escapeHtml(player.name)}" draggable="false">`;
        wrap.appendChild(el);
        app.tokenEls.set(player.id, el);
      }
      el.style.setProperty('--player-color', player.color);
      el.classList.toggle('active', player.id === state.turnPlayerId && state.status === 'playing');
      el.classList.toggle('offline', !player.online);
      el.classList.toggle('hidden', Boolean(player.eliminated));
      el.title = `${player.name} · ${player.points} 积分`;
    }
    for (const [id, el] of app.tokenEls) {
      if (!seen.has(id)) {
        el.remove();
        app.tokenEls.delete(id);
      }
    }
    renderTokenPositions();
  }

  function renderTokenPositions() {
    if (!app.state) return;
    const groups = new Map();
    for (const player of app.state.players) {
      if (player.eliminated) continue;
      const pos = app.displayPos.get(player.id);
      if (!Number.isInteger(pos)) continue;
      if (!groups.has(pos)) groups.set(pos, []);
      groups.get(pos).push(player);
    }
    for (const [pos, players] of groups) {
      const tile = tileOf(pos);
      const offsets = tokenOffsets(players.length);
      players.forEach((player, index) => {
        const el = app.tokenEls.get(player.id);
        if (!el) return;
        const offset = offsets[index] || { x: 0, y: 0 };
        el.style.left = `${tile.x + offset.x}%`;
        el.style.top = `${tile.y + offset.y}%`;
      });
    }
  }

  function tokenOffsets(count) {
    if (count <= 1) return [{ x: 0, y: 0 }];
    if (count === 2) return [{ x: -1.8, y: -0.8 }, { x: 1.8, y: 0.8 }];
    if (count === 3) return [{ x: -2.1, y: 0.8 }, { x: 0, y: -1.3 }, { x: 2.1, y: 0.8 }];
    if (count === 4) return [{ x: -1.8, y: -1.3 }, { x: 1.8, y: -1.3 }, { x: -1.8, y: 1.3 }, { x: 1.8, y: 1.3 }];
    const grid = [
      { x: -2.2, y: -1.5 }, { x: 0, y: -1.5 }, { x: 2.2, y: -1.5 },
      { x: -2.2, y: 1.5 }, { x: 0, y: 1.5 }, { x: 2.2, y: 1.5 },
      { x: -1.1, y: 2.5 }, { x: 1.1, y: 2.5 },
    ];
    return grid.slice(0, count);
  }

  function renderTurnInfo(me, current, pendingPlayer) {
    const avatar = $('turnAvatar');
    const name = $('turnName');
    const hint = $('turnHint');
    const state = app.state;
    if (current) {
      avatar.innerHTML = `<img src="${escapeHtml(current.avatar)}" alt="${escapeHtml(current.name)}" draggable="false">`;
      name.textContent = current.id === app.meId ? '你的回合' : `${current.name} 的回合`;
    } else {
      avatar.innerHTML = '';
      name.textContent = '比赛结束';
    }
    if (state.status === 'ended') {
      hint.textContent = '比赛结算完成';
    } else if (state.pending) {
      hint.textContent = state.pending.playerId === app.meId ? '请完成弹窗操作' : `等待 ${pendingPlayer?.name || '玩家'} 操作`;
    } else if (!current) {
      hint.textContent = '';
    } else if (!current.online) {
      hint.textContent = '该玩家暂时离线';
    } else if (current.id !== app.meId) {
      hint.textContent = '等待对方行动';
    } else if (state.phase === 'awaitRoll') {
      hint.textContent = '点击骰子前进';
    } else if (state.phase === 'action') {
      hint.textContent = '可出牌，或结束回合';
    } else if (state.phase === 'skipped') {
      hint.textContent = '本回合暂停';
    } else {
      hint.textContent = '结算中…';
    }
  }

  function renderDice(state) {
    const face = $('diceFace');
    const box = $('diceBox');
    const value = state.lastDice?.value;
    face.textContent = value || '?';
    box.classList.toggle('rolling', state.phase === 'rolling');
  }

  function renderControls(me, current, pendingPlayer) {
    const wrap = $('controlActions');
    const state = app.state;
    if (state.status === 'ended') {
      wrap.innerHTML = '<span class="dock-note">比赛已结束</span>';
      return;
    }
    if (!me) {
      wrap.innerHTML = '';
      return;
    }
    if (state.pending) {
      wrap.innerHTML = `<span class="dock-note">${state.pending.playerId === app.meId ? '请完成弹窗操作' : `等待 ${escapeHtml(pendingPlayer?.name || '玩家')}`}</span>`;
      return;
    }
    if (!current || current.id !== app.meId) {
      wrap.innerHTML = `<span class="dock-note">等待 ${escapeHtml(current?.name || '玩家')}</span>`;
      return;
    }

    if (state.phase === 'awaitRoll') {
      const divine = me.charKey === 'tunlusi' && !me.divineUsed
        ? '<button class="dock-btn" data-action="divine" type="button">神谕</button>'
        : '';
      wrap.innerHTML = `<button class="dock-btn primary" data-action="roll" type="button">掷骰子</button>${divine}`;
      return;
    }

    if (state.phase === 'action') {
      const canBlade = !state.bladeUsed && hasBladeTarget(me);
      const divine = me.charKey === 'tunlusi' && !me.divineUsed
        ? '<button class="dock-btn" data-action="divine" type="button">神谕</button>'
        : '';
      wrap.innerHTML = `
        <button class="dock-btn primary" data-action="end" type="button">结束回合</button>
        <button class="dock-btn" data-action="borrow" type="button">借债</button>
        <button class="dock-btn" data-action="sell" type="button" ${me.trophies.length ? '' : 'disabled'}>卖房</button>
        <button class="dock-btn" data-action="blade" type="button" ${canBlade ? '' : 'disabled'}>拼刺刀</button>
        ${divine}
      `;
      return;
    }

    if (state.phase === 'rolling') {
      wrap.innerHTML = '<span class="dock-note">掷骰中…</span>';
      return;
    }
    if (state.phase === 'skipped') {
      wrap.innerHTML = '<span class="dock-note">本回合暂停</span>';
      return;
    }
    wrap.innerHTML = '<span class="dock-note">结算中…</span>';
  }

  function hasBladeTarget(me) {
    return app.state.players.some(
      (player) => player.id !== me.id && !player.eliminated && player.pos === me.pos
    );
  }

  function renderFeed(state) {
    const feed = $('eventFeed');
    const logs = state.logs.slice(-2).reverse();
    const key = logs.map((log) => log.id).join(',');
    if (key === app.feedRendered) return;
    app.feedRendered = key;
    feed.innerHTML = logs.map((log) => `
      <div class="feed-line ${escapeHtml(log.tone || 'info')}">${escapeHtml(log.text)}</div>
    `).join('');
  }

  function updateEffectBanner(state) {
    const effect = state.lastEffect;
    if (!effect?.id) return;
    if (effect.id === app.seenEffectId) return;
    app.seenEffectId = effect.id;
    const banner = $('effectBanner');
    banner.innerHTML = `<strong>${escapeHtml(effect.title)}</strong> · ${escapeHtml(effect.text)}`;
    banner.classList.add('show');
    clearTimeout(app.bannerTimer);
    app.bannerTimer = setTimeout(() => banner.classList.remove('show'), 3400);
  }

  function updateResumeAction() {
    const button = $('resumeActionBtn');
    if (!button) return;
    const state = app.state;
    const pending = state?.pending;
    const hiddenRoll = Boolean(
      pending &&
      pending.playerId === app.meId &&
      ['roll', 'number'].includes(pending.type) &&
      app.hiddenPendingId === pending.id
    );
    if (state?.status === 'playing' && hiddenRoll) {
      button.textContent = pending.type === 'roll' ? '继续掷骰' : '继续选择';
      button.classList.remove('hidden');
      return;
    }
    if (state?.status === 'playing' && app.divineMinimized) {
      button.textContent = '继续选择点数';
      button.classList.remove('hidden');
      return;
    }
    button.classList.add('hidden');
  }

  function hidePendingForMap() {
    const pending = app.state?.pending;
    if (!pending || pending.playerId !== app.meId) return;
    if (!['roll', 'number'].includes(pending.type)) return;
    app.hiddenPendingId = pending.id;
    app.pendingId = pending.id;
    $('pendingBackdrop').classList.add('hidden');
    updateResumeAction();
  }

  function resumeAction() {
    if (app.hiddenPendingId) {
      app.hiddenPendingId = null;
      app.pendingId = null;
      renderPending();
      updateResumeAction();
      return;
    }
    if (app.divineMinimized) {
      app.divineMinimized = false;
      openDivineModal();
      updateResumeAction();
    }
  }

  function renderPending() {
    const state = app.state;
    const pending = state.pending;
    const backdrop = $('pendingBackdrop');
    if (!pending) {
      backdrop.classList.add('hidden');
      app.pendingId = null;
      app.hiddenPendingId = null;
      app.pendingSubmitting = false;
      updateResumeAction();
      return;
    }
    if (app.hiddenPendingId && app.hiddenPendingId !== pending.id) {
      app.hiddenPendingId = null;
    }

    const mine = pending.playerId === app.meId;
    const isPublicCard = pending.type === 'card'
      && ['chance', 'fate'].includes(pending.meta?.deck);
    if (mine && ['roll', 'number'].includes(pending.type) && app.hiddenPendingId === pending.id) {
      backdrop.classList.add('hidden');
      app.pendingId = pending.id;
      updateResumeAction();
      return;
    }
    if (!mine && !isPublicCard) {
      backdrop.classList.add('hidden');
      app.pendingId = null;
      app.pendingSubmitting = false;
      updateResumeAction();
      return;
    }
    if (app.pendingId === pending.id) return;
    app.pendingId = pending.id;
    app.pendingSubmitting = false;

    const owner = state.players.find((player) => player.id === pending.playerId);
    const image = pending.image
      ? `<img class="pending-image" src="${escapeHtml(pending.image)}" alt="${escapeHtml(pending.title)}">`
      : '';

    // 其他玩家同步围观命运/机会卡
    if (!mine && isPublicCard) {
      $('pendingCard').innerHTML = `
        <div class="pending-kicker">SWTT · 抽卡同步</div>
        <div class="pending-title">${escapeHtml(owner?.name || '玩家')} 抽到了 ${escapeHtml(pending.title)}</div>
        <div class="pending-message">${escapeHtml(pending.message || '')}</div>
        ${image}
        <div class="pending-watch">等待 ${escapeHtml(owner?.name || '玩家')} 关闭卡牌…</div>
      `;
      backdrop.classList.remove('hidden');
      return;
    }

    // 破产时的借积分表单
    if (pending.type === 'loanForm') {
      const me = state.players.find((player) => player.id === app.meId);
      const lenders = state.players.filter(
        (player) => player.id !== app.meId && !player.eliminated && player.online && player.points > 0
      );
      const minAmount = Math.max(100, Number(pending.meta?.minAmount) || 100);
      const points = me?.points ?? 0;
      const target = Number(pending.meta?.target) || points + 1;
      const needed = Math.max(0, target - points);
      const defaultAmount = Math.min(5000, Math.max(minAmount, needed, 500));
      $('pendingCard').innerHTML = `
        <div class="pending-kicker">SWTT · 积分不足</div>
        <div class="pending-title">${escapeHtml(pending.title)}</div>
        <div class="pending-message">${escapeHtml(pending.message || '')}</div>
        <form id="pendingLoanForm" class="loan-form">
          <div class="form-field full">
            <label for="pendingLender">债主</label>
            <select id="pendingLender">
              ${lenders.map((player) => `<option value="${escapeHtml(player.id)}">${escapeHtml(player.name)} · ${formatPoints(player.points)} 积分</option>`).join('')}
            </select>
          </div>
          <div class="form-field">
            <label for="pendingAmount">借款积分</label>
            <input id="pendingAmount" type="number" min="${minAmount}" max="5000" step="50" value="${defaultAmount}">
          </div>
          <div class="form-field">
            <label for="pendingInterest">利息 %</label>
            <input id="pendingInterest" type="number" min="0" max="100" step="1" value="10">
          </div>
          <div class="form-field">
            <label for="pendingTerm">期限（回合）</label>
            <input id="pendingTerm" type="number" min="1" max="5" step="1" value="2">
          </div>
          <div class="loan-form-actions">
            <span>当前积分：${formatPoints(me?.points ?? 0)}</span>
            <div class="loan-form-buttons">
              <button class="loan-cancel" id="pendingLoanCancel" type="button">退出选择</button>
              <button class="option-btn primary" type="submit">确认借款</button>
            </div>
          </div>
        </form>
      `;
      $('pendingLoanCancel').addEventListener('click', () => {
        if (app.pendingSubmitting) return;
        app.pendingSubmitting = true;
        app.socket.emit('pending:respond', { id: pending.id, value: null });
        setTimeout(() => { app.pendingSubmitting = false; }, 1000);
      });
      $('pendingLoanForm').addEventListener('submit', (event) => {
        event.preventDefault();
        if (app.pendingSubmitting) return;
        const lenderId = $('pendingLender').value;
        const amount = Number($('pendingAmount').value);
        const interest = Number($('pendingInterest').value);
        const term = Number($('pendingTerm').value);
        if (!lenderId) {
          showToast('没有可借款的玩家', 'error');
          return;
        }
        if (!Number.isFinite(amount) || amount < minAmount || amount > 5000) {
          showToast(`借款积分需在 ${minAmount}-5000 之间`, 'error');
          return;
        }
        if (!Number.isFinite(interest) || interest < 0 || interest > 100) {
          showToast('利息需在 0-100% 之间', 'error');
          return;
        }
        if (!Number.isFinite(term) || term < 1 || term > 5) {
          showToast('期限需在 1-5 回合之间', 'error');
          return;
        }
        app.pendingSubmitting = true;
        $('pendingLoanForm').querySelectorAll('button, input, select').forEach((el) => { el.disabled = true; });
        app.socket.emit('pending:respond', {
          id: pending.id,
          value: { lenderId, amount, interest, term },
        });
        setTimeout(() => { app.pendingSubmitting = false; }, 1500);
      });
      backdrop.classList.remove('hidden');
      return;
    }

    const options = (pending.options || []).map((option, index) => {
      const tone = option.tone === 'primary' ? ' primary' : option.tone === 'danger' ? ' danger' : '';
      const playerInfo = option.avatar
        ? `<span class="option-player"><img src="${escapeHtml(option.avatar)}" alt=""><span>${escapeHtml(option.label)}<small>${escapeHtml(option.sub || '')}</small></span></span>`
        : `<span class="option-text"><span>${escapeHtml(option.label)}</span>${option.sub ? `<small>${escapeHtml(option.sub)}</small>` : ''}</span>`;
      return `<button type="button" class="option-btn${tone}" data-pending-value="${escapeHtml(option.value)}" ${index === 0 ? 'autofocus' : ''}>${playerInfo}</button>`;
    }).join('');

    $('pendingCard').innerHTML = `
      <div class="pending-kicker">SWTT · 待处理</div>
      <div class="pending-title">${escapeHtml(pending.title)}</div>
      <div class="pending-message">${escapeHtml(pending.message || '')}</div>
      ${image}
      <div class="pending-options${pending.options?.length === 2 ? ' stack' : ''}" id="pendingOptions">${options}</div>
      ${['roll', 'number'].includes(pending.type) ? '<button class="ghost-btn pending-map-btn" id="pendingMapBtn" type="button">查看地图</button>' : ''}
    `;
    $('pendingOptions').addEventListener('click', (event) => {
      const button = event.target.closest('[data-pending-value]');
      if (!button || app.pendingSubmitting) return;
      app.pendingSubmitting = true;
      $('pendingOptions').querySelectorAll('button').forEach((item) => { item.disabled = true; });
      app.socket.emit('pending:respond', { id: pending.id, value: button.dataset.pendingValue });
      setTimeout(() => { app.pendingSubmitting = false; }, 1200);
    });
    const mapButton = $('pendingMapBtn');
    if (mapButton) mapButton.addEventListener('click', hidePendingForMap);
    backdrop.classList.remove('hidden');
  }

  function renderEnd(state) {
    const overlay = $('endOverlay');
    if (state.status !== 'ended') {
      overlay.classList.add('hidden');
      return;
    }
    overlay.classList.remove('hidden');
    const pointsRows = state.pointsRankings || state.rankings || [];
    const trophyRows = state.trophyRankings || [];
    const pointLeader = pointsRows[0];
    const trophyLeader = trophyRows[0];
    const pointNames = pointLeader
      ? pointsRows.filter((row) => row.points === pointLeader.points).map((row) => row.name)
      : [];
    const trophyNames = trophyLeader
      ? trophyRows.filter((row) => (row.trophies || 0) === (trophyLeader.trophies || 0)).map((row) => row.name)
      : [];
    if (pointLeader || trophyLeader) {
      const parts = [];
      if (pointNames.length) parts.push(`积分榜第一：${pointNames.join('、')}`);
      if (trophyNames.length) parts.push(`奖牌榜第一：${trophyNames.join('、')}`);
      $('endTitle').textContent = parts.join(' · ');
    } else {
      $('endTitle').textContent = '比赛结束';
    }

    $('pointsRankList').innerHTML = pointsRows.map((row) => `
      <div class="rank-row${row.rank === 1 ? ' first' : ''}" title="现有积分 ${formatPoints(row.points)}">
        <div class="rank-no">${row.rank}</div>
        <img src="${escapeHtml(row.avatar)}" alt="${escapeHtml(row.name)}">
        <div class="rank-name">
          ${escapeHtml(row.name)}${row.eliminated ? '（退出）' : ''}
        </div>
        <div class="rank-score">
          <strong>${formatPoints(row.points)}</strong>
          <small>现有积分</small>
        </div>
      </div>
    `).join('');

    $('trophyRankList').innerHTML = trophyRows.map((row) => {
      const names = (row.trophyNames || [])
        .map((trophy) => `${escapeHtml(trophy.name)}${trophy.count > 1 ? ` ×${trophy.count}` : ''}`)
        .join('、');
      return `
        <div class="rank-row trophy-row${row.rank === 1 ? ' first' : ''}" title="奖杯数量 ${row.trophies || 0}">
          <div class="rank-no">${row.rank}</div>
          <img src="${escapeHtml(row.avatar)}" alt="${escapeHtml(row.name)}">
          <div class="rank-name">
            ${escapeHtml(row.name)}${row.eliminated ? '（退出）' : ''}
            <span class="rank-trophy-names">${names || '暂无奖杯'}</span>
          </div>
          <div class="rank-score">
            <strong>${row.trophies || 0}</strong>
            <small>个奖杯</small>
          </div>
        </div>
      `;
    }).join('');
  }

  function handleControlAction(event) {
    const button = event.target.closest('[data-action]');
    if (!button || button.disabled) return;
    const action = button.dataset.action;
    if (action === 'roll') {
      app.socket.emit('game:roll');
    } else if (action === 'end') {
      app.socket.emit('game:endTurn');
    } else if (action === 'borrow') {
      openBorrowModal();
    } else if (action === 'sell') {
      openSellModal();
    } else if (action === 'blade') {
      openBladeModal();
    } else if (action === 'divine') {
      openDivineModal();
    }
  }

  function handlePanelClick(event) {
    const cardButton = event.target.closest('[data-card-key]');
    if (cardButton) {
      openCharacterCard(cardButton.dataset.cardKey);
      return;
    }
    const divineButton = event.target.closest('[data-divine]');
    if (divineButton) {
      openDivineModal();
      return;
    }
    const button = event.target.closest('[data-item-uid]');
    if (!button) return;
    openItemCard(button.dataset.playerId, button.dataset.itemUid);
  }

  function startGame() {
    if (!app.state || app.state.status !== 'waiting') return;
    app.socket.emit('game:start');
  }

  function openRules() {
    openModal(`
      <div class="modal-title">规则手册</div>
      <div class="rules-scroll">
        <img src="/assets/rules/rule1.jpg" alt="规则手册 1">
        <img src="/assets/rules/rule2.jpg" alt="规则手册 2">
      </div>
      <div class="modal-actions">
        <button class="ghost-btn" data-close-modal type="button">关闭</button>
      </div>
    `, { locked: false });
  }

  function openItemCard(playerId, uid) {
    const state = app.state;
    const player = state?.players.find((p) => p.id === playerId);
    const item = player?.items.find((i) => i.uid === uid);
    const card = item ? cardByKey.get(item.key) : null;
    if (!player || !item || !card) {
      showToast('道具已不存在', 'error');
      return;
    }
    const mine = player.id === app.meId;
    const canUse = mine && state.turnPlayerId === app.meId && state.status === 'playing';
    openModal(`
      <div class="modal-title">${escapeHtml(card.name)}</div>
      <div class="modal-message">${escapeHtml(card.desc)}</div>
      <img class="item-card-image" src="${escapeHtml(card.image)}" alt="${escapeHtml(card.name)}">
      <div class="item-card-owner">持有者：${escapeHtml(player.name)}${mine ? '（你）' : ''}</div>
      <div class="modal-actions">
        <button class="ghost-btn" data-close-modal type="button">关闭</button>
        ${canUse ? '<button class="primary-btn" id="useItemBtn" type="button">使用</button>' : ''}
      </div>
    `);
    const useBtn = $('useItemBtn');
    if (useBtn) {
      useBtn.addEventListener('click', () => {
        closeModal();
        app.socket.emit('game:item', { uid });
      });
    }
  }

  function openCharacterCard(charKey) {
    const character = app.config?.characters?.find((c) => c.key === charKey);
    if (!character) return;
    const abilityLines = (character.ability || []).map((line) => `<li>${escapeHtml(line)}</li>`).join('');
    openModal(`
      <div class="modal-title">${escapeHtml(character.name)} · 角色卡</div>
      <img class="character-card-image" src="${escapeHtml(character.cardImage || character.avatar)}" alt="${escapeHtml(character.name)} 角色卡">
      ${abilityLines ? `<ul class="character-ability-list">${abilityLines}</ul>` : ''}
      <div class="modal-actions">
        <button class="ghost-btn" data-close-modal type="button">关闭</button>
      </div>
    `);
  }

  function openDivineModal() {
    const me = app.state?.players.find((player) => player.id === app.meId);
    if (!me || me.charKey !== 'tunlusi') {
      showToast('只有豚鲁斯可以发动神的旨意', 'error');
      return;
    }
    if (me.divineUsed) {
      showToast('神的旨意整局只能使用一次', 'error');
      return;
    }
    app.divineMinimized = false;
    openModal(`
      <div class="modal-title">神的旨意</div>
      <div class="modal-message">指定本人下一次骰子的点数，整局仅一次。</div>
      <div class="pending-options divine-options">
        ${[1, 2, 3, 4, 5, 6].map((n) => `<button type="button" class="option-btn" data-divine-value="${n}">${n} 点</button>`).join('')}
      </div>
      <div class="modal-actions">
        <button class="ghost-btn" id="divineMapBtn" type="button">查看地图</button>
        <button class="ghost-btn" data-close-modal type="button">取消</button>
      </div>
    `);
    $('divineMapBtn').addEventListener('click', () => {
      closeModal();
      app.divineMinimized = true;
      updateResumeAction();
    });
    $('modalCard').querySelectorAll('[data-divine-value]').forEach((button) => {
      button.addEventListener('click', () => {
        const value = Number(button.dataset.divineValue);
        app.divineMinimized = false;
        closeModal();
        app.socket.emit('game:divine', { value });
      });
    });
    updateResumeAction();
  }

  function toggleFullscreen() {
    const doc = document;
    const fsElement = doc.fullscreenElement || doc.webkitFullscreenElement;
    if (fsElement) {
      const exit = doc.exitFullscreen || doc.webkitExitFullscreen;
      if (exit) Promise.resolve(exit.call(doc)).catch(() => {});
      return;
    }
    const request =
      doc.documentElement.requestFullscreen || doc.documentElement.webkitRequestFullscreen;
    if (!request) {
      showToast('当前浏览器不支持全屏', 'error');
      return;
    }
    Promise.resolve(request.call(doc.documentElement)).catch(() => {
      showToast('无法进入全屏，请检查浏览器权限', 'error');
    });
  }

  function updateFullscreenButtons() {
    const active = Boolean(document.fullscreenElement || document.webkitFullscreenElement);
    document.querySelectorAll('.fullscreen-btn').forEach((button) => {
      button.textContent = active ? '退出全屏' : '全屏';
    });
  }

  function exitFullscreen() {
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (exit) Promise.resolve(exit.call(document)).catch(() => {});
  }

  function openModal(html, options = {}) {
    $('modalCard').innerHTML = html;
    $('modalBackdrop').classList.remove('hidden');
    app.modalLocked = Boolean(options.locked);
    $('modalCard').querySelectorAll('[data-close-modal]').forEach((button) => {
      button.addEventListener('click', closeModal);
    });
  }

  function closeModal() {
    $('modalBackdrop').classList.add('hidden');
    $('modalCard').innerHTML = '';
    app.modalLocked = false;
  }

  function confirmDialog(title, message, confirmLabel, onConfirm) {
    openModal(`
      <div class="modal-title">${escapeHtml(title)}</div>
      <div class="modal-message">${escapeHtml(message)}</div>
      <div class="modal-actions">
        <button class="ghost-btn" data-close-modal type="button">取消</button>
        <button class="primary-btn" id="confirmActionBtn" type="button">${escapeHtml(confirmLabel)}</button>
      </div>
    `);
    $('confirmActionBtn').addEventListener('click', () => {
      closeModal();
      onConfirm();
    });
  }

  function confirmLeave() {
    if (!app.state) {
      clearToLanding();
      return;
    }
    confirmDialog(
      '离开房间',
      app.state.status === 'playing' ? '离开后本局视为退出比赛。' : '确定要离开房间吗？',
      '离开',
      leaveRoom
    );
  }

  function leaveRoom() {
    if (!app.state) {
      clearToLanding();
      return;
    }
    app.socket.emit('room:leave');
    setTimeout(() => {
      forgetSession();
      clearToLanding();
    }, 350);
  }

  function confirmFinish() {
    if (!app.state || app.state.status !== 'playing') return;
    confirmDialog(
      '结束并结算',
      '按“持有积分 + 奖杯账面积分”综合排名，最高者获得世一头衔。',
      '结算',
      () => app.socket.emit('game:finish')
    );
  }

  function openBorrowModal() {
    const state = app.state;
    const me = state.players.find((player) => player.id === app.meId);
    const lenders = state.players.filter((player) => player.id !== app.meId && !player.eliminated);
    if (!lenders.length) {
      showToast('没有可借款的玩家', 'error');
      return;
    }
    openModal(`
      <div class="modal-title">借债</div>
      <div class="modal-message">与债主自由商定金额、利息和期限，到期强制归还。</div>
      <div class="form-grid">
        <div class="form-field full">
          <label for="loanLender">债主</label>
          <select id="loanLender">
            ${lenders.map((player) => `<option value="${escapeHtml(player.id)}">${escapeHtml(player.name)} · ${formatPoints(player.points)} 积分</option>`).join('')}
          </select>
        </div>
        <div class="form-field">
          <label for="loanAmount">借款积分</label>
          <input id="loanAmount" type="number" min="100" max="5000" step="50" value="500">
        </div>
        <div class="form-field">
          <label for="loanInterest">利息 %</label>
          <input id="loanInterest" type="number" min="0" max="100" step="1" value="10">
        </div>
        <div class="form-field">
          <label for="loanTerm">期限（回合）</label>
          <input id="loanTerm" type="number" min="1" max="5" step="1" value="2">
        </div>
        <div class="form-field">
          <label>你的积分</label>
          <input value="${formatPoints(me.points)}" disabled>
        </div>
      </div>
      <div class="modal-actions">
        <button class="ghost-btn" data-close-modal type="button">取消</button>
        <button class="primary-btn" id="submitLoanBtn" type="button">发送请求</button>
      </div>
    `);
    $('submitLoanBtn').addEventListener('click', () => {
      const lenderId = $('loanLender').value;
      const amount = Number($('loanAmount').value);
      const interest = Number($('loanInterest').value);
      const term = Number($('loanTerm').value);
      if (!Number.isFinite(amount) || amount < 100 || amount > 5000) {
        showToast('借款积分需在 100-5000 之间', 'error');
        return;
      }
      if (!Number.isFinite(interest) || interest < 0 || interest > 100) {
        showToast('利息需在 0-100% 之间', 'error');
        return;
      }
      if (!Number.isFinite(term) || term < 1 || term > 5) {
        showToast('期限需在 1-5 回合之间', 'error');
        return;
      }
      closeModal();
      app.socket.emit('game:borrow', { lenderId, amount, interest, term });
    });
  }

  function openSellModal() {
    const me = app.state.players.find((player) => player.id === app.meId);
    if (!me) return;
    if (!me.trophies.length) {
      showToast('你还没有可以卖出的奖杯', 'error');
      return;
    }
    openModal(`
      <div class="modal-title">卖房</div>
      <div class="modal-message">按该站当前奖杯数量 × 原始积分，再以 50% 一次性回收整站奖杯。</div>
      <div class="trophy-sell-list">
        ${me.trophies.map((trophy) => {
          const count = Math.max(1, trophy.streak || 1);
          const price = Math.floor((trophy.points * count) / 2);
          return `
            <div class="sell-row">
              <div>
                <strong>${escapeHtml(trophy.name)}</strong><br>
                <span>${trophy.points} 积分 × ${count}/3 个</span>
              </div>
              <button type="button" data-sell-tile="${trophy.tileId}">整站回收 +${price}</button>
            </div>
          `;
        }).join('')}
      </div>
      <div class="modal-actions">
        <button class="ghost-btn" data-close-modal type="button">关闭</button>
      </div>
    `);
    $('modalCard').querySelectorAll('[data-sell-tile]').forEach((button) => {
      button.addEventListener('click', () => {
        const tileId = Number(button.dataset.sellTile);
        closeModal();
        app.socket.emit('game:sell', { tileId });
      });
    });
  }

  function openBladeModal() {
    const state = app.state;
    const me = state.players.find((player) => player.id === app.meId);
    const targets = state.players.filter(
      (player) => player.id !== app.meId && !player.eliminated && player.pos === me.pos
    );
    if (!targets.length) {
      showToast('同一格没有其他玩家', 'error');
      return;
    }
    openModal(`
      <div class="modal-title">拼刺刀</div>
      <div class="modal-message">双方各掷一次骰子，点数小者支付点数大者 300 积分。需要对方同意。</div>
      <div class="pending-options" id="bladeTargets">
        ${targets.map((player) => `
          <button type="button" class="option-btn" data-blade-target="${escapeHtml(player.id)}">
            <span class="option-player">
              <img src="${escapeHtml(player.avatar)}" alt="">
              <span>${escapeHtml(player.name)}<small>${player.points} 积分</small></span>
            </span>
          </button>
        `).join('')}
      </div>
      <div class="modal-actions">
        <button class="ghost-btn" data-close-modal type="button">取消</button>
      </div>
    `);
    $('bladeTargets').addEventListener('click', (event) => {
      const button = event.target.closest('[data-blade-target]');
      if (!button) return;
      const targetId = button.dataset.bladeTarget;
      closeModal();
      app.socket.emit('game:blade', { targetId });
    });
  }

  init();
})();
