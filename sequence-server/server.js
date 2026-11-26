import { createServer } from "node:http";
import { randomBytes, randomInt } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer, WebSocket } from "ws";

const SUITS = [
  { code: "H", symbol: "♥", name: "Hearts", red: true },
  { code: "D", symbol: "♦", name: "Diamonds", red: true },
  { code: "C", symbol: "♣", name: "Clubs", red: false },
  { code: "S", symbol: "♠", name: "Spades", red: false },
];
const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
const TEAM_COLORS = ["#c65c5d", "#628dc2", "#5c9b78"];
const BOARD_LAYOUT = [
  ["FREE", "2S", "3S", "4S", "5S", "6S", "7S", "8S", "9S", "FREE"],
  ["6C", "5C", "4C", "3C", "2C", "AH", "KH", "QH", "10H", "10S"],
  ["7C", "AS", "2D", "3D", "4D", "5D", "6D", "7D", "9H", "QS"],
  ["8C", "KS", "6C", "5C", "4C", "3C", "2C", "8D", "8H", "KS"],
  ["9C", "QS", "7C", "6H", "5H", "4H", "AH", "9D", "7H", "AS"],
  ["10C", "10S", "8C", "7H", "2H", "3H", "KH", "10D", "6H", "2D"],
  ["QC", "9S", "9C", "8H", "9H", "10H", "QH", "QD", "5H", "3D"],
  ["KC", "8S", "10C", "QC", "KC", "AC", "AD", "KD", "4H", "4D"],
  ["AC", "7S", "6S", "5S", "4S", "3S", "2S", "2H", "3H", "5D"],
  ["FREE", "AD", "KD", "QD", "10D", "9D", "8D", "7D", "6D", "FREE"],
];
const STANDARD_HANDS = { 2: 7, 3: 6, 4: 6, 6: 5, 8: 4, 9: 4, 10: 3, 11: 3, 12: 3 };
const rooms = new Map();
const queues = new Map();
const clients = new WeakMap();
const roomLifetimeMs = 3 * 60 * 60 * 1000;

export function shuffle(cards) {
  for (let index = cards.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(index + 1);
    [cards[index], cards[swapIndex]] = [cards[swapIndex], cards[index]];
  }
  return cards;
}

export function buildDeck() {
  return SUITS.flatMap((suit) => RANKS.flatMap((rank) => [0, 1].map((copy) => ({
    id: `${suit.code}-${rank}-${copy}`,
    rank,
    suit: suit.code,
    symbol: suit.symbol,
    suitName: suit.name,
    red: suit.red,
    jackType: rank === "J" ? (suit.code === "D" || suit.code === "C" ? "WILD" : "REMOVE") : null,
  }))));
}

export function buildBoard() {
  return BOARD_LAYOUT.flatMap((row, rowIndex) => row.map((face, columnIndex) => {
    const index = rowIndex * 10 + columnIndex;
    if (face === "FREE") return { index, free: true, tokenTeamId: null };
    const rank = face.slice(0, -1);
    const suit = SUITS.find((item) => item.code === face.slice(-1));
    return { index, free: false, rank, suit: suit.code, symbol: suit.symbol, red: suit.red, tokenTeamId: null };
  }));
}

export function hasAdjacentTeammates(assignments) {
  return assignments.some((teamId, index) => teamId && teamId === assignments[(index + 1) % assignments.length]);
}

function normalizedName(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, 24) : "";
}

function makeCode() {
  return randomBytes(4).toString("hex").slice(0, 6).toUpperCase();
}

function makeToken() {
  return randomBytes(24).toString("base64url");
}

