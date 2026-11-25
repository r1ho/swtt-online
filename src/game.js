'use strict';

const crypto = require('crypto');
const {
  CHARACTERS,
  TILES,
  CARDS,
  CARD_BY_KEY,
  PERSISTENT,
  BOARD_SIZE,
  INITIAL_POINTS,
  MAX_PLAYERS,
} = require('./config');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CHARACTER_BY_KEY = Object.fromEntries(CHARACTERS.map((c) => [c.key, c]));
const TILE_BY_ID = Object.fromEntries(TILES.map((t) => [t.id, t]));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => Date.now();

function randomInt(min, max) {
  return crypto.randomInt(min, max + 1);
}

function makeId(bytes = 12) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function shuffle(list) {
  const arr = [...list];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(0, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function circularDistance(a, b) {
  const d = Math.abs(a - b);
  return Math.min(d, BOARD_SIZE - d);
}

function normalizeCode(code) {
  return String(code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

class GameError extends Error {}

class Room {
  constructor(code, io, character) {
    this.code = code;
    this.io = io;
    this.createdAt = now();
    this.status = 'waiting';
    const host = this.makePlayer(character);
    this.hostId = host.id;
    this.players = [host];
    this.turnIndex = 0;
    this.round = 1;
    this.phase = 'waiting';
    this.pending = null;
    this._pendingResolve = null;
    this.lastDice = null;
    this.lastMove = null;
    this.lastEffect = null;
    this.winnerIds = [];
    this.logs = [];
    this.loans = [];
    this.decks = { chance: [], fate: [], item: [] };
    this.bladeUsed = false;
    this.activeBonds = new Set();
    this.seq = 0;
    this.log(`${host.name} 创建了房间`, 'system');
  }

  nextSeq() {
    this.seq += 1;
    return this.seq;
  }

  log(text, tone = 'info', playerId = null) {
    this.logs.push({
      id: makeId(6),
      text,
      tone,
      playerId,
      at: now(),
    });
    if (this.logs.length > 80) this.logs.splice(0, this.logs.length - 80);
  }

  effectLog(player, title, text, tone = 'info') {
    this.lastEffect = {
      id: makeId(6),
      playerId: player ? player.id : null,
      title,
      text,
      tone,
      at: now(),
    };
    this.log(`${player ? `${player.name} · ` : ''}${title}：${text}`, tone, player ? player.id : null);
  }

  get current() {
    return this.players[this.turnIndex] || null;
  }

  get alivePlayers() {
    return this.players.filter((p) => !p.eliminated);
  }

  netWorth(player) {
    const trophyValue = player.trophies.reduce((sum, trophy) => {
      const tile = TILE_BY_ID[trophy.tileId];
      return sum + (tile ? tile.points * (trophy.streak || 1) : 0);
    }, 0);
    return player.points + trophyValue;
  }

  trophyValue(player) {
    return player.trophies.reduce((sum, trophy) => {
      const tile = TILE_BY_ID[trophy.tileId];
      return sum + (tile ? tile.points * (trophy.streak || 1) : 0);
    }, 0);
  }

  playerById(id) {
    return this.players.find((p) => p.id === id) || null;
  }

  playerByToken(token) {
    return this.players.find((p) => p.token === token) || null;
  }

  isFull() {
    return this.players.length >= MAX_PLAYERS;
  }

  usedCharacters() {
    return new Set(this.players.map((p) => p.charKey));
  }

  addPlayer(character) {
    if (this.status !== 'waiting') throw new GameError('游戏已经开始');
    if (this.isFull()) throw new GameError('房间已满');
    if (this.usedCharacters().has(character.key)) throw new GameError('该角色已被选择');
    const player = this.makePlayer(character);
    this.players.push(player);
    this.hostId = this.hostId || player.id;
    this.log(`${player.name} 加入了房间`, 'system');
    return player;
  }

  makePlayer(character) {
    return {
      id: makeId(10),
      token: makeId(24),
      charKey: character.key,
      name: character.name,
      avatar: character.avatar,
      color: character.color,
      gender: character.gender,
      country: character.country,
      language: character.language,
      pos: 0,
      points: INITIAL_POINTS,
      trophies: [],
      items: [],
      effects: { pingshu: false, michelin: false, blame: false },
      skipTurns: 0,
      eliminated: false,
      online: true,
      joinedAt: now(),
      jinNaiPasses: 0,
      turnsTaken: 0,
      divineUsed: false,
      divineValue: null,
      lastLandedTileId: null,
    };
  }

  restorePlayer(token) {
    const player = this.playerByToken(token);
    if (!player) throw new GameError('找不到原座位');
    return player;
  }

  start(hostId) {
    if (this.status !== 'waiting') throw new GameError('游戏已经开始');
    if (hostId !== this.hostId) throw new GameError('只有房主可以开始');
    const onlinePlayers = this.players.filter((p) => p.online);
    if (onlinePlayers.length < 2) throw new GameError('至少需要两名在线玩家');
    this.players = this.players.filter((p) => p.online);
    if (this.players[0]?.id !== this.hostId) {
      this.turnIndex = Math.max(0, this.players.findIndex((p) => p.id === this.hostId));
    } else {
      this.turnIndex = 0;
    }
    this.status = 'playing';
    this.phase = 'awaitRoll';
    this.round = 1;
    this.activeBonds.clear();
    this.decks = {
      chance: shuffle(CARDS.chance.map((c) => c.key)),
      fate: shuffle(CARDS.fate.map((c) => c.key)),
      item: shuffle(CARDS.item.map((c) => c.key)),
    };
    this.log('比赛开始，每位选手初始 2000 积分', 'system');
    this.broadcast();
  }

  publicPlayer(player) {
    const character = CHARACTERS.find((c) => c.key === player.charKey);
    return {
      id: player.id,
      charKey: player.charKey,
      name: player.name,
      avatar: player.avatar,
      color: player.color,
      gender: player.gender,
      country: player.country,
      language: player.language,
      cardImage: character?.cardImage || null,
      homeTile: character?.homeTile ?? null,
      ability: character?.ability || [],
      divineUsed: Boolean(player.divineUsed),
      divineValue: player.divineValue ?? null,
      pos: player.pos,
      points: player.points,
      trophies: player.trophies.map((t) => ({ ...t })),
      items: player.items.map((i) => ({ ...i })),
      effects: Object.keys(player.effects)
        .filter((key) => player.effects[key])
        .map((key) => ({ ...PERSISTENT[key] })),
      skipTurns: player.skipTurns,
      eliminated: player.eliminated,
      online: player.online,
      isHost: player.id === this.hostId,
      jinNaiPasses: player.jinNaiPasses,
      loanCount: this.loans.filter(
        (l) => l.status === 'active' && (l.borrowerId === player.id || l.lenderId === player.id)
      ).length,
      characterColor: character?.color || player.color,
    };
  }

  publicState() {
    return {
      code: this.code,
      status: this.status,
      hostId: this.hostId,
      turnPlayerId: this.current?.id || null,
      round: this.round,
      phase: this.phase,
      players: this.players.map((p) => this.publicPlayer(p)),
      pending: this.pending
        ? {
            id: this.pending.id,
            playerId: this.pending.playerId,
            type: this.pending.type,
            title: this.pending.title,
            message: this.pending.message,
            image: this.pending.image || null,
            options: this.pending.options || [],
            meta: this.pending.meta || null,
          }
        : null,
      lastDice: this.lastDice,
      lastMove: this.lastMove,
      lastEffect: this.lastEffect,
      winnerIds: this.winnerIds,
      rankings: this.status === 'ended' ? this.rankings() : null,
      logs: this.logs.slice(-40),
      loans: this.loans.map((l) => ({ ...l })),
      bladeUsed: this.bladeUsed,
    };
  }

  syncPlayerOnline(playerId, online) {
    const player = this.playerById(playerId);
    if (!player) return;
    player.online = online;
    if (this.status === 'waiting') {
      if (!online && player.id === this.hostId) {
        const next = this.players.find((p) => p.id !== playerId && p.online);
        if (next) {
          this.hostId = next.id;
          this.log(`${next.name} 成为新房主`, 'system');
        }
      }
    }
    this.broadcast();
  }

  broadcast() {
    if (!this.io) return;
    this.io.to(this.code).emit('room:state', this.publicState());
  }

  allCharacters() {
    const taken = this.usedCharacters();
    return CHARACTERS.map((c) => ({ ...c, taken: taken.has(c.key) }));
  }

  availableCharacters() {
    const taken = this.usedCharacters();
    return CHARACTERS.filter((c) => !taken.has(c.key));
  }

  async ask(playerId, spec) {
    if (this.pending) {
      throw new GameError('当前还有待处理的操作');
    }
    const id = makeId(6);
    const promise = new Promise((resolve) => {
      this._pendingResolve = resolve;
    });
    this.pending = { id, playerId, ...spec };
    this.broadcast();
    return promise;
  }

  respond(playerId, pendingId, value) {
    if (!this.pending) throw new GameError('当前没有待处理的操作');
    if (this.pending.id !== pendingId) throw new GameError('操作已失效');
    if (this.pending.playerId !== playerId) throw new GameError('不是你的操作');
    const resolve = this._pendingResolve;
    this.pending = null;
    this._pendingResolve = null;
    this.broadcast();
    if (resolve) resolve(value);
  }

  cancelPending() {
    if (!this.pending) return;
    const resolve = this._pendingResolve;
    this.pending = null;
    this._pendingResolve = null;
    if (resolve) resolve(null);
  }

  ensureTurn(playerId) {
    if (this.status !== 'playing') throw new GameError('游戏未在进行中');
    if (this.pending) throw new GameError('请先完成当前操作');
    if (!this.current || this.current.id !== playerId) throw new GameError('还没轮到你');
    if (this.current.eliminated) throw new GameError('你已退出比赛');
  }

  rollDie(player, purpose, options = {}) {
    let value;
    let divine = false;
    if (
      player.charKey === 'tunlusi' &&
      Number.isInteger(player.divineValue) &&
      player.divineValue >= 1 &&
      player.divineValue <= 6
    ) {
      value = player.divineValue;
      player.divineValue = null;
      divine = true;
      this.log(`${player.name} 发动「神的旨意」，指定点数 ${value}`, 'roll', player.id);
    } else {
      value = randomInt(1, 6);
    }

    if (player.charKey === 'yunshuimu' && player.points <= 2500 && !player.eliminated) {
      const gain = value * 10;
      player.points += gain;
      this.effectLog(player, '蛰伏', `掷出 ${value}，积分 +${gain}`, 'gain');
    }

    this.lastDice = {
      seq: this.nextSeq(),
      playerId: player.id,
      value,
      purpose,
      byName: player.name,
      divine,
    };
    return value;
  }

  async roll(playerId) {
    this.ensureTurn(playerId);
    if (this.phase !== 'awaitRoll') throw new GameError('现在不能掷骰子');
    const player = this.current;
    this.phase = 'rolling';
    this.bladeUsed = false;
    this.broadcast();

    let value = this.rollDie(player, '移动', { movement: true });
    let rerolls = 0;
    while (
      value === 1 &&
      (player.charKey === 'aolikeyou' || player.charKey === 'feilikeyou') &&
      rerolls < 20
    ) {
      rerolls += 1;
      this.log(`${player.name} 急脾气：掷出 1，需要手动重新投掷`, 'roll', player.id);
      await this.ask(player.id, {
        type: 'roll',
        title: '急脾气 · 重新投掷',
        message: '你掷出了 1。请手动点击下方按钮重新投掷。',
        options: [{ value: 'roll', label: '重新掷骰', tone: 'primary' }],
      });
      if (this.status !== 'playing' || player.eliminated) return;
      value = this.rollDie(player, '移动', { movement: true });
    }
    this.log(`${player.name} 掷出了 ${value} 点`, 'roll', playerId);
    this.broadcast();
    await sleep(420);

    const from = player.pos;
    const path = [];
    for (let i = 0; i < value; i += 1) {
      player.pos = (player.pos + 1) % BOARD_SIZE;
      path.push(player.pos);
    }
    this.lastMove = {
      seq: this.nextSeq(),
      playerId,
      from,
      to: player.pos,
      path,
    };
    this.phase = 'resolving';
    this.broadcast();
    await sleep(480);

    // 路过训练场的结算（金奈只在到达时触发）
    for (const pos of path) {
      if (this.status !== 'playing' || player.eliminated) break;
      const tile = TILES[pos];
      if (tile.kind === 'training') {
        player.points += 1000;
        this.effectLog(player, '训练场', '经过训练场，积分 +1000', 'gain');
      }
    }
    this.broadcast();
    await sleep(250);

    if (this.status === 'playing' && !player.eliminated) {
      await this.resolveLanding(player, 0);
    }

    if (this.status === 'playing') {
      if (this.current?.eliminated || !this.current || this.current.id !== playerId) {
        await this.finishTurnAfterElimination();
      } else {
        this.phase = 'action';
        this.broadcast();
      }
    }
  }

  async applyJinNai(player) {
    player.jinNaiPasses += 1;
    const nth = player.jinNaiPasses;
    if (nth > 2) return;
    const amount = nth === 1 ? 100 : 50;
    const paid = await this.charge(player, amount, {
      reason: nth === 1 ? '第一次到达金奈' : '第二次到达金奈',
      allowFanshen: false,
    });
    if (paid > 0) {
      this.effectLog(player, '金奈', `第 ${nth} 次到达，积分 -${amount}`, 'loss');
    } else {
      this.effectLog(player, '金奈', `第 ${nth} 次到达，惩罚已免除`, 'info');
    }
  }

  async finishTurnAfterElimination() {
    if (this.status !== 'playing') return;
    this.phase = 'ending';
    this.broadcast();
    await sleep(300);
    await this.advanceTurn();
  }

  async advanceTurn() {
    if (this.status !== 'playing') return;
    const total = this.players.length;
    if (total === 0) return;
    let guard = 0;
    while (guard < total * 4) {
      guard += 1;
      this.turnIndex = (this.turnIndex + 1) % total;
      if (this.turnIndex === 0) this.round += 1;
      const candidate = this.players[this.turnIndex];
      if (!candidate || candidate.eliminated) continue;
      if (candidate.skipTurns > 0) {
        candidate.skipTurns -= 1;
        this.phase = 'skipped';
        this.log(`${candidate.name} 在理发店暂停一回合`, 'info', candidate.id);
        this.broadcast();
        await sleep(700);
        continue;
      }
      this.phase = 'awaitRoll';
      this.lastMove = null;
      this.lastDice = null;
      this.bladeUsed = false;
      candidate.turnsTaken += 1;
      this.broadcast();
      return;
    }
    // 理论上只剩一名玩家时已经结束，这里兜底
    this.checkGameEnd();
  }

  async endTurn(playerId) {
    this.ensureTurn(playerId);
    if (this.phase !== 'action') throw new GameError('现在还不能结束回合');
    const player = this.current;
    this.phase = 'ending';
    this.broadcast();
    await this.settleLoansFor(player);
    if (this.status !== 'playing') return;
    if (this.current?.eliminated) {
      await this.advanceTurn();
      return;
    }
    await sleep(180);
    await this.advanceTurn();
  }

  async settleLoansFor(player) {
    const loans = this.loans.filter(
      (l) => l.status === 'active' && l.borrowerId === player.id && this.round >= l.dueRound
    );
    for (const loan of loans) {
      if (this.status !== 'playing' || player.eliminated) return;
      const lender = this.playerById(loan.lenderId);
      if (!lender || lender.eliminated) {
        loan.status = 'closed';
        this.log(`与 ${lender ? lender.name : '未知玩家'} 的借债已失效`, 'info');
        continue;
      }
      const total = Math.ceil(loan.principal * (1 + loan.interest / 100));
      player.points -= total;
      lender.points += total;
      loan.status = 'closed';
      loan.paid = total;
      this.effectLog(
        player,
        '借债到期',
        `${lender.name} 收回 ${total} 积分`,
        'loss'
      );
      this.broadcast();
      await this.normalizeFinances(player);
      if (this.status !== 'playing' || player.eliminated) return;
      await sleep(250);
    }
  }

  trophySaleValue(trophy) {
    const tile = TILE_BY_ID[trophy.tileId];
    if (!tile) return 0;
    return Math.floor((tile.points * (trophy.streak || 1)) / 2);
  }

  sellTrophyInternal(player, trophy, forced = false) {
    const index = player.trophies.findIndex((t) => t.tileId === trophy.tileId);
    if (index < 0) return 0;
    const tile = TILE_BY_ID[trophy.tileId];
    const count = Math.max(1, trophy.streak || 1);
    const price = Math.floor((tile.points * count) / 2);
    player.trophies.splice(index, 1);
    player.points += price;
    this.effectLog(
      player,
      forced ? '强制回收奖杯' : '卖房',
      `${tile.name} 的 ${count} 个奖杯一起回收，获得 ${price} 积分`,
      'info'
    );
    return price;
  }

  async askInsolvencyLoan(player) {
    const lenders = this.alivePlayers.filter(
      (p) => p.id !== player.id && p.points > 0 && p.online
    );
    if (!lenders.length) {
      this.log('没有其他在线玩家可以借款', 'info', player.id);
      return false;
    }
    const minAmount = 100;
    const form = await this.ask(player.id, {
      type: 'loanForm',
      title: '借积分',
      message: `当前积分 ${player.points}，请选择债主和借款条件。`,
      options: [],
      meta: { minAmount, maxAmount: 5000, playerPoints: player.points },
    });
    if (!form || typeof form !== 'object') return false;
    const lender = this.playerById(form.lenderId);
    const amount = Math.round(Number(form.amount));
    const interest = Math.round(Number(form.interest));
    const term = Math.round(Number(form.term));
    if (!lender || lender.eliminated || lender.id === player.id || !lender.online) {
      this.log('借款条件无效：债主不可用', 'info', player.id);
      return false;
    }
    if (!Number.isFinite(amount) || amount < 100 || amount > 5000) {
      this.log('借款条件无效：金额需在 100-5000 之间', 'info', player.id);
      return false;
    }
    if (!Number.isFinite(interest) || interest < 0 || interest > 100) {
      this.log('借款条件无效：利息需在 0-100% 之间', 'info', player.id);
      return false;
    }
    if (!Number.isFinite(term) || term < 1 || term > 5) {
      this.log('借款条件无效：期限需在 1-5 回合之间', 'info', player.id);
      return false;
    }
    if (lender.points < amount) {
      this.log('借款条件无效：债主积分不足', 'info', player.id);
      return false;
    }
    const accept = await this.ask(lender.id, {
      type: 'loan',
      title: '借债请求',
      message: `${player.name} 积分不足，向你借款 ${amount} 积分，利息 ${interest}%，期限 ${term} 回合。`,
      options: [
        { value: 'yes', label: '接受', tone: 'primary' },
        { value: 'no', label: '拒绝' },
      ],
      meta: { amount, interest, term, borrowerId: player.id, lenderId: lender.id },
    });
    if (accept !== 'yes') {
      this.log(`${lender.name} 拒绝了 ${player.name} 的借债`, 'info', lender.id);
      return false;
    }
    if (lender.points < amount) {
      this.log('债主积分已不足，借款失败', 'info', player.id);
      return false;
    }
    lender.points -= amount;
    player.points += amount;
    this.loans.push({
      id: makeId(6),
      borrowerId: player.id,
      lenderId: lender.id,
      principal: amount,
      interest,
      dueRound: this.round + term,
      createdRound: this.round,
      status: 'active',
      paid: 0,
    });
    this.effectLog(
      player,
      '借债',
      `向 ${lender.name} 借入 ${amount} 积分，${term} 回合后还 ${Math.ceil(amount * (1 + interest / 100))}`,
      'info'
    );
    this.broadcast();
    return true;
  }

  async normalizeFinances(player) {
    if (!player || player.eliminated || this.status !== 'playing') return;
    let guard = 0;
    while (this.status === 'playing' && !player.eliminated && player.points <= 0 && guard < 20) {
      guard += 1;
      const lenders = this.alivePlayers.filter(
        (p) => p.id !== player.id && p.points > 0 && p.online
      );
      const options = [];
      if (lenders.length > 0) {
        options.push({ value: 'borrow', label: '借积分', tone: 'primary' });
      }
      if (player.trophies.length > 0) {
        options.push({ value: 'sell', label: '卖出奖杯' });
      }
      options.push({ value: 'giveup', label: '接受淘汰', tone: 'danger' });

      const choice = await this.ask(player.id, {
        type: 'insolvency',
        title: '积分不足',
        message: `当前持有 ${player.points} 积分。请先借积分，或卖出奖杯使积分回到正数；否则将被淘汰。`,
        options,
      });

      if (choice === 'borrow') {
        const ok = await this.askInsolvencyLoan(player);
        if (!ok) continue;
        if (player.points > 0) break;
        continue;
      }

      if (choice === 'sell') {
        if (player.trophies.length === 0) continue;
        const sellOptions = player.trophies.map((trophy) => ({
          value: String(trophy.tileId),
          label: trophy.name,
          sub: `回收 +${this.trophySaleValue(trophy)}`,
        }));
        const tileId = await this.ask(player.id, {
          type: 'sellChoice',
          title: '选择卖出奖杯',
          message: '请选择要卖给 SWTT 的奖杯，回收价为账面价值的一半。',
          options: sellOptions,
        });
        const trophy = player.trophies.find((t) => t.tileId === Number(tileId));
        if (trophy) {
          this.sellTrophyInternal(player, trophy, false);
          this.broadcast();
        }
        continue;
      }

      if (choice === 'giveup') {
        this.eliminate(player);
        break;
      }
    }
    if (player.points <= 0 && !player.eliminated) {
      this.eliminate(player);
    }
    this.checkGameEnd();
    if (
      this.status === 'playing' &&
      !player.eliminated &&
      player.points > 0 &&
      this.current?.id === player.id &&
      this.phase === 'action' &&
      !this.pending
    ) {
      await this.recheckPurchase(player);
    }
  }

  eliminate(player) {
    if (player.eliminated) return;
    player.eliminated = true;
    player.skipTurns = 0;
    player.effects = { pingshu: false, michelin: false, blame: false };
    player.items = [];
    player.trophies = [];
    player.divineValue = null;
    this.activeBonds.clear();
    this.log(`${player.name} 积分≤0，退出世排`, 'danger', player.id);
    for (const loan of this.loans) {
      if (loan.status === 'active' && (loan.borrowerId === player.id || loan.lenderId === player.id)) {
        loan.status = 'defaulted';
      }
    }
  }

  checkGameEnd() {
    if (this.status !== 'playing') return;
    const alive = this.alivePlayers;
    if (alive.length <= 1) {
      this.finish(alive.map((p) => p.id), alive.length === 1 ? '最后一名选手' : '全员退出');
    }
  }

  rankings() {
    const units = (p) => p.trophies.reduce((sum, t) => sum + (t.streak || 1), 0);
    return [...this.players]
      .sort((a, b) => {
        if (a.eliminated !== b.eliminated) return a.eliminated ? 1 : -1;
        const netDiff = this.netWorth(b) - this.netWorth(a);
        if (netDiff !== 0) return netDiff;
        if (b.points !== a.points) return b.points - a.points;
        return units(b) - units(a);
      })
      .map((p, index) => ({
        rank: index + 1,
        id: p.id,
        name: p.name,
        avatar: p.avatar,
        points: p.points,
        trophyValue: this.trophyValue(p),
        netWorth: this.netWorth(p),
        trophies: units(p),
        eliminated: p.eliminated,
      }));
  }

  finish(winnerIds, reason = '结算') {
    if (this.status === 'ended') return;
    this.status = 'ended';
    this.phase = 'ended';
    this.pending = null;
    if (this._pendingResolve) {
      const resolve = this._pendingResolve;
      this._pendingResolve = null;
      resolve(null);
    }
    const unique = [...new Set(winnerIds)];
    this.winnerIds = unique;
    const names = unique.map((id) => this.playerById(id)?.name).filter(Boolean).join('、');
    this.log(`${reason}：${names || '无人'} 获得世一头衔`, 'win');
    this.broadcast();
  }

  finishByHost(playerId) {
    if (playerId !== this.hostId) throw new GameError('只有房主可以结算');
    if (this.status !== 'playing') throw new GameError('游戏未在进行中');
    const ranked = this.rankings();
    const top = ranked.length ? ranked[0].netWorth : 0;
    const winners = ranked.filter((r) => r.netWorth === top).map((r) => r.id);
    this.lastEffect = {
      id: makeId(6),
      playerId: null,
      title: '比赛结算',
      text: '按“持有积分 + 奖杯账面积分”综合排名',
      tone: 'win',
      at: now(),
    };
    this.finish(winners, '房主结算');
  }

  async resolveArrivalSpecial(player) {
    if (this.status !== 'playing' || player.eliminated) return;
    const tile = TILES[player.pos];
    if (tile.kind === 'training') {
      player.points += 1000;
      this.effectLog(player, '训练场', '到达训练场，积分 +1000', 'gain');
      this.broadcast();
    }
  }

  async offerPurchase(player, tile) {
    if (this.status !== 'playing' || player.eliminated) return false;
    if (player.points < tile.points) {
      this.log(`${player.name} 积分不足，无法兑换 ${tile.name} 奖杯`, 'info', player.id);
      return false;
    }
    const answer = await this.ask(player.id, {
      type: 'buy',
      title: tile.name,
      message: `花费 ${tile.points} 积分兑换本站第 1 个奖杯？（每站上限 3 个）`,
      image: null,
      options: [
        { value: 'yes', label: '兑换奖杯', tone: 'primary' },
        { value: 'no', label: '放弃' },
      ],
    });
    if (answer !== 'yes') {
      this.log(`${player.name} 放弃兑换 ${tile.name} 奖杯`, 'info', player.id);
      return false;
    }
    player.points -= tile.points;
    player.trophies.push({
      tileId: tile.id,
      name: tile.name,
      short: tile.short,
      points: tile.points,
      streak: 1,
    });
    this.effectLog(player, '夺得奖杯', `${tile.name} · 花费 ${tile.points} 积分`, 'gain');
    this.broadcast();
    await this.normalizeFinances(player);
    return true;
  }

  async recheckPurchase(player) {
    if (this.status !== 'playing' || player.eliminated || this.pending) return false;
    if (this.current?.id !== player.id || this.phase !== 'action') return false;
    const tile = TILE_BY_ID[player.lastLandedTileId];
    if (!tile || tile.kind !== 'tournament' || tile.noPurchase) return false;
    if (player.pos !== tile.id) return false;
    const owner = this.players.find(
      (p) => p.trophies.some((t) => t.tileId === tile.id) && !p.eliminated
    );
    if (owner) return false;
    if (player.points < tile.points) return false;
    return this.offerPurchase(player, tile);
  }

  async resolveLanding(player, depth = 0) {
    if (this.status !== 'playing' || player.eliminated) return;
    if (depth > 5) {
      this.log('连续触发次数过多，本次地点效果结束', 'info');
      return;
    }
    const tile = TILES[player.pos];
    const character = CHARACTER_BY_KEY[player.charKey];
    player.lastLandedTileId = tile.id;

    // 角色主场优势
    if (character?.homeTile === tile.id && tile.kind === 'tournament') {
      player.points += 250;
      this.effectLog(player, '主场优势', `到达${tile.short}，积分 +250`, 'gain');
    }

    // 金奈：只在到达时计算第一次/第二次
    if (tile.special === 'jinNai') {
      await this.applyJinNai(player);
      if (this.status !== 'playing' || player.eliminated) return;
    }

    // 持续效果：米其林（仅具体赛事地，特殊格子不加分）
    if (player.effects.michelin) {
      if (tile.special === 'jinNai') {
        player.effects.michelin = false;
        this.effectLog(player, '米其林', '到达金奈后拉肚子，此卡不再生效', 'loss');
      } else if (tile.kind === 'tournament') {
        player.points += 20;
        this.effectLog(player, '米其林', `到达${tile.short}，积分 +20`, 'gain');
      }
    }

    // 持续效果：乒超
    if (player.effects.pingshu && tile.region === '中国大陆') {
      const value = await this.rollEffect(player, '乒超');
      if (value === 6) {
        player.effects.pingshu = false;
        this.effectLog(player, '乒超', '掷出 6，水平过高不允许参赛，此卡不再生效', 'loss');
      } else {
        const gain = value * 10;
        player.points += gain;
        this.effectLog(player, '乒超', `掷出 ${value}，积分 +${gain}`, 'gain');
      }
      this.broadcast();
    }

    // 成都混团世界杯 / 伦敦世乒赛团体：到达后重新掷骰，点数×100
    if (tile.special === 'diceBonus') {
      const value = await this.rollEffect(player, tile.short);
      const gain = value * 100;
      player.points += gain;
      this.effectLog(player, '掷骰加分', `${tile.short} 掷出 ${value}，积分 +${gain}`, 'gain');
      this.broadcast();
    }

    if (this.status !== 'playing' || player.eliminated) return;

    if (tile.kind === 'tournament' && !tile.noPurchase) {
      const owner = this.players.find((p) =>
        p.trophies.some((t) => t.tileId === tile.id) && !p.eliminated
      );
      if (!owner) {
        await this.offerPurchase(player, tile);
      } else if (owner.id === player.id) {
        const trophy = owner.trophies.find((t) => t.tileId === tile.id);
        if (trophy.streak < 3 && player.points >= tile.points) {
          const answer = await this.ask(player.id, {
            type: 'defend',
            title: `${tile.name} · 连冠`,
            message: `再次兑换本站第 ${trophy.streak + 1} 个奖杯，花费 ${tile.points} 积分，达到 ${trophy.streak + 1}/3？`,
            options: [
              { value: 'yes', label: `兑换第 ${trophy.streak + 1} 个`, tone: 'primary' },
              { value: 'no', label: '放弃' },
            ],
          });
          if (answer === 'yes') {
            player.points -= tile.points;
            trophy.streak += 1;
            this.effectLog(
              player,
              '连冠',
              `${tile.name} 奖杯达到 ${trophy.streak}/3`,
              'gain'
            );
            await this.normalizeFinances(player);
          }
        } else if (trophy.streak >= 3) {
          this.log(`${tile.name} 已达 3 个奖杯上限，无法继续兑换`, 'info', player.id);
        } else {
          this.log(`${player.name} 积分不足，无法卫冕 ${tile.name}`, 'info', player.id);
        }
      } else {
        const aliveCount = Math.max(1, this.alivePlayers.length);
        const trophy = owner.trophies.find((t) => t.tileId === tile.id);
        const trophyCount = Math.max(1, trophy?.streak || 1);
        let rent = Math.max(1, Math.round((tile.points * trophyCount) / aliveCount));
        const halfRent =
          (player.charKey === 'zhangbenzhiyao' && owner.charKey === 'zhangbenmeiyao') ||
          (player.charKey === 'zhangbenmeiyao' && owner.charKey === 'zhangbenzhiyao');
        if (halfRent) {
          rent = Math.max(1, Math.round(rent / 2));
          this.effectLog(player, '人物羁绊', `到达${owner.name}的地产，只支付一半过路费`, 'info');
        }
        this.log(
          `${player.name} 到达 ${owner.name} 的 ${tile.name}（${trophyCount}/3），需支付 ${rent} 积分`,
          'info',
          player.id
        );
        await this.charge(player, rent, {
          reason: `${tile.name} 过路费`,
          recipient: owner,
          owner,
          allowFanshen: true,
        });
        if (!player.eliminated && !owner.eliminated) {
          this.log(
            `${tile.name} 过路费 ${rent} 积分已结算`,
            'transfer',
            player.id
          );
        }
      }
    } else if (tile.kind === 'chance') {
      await this.drawCard(player, 'chance', depth);
    } else if (tile.kind === 'fate') {
      await this.drawCard(player, 'fate', depth);
    } else if (tile.kind === 'barber') {
      if (player.charKey === 'yunshuimu') {
        this.effectLog(player, '理发店', '丑发型：免除暂停惩罚', 'gain');
      } else {
        player.skipTurns += 1;
        this.effectLog(player, '理发店', '下一回合暂停一次', 'info');
      }
    } else if (tile.kind === 'gym') {
      player.points += 500;
      this.effectLog(player, '健身房', '到达健身房，积分 +500', 'gain');
    } else if (tile.kind === 'sponsor') {
      await this.drawItem(player);
    }

    if (this.status === 'playing' && !player.eliminated) {
      await this.resolveCharacterBonds(player, depth);
    }
    this.broadcast();
  }

  async resolveCharacterBonds(mover, depth = 0) {
    if (this.status !== 'playing' || mover.eliminated || depth > 4) return;
    const pairs = [
      ['yunshuimu', 'zhangbenzhiyao', 'both200'],
      ['yunshuimu', 'zhangbenmeiyao', 'pay200'],
      ['yunshuimu', 'tunlusi', 'moveTun'],
      ['aolikeyou', 'feilikeyou', 'both200'],
      ['yuguogui', 'bulugui', 'both200'],
    ];

    for (const [aKey, bKey, kind] of pairs) {
      if (mover.charKey !== aKey && mover.charKey !== bKey) continue;
      const a = this.players.find((p) => p.charKey === aKey && !p.eliminated);
      const b = this.players.find((p) => p.charKey === bKey && !p.eliminated);
      const key = [aKey, bKey].sort().join('|');
      if (!a || !b || a.pos !== b.pos) {
        this.activeBonds.delete(key);
        continue;
      }
      if (this.activeBonds.has(key)) continue;
      this.activeBonds.add(key);

      if (kind === 'both200') {
        a.points += 200;
        b.points += 200;
        this.effectLog(
          mover,
          '人物羁绊',
          `${a.name} 与 ${b.name} 同格，双方积分 +200`,
          'gain'
        );
        this.broadcast();
        continue;
      }

      if (kind === 'pay200') {
        const yun = a.charKey === 'yunshuimu' ? a : b;
        const mei = a.charKey === 'zhangbenmeiyao' ? a : b;
        await this.charge(yun, 200, {
          reason: '与张本美鳐同格',
          recipient: mei,
          allowFanshen: false,
        });
        this.effectLog(
          yun,
          '人物羁绊',
          `${yun.name} 与 ${mei.name} 同格，支付 ${mei.name} 200 积分`,
          'loss'
        );
        this.broadcast();
        if (this.status !== 'playing' || mover.eliminated) return;
        continue;
      }

      if (kind === 'moveTun') {
        const yun = a.charKey === 'yunshuimu' ? a : b;
        const tun = a.charKey === 'tunlusi' ? a : b;
        const zhi = this.players.find(
          (p) => p.charKey === 'zhangbenzhiyao' && !p.eliminated
        );
        if (!zhi) {
          this.log(`${yun.name} 与 ${tun.name} 同格，但张本智鳐不在场上`, 'info', yun.id);
          continue;
        }
        const answer = await this.ask(yun.id, {
          type: 'choice',
          title: '人物羁绊 · 云水母',
          message: `你和豚鲁斯处于同一格，是否让豚鲁斯移动到张本智鳐所在位置？`,
          image: null,
          options: [
            { value: 'yes', label: '让豚鲁斯移动', tone: 'primary' },
            { value: 'no', label: '不移动' },
          ],
        });
        if (this.status !== 'playing' || yun.eliminated) return;
        if (answer === 'yes') {
          this.log(
            `${yun.name} 发动羁绊，令 ${tun.name} 移动到张本智鳐所在位置`,
            'info',
            yun.id
          );
          const oldPos = tun.pos;
          tun.pos = zhi.pos;
          this.lastMove = {
            seq: this.nextSeq(),
            playerId: tun.id,
            from: oldPos,
            to: tun.pos,
            path: [tun.pos],
          };
          this.broadcast();
          await sleep(360);
          await this.resolveLanding(tun, depth + 1);
        }
        this.broadcast();
      }
    }
  }

  async rollEffect(player, purpose) {
    await this.ask(player.id, {
      type: 'roll',
      title: `${purpose} · 再次掷骰`,
      message: '请手动点击下方按钮投掷骰子。',
      options: [{ value: 'roll', label: '掷骰子', tone: 'primary' }],
    });
    if (this.status !== 'playing' || player.eliminated) return 0;
    const value = this.rollDie(player, purpose);
    this.log(`${player.name} 为「${purpose}」重新掷骰：${value} 点`, 'roll', player.id);
    this.broadcast();
    await sleep(460);
    return value;
  }

  drawFromDeck(deckKey) {
    const cards = CARDS[deckKey];
    if (!this.decks[deckKey] || this.decks[deckKey].length === 0) {
      this.decks[deckKey] = shuffle(cards.map((c) => c.key));
    }
    const key = this.decks[deckKey].pop();
    return CARD_BY_KEY[key];
  }

  async drawCard(player, deckKey, depth = 0) {
    const card = this.drawFromDeck(deckKey);
    const label = deckKey === 'chance' ? '机会' : '命运';
    this.log(`${player.name} 抽到${label}卡：${card.name}`, 'card', player.id);
    this.broadcast();
    await this.ask(player.id, {
      type: 'card',
      title: `${label} · ${card.name}`,
      message: card.desc,
      image: card.image,
      options: [{ value: 'ok', label: '继续', tone: 'primary' }],
      meta: { cardKey: card.key, deck: deckKey },
    });
    await this.applyCard(player, card, depth);
    this.broadcast();
  }

  async drawItem(player) {
    const card = this.drawFromDeck('item');
    const item = { uid: makeId(6), key: card.key };
    player.items.push(item);
    this.log(`${player.name} 获得赞助道具：${card.name}`, 'card', player.id);
    this.broadcast();
    await this.ask(player.id, {
      type: 'card',
      title: `获得赞助 · ${card.name}`,
      message: card.desc,
      image: card.image,
      options: [{ value: 'ok', label: '收下', tone: 'primary' }],
      meta: { cardKey: card.key, deck: 'item' },
    });
  }

  hasItem(player, key) {
    return player.items.some((item) => item.key === key);
  }

  removeItemByKey(player, key) {
    const index = player.items.findIndex((item) => item.key === key);
    if (index >= 0) {
      const [item] = player.items.splice(index, 1);
      return item;
    }
    return null;
  }

  async charge(player, amount, options = {}) {
    amount = Math.max(0, Math.round(amount));
    if (!amount || player.eliminated || this.status !== 'playing') return 0;
    let payer = player;

    // 布鲁龟的羁绊：支付其他玩家时，最高一位由布鲁龟支付，其余零头由雨果龟支付。
    // 例如 1500 = 布鲁龟 1000 + 雨果龟 500。
    if (
      !options._split &&
      payer.charKey === 'bulugui' &&
      options.recipient &&
      options.recipient.id !== payer.id
    ) {
      const hugo = this.players.find(
        (p) => p.charKey === 'yuguogui' && !p.eliminated
      );
      if (hugo) {
        const scale = 10 ** Math.floor(Math.log10(amount));
        const highPart = Math.floor(amount / scale) * scale;
        const remainder = amount - highPart;
        if (remainder > 0) {
          this.log(
            `布鲁龟支付 ${highPart}，雨果龟代付零头 ${remainder}，合计 ${amount}`,
            'info',
            payer.id
          );
          const paidHigh = await this.charge(payer, highPart, {
            ...options,
            _split: true,
          });
          let paidRest = 0;
          if (this.status === 'playing') {
            if (options.recipient.id === hugo.id) {
              // 收款人就是雨果龟时，零头等于自己付给自己，不再重复结算。
              this.log('雨果龟承担零头，但收款人是自己，不重复扣款', 'info', hugo.id);
            } else {
              paidRest = await this.charge(hugo, remainder, {
                ...options,
                _split: true,
              });
            }
          }
          return paidHigh + paidRest;
        }
      }
    }

    if (options.allowDunwu !== false && this.hasItem(payer, 'dunwu')) {
      const answer = await this.ask(payer.id, {
        type: 'choice',
        title: '顿悟',
        message: `即将扣除 ${amount} 积分，是否使用「顿悟」免除？`,
        image: CARD_BY_KEY.dunwu.image,
        options: [
          { value: 'yes', label: '使用顿悟', tone: 'primary' },
          { value: 'no', label: '承受扣除' },
        ],
      });
      if (answer === 'yes') {
        this.removeItemByKey(payer, 'dunwu');
        this.effectLog(payer, '顿悟', '免除了一次积分扣除', 'gain');
        this.broadcast();
        return 0;
      }
      if (payer.eliminated || this.status !== 'playing') return 0;
    }

    if (
      options.allowFanshen !== false &&
      options.owner &&
      this.hasItem(payer, 'fanshen')
    ) {
      const answer = await this.ask(payer.id, {
        type: 'choice',
        title: '翻身',
        message: `${options.owner.name} 是本站奖杯持有者，是否使用「翻身」令其支付这笔积分？`,
        image: CARD_BY_KEY.fanshen.image,
        options: [
          { value: 'yes', label: '使用翻身', tone: 'primary' },
          { value: 'no', label: '照常支付' },
        ],
      });
      if (answer === 'yes') {
        this.removeItemByKey(payer, 'fanshen');
        options.owner.points -= amount;
        payer.points += amount;
        this.effectLog(
          payer,
          '翻身',
          `令 ${options.owner.name} 支付 ${amount} 积分给你`,
          'gain'
        );
        await this.normalizeFinances(options.owner);
        this.broadcast();
        return amount;
      }
      if (payer.eliminated || this.status !== 'playing') return 0;
    }

    if (
      options.allowBlame !== false &&
      payer.effects.blame &&
      this.alivePlayers.length > 1
    ) {
      const candidates = this.alivePlayers.filter(
        (p) => p.id !== payer.id && (!options.owner || p.id !== options.owner.id)
      );
      if (candidates.length > 0) {
        const targetId = await this.ask(payer.id, {
          type: 'target',
          title: '嫁祸',
          message: `下一次需支付 ${amount} 积分。指定一人替你支付，或自己支付。`,
          image: CARD_BY_KEY.jiahuo.image,
          options: [
            ...candidates.map((p) => ({
              value: p.id,
              label: p.name,
              avatar: p.avatar,
              sub: `${p.points} 积分`,
            })),
            { value: 'self', label: '自己支付' },
          ],
          meta: { allowSelf: true },
        });
        if (targetId && targetId !== 'self') {
          const target = this.playerById(targetId);
          if (target && !target.eliminated) {
            payer.effects.blame = false;
            this.effectLog(payer, '嫁祸', `指定 ${target.name} 代付 ${amount} 积分`, 'info');
            this.broadcast();
            const paid = await this.charge(target, amount, {
              ...options,
              allowBlame: false,
              allowDunwu: true,
            });
            return paid;
          }
        }
      }
      if (payer.eliminated || this.status !== 'playing') return 0;
    }

    if (payer.points < amount) {
      this.log(`${payer.name} 积分不足，仍被扣除 ${amount} 积分`, 'loss', payer.id);
    }
    payer.points -= amount;
    if (options.recipient && !options.recipient.eliminated) {
      options.recipient.points += amount;
    }
    await this.normalizeFinances(payer);
    this.broadcast();
    return amount;
  }

  async applyCard(player, card, depth = 0) {
    if (this.status !== 'playing' || player.eliminated) return;
    const p = player;
    const pay = async (amount, reason, opts = {}) => {
      await this.charge(p, amount, { reason, ...opts });
      return !p.eliminated && this.status === 'playing';
    };
    const gain = (amount, reason) => {
      p.points += amount;
      this.effectLog(p, card.name, `${reason}，积分 +${amount}`, 'gain');
      this.broadcast();
    };

    switch (card.key) {
      case 'ttr': {
        const value = await this.rollEffect(p, 'TTR');
        if (value <= 3) gain(200, `掷出 ${value}`);
        else await pay(200, `TTR 掷出 ${value}`);
        break;
      }
      case 'pingshu': {
        p.effects.pingshu = true;
        this.effectLog(p, '乒超', '获得持续效果：到达中国大陆时掷骰子加分', 'gain');
        break;
      }
      case 'jiefu': {
        const others = this.alivePlayers.filter((x) => x.id !== p.id);
        const next = this.nextPlayerAfter(p.id, others);
        if (!next) {
          this.effectLog(p, '劫富济贫', '场上没有其他选手', 'info');
        } else if (next.points === p.points) {
          this.effectLog(p, '劫富济贫', `你与 ${next.name} 积分相同，无需支付`, 'info');
        } else {
          const high = next.points > p.points ? next : p;
          const low = next.points > p.points ? p : next;
          this.log(`${high.name} 需向 ${low.name} 支付 500 积分`, 'info', high.id);
          await this.charge(high, 500, {
            reason: '劫富济贫',
            recipient: low,
            allowFanshen: false,
          });
          if (!high.eliminated) {
            this.effectLog(p, '劫富济贫', `${high.name} 向 ${low.name} 支付 500 积分`, 'transfer');
          }
        }
        break;
      }
      case 'qizong': {
        const value = await this.rollEffect(p, '器宗');
        if (value % 2 === 1) gain(200, `掷出奇数 ${value}`);
        else await pay(200, `器宗掷出偶数 ${value}`);
        break;
      }
      case 'duilian': {
        const nearest = this.nearestPlayer(p);
        if (nearest && nearest.charKey === 'yunshuimu' && p.charKey !== 'yunshuimu') {
          this.effectLog(p, '对练', `最近的玩家是云水母，积分 -500`, 'loss');
          await pay(500, '对练遇云水母');
        } else {
          gain(500, nearest ? `最近玩家是 ${nearest.name}` : '没有找到对手');
        }
        break;
      }
      case 'tuisai': {
        const ok = await pay(200, '战略退赛');
        if (!ok) return;
        const choice = await this.ask(p.id, {
          type: 'number',
          title: '战略退赛',
          message: '自行决定前进的步数（1-6）',
          options: [1, 2, 3, 4, 5, 6].map((n) => ({
            value: String(n),
            label: `${n} 步`,
          })),
        });
        if (p.eliminated || this.status !== 'playing') return;
        const steps = Math.max(1, Math.min(6, Number(choice) || 1));
        this.log(`${p.name} 选择前进 ${steps} 步`, 'info', p.id);
        await this.moveBy(p, steps, depth + 1);
        break;
      }
      case 'chouqian': {
        const target = await this.chooseOtherPlayer(p, card, '指定一名玩家替你抽签');
        if (!target) break;
        const value = await this.rollEffect(target, '抽签嘉宾');
        if (value >= 4) {
          target.points += 200;
          this.effectLog(p, '抽签嘉宾', `${target.name} 掷出 ${value}，积分 +200`, 'gain');
        } else {
          target.points -= 200;
          this.effectLog(p, '抽签嘉宾', `${target.name} 掷出 ${value}，积分 -200`, 'loss');
          await this.normalizeFinances(target);
        }
        break;
      }
      case 'meiyou': {
        const nearby = this.nearestPlayerWithin(p, 3);
        if (nearby) {
          p.points += 150;
          nearby.points += 150;
          this.effectLog(
            p,
            '没有陪练',
            `与 ${nearby.name} 对练，双方积分 +150`,
            'gain'
          );
        } else {
          this.log(`${p.name} 前后三步没有其他玩家，积分 -100`, 'loss', p.id);
          await pay(100, '没有陪练');
        }
        break;
      }
      case 'michelin': {
        p.effects.michelin = true;
        this.effectLog(p, '米其林', '获得持续效果：每次到达地点积分 +20', 'gain');
        break;
      }
      case 'ganfeiji': {
        const value = await this.rollEffect(p, '赶飞机');
        if (value >= 3) gain(200, `掷出 ${value}`);
        else await pay(200, `赶飞机掷出 ${value}`);
        break;
      }
      case 'toubaiwa': {
        if (p.gender === 'male') {
          this.log(`${p.name} 的袜子不翼而飞，积分 -200`, 'loss', p.id);
          await pay(200, '偷白袜');
        } else {
          this.effectLog(p, '偷白袜', '此卡只对男性角色生效，无事发生', 'info');
        }
        break;
      }
      case 'fanancai': {
        const value = await this.rollEffect(p, '发难财');
        if (value >= 5) gain(1000, `掷出 ${value}`);
        else this.effectLog(p, '发难财', `掷出 ${value}，未达到 5`, 'info');
        break;
      }
      case 'dazuoqian': {
        if (p.charKey === 'zhangbenzhiyao') {
          this.log(`${p.name} 无条件被大做签，积分 -500`, 'loss', p.id);
          await pay(500, '大做签');
        } else if (p.points >= 4000) {
          await pay(250, '大做签（大种子位）');
        } else {
          await pay(500, '大做签');
        }
        break;
      }
      case 'youzou': {
        if (p.points <= 2500) {
          this.effectLog(p, '游走', '当前积分≤2500，没有清分压力，积分不变', 'info');
        } else {
          await pay(500, '游走');
        }
        break;
      }
      case 'baozhong': {
        gain(1000, '本站表现极佳');
        break;
      }
      case 'jianmianhui': {
        await pay(200, '球员见面会');
        break;
      }
      case 'jifenshixiao': {
        if (p.trophies.length === 0) {
          this.effectLog(p, '积分失效', '没有持有奖杯，无事发生', 'info');
        } else {
          const closest = [...p.trophies].sort((a, b) => {
            const da = (p.pos - a.tileId + BOARD_SIZE) % BOARD_SIZE;
            const db = (p.pos - b.tileId + BOARD_SIZE) % BOARD_SIZE;
            return da - db;
          })[0];
          const index = p.trophies.findIndex((t) => t.tileId === closest.tileId);
          closest.streak = Math.max(0, (closest.streak || 1) - 1);
          if (closest.streak <= 0 && index >= 0) p.trophies.splice(index, 1);
          this.effectLog(
            p,
            '积分失效',
            `失去逆时针最近的 ${closest.name} 的 1 个奖杯${closest.streak > 0 ? `（剩 ${closest.streak}/3）` : ''}`,
            'loss'
          );
        }
        break;
      }
      case 'zushuangda': {
        const target = await this.chooseOtherPlayer(p, card, '指定一名玩家与你组双打');
        if (!target) break;
        const a = await this.rollEffect(p, '组双打');
        const b = await this.rollEffect(target, '组双打');
        if (a === b) {
          p.points += 500;
          target.points += 500;
          this.effectLog(p, '组双打', `双方都掷出 ${a}，各 +500 积分`, 'gain');
        } else {
          this.effectLog(p, '组双打', `你掷出 ${a}，${target.name} 掷出 ${b}，点数不同`, 'info');
        }
        break;
      }
      case 'chudifantan': {
        if (p.points <= 2000) gain(500, '触底反弹');
        else this.effectLog(p, '触底反弹', '当前积分高于 2000，不触发', 'info');
        break;
      }
      case 'caifang': {
        const hasLanguage = p.trophies.some((trophy) => {
          const tile = TILES[trophy.tileId];
          return tile.languages?.includes('英语') || tile.languages?.includes(p.language);
        });
        if (hasLanguage) gain(200, '冠军采访');
        else this.effectLog(p, '采访', '持有奖杯的赛事地语言均不符合，无事发生', 'info');
        break;
      }
      default:
        this.effectLog(p, card.name, '卡牌效果待补充', 'info');
    }
  }

  nextPlayerAfter(playerId, pool = this.alivePlayers) {
    if (!pool.length) return null;
    const start = this.players.findIndex((p) => p.id === playerId);
    for (let step = 1; step <= this.players.length; step += 1) {
      const candidate = this.players[(start + step) % this.players.length];
      if (candidate && pool.some((p) => p.id === candidate.id)) return candidate;
    }
    return pool[0];
  }

  nearestPlayer(player) {
    const others = this.alivePlayers.filter((p) => p.id !== player.id);
    if (!others.length) return null;
    return [...others].sort((a, b) => {
      const da = circularDistance(player.pos, a.pos);
      const db = circularDistance(player.pos, b.pos);
      if (da !== db) return da - db;
      return a.joinedAt - b.joinedAt;
    })[0];
  }

  nearestPlayerWithin(player, range) {
    return (
      this.alivePlayers
        .filter((p) => p.id !== player.id && circularDistance(player.pos, p.pos) <= range)
        .sort((a, b) => {
          const da = circularDistance(player.pos, a.pos);
          const db = circularDistance(player.pos, b.pos);
          if (da !== db) return da - db;
          return a.joinedAt - b.joinedAt;
        })[0] || null
    );
  }

  async chooseOtherPlayer(player, card, message) {
    const others = this.alivePlayers.filter((p) => p.id !== player.id);
    if (!others.length) {
      this.effectLog(player, card.name, '场上没有其他玩家', 'info');
      return null;
    }
    const targetId = await this.ask(player.id, {
      type: 'target',
      title: card.name,
      message,
      image: card.image,
      options: others.map((p) => ({
        value: p.id,
        label: p.name,
        avatar: p.avatar,
        sub: `${p.points} 积分${p.eliminated ? ' · 已退出' : ''}`,
      })),
    });
    const target = this.playerById(targetId);
    if (!target || target.eliminated) return null;
    return target;
  }

  async moveBy(player, steps, depth = 0) {
    if (this.status !== 'playing' || player.eliminated) return;
    const path = [];
    for (let i = 0; i < steps; i += 1) {
      player.pos = (player.pos + 1) % BOARD_SIZE;
      path.push(player.pos);
    }
    this.lastMove = {
      seq: this.nextSeq(),
      playerId: player.id,
      from: path.length ? (path[0] - 1 + BOARD_SIZE) % BOARD_SIZE : player.pos,
      to: player.pos,
      path,
    };
    this.broadcast();
    await sleep(420);
    for (const pos of path) {
      const tile = TILES[pos];
      if (tile.kind === 'training') {
        player.points += 1000;
        this.effectLog(player, '训练场', '经过训练场，积分 +1000', 'gain');
      }
      if (player.eliminated || this.status !== 'playing') return;
    }
    if (this.status === 'playing' && !player.eliminated) {
      await this.resolveLanding(player, depth);
    }
  }

  useDivine(playerId, value) {
    if (this.status !== 'playing') throw new GameError('游戏未在进行中');
    if (this.pending) throw new GameError('请先完成当前操作');
    if (['rolling', 'resolving', 'ending', 'ended'].includes(this.phase)) {
      throw new GameError('当前不能发动神的旨意');
    }
    const player = this.playerById(playerId);
    if (!player || player.eliminated) throw new GameError('你已退出比赛');
    if (player.charKey !== 'tunlusi') throw new GameError('只有豚鲁斯可以发动神的旨意');
    if (player.divineUsed) throw new GameError('神的旨意整局只能使用一次');
    const v = Math.round(Number(value));
    if (!Number.isFinite(v) || v < 1 || v > 6) throw new GameError('请选择 1-6 点');
    player.divineUsed = true;
    player.divineValue = v;
    this.effectLog(
      player,
      '神的旨意',
      `指定本人下一次骰子点数为 ${v}`,
      'gain'
    );
    this.broadcast();
  }

  async useItem(playerId, uid, payload = {}) {
    this.ensureTurn(playerId);
    if (this.phase !== 'action') throw new GameError('掷骰后才能使用道具');
    const player = this.current;
    const itemIndex = player.items.findIndex((item) => item.uid === uid);
    if (itemIndex < 0) throw new GameError('没有这件道具');
    const item = player.items[itemIndex];
    const card = CARD_BY_KEY[item.key];
    const consume = () => {
      player.items.splice(itemIndex, 1);
    };

    this.phase = 'resolving';
    this.broadcast();

    try {
      if (item.key === 'jiahuo') {
        player.effects.blame = true;
        consume();
        this.effectLog(player, '嫁祸', '下一次支付时，可指定一人代付', 'info');
      } else if (item.key === 'jipiao') {
        const target = await this.chooseOtherPlayer(
          player,
          card,
          '和任意一名玩家互换位置'
        );
        if (!target) {
          this.phase = 'action';
          this.broadcast();
          return;
        }
        consume();
        const ownPos = player.pos;
        player.pos = target.pos;
        target.pos = ownPos;
        this.lastMove = {
          seq: this.nextSeq(),
          playerId: player.id,
          from: ownPos,
          to: player.pos,
          path: [player.pos],
          swapWith: target.id,
        };
        this.log(`${player.name} 与 ${target.name} 互换位置`, 'info', player.id);
        this.broadcast();
        await sleep(520);
        this.lastMove = {
          seq: this.nextSeq(),
          playerId: target.id,
          from: ownPos,
          to: target.pos,
          path: [target.pos],
          swapWith: player.id,
        };
        this.broadcast();
        await this.resolveArrivalSpecial(player);
        await this.resolveLanding(player, 1);
        if (this.status === 'playing' && !target.eliminated) {
          await this.resolveArrivalSpecial(target);
          await this.resolveLanding(target, 1);
        }
      } else if (item.key === 'xieyao') {
        const target = await this.chooseOtherPlayer(
          player,
          card,
          '选择一名玩家，令其积分 -500'
        );
        if (!target) {
          this.phase = 'action';
          this.broadcast();
          return;
        }
        consume();
        target.points -= 500;
        this.effectLog(player, '泻药', `对 ${target.name} 使用，积分 -500`, 'loss');
        await this.normalizeFinances(target);
      } else if (item.key === 'qingshen') {
        const tile = TILES[player.pos];
        const owns = player.trophies.some((t) => t.tileId === tile.id);
        if (!owns || tile.kind !== 'tournament') {
          this.phase = 'action';
          this.broadcast();
          throw new GameError('你未持有所处赛事地的奖杯');
        }
        consume();
        player.points += tile.points;
        this.effectLog(player, '请神', `再次获得 ${tile.name} 冠军，积分 +${tile.points}`, 'gain');
      } else if (item.key === 'fanshen' || item.key === 'dunwu') {
        this.phase = 'action';
        this.broadcast();
        throw new GameError('这张卡会在对应时机自动询问');
      }
      this.phase = 'action';
      this.broadcast();
      if (item.key === 'qingshen') await this.recheckPurchase(player);
    } catch (error) {
      this.phase = 'action';
      this.broadcast();
      throw error;
    }
  }

  async sellTrophy(playerId, tileId) {
    this.ensureTurn(playerId);
    if (this.phase !== 'action') throw new GameError('掷骰后才能卖房');
    const player = this.current;
    const trophy = player.trophies.find((t) => t.tileId === Number(tileId));
    if (!trophy) throw new GameError('你没有这站奖杯');
    this.sellTrophyInternal(player, trophy, false);
    this.broadcast();
    await this.recheckPurchase(player);
  }

  async challengeBlade(playerId, targetId) {
    this.ensureTurn(playerId);
    if (this.phase !== 'action') throw new GameError('掷骰后才能拼刺刀');
    if (this.bladeUsed) throw new GameError('本回合已经拼过刺刀');
    const player = this.current;
    const target = this.playerById(targetId);
    if (!target || target.eliminated || target.id === player.id) throw new GameError('对手不在场上');
    if (target.pos !== player.pos) throw new GameError('你们不在同一格');
    this.phase = 'resolving';
    this.broadcast();
    try {
      const accept = await this.ask(target.id, {
        type: 'blade',
        title: '拼刺刀',
        message: `${player.name} 邀请你拼刺刀：双方掷骰子，点数小者支付点数大者 300 积分。`,
        options: [
          { value: 'yes', label: '应战', tone: 'primary' },
          { value: 'no', label: '拒绝' },
        ],
      });
      if (accept !== 'yes') {
        this.log(`${target.name} 拒绝了拼刺刀`, 'info', target.id);
        this.phase = 'action';
        this.broadcast();
        return;
      }
      this.bladeUsed = true;
      const a = await this.rollEffect(player, '拼刺刀');
      const b = await this.rollEffect(target, '拼刺刀');
      if (a > b) {
        await this.charge(target, 300, {
          reason: '拼刺刀',
          recipient: player,
          allowFanshen: false,
        });
        this.effectLog(player, '拼刺刀', `${player.name} ${a} 点胜 ${target.name} ${b} 点，赢得 300 积分`, 'gain');
      } else if (b > a) {
        await this.charge(player, 300, {
          reason: '拼刺刀',
          recipient: target,
          allowFanshen: false,
        });
        this.effectLog(player, '拼刺刀', `${target.name} ${b} 点胜 ${player.name} ${a} 点，获得 300 积分`, 'loss');
      } else {
        this.effectLog(player, '拼刺刀', `双方都掷出 ${a} 点，平局`, 'info');
      }
      this.phase = 'action';
      this.broadcast();
    } catch (error) {
      this.phase = 'action';
      this.broadcast();
      throw error;
    }
  }

  async createLoan(playerId, payload) {
    this.ensureTurn(playerId);
    if (this.phase !== 'action') throw new GameError('掷骰后才能借债');
    const borrower = this.current;
    const lender = this.playerById(payload.lenderId);
    if (!lender || lender.eliminated || lender.id === borrower.id) {
      throw new GameError('请选择有效的债主');
    }
    if (!lender.online) throw new GameError('该玩家当前离线');
    if (lender.points < Number(payload.amount)) throw new GameError('债主积分不足');
    const amount = Math.round(Number(payload.amount));
    const interest = Math.round(Number(payload.interest));
    const term = Math.round(Number(payload.term));
    if (!Number.isFinite(amount) || amount < 100 || amount > 5000) {
      throw new GameError('借款金额需在 100-5000 之间');
    }
    if (!Number.isFinite(interest) || interest < 0 || interest > 100) {
      throw new GameError('利息需在 0-100% 之间');
    }
    if (!Number.isFinite(term) || term < 1 || term > 5) {
      throw new GameError('期限需在 1-5 回合之间');
    }
    if (lender.points < amount) throw new GameError('债主积分不足');
    this.phase = 'resolving';
    this.broadcast();
    try {
      const accept = await this.ask(lender.id, {
        type: 'loan',
        title: '借债请求',
        message: `${borrower.name} 向你借款 ${amount} 积分，利息 ${interest}%，期限 ${term} 回合。`,
        options: [
          { value: 'yes', label: '接受', tone: 'primary' },
          { value: 'no', label: '拒绝' },
        ],
        meta: { amount, interest, term, borrowerId: borrower.id, lenderId: lender.id },
      });
      if (accept !== 'yes') {
        this.log(`${lender.name} 拒绝了 ${borrower.name} 的借债`, 'info', lender.id);
        this.phase = 'action';
        this.broadcast();
        return;
      }
      if (lender.points < amount) {
        this.phase = 'action';
        this.broadcast();
        throw new GameError('债主积分不足，借款失败');
      }
      lender.points -= amount;
      borrower.points += amount;
      const loan = {
        id: makeId(6),
        borrowerId: borrower.id,
        lenderId: lender.id,
        principal: amount,
        interest,
        dueRound: this.round + term,
        createdRound: this.round,
        status: 'active',
        paid: 0,
      };
      this.loans.push(loan);
      this.effectLog(
        borrower,
        '借债',
        `向 ${lender.name} 借入 ${amount} 积分，${term} 回合后还 ${Math.ceil(amount * (1 + interest / 100))}`,
        'info'
      );
      this.phase = 'action';
      this.broadcast();
      await this.recheckPurchase(borrower);
    } catch (error) {
      this.phase = 'action';
      this.broadcast();
      throw error;
    }
  }

  forfeit(playerId) {
    const player = this.playerById(playerId);
    if (!player) return;
    if (this.status === 'waiting') {
      this.players = this.players.filter((p) => p.id !== playerId);
      if (this.hostId === playerId) {
        const next = this.players[0];
        this.hostId = next ? next.id : null;
      }
      this.log(`${player.name} 离开了房间`, 'system');
      this.broadcast();
      return;
    }
    if (this.status === 'playing' && !player.eliminated) {
      this.log(`${player.name} 退出了比赛`, 'danger', player.id);
      const wasCurrent = this.current?.id === playerId;
      const hadPending = Boolean(this.pending);
      player.eliminated = true;
      player.effects = { pingshu: false, michelin: false, blame: false };
      player.items = [];
      player.trophies = [];
      player.divineValue = null;
      this.activeBonds.clear();
      if (this.hostId === playerId) this.transferHost();
      if (hadPending) this.cancelPending();
      this.checkGameEnd();
      if (this.status === 'playing' && wasCurrent && !hadPending) {
        this.phase = 'ending';
        this.advanceTurn();
      }
      if (hadPending && this.status === 'playing') {
        // 让被取消的异步流程自行结束并推进回合
        setTimeout(() => {
          if (this.status === 'playing' && this.current?.id === playerId) {
            this.advanceTurn();
          }
        }, 500);
      }
      this.broadcast();
    }
  }

  transferHost(preferredId = null) {
    const preferred = preferredId ? this.playerById(preferredId) : null;
    const next =
      preferred && !preferred.eliminated && preferred.online
        ? preferred
        : this.players.find((p) => p.id !== this.hostId && !p.eliminated && p.online) ||
          this.players.find((p) => p.id !== this.hostId && !p.eliminated) ||
          null;
    if (next) {
      this.hostId = next.id;
      this.log(`${next.name} 成为新房主`, 'system');
    }
  }
}

module.exports = {
  Room,
  GameError,
  randomInt,
  makeId,
  normalizeCode,
  CODE_ALPHABET,
};
