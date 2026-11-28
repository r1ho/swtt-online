'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const {
  CHARACTERS,
  TILES,
  CARDS,
  INITIAL_POINTS,
  MAX_PLAYERS,
} = require('./src/config');
const {
  Room,
  GameError,
  makeId,
  normalizeCode,
  CODE_ALPHABET,
} = require('./src/game');

const PORT = Number(process.env.PORT) || 3000;
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e6,
  pingTimeout: 30000,
  pingInterval: 25000,
});

const rooms = new Map();
const cleanupTimers = new Map();

process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error);
});

app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));
app.use(
  express.static(path.join(__dirname, 'public'), {
    maxAge: '7d',
    setHeaders(res, filePath) {
      const normalized = filePath.replace(/\\/g, '/');
      if (normalized.includes('/assets/avatars/')) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
      } else if (filePath.endsWith('.html') || filePath.endsWith('app.js') || filePath.endsWith('styles.css')) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  })
);

app.get('/api/config', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.json({
    characters: CHARACTERS,
    tiles: TILES,
    cards: CARDS,
    initialPoints: INITIAL_POINTS,
    maxPlayers: MAX_PLAYERS,
  });
});

app.get('/api/rooms/:code', (req, res) => {
  const code = normalizeCode(req.params.code);
  const room = rooms.get(code);
  if (!room) {
    res.status(404).json({ error: '房间不存在' });
    return;
  }
  res.json({
    code,
    status: room.status,
    playerCount: room.players.length,
    onlineCount: room.players.filter((p) => p.online).length,
    spectatorCount: room.spectators.length,
    spectatorLimit: 5,
    maxPlayers: MAX_PLAYERS,
    availableCharacters: room.availableCharacters(),
    hostName: room.playerById(room.hostId)?.name || '',
  });
});

app.get('/healthz', (req, res) => {
  res.json({ ok: true, rooms: rooms.size });
});

function makeCode() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    let code = '';
    for (let i = 0; i < 4; i += 1) {
      code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
    if (!rooms.has(code)) return code;
  }
  throw new Error('无法生成房间码');
}

function getSocketRoom(socket) {
  const code = socket.data.code;
  if (!code) throw new GameError('你还没有加入房间');
  const room = rooms.get(code);
  if (!room) throw new GameError('房间已关闭');
  const player = room.playerById(socket.data.playerId);
  if (!player || player.token !== socket.data.token) {
    throw new GameError('座位信息已失效');
  }
  if (player.socketId !== socket.id) {
    throw new GameError('你的座位已在其他窗口重新连接');
  }
  return { room, player };
}

function bindSocket(socket, room, player) {
  socket.data.code = room.code;
  socket.data.playerId = player.id;
  socket.data.token = player.token;
  player.socketId = socket.id;
  socket.join(room.code);
}

function bindSpectatorSocket(socket, room, spectator) {
  socket.data.code = room.code;
  socket.data.spectatorId = spectator.id;
  socket.data.token = spectator.token;
  spectator.socketId = socket.id;
  socket.join(room.code);
}

function getSocketSpectator(socket) {
  const code = socket.data.code;
  if (!code) throw new GameError('你还没有加入房间');
  const room = rooms.get(code);
  if (!room) throw new GameError('房间已关闭');
  const spectator = room.spectatorById(socket.data.spectatorId);
  if (!spectator || spectator.token !== socket.data.token) {
    throw new GameError('观战信息已失效');
  }
  if (spectator.socketId !== socket.id) {
    throw new GameError('你的观战席位已在其他窗口重新连接');
  }
  return { room, spectator };
}

function scheduleRoomCleanup(room) {
  if (cleanupTimers.has(room.code)) return;
  const timer = setTimeout(() => {
    cleanupTimers.delete(room.code);
    const current = rooms.get(room.code);
    if (!current) return;
    if (
      current.players.every((p) => !p.online) &&
      current.spectators.every((s) => !s.online)
    ) {
      rooms.delete(room.code);
      io.to(room.code).emit('room:closed');
    }
  }, 30 * 60 * 1000);
  timer.unref?.();
  cleanupTimers.set(room.code, timer);
}

function clearRoomCleanup(code) {
  const timer = cleanupTimers.get(code);
  if (timer) {
    clearTimeout(timer);
    cleanupTimers.delete(code);
  }
}

function sendError(socket, error) {
  const message = error instanceof GameError ? error.message : '操作失败';
  if (!(error instanceof GameError)) {
    console.error(error);
  }
  socket.emit('toast', { type: 'error', message });
}

function handleAsync(socket, fn) {
  Promise.resolve()
    .then(fn)
    .catch((error) => sendError(socket, error));
}

io.on('connection', (socket) => {
  socket.on('room:create', (payload, ack) => {
    try {
      const character = CHARACTERS.find((c) => c.key === payload?.charKey);
      if (!character) throw new GameError('请选择一个角色');
      const code = makeCode();
      const room = new Room(code, io, character);
      const host = room.players[0];
      rooms.set(code, room);
      bindSocket(socket, room, host);
      clearRoomCleanup(code);
      room.broadcast();
      ack?.({
        ok: true,
        code,
        playerId: host.id,
        token: host.token,
        state: room.publicState(),
      });
    } catch (error) {
      if (!(error instanceof GameError)) console.error(error);
      ack?.({ ok: false, error: error.message || '创建失败' });
    }
  });

  socket.on('room:join', (payload, ack) => {
    try {
      const code = normalizeCode(payload?.code);
      const room = rooms.get(code);
      if (!room) throw new GameError('房间不存在');
      const wantsSpectate = Boolean(payload?.spectate) || room.status !== 'waiting';
      if (wantsSpectate) {
        const spectator = room.addSpectator();
        clearRoomCleanup(code);
        bindSpectatorSocket(socket, room, spectator);
        room.broadcast();
        ack?.({
          ok: true,
          spectator: true,
          code,
          spectatorId: spectator.id,
          token: spectator.token,
          state: room.publicState(),
        });
        return;
      }
      const character = CHARACTERS.find((c) => c.key === payload?.charKey);
      if (!character) throw new GameError('请填写房间码并选择角色');
      const player = room.addPlayer(character);
      clearRoomCleanup(code);
      bindSocket(socket, room, player);
      room.broadcast();
      ack?.({
        ok: true,
        code,
        playerId: player.id,
        token: player.token,
        state: room.publicState(),
      });
    } catch (error) {
      if (!(error instanceof GameError)) console.error(error);
      ack?.({ ok: false, error: error.message || '加入失败' });
    }
  });

  socket.on('room:rejoin', (payload, ack) => {
    try {
      const code = normalizeCode(payload?.code);
      const room = rooms.get(code);
      if (!room) throw new GameError('房间已关闭');
      const spectator = room.spectatorByToken(payload?.token);
      if (spectator) {
        clearRoomCleanup(code);
        bindSpectatorSocket(socket, room, spectator);
        spectator.online = true;
        if (spectator._disconnectTimer) {
          clearTimeout(spectator._disconnectTimer);
          spectator._disconnectTimer = null;
        }
        room.log(`${spectator.name} 重新连接观战`, 'system');
        room.broadcast();
        ack?.({
          ok: true,
          spectator: true,
          code,
          spectatorId: spectator.id,
          token: spectator.token,
          state: room.publicState(),
        });
        return;
      }
      const player = room.restorePlayer(payload?.token);
      clearRoomCleanup(code);
      bindSocket(socket, room, player);
      player.online = true;
      if (player._disconnectTimer) {
        clearTimeout(player._disconnectTimer);
        player._disconnectTimer = null;
      }
      if (player._hostTimer) {
        clearTimeout(player._hostTimer);
        player._hostTimer = null;
      }
      room.log(`${player.name} 重新连接`, 'system');
      room.broadcast();
      ack?.({
        ok: true,
        code,
        playerId: player.id,
        token: player.token,
        state: room.publicState(),
      });
    } catch (error) {
      if (!(error instanceof GameError)) console.error(error);
      ack?.({ ok: false, error: error.message || '重连失败' });
    }
  });

  socket.on('room:state', () => {
    try {
      if (socket.data.spectatorId) {
        const { room } = getSocketSpectator(socket);
        socket.emit('room:state', room.publicState());
        return;
      }
      const { room } = getSocketRoom(socket);
      socket.emit('room:state', room.publicState());
    } catch (error) {
      sendError(socket, error);
    }
  });

  socket.on('room:kick', (payload) => {
    try {
      const { room, player: host } = getSocketRoom(socket);
      if (host.id !== room.hostId) throw new GameError('只有房主可以移出玩家');
      const target = room.playerById(payload?.playerId);
      if (!target) throw new GameError('该玩家不在房间中');
      if (target.id === host.id) throw new GameError('不能移出自己');
      target.token = makeId(24);
      const targetSocket = target.socketId
        ? io.sockets.sockets.get(target.socketId)
        : null;
      if (targetSocket) {
        targetSocket.emit('room:kicked');
        targetSocket.leave(room.code);
        targetSocket.data.code = null;
        targetSocket.data.playerId = null;
        targetSocket.data.token = null;
      }
      target.socketId = null;
      room.forfeit(target.id);
      room.broadcast();
    } catch (error) {
      sendError(socket, error);
    }
  });

  socket.on('room:leave', () => {
    if (socket.data.spectatorId) {
      const code = socket.data.code;
      const room = rooms.get(code);
      if (room) {
        room.removeSpectator(socket.data.spectatorId);
        room.broadcast();
        if (room.players.every((p) => !p.online) && room.spectators.every((s) => !s.online)) {
          scheduleRoomCleanup(room);
        }
      }
      socket.leave(code);
      socket.data.code = null;
      socket.data.spectatorId = null;
      socket.data.token = null;
      socket.emit('room:left');
      return;
    }
    try {
      const { room, player } = getSocketRoom(socket);
      const code = room.code;
      room.forfeit(player.id);
      socket.leave(code);
      socket.data.code = null;
      socket.data.playerId = null;
      socket.data.token = null;
      if (room.players.length === 0) {
        rooms.delete(code);
        clearRoomCleanup(code);
      } else if (
        room.players.every((p) => !p.online) &&
        room.spectators.every((s) => !s.online)
      ) {
        scheduleRoomCleanup(room);
      }
      socket.emit('room:left');
    } catch (error) {
      sendError(socket, error);
    }
  });

  socket.on('game:start', () => {
    try {
      const { room, player } = getSocketRoom(socket);
      room.start(player.id);
    } catch (error) {
      sendError(socket, error);
    }
  });

  socket.on('game:roll', () => {
    try {
      const { room, player } = getSocketRoom(socket);
      room.roll(player.id).catch((error) => sendError(socket, error));
    } catch (error) {
      sendError(socket, error);
    }
  });

  socket.on('game:endTurn', () => {
    try {
      const { room, player } = getSocketRoom(socket);
      room.endTurn(player.id).catch((error) => sendError(socket, error));
    } catch (error) {
      sendError(socket, error);
    }
  });

  socket.on('game:item', (payload) => {
    try {
      const { room, player } = getSocketRoom(socket);
      room.useItem(player.id, payload?.uid, payload).catch((error) => sendError(socket, error));
    } catch (error) {
      sendError(socket, error);
    }
  });

  socket.on('game:sell', (payload) => {
    try {
      const { room, player } = getSocketRoom(socket);
      room.sellTrophy(player.id, payload?.tileId).catch((error) => sendError(socket, error));
    } catch (error) {
      sendError(socket, error);
    }
  });

  socket.on('game:blade', (payload) => {
    try {
      const { room, player } = getSocketRoom(socket);
      room.challengeBlade(player.id, payload?.targetId, payload?.amount).catch((error) => sendError(socket, error));
    } catch (error) {
      sendError(socket, error);
    }
  });

  socket.on('game:borrow', (payload) => {
    try {
      const { room, player } = getSocketRoom(socket);
      room.createLoan(player.id, payload).catch((error) => sendError(socket, error));
    } catch (error) {
      sendError(socket, error);
    }
  });

  socket.on('game:divine', (payload) => {
    try {
      const { room, player } = getSocketRoom(socket);
      room.useDivine(player.id, payload?.value);
    } catch (error) {
      sendError(socket, error);
    }
  });

  socket.on('game:finish', () => {
    try {
      const { room, player } = getSocketRoom(socket);
      room.finishByHost(player.id);
    } catch (error) {
      sendError(socket, error);
    }
  });

  socket.on('pending:respond', (payload) => {
    try {
      const { room, player } = getSocketRoom(socket);
      room.respond(player.id, payload?.id, payload?.value);
    } catch (error) {
      sendError(socket, error);
    }
  });

  socket.on('disconnect', () => {
    const code = socket.data.code;
    const spectatorId = socket.data.spectatorId;
    if (code && spectatorId) {
      const room = rooms.get(code);
      if (!room) return;
      const spectator = room.spectatorById(spectatorId);
      if (!spectator) return;
      if (spectator.socketId && spectator.socketId !== socket.id) return;
      spectator.socketId = null;
      spectator.online = false;
      room.broadcast();
      if (spectator._disconnectTimer) clearTimeout(spectator._disconnectTimer);
      spectator._disconnectTimer = setTimeout(() => {
        spectator._disconnectTimer = null;
        if (!spectator.online) {
          room.removeSpectator(spectator.id);
          room.broadcast();
          if (room.players.every((p) => !p.online) && room.spectators.every((s) => !s.online)) {
            scheduleRoomCleanup(room);
          }
        }
      }, 60 * 1000);
      spectator._disconnectTimer.unref?.();
      if (room.players.every((p) => !p.online) && room.spectators.every((s) => !s.online)) {
        scheduleRoomCleanup(room);
      }
      return;
    }
    const playerId = socket.data.playerId;
    if (!code || !playerId) return;
    const room = rooms.get(code);
    if (!room) return;
    const player = room.playerById(playerId);
    if (!player) return;
    // 重连后旧 socket 的 disconnect 可能晚到，不能把新连接标成离线
    if (player.socketId && player.socketId !== socket.id) return;
    player.socketId = null;
    player.online = false;
    room.log(`${player.name} 暂时离线`, 'system');
    room.broadcast();

    if (room.status === 'waiting') {
      if (player._disconnectTimer) clearTimeout(player._disconnectTimer);
      player._disconnectTimer = setTimeout(() => {
        player._disconnectTimer = null;
        if (!player.online) {
          room.forfeit(player.id);
          if (room.players.length === 0) {
            rooms.delete(room.code);
            clearRoomCleanup(room.code);
          }
        }
      }, 60 * 1000);
      player._disconnectTimer.unref?.();
    } else if (room.status === 'playing' && room.hostId === player.id) {
      if (player._hostTimer) clearTimeout(player._hostTimer);
      player._hostTimer = setTimeout(() => {
        player._hostTimer = null;
        if (!player.online && room.status === 'playing' && room.hostId === player.id) {
          room.transferHost();
          room.broadcast();
        }
      }, 60 * 1000);
      player._hostTimer.unref?.();
    }

    if (
      room.players.every((p) => !p.online) &&
      room.spectators.every((s) => !s.online)
    ) {
      scheduleRoomCleanup(room);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`SWTT online listening on http://localhost:${PORT}`);
});