function send(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function sendError(socket, message) {
  send(socket, { type: "error", message });
}

function teamSetupValid(room, teams, assignments) {
  if (!Array.isArray(teams) || teams.length < 2 || teams.length > 3) return "Choose two or three teams.";
  if (!Array.isArray(assignments) || assignments.length !== room.players.length) return "Assign every player to a team.";
  const teamIds = new Set(teams.map((team) => team.id));
  if (teamIds.size !== teams.length || teams.some((team) => !teamIds.has(team.id) || !normalizedName(team.name))) {
    return "Every team needs a unique ID and a name.";
  }
  if (assignments.some((teamId) => !teamIds.has(teamId))) return "Assign every player to a valid team.";
  if (hasAdjacentTeammates(assignments)) return "Teammates cannot sit side by side.";
  if (teams.length === 3 && room.players.length !== 3 && room.players.length < 6) {
    return "Three teams require three players or at least six players.";
  }
  const teamSizes = teams.map((team) => assignments.filter((teamId) => teamId === team.id).length);
  if (teamSizes.some((size) => size === 0)) return "Assign at least one player to every team.";
  const maximumTeamSize = teams.length === 2 ? 6 : 4;
  if (teamSizes.some((size) => size > maximumTeamSize)) return `Each team can have at most ${maximumTeamSize} players.`;
  if (teams.length === 2 && room.players.length > 12) return "Two teams support up to twelve players.";
  return "";
}

function makeTeams(inputTeams, previousTeams = []) {
  return inputTeams.map((team, index) => {
    const previous = previousTeams.find((item) => item.id === team.id);
    return {
      id: team.id,
      name: normalizedName(team.name),
      color: /^#[0-9a-f]{6}$/i.test(team.color) ? team.color : TEAM_COLORS[index],
      score: previous?.score ?? 0,
    };
  });
}

function addPlayer(room, socket, name, isHost = false) {
  const player = {
    id: randomBytes(10).toString("hex"),
    token: makeToken(),
    name: normalizedName(name),
    seat: room.players.length,
    teamId: null,
    hand: [],
    socket,
    connected: true,
  };
  room.players.push(player);
  if (isHost) room.hostId = player.id;
  clients.set(socket, { roomCode: room.code, playerId: player.id });
  send(socket, { type: "joined", roomCode: room.code, playerId: player.id, playerToken: player.token, host: isHost });
  return player;
}

function createRoom(socket, name, capacity, privacy, queuedPlayers = []) {
  let code = makeCode();
  while (rooms.has(code)) code = makeCode();
  const room = {
    code,
    privacy,
    capacity,
    hostId: null,
    players: [],
    teams: [],
    phase: "lobby",
    priorPhase: null,
    deck: [],
    discard: [],
    board: [],
    sequences: [],
    activePlayerId: null,
    winnerTeamId: null,
    createdAt: Date.now(),
    lastActivity: Date.now(),
  };
  rooms.set(code, room);
  addPlayer(room, socket, name, true);
  for (const queued of queuedPlayers) addPlayer(room, queued.socket, queued.name);
  broadcastRoom(room);
  return room;
}

function removeFromQueues(socket) {
  for (const [capacity, queue] of queues) {
    const remaining = queue.filter((entry) => entry.socket !== socket);
    if (remaining.length) queues.set(capacity, remaining);
    else queues.delete(capacity);
  }
}

function joinPublicQueue(socket, name, capacity) {
  if (!Number.isInteger(capacity) || capacity < 2 || capacity > 12) {
    sendError(socket, "Choose a player count between two and twelve.");
    return;
  }
  const playerName = normalizedName(name);
  if (!playerName) {
    sendError(socket, "Enter your player name first.");
    return;
  }
  removeFromQueues(socket);
  const queue = queues.get(capacity) ?? [];
  queue.push({ socket, name: playerName, joinedAt: Date.now() });
  queues.set(capacity, queue);
  send(socket, { type: "queueStatus", capacity, waiting: queue.length, needed: capacity - queue.length });
  while (queue.length >= capacity) {
    const group = queue.splice(0, capacity);
    if (!queue.length) queues.delete(capacity);
    else queues.set(capacity, queue);
    createRoom(group[0].socket, group[0].name, capacity, "public", group.slice(1));
  }
}

function playerFor(room, playerId) {
  return room.players.find((player) => player.id === playerId);
}

function stateFor(room, player) {
  return {
    type: "state",
    roomCode: room.code,
    privacy: room.privacy,
    capacity: room.capacity,
    phase: room.phase,
    priorPhase: room.priorPhase,
    hostId: room.hostId,
    viewerId: player.id,
    players: room.players.map((member) => ({
      id: member.id,
      name: member.name,
      seat: member.seat,
      teamId: member.teamId,
      handCount: member.hand.length,
      connected: member.connected,
    })),
    teams: room.teams.map((team) => ({ id: team.id, name: team.name, color: team.color, score: team.score })),
    board: room.board.map((tile) => ({ ...tile })),
    sequences: room.sequences.map((sequence) => ({ teamId: sequence.teamId, cells: [...sequence.cells] })),
    activePlayerId: room.activePlayerId,
    winnerTeamId: room.winnerTeamId,
    deckCount: room.deck.length,
    discardCount: room.discard.length,
    hand: room.phase === "playing" && room.activePlayerId === player.id ? player.hand.map((card) => ({ ...card })) : [],
    isHost: player.id === room.hostId,
    canStart: player.id === room.hostId && room.phase === "lobby" && room.players.length >= 2,
  };
}

function broadcastRoom(room) {
  room.lastActivity = Date.now();
  for (const player of room.players) {
    if (player.connected && player.socket) send(player.socket, stateFor(room, player));
  }
}

function applyTeamSetup(room, teams, assignments) {
  const problem = teamSetupValid(room, teams, assignments);
  if (problem) return problem;
  room.teams = makeTeams(teams, room.teams);
  room.players.forEach((player, index) => { player.teamId = assignments[index]; });
  return "";
}

function validateRoomCode(value) {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function joinRoom(socket, message) {
  const code = validateRoomCode(message.code);
  const room = rooms.get(code);
  if (!room) return sendError(socket, "That room link is invalid or expired.");
  const name = normalizedName(message.name);
  if (!name) return sendError(socket, "Enter your player name first.");
  const resumed = message.playerToken && room.players.find((player) => player.token === message.playerToken);
  if (resumed) {
    if (resumed.socket && resumed.socket !== socket) resumed.socket.close(4001, "Reconnected from another device");
    resumed.socket = socket;
    resumed.connected = true;
    clients.set(socket, { roomCode: code, playerId: resumed.id });
    send(socket, { type: "joined", roomCode: code, playerId: resumed.id, playerToken: resumed.token, host: resumed.id === room.hostId });
    broadcastRoom(room);
    return;
  }
  if (room.phase !== "lobby" || room.players.length >= room.capacity) return sendError(socket, "That room is full or the game has already started.");
  if (room.players.some((player) => player.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
    return sendError(socket, "That player name is already in this room.");
  }
  const player = addPlayer(room, socket, name);
  if (room.teams.length) {
    player.teamId = null;
    room.teams = [];
    room.players.forEach((member) => { member.teamId = null; });
  }
  broadcastRoom(room);
}

function updateTeamsFromMessage(room, message, player) {
  if (player.id !== room.hostId) return sendError(player.socket, "Only the room host can set teams.");
  if (room.phase !== "lobby" && room.phase !== "paused") return sendError(player.socket, "Pause the game before editing teams.");
  const problem = applyTeamSetup(room, message.teams, message.assignments);
  if (problem) return sendError(player.socket, problem);
  broadcastRoom(room);
}

function startGame(room, player, message) {
  if (player.id !== room.hostId) return sendError(player.socket, "Only the room host can start the game.");
  if (room.phase !== "lobby") return sendError(player.socket, "This game has already started.");
  if (room.players.length < 2) return sendError(player.socket, "At least two players are required.");
  if (room.privacy === "public" && room.players.length !== room.capacity) return sendError(player.socket, "The public match is not full yet.");
  const problem = applyTeamSetup(room, message.teams, message.assignments);
  if (problem) return sendError(player.socket, problem);
  const suggested = STANDARD_HANDS[room.players.length] ?? Number(message.handSize);
  const handSize = Number.isInteger(suggested) && suggested > 0 && suggested * room.players.length <= 104 ? suggested : 5;
  room.deck = shuffle(buildDeck());
  room.discard = [];
  room.board = buildBoard();
  room.sequences = [];
  for (let cardIndex = 0; cardIndex < handSize; cardIndex += 1) {
    for (const member of room.players) member.hand.push(room.deck.pop());
  }
  room.activePlayerId = room.players[0].id;
  room.phase = "playing";
  room.winnerTeamId = null;
  assertDeckIntegrity(room);
  broadcastRoom(room);
}

function restartGame(room, player) {
  if (player.id !== room.hostId) return sendError(player.socket, "Only the room host can restart the game.");
  if (!room.teams.length || room.players.some((member) => !member.teamId)) return sendError(player.socket, "Assign teams before restarting.");
  const handSize = room.handSize ?? STANDARD_HANDS[room.players.length] ?? 5;
  room.deck = shuffle(buildDeck());
  room.discard = [];
  room.board = buildBoard();
  room.sequences = [];
  room.winnerTeamId = null;
  room.teams.forEach((team) => { team.score = 0; });
  room.handSize = handSize;
  for (const member of room.players) member.hand = [];
  for (let cardIndex = 0; cardIndex < handSize; cardIndex += 1) {
    for (const member of room.players) member.hand.push(room.deck.pop());
  }
  room.activePlayerId = room.players[0].id;
  room.phase = "playing";
  broadcastRoom(room);
}

function endGame(room, player) {
  if (player.id !== room.hostId) return sendError(player.socket, "Only the room host can end the game.");
  room.phase = "ended";
  room.activePlayerId = null;
  room.deck = [];
  room.discard = [];
  room.board = [];
  room.players.forEach((member) => { member.hand = []; });
  broadcastRoom(room);
}

function shuffleRemaining(room, player) {
  if (player.id !== room.hostId) return sendError(player.socket, "Only the room host can shuffle the deck.");
  if (!room.deck.length && !room.discard.length) return sendError(player.socket, "There are no cards to shuffle.");
  room.deck = shuffle([...room.deck, ...room.discard]);
  room.discard = [];
  assertDeckIntegrity(room);
  broadcastRoom(room);
}

function sequenceLocked(room, index) {
  return room.sequences.some((sequence) => sequence.cells.includes(index));
}

function legalMoves(room, player, card) {
  if (card.jackType === "WILD") return room.board.filter((tile) => !tile.free && !tile.tokenTeamId).map((tile) => tile.index);
  if (card.jackType === "REMOVE") return room.board
    .filter((tile) => tile.tokenTeamId && tile.tokenTeamId !== player.teamId && !sequenceLocked(room, tile.index))
    .map((tile) => tile.index);
  return room.board
    .filter((tile) => !tile.free && !tile.tokenTeamId && tile.rank === card.rank && tile.suit === card.suit)
    .map((tile) => tile.index);
}

function completeSequences(room, teamId, placedIndex) {
  const directions = [[1, 0], [0, 1], [1, 1], [1, -1]];
  const found = [];
  for (const [rowStep, columnStep] of directions) {
    for (let row = 0; row < 10; row += 1) {
      for (let column = 0; column < 10; column += 1) {
        const cells = [];
        for (let offset = 0; offset < 5; offset += 1) {
          const nextRow = row + rowStep * offset;
          const nextColumn = column + columnStep * offset;
          if (nextRow < 0 || nextRow >= 10 || nextColumn < 0 || nextColumn >= 10) break;
          cells.push(nextRow * 10 + nextColumn);
        }
        if (cells.length !== 5 || !cells.includes(placedIndex)) continue;
        if (!cells.every((index) => room.board[index].free || room.board[index].tokenTeamId === teamId)) continue;
        const existing = [...room.sequences, ...found].filter((sequence) => sequence.teamId === teamId);
        if (existing.some((sequence) => sequence.cells.filter((index) => cells.includes(index)).length > 1)) continue;
        found.push({ teamId, cells });
      }
    }
  }
  if (found.length) {
    room.sequences.push(...found);
    const team = room.teams.find((item) => item.id === teamId);
    team.score += found.length;
    const goal = room.players.length >= 4 ? 2 : 1;
    if (team.score >= goal) {
      room.winnerTeamId = teamId;
      room.phase = "won";
    }
  }
}

function drawReplacement(room, player) {
  if (!room.deck.length) room.deck = shuffle(room.discard.splice(0));
  player.hand.push(room.deck.pop());
  if (!room.deck.length && room.discard.length) room.deck = shuffle(room.discard.splice(0));
}

function discardAndDraw(room, player, cardIndex) {
  if (!Number.isInteger(cardIndex) || cardIndex < 0 || cardIndex >= player.hand.length) return "Choose a card in your hand.";
  const card = player.hand.splice(cardIndex, 1)[0];
  room.discard.push(card);
  drawReplacement(room, player);
  return "";
}

function playCard(room, player, message) {
  if (room.phase !== "playing" || room.activePlayerId !== player.id) return sendError(player.socket, "It is not your turn.");
  const card = player.hand[message.cardIndex];
  if (!card) return sendError(player.socket, "Choose a card in your hand.");
  const moves = legalMoves(room, player, card);
  if (message.deadCard === true) {
    if (moves.length) return sendError(player.socket, "This card still has a legal board move.");
    const problem = discardAndDraw(room, player, message.cardIndex);
    if (problem) return sendError(player.socket, problem);
  } else {
    const tile = room.board[message.tileIndex];
    if (!tile || !moves.includes(tile.index)) return sendError(player.socket, "That is not a legal space for this card.");
    player.hand.splice(message.cardIndex, 1);
    room.discard.push(card);
    if (card.jackType === "REMOVE") tile.tokenTeamId = null;
    else {
      tile.tokenTeamId = player.teamId;
      completeSequences(room, player.teamId, tile.index);
    }
    drawReplacement(room, player);
  }
  if (room.phase !== "won") {
    const currentIndex = room.players.findIndex((member) => member.id === player.id);
    room.activePlayerId = room.players[(currentIndex + 1) % room.players.length].id;
  }
  assertDeckIntegrity(room);
  broadcastRoom(room);
}

export function assertDeckIntegrity(room) {
  const cards = [...room.deck, ...room.discard, ...room.players.flatMap((player) => player.hand)];
  if (cards.length !== 104 || new Set(cards.map((card) => card.id)).size !== 104) {
    throw new Error("Deck integrity check failed.");
  }
}

function pauseGame(room, player) {
  if (player.id !== room.hostId) return sendError(player.socket, "Only the room host can pause the game.");
  if (room.phase !== "playing") return sendError(player.socket, "Only an active game can be paused.");
  room.priorPhase = room.phase;
  room.phase = "paused";
  broadcastRoom(room);
}

function resumeGame(room, player) {
  if (player.id !== room.hostId || room.phase !== "paused") return sendError(player.socket, "Only the room host can resume this game.");
  room.phase = room.priorPhase ?? "playing";
  room.priorPhase = null;
  broadcastRoom(room);
}

function handleMessage(socket, payload) {
  const message = payload.toString();
  if (message.length > 16_384) return sendError(socket, "Message is too large.");
  let data;
  try { data = JSON.parse(message); } catch { return sendError(socket, "Invalid message format."); }
  if (!data || typeof data.type !== "string") return sendError(socket, "Message type is required.");

  if (data.type === "createPrivate") {
    const name = normalizedName(data.name);
    const capacity = Number(data.capacity);
    if (!name || !Number.isInteger(capacity) || capacity < 2 || capacity > 12) return sendError(socket, "Enter a name and a room size from two to twelve.");
    createRoom(socket, name, capacity, "private");
    return;
  }
  if (data.type === "joinPublic") {
    joinPublicQueue(socket, data.name, Number(data.capacity));
    return;
  }
  if (data.type === "joinRoom") return joinRoom(socket, data);

  const identity = clients.get(socket);
  const room = identity ? rooms.get(identity.roomCode) : null;
  const player = room ? playerFor(room, identity.playerId) : null;
  if (!room || !player || player.socket !== socket) return sendError(socket, "Join a room before sending game actions.");

  switch (data.type) {
    case "assignTeams": return updateTeamsFromMessage(room, data, player);
    case "start": return startGame(room, player, data);
    case "playCard": return playCard(room, player, data);
    case "pause": return pauseGame(room, player);
    case "resume": return resumeGame(room, player);
    case "restart": return restartGame(room, player);
    case "endGame": return endGame(room, player);
    case "shuffle": return shuffleRemaining(room, player);
    case "ping": return send(socket, { type: "pong", at: Date.now() });
    default: return sendError(socket, "Unknown game action.");
  }
}

export function createSequenceServer({ port = Number(process.env.PORT ?? 3000), host = process.env.HOST ?? "0.0.0.0" } = {}) {
  const httpServer = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ ok: true, service: "sequence-multiplayer", rooms: rooms.size }));
      return;
    }
    const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (request.method === "GET" && (requestUrl.pathname === "/" || requestUrl.pathname === "/index.html")) {
      const currentDir = dirname(fileURLToPath(import.meta.url));
      const htmlPath = existsSync(resolve(currentDir, "index.html"))
        ? resolve(currentDir, "index.html")
        : existsSync(resolve(currentDir, "../index.html"))
          ? resolve(currentDir, "../index.html")
          : resolve(currentDir, "../sequence.html");
      readFile(htmlPath).then((html) => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
        response.end(html);
      }).catch(() => {
        response.writeHead(404, { "content-type": "text/plain" });
        response.end("Sequence app entry file is missing.");
      });
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "Not found" }));
  });
  const allowedOrigins = new Set((process.env.ALLOWED_ORIGINS ?? "").split(",").map((origin) => origin.trim()).filter(Boolean));
  const socketServer = new WebSocketServer({
    server: httpServer,
    path: "/ws",
    maxPayload: 16_384,
    verifyClient: ({ origin, req }, done) => {
      if (!origin) return done(true);
      let originUrl;
      try { originUrl = new URL(origin); } catch { return done(false, 403, "Invalid origin"); }
      const sameOrigin = originUrl.host === req.headers.host;
      const localDevelopment = ["localhost", "127.0.0.1"].includes(originUrl.hostname);
      if (sameOrigin || localDevelopment || allowedOrigins.has(origin)) return done(true);
      done(false, 403, "Origin is not allowed");
    },
  });

  socketServer.on("connection", (socket) => {
    let messageWindow = Date.now();
    let messageCount = 0;
    socket.on("message", (payload) => {
      if (Date.now() - messageWindow > 10_000) {
        messageWindow = Date.now();
        messageCount = 0;
      }
      messageCount += 1;
      if (messageCount > 120) return sendError(socket, "Too many requests. Slow down.");
      try { handleMessage(socket, payload); } catch (error) {
        console.error("Sequence action failed", error);
        sendError(socket, "The game could not process that action.");
      }
    });
    socket.on("close", () => {
      removeFromQueues(socket);
      const identity = clients.get(socket);
      const room = identity ? rooms.get(identity.roomCode) : null;
      const player = room ? playerFor(room, identity.playerId) : null;
      if (!player || player.socket !== socket) return;
      player.connected = false;
      player.socket = null;
      broadcastRoom(room);
    });
  });

  const cleanup = setInterval(() => {
    const expiry = Date.now() - roomLifetimeMs;
    for (const [code, room] of rooms) {
      if (room.lastActivity < expiry && room.players.every((player) => !player.connected)) rooms.delete(code);
    }
  }, 60_000);
  cleanup.unref();

  return {
    httpServer,
    socketServer,
    listen() {
      return new Promise((resolve) => httpServer.listen(port, host, () => resolve(httpServer.address())));
    },
    close() {
      clearInterval(cleanup);
      for (const socket of socketServer.clients) socket.close();
      return new Promise((resolve) => httpServer.close(() => resolve()));
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const server = createSequenceServer();
  server.listen().then((address) => console.log(`Sequence multiplayer listening on ${address.address}:${address.port}`));
}