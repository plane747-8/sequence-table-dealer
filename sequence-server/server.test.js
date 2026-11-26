import assert from "node:assert/strict";
import { after, test } from "node:test";
import WebSocket from "ws";
import { buildBoard, buildDeck, createSequenceServer, hasAdjacentTeammates } from "./server.js";

test("the server deck has 104 unique physical cards and eight correctly classified Jacks", () => {
  const deck = buildDeck();
  assert.equal(deck.length, 104);
  assert.equal(new Set(deck.map((card) => card.id)).size, 104);
  const jacks = deck.filter((card) => card.rank === "J");
  assert.equal(jacks.length, 8);
  assert.equal(jacks.filter((card) => card.jackType === "WILD").length, 4);
  assert.equal(jacks.filter((card) => card.jackType === "REMOVE").length, 4);
});

test("the fixed board has four free corners and two copies of every non-Jack face", () => {
  const board = buildBoard();
  assert.equal(board.length, 100);
  assert.equal(board.filter((tile) => tile.free).length, 4);
  const counts = new Map();
  for (const tile of board.filter((item) => !item.free)) {
    const face = `${tile.rank}${tile.suit}`;
    counts.set(face, (counts.get(face) ?? 0) + 1);
  }
  assert.equal(counts.size, 48);
  assert.ok([...counts.values()].every((count) => count === 2));
  assert.deepEqual(board.slice(0, 10).map((tile) => tile.free ? "FREE" : `${tile.rank}${tile.suit}`), [
    "FREE", "2S", "3S", "4S", "5S", "6S", "7S", "8S", "9S", "FREE",
  ]);
});

test("seating validation rejects neighbors on both sides of the table", () => {
  assert.equal(hasAdjacentTeammates(["red", "blue", "red", "blue"]), false);
  assert.equal(hasAdjacentTeammates(["red", "red", "blue", "blue"]), true);
  assert.equal(hasAdjacentTeammates(["red", "blue", "green"]), false);
});

test("private room broadcasts only the active player's hand", async (context) => {
  const server = createSequenceServer({ port: 0, host: "127.0.0.1" });
  const address = await server.listen();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const health = await fetch(`${baseUrl}/health`).then((response) => response.json());
  assert.equal(health.ok, true);
  const html = await fetch(baseUrl).then((response) => response.text());
  assert.match(html, /Sequence Table Dealer/);

  const host = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
  const guest = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
  await Promise.all([onceOpen(host), onceOpen(guest)]);
  context.after(async () => {
    for (const socket of [host, guest]) if (socket.readyState === WebSocket.OPEN) socket.close();
    await Promise.all([onceClosed(host), onceClosed(guest)]);
    await server.close();
  });

  const hostJoinPromise = waitForMessage(host, (message) => message.type === "joined");
  host.send(JSON.stringify({ type: "createPrivate", name: "Nia", capacity: 2 }));
  const hostJoin = await hostJoinPromise;
  const roomCode = hostJoin.roomCode;

  const hostLobbyPromise = waitForMessage(host, (message) => message.type === "state" && message.players.length === 2);
  const guestJoinPromise = waitForMessage(guest, (message) => message.type === "joined");
  const guestLobbyPromise = waitForMessage(guest, (message) => message.type === "state" && message.players.length === 2);
  guest.send(JSON.stringify({ type: "joinRoom", code: roomCode, name: "Omar" }));
  const [hostLobby, guestJoin, guestLobby] = await Promise.all([hostLobbyPromise, guestJoinPromise, guestLobbyPromise]);
  assert.equal(guestJoin.host, false);
  assert.equal(hostLobby.phase, "lobby");
  assert.equal(guestLobby.phase, "lobby");

  const teams = [
    { id: "red", name: "Red Team", color: "#c65c5d" },
    { id: "blue", name: "Blue Team", color: "#628dc2" },
  ];
  const assignments = ["red", "blue"];
  const hostStartPromise = waitForMessage(host, (message) => message.type === "state" && message.phase === "playing");
  const guestStartPromise = waitForMessage(guest, (message) => message.type === "state" && message.phase === "playing");
  host.send(JSON.stringify({ type: "start", teams, assignments }));
  const [hostStart, guestStart] = await Promise.all([hostStartPromise, guestStartPromise]);
  assert.equal(hostStart.hand.length, 7);
  assert.equal(guestStart.hand.length, 7);
  assert.equal(guestStart.activePlayerId, hostStart.viewerId);
  assert.equal(new Set([...hostStart.hand, ...guestStart.hand].map((card) => card.id)).size, 14);
  assert.ok(hostStart.players.every((player) => !("hand" in player)));

  const cardIndex = hostStart.hand.findIndex((card) => !card.jackType);
  const card = hostStart.hand[cardIndex];
  const tileIndex = hostStart.board.find((tile) => !tile.free && !tile.tokenTeamId && tile.rank === card.rank && tile.suit === card.suit).index;
  const hostNextPromise = waitForMessage(host, (message) => message.type === "state" && message.phase === "playing" && message.activePlayerId !== hostStart.viewerId);
  const guestNextPromise = waitForMessage(guest, (message) => message.type === "state" && message.phase === "playing" && message.activePlayerId === message.viewerId);
  host.send(JSON.stringify({ type: "playCard", cardIndex, tileIndex }));
  const [hostNext, guestNext] = await Promise.all([hostNextPromise, guestNextPromise]);
  assert.equal(hostNext.hand.length, 7);
  assert.equal(guestNext.hand.length, 7);
  assert.equal(new Set([...hostNext.hand, ...guestNext.hand].map((card) => card.id)).size, 14);
  assert.equal(hostNext.discardCount, 1);
  assert.equal(hostNext.deckCount, 89);
  assert.equal(guestNext.board[tileIndex].tokenTeamId, "red");
});

test("public matchmaking only combines players in the same requested queue size", async (context) => {
  const server = createSequenceServer({ port: 0, host: "127.0.0.1" });
  const address = await server.listen();
  const sockets = [2, 3, 4].map(() => new WebSocket(`ws://127.0.0.1:${address.port}/ws`));
  await Promise.all(sockets.map(onceOpen));
  context.after(async () => {
    for (const socket of sockets) if (socket.readyState === WebSocket.OPEN) socket.close();
    await Promise.all(sockets.map(onceClosed));
    await server.close();
  });

  const [twoPlayer, threePlayer, secondTwoPlayer] = sockets;
  const twoQueuePromise = waitForMessage(twoPlayer, (message) => message.type === "queueStatus");
  twoPlayer.send(JSON.stringify({ type: "joinPublic", name: "One", capacity: 2 }));
  assert.equal((await twoQueuePromise).waiting, 1);
  const threeQueuePromise = waitForMessage(threePlayer, (message) => message.type === "queueStatus");
  threePlayer.send(JSON.stringify({ type: "joinPublic", name: "Three", capacity: 3 }));
  assert.equal((await threeQueuePromise).waiting, 1);

  const firstJoined = waitForMessage(twoPlayer, (message) => message.type === "joined");
  const secondJoined = waitForMessage(secondTwoPlayer, (message) => message.type === "joined");
  const firstState = waitForMessage(twoPlayer, (message) => message.type === "state");
  const secondState = waitForMessage(secondTwoPlayer, (message) => message.type === "state");
  secondTwoPlayer.send(JSON.stringify({ type: "joinPublic", name: "Two", capacity: 2 }));
  const [, , match, guestMatch] = await Promise.all([
    firstJoined,
    secondJoined,
    firstState,
    secondState,
  ]);
  assert.equal(match.privacy, "public");
  assert.equal(match.capacity, 2);
  assert.equal(match.players.length, 2);
  assert.equal(guestMatch.players.length, 2);
  assert.ok(match.players.every((player) => player.name !== "Three"));
});

function onceOpen(socket) {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

function onceClosed(socket) {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => socket.once("close", resolve));
}

function waitForMessage(socket, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error("Timed out waiting for a matching server message."));
    }, 5000);
    function onMessage(payload) {
      let message;
      try { message = JSON.parse(payload.toString()); } catch { return; }
      if (message.type === "error") {
        clearTimeout(timer);
        socket.off("message", onMessage);
        reject(new Error(message.message));
        return;
      }
      if (!predicate(message)) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(message);
    }
    socket.on("message", onMessage);
  });
}