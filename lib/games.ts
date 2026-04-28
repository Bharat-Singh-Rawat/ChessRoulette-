import { Chess } from "chess.js";
import type { Server, Socket } from "socket.io";
import { prisma } from "./db";
import { computeNewRatings, type EloOutcome } from "./elo";
import { parsePreferences, nameForId } from "./openings";
import {
  TOKENS_PER_CASUAL_MATCH,
  TOKENS_FOR_BULLET_WIN,
  BULLET_TIME_MS,
} from "./economy";

type Color = "white" | "black";
type Mode = "casual" | "bullet";
type Side = {
  userId: string;
  username: string;
  socketId: string;
  preferences: string[];
};
type Clocks = { whiteMs: number; blackMs: number; lastUpdateAt: number };
type Game = {
  id: string;
  mode: Mode;
  white: Side;
  black: Side;
  chess: Chess;
  status: "in_progress" | "finished";
  startedAt: Date;
  vsBot?: boolean;
  matchedOpening?: string;
  clocks?: Clocks;
  flagTimer?: NodeJS.Timeout;
};

const games = new Map<string, Game>();
const casualQueue: Side[] = [];
const bulletQueue: Side[] = [];
const userToGame = new Map<string, string>();

const BOT_USER_ID = "bot:random";
const BOT_USERNAME = "ChessBot";

function colorFor(game: Game, userId: string): Color | null {
  if (game.white.userId === userId) return "white";
  if (game.black.userId === userId) return "black";
  return null;
}

// --- Clocks --------------------------------------------------------------
function snapshotClocks(game: Game): Clocks | null {
  if (!game.clocks) return null;
  // Return a snapshot with active-player time decremented by elapsed since last update.
  const now = Date.now();
  const elapsed = now - game.clocks.lastUpdateAt;
  const turn = game.chess.turn() === "w" ? "white" : "black";
  return {
    whiteMs: turn === "white" ? Math.max(0, game.clocks.whiteMs - elapsed) : game.clocks.whiteMs,
    blackMs: turn === "black" ? Math.max(0, game.clocks.blackMs - elapsed) : game.clocks.blackMs,
    lastUpdateAt: now,
  };
}

function applyClockOnMove(game: Game): boolean {
  // Returns true if active player still has time, false if they flagged.
  if (!game.clocks) return true;
  const now = Date.now();
  const elapsed = now - game.clocks.lastUpdateAt;
  const turnBeforeMove = game.chess.history().length % 2 === 0 ? "white" : "black";
  // turnBeforeMove is whoever was on move *before* the move was applied. But we
  // call this AFTER game.chess.move(...), so chess.turn() is now the OTHER side.
  // Easier: use the inverse of current turn.
  const moverColor = game.chess.turn() === "w" ? "black" : "white";
  const moverKey = moverColor === "white" ? "whiteMs" : "blackMs";
  game.clocks[moverKey] = Math.max(0, game.clocks[moverKey] - elapsed);
  game.clocks.lastUpdateAt = now;
  return game.clocks[moverKey] > 0;
}

function scheduleFlagFall(io: Server, game: Game) {
  if (game.flagTimer) {
    clearTimeout(game.flagTimer);
    game.flagTimer = undefined;
  }
  if (!game.clocks || game.status !== "in_progress") return;
  const turn = game.chess.turn() === "w" ? "white" : "black";
  const remaining = turn === "white" ? game.clocks.whiteMs : game.clocks.blackMs;
  game.flagTimer = setTimeout(() => {
    if (game.status !== "in_progress" || !game.clocks) return;
    const now = Date.now();
    const t = game.chess.turn() === "w" ? "white" : "black";
    const r =
      (t === "white" ? game.clocks.whiteMs : game.clocks.blackMs) -
      (now - game.clocks.lastUpdateAt);
    if (r <= 0) {
      finalize(io, game, {
        winner: t === "white" ? "black" : "white",
        reason: "time",
      });
    } else {
      // Race: not flagged yet, reschedule.
      scheduleFlagFall(io, game);
    }
  }, remaining + 50);
}

// --- Broadcasting --------------------------------------------------------
function pushGameState(
  io: Server,
  game: Game,
  lastMove?: { from: string; to: string; san: string },
) {
  io.to(game.id).emit("game:state", {
    fen: game.chess.fen(),
    turn: game.chess.turn() === "w" ? "white" : "black",
    lastMove,
    clocks: snapshotClocks(game),
  });
}

function matchFoundPayload(game: Game, color: Color) {
  const opp = color === "white" ? game.black : game.white;
  return {
    gameId: game.id,
    color,
    opponent: { id: opp.userId, username: opp.username },
    fen: game.chess.fen(),
    turn: game.chess.turn() === "w" ? ("white" as const) : ("black" as const),
    vsBot: !!game.vsBot,
    mode: game.mode,
    matchedOpening: game.matchedOpening
      ? { id: game.matchedOpening, name: nameForId(game.matchedOpening) }
      : null,
    clocks: snapshotClocks(game),
  };
}

function detectGameOver(game: Game): { winner: Color | null; reason: string } | null {
  if (!game.chess.isGameOver()) return null;
  if (game.chess.isCheckmate()) {
    return { winner: game.chess.turn() === "w" ? "black" : "white", reason: "checkmate" };
  }
  if (game.chess.isStalemate()) return { winner: null, reason: "stalemate" };
  if (game.chess.isThreefoldRepetition()) return { winner: null, reason: "threefold_repetition" };
  if (game.chess.isInsufficientMaterial()) return { winner: null, reason: "insufficient_material" };
  return { winner: null, reason: "draw" };
}

function finalize(io: Server, game: Game, result: { winner: Color | null; reason: string }) {
  if (game.status === "finished") return;
  game.status = "finished";
  if (game.flagTimer) {
    clearTimeout(game.flagTimer);
    game.flagTimer = undefined;
  }

  setTimeout(() => {
    userToGame.delete(game.white.userId);
    userToGame.delete(game.black.userId);
    games.delete(game.id);
  }, 60_000);

  if (game.vsBot) {
    io.to(game.id).emit("game:over", result);
    return;
  }

  void (async () => {
    try {
      const outcome: EloOutcome =
        result.winner === "white" ? "white_wins" : result.winner === "black" ? "black_wins" : "draw";

      const [whiteUser, blackUser] = await Promise.all([
        prisma.user.findUnique({
          where: { id: game.white.userId },
          select: { rating: true, tokens: true },
        }),
        prisma.user.findUnique({
          where: { id: game.black.userId },
          select: { rating: true, tokens: true },
        }),
      ]);
      if (!whiteUser || !blackUser) {
        io.to(game.id).emit("game:over", result);
        return;
      }

      const r = computeNewRatings(whiteUser.rating, blackUser.rating, outcome);

      const whiteWon = result.winner === "white";
      const blackWon = result.winner === "black";
      const drew = result.winner === null;

      // Bullet bonus for the winner only (no bonus on draws).
      const bulletBonusWhite = game.mode === "bullet" && whiteWon ? TOKENS_FOR_BULLET_WIN : 0;
      const bulletBonusBlack = game.mode === "bullet" && blackWon ? TOKENS_FOR_BULLET_WIN : 0;

      await prisma.$transaction([
        prisma.user.update({
          where: { id: game.white.userId },
          data: {
            rating: r.whiteRating,
            wins: { increment: whiteWon ? 1 : 0 },
            losses: { increment: blackWon ? 1 : 0 },
            draws: { increment: drew ? 1 : 0 },
            tokens: { increment: bulletBonusWhite },
          },
        }),
        prisma.user.update({
          where: { id: game.black.userId },
          data: {
            rating: r.blackRating,
            wins: { increment: blackWon ? 1 : 0 },
            losses: { increment: whiteWon ? 1 : 0 },
            draws: { increment: drew ? 1 : 0 },
            tokens: { increment: bulletBonusBlack },
          },
        }),
        prisma.game.create({
          data: {
            whiteId: game.white.userId,
            blackId: game.black.userId,
            result: outcome,
            reason: result.reason,
            whiteRatingBefore: whiteUser.rating,
            blackRatingBefore: blackUser.rating,
            whiteRatingAfter: r.whiteRating,
            blackRatingAfter: r.blackRating,
          },
        }),
      ]);

      io.to(game.id).emit("game:over", {
        ...result,
        ratingChange: {
          white: r.whiteDelta,
          black: r.blackDelta,
          whiteRating: r.whiteRating,
          blackRating: r.blackRating,
        },
        tokenChange: {
          white: bulletBonusWhite,
          black: bulletBonusBlack,
        },
      });
    } catch (err) {
      console.error("[games] rating/token update failed", err);
      io.to(game.id).emit("game:over", result);
    }
  })();
}

// --- Bot ----------------------------------------------------------------
function pickBotMove(chess: Chess): { from: string; to: string; promotion?: string } | null {
  const moves = chess.moves({ verbose: true });
  if (!moves.length) return null;
  const score = (m: (typeof moves)[number]) =>
    (m.captured ? 5 : 0) + (m.flags.includes("p") ? 2 : 0) + Math.random();
  moves.sort((a, b) => score(b) - score(a));
  const m = moves[0];
  return { from: m.from, to: m.to, promotion: m.promotion };
}

function maybeBotMove(io: Server, game: Game) {
  if (!game.vsBot || game.status !== "in_progress") return;
  const turnColor: Color = game.chess.turn() === "w" ? "white" : "black";
  const botIsWhite = game.white.userId === BOT_USER_ID;
  const botColor: Color = botIsWhite ? "white" : "black";
  if (turnColor !== botColor) return;
  const delay = 500 + Math.floor(Math.random() * 800);
  setTimeout(() => {
    if (game.status !== "in_progress") return;
    if ((game.chess.turn() === "w" ? "white" : "black") !== botColor) return;
    const choice = pickBotMove(game.chess);
    if (!choice) return;
    const result = game.chess.move({ ...choice, promotion: choice.promotion ?? "q" });
    if (!result) return;
    pushGameState(io, game, { from: result.from, to: result.to, san: result.san });
    const over = detectGameOver(game);
    if (over) finalize(io, game, over);
  }, delay);
}

// ------------------------------------------------------------------------

async function loadPreferences(userId: string): Promise<string[]> {
  const row = await prisma.user
    .findUnique({ where: { id: userId }, select: { preferredOpenings: true } })
    .catch(() => null);
  return parsePreferences(row?.preferredOpenings);
}

function startMatch(
  io: Server,
  newcomer: Side,
  partner: Side,
  mode: Mode,
  matchedOpening: string | undefined,
): Game {
  const newcomerIsWhite = Math.random() < 0.5;
  const white = newcomerIsWhite ? newcomer : partner;
  const black = newcomerIsWhite ? partner : newcomer;
  const gameId = `g_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const game: Game = {
    id: gameId,
    mode,
    white,
    black,
    chess: new Chess(),
    status: "in_progress",
    startedAt: new Date(),
    matchedOpening,
  };
  if (mode === "bullet") {
    game.clocks = {
      whiteMs: BULLET_TIME_MS,
      blackMs: BULLET_TIME_MS,
      lastUpdateAt: Date.now(),
    };
    scheduleFlagFall(io, game);
  }
  games.set(gameId, game);
  userToGame.set(white.userId, gameId);
  userToGame.set(black.userId, gameId);

  const whiteSock = io.sockets.sockets.get(white.socketId);
  const blackSock = io.sockets.sockets.get(black.socketId);
  whiteSock?.join(gameId);
  blackSock?.join(gameId);

  whiteSock?.emit("match:found", matchFoundPayload(game, "white"));
  blackSock?.emit("match:found", matchFoundPayload(game, "black"));

  return game;
}

function debitCasualTokens(game: Game) {
  if (game.mode !== "casual" || game.vsBot) return;
  void prisma
    .$transaction([
      prisma.user.update({
        where: { id: game.white.userId },
        data: { tokens: { decrement: TOKENS_PER_CASUAL_MATCH } },
      }),
      prisma.user.update({
        where: { id: game.black.userId },
        data: { tokens: { decrement: TOKENS_PER_CASUAL_MATCH } },
      }),
    ])
    .catch((err) => console.error("[games] token debit failed", err));
}

export function handleConnection(io: Server, socket: Socket) {
  const user = socket.data.user as { id: string; username: string };

  function resumeIfActive(): boolean {
    const existingGameId = userToGame.get(user.id);
    const existing = existingGameId ? games.get(existingGameId) : null;
    if (existing && existing.status === "in_progress") {
      const youAre = colorFor(existing, user.id);
      if (!youAre) return false;
      if (youAre === "white") existing.white.socketId = socket.id;
      else existing.black.socketId = socket.id;
      socket.join(existing.id);
      socket.emit("match:found", matchFoundPayload(existing, youAre));
      return true;
    }
    return false;
  }

  socket.on("queue:join", async () => {
    if (resumeIfActive()) return;

    // Already queued?
    const idx = casualQueue.findIndex((q) => q.userId === user.id);
    if (idx >= 0) {
      casualQueue[idx].socketId = socket.id;
      socket.emit("queue:waiting", { position: idx + 1 });
      return;
    }

    // Token check
    const u = await prisma.user
      .findUnique({ where: { id: user.id }, select: { tokens: true } })
      .catch(() => null);
    if (!u || u.tokens < TOKENS_PER_CASUAL_MATCH) {
      socket.emit("queue:rejected", {
        reason: "out_of_tokens",
        message: "Out of tokens. Win a bullet game to earn 10.",
      });
      return;
    }

    const preferences = await loadPreferences(user.id);
    const newcomer: Side = {
      userId: user.id,
      username: user.username,
      socketId: socket.id,
      preferences,
    };

    let partnerIdx = -1;
    if (preferences.length > 0) {
      partnerIdx = casualQueue.findIndex((q) =>
        q.preferences.some((p) => preferences.includes(p)),
      );
    }
    if (partnerIdx === -1 && casualQueue.length > 0) partnerIdx = 0;

    if (partnerIdx >= 0) {
      const partner = casualQueue.splice(partnerIdx, 1)[0]!;
      const overlap = newcomer.preferences.find((p) => partner.preferences.includes(p));
      const game = startMatch(io, newcomer, partner, "casual", overlap);
      debitCasualTokens(game);
    } else {
      casualQueue.push(newcomer);
      socket.emit("queue:waiting", { position: casualQueue.length });
    }
  });

  socket.on("queue:join_bullet", () => {
    if (resumeIfActive()) return;

    const idx = bulletQueue.findIndex((q) => q.userId === user.id);
    if (idx >= 0) {
      bulletQueue[idx].socketId = socket.id;
      socket.emit("queue:waiting", { position: idx + 1 });
      return;
    }

    const newcomer: Side = {
      userId: user.id,
      username: user.username,
      socketId: socket.id,
      preferences: [],
    };

    if (bulletQueue.length > 0) {
      const partner = bulletQueue.shift()!;
      startMatch(io, newcomer, partner, "bullet", undefined);
    } else {
      bulletQueue.push(newcomer);
      socket.emit("queue:waiting", { position: bulletQueue.length });
    }
  });

  socket.on("queue:leave", () => {
    for (const q of [casualQueue, bulletQueue]) {
      const i = q.findIndex((x) => x.userId === user.id);
      if (i >= 0) q.splice(i, 1);
    }
  });

  socket.on("queue:join_bot", () => {
    if (resumeIfActive()) return;
    socket.emit("queue:leave"); // also drop from real queues if waiting
    for (const q of [casualQueue, bulletQueue]) {
      const i = q.findIndex((x) => x.userId === user.id);
      if (i >= 0) q.splice(i, 1);
    }

    const humanIsWhite = Math.random() < 0.5;
    const human: Side = { userId: user.id, username: user.username, socketId: socket.id, preferences: [] };
    const bot: Side = { userId: BOT_USER_ID, username: BOT_USERNAME, socketId: "", preferences: [] };
    const white = humanIsWhite ? human : bot;
    const black = humanIsWhite ? bot : human;
    const gameId = `g_bot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const game: Game = {
      id: gameId,
      mode: "casual",
      white,
      black,
      chess: new Chess(),
      status: "in_progress",
      startedAt: new Date(),
      vsBot: true,
    };
    games.set(gameId, game);
    userToGame.set(user.id, gameId);
    socket.join(gameId);
    socket.emit("match:found", matchFoundPayload(game, humanIsWhite ? "white" : "black"));
    maybeBotMove(io, game);
  });

  socket.on(
    "game:move",
    (payload: { gameId: string; from: string; to: string; promotion?: string }) => {
      const game = games.get(payload.gameId);
      if (!game || game.status !== "in_progress") {
        return socket.emit("error", { message: "Game not found" });
      }
      const youAre = colorFor(game, user.id);
      if (!youAre) return socket.emit("error", { message: "Not your game" });

      const turn = game.chess.turn() === "w" ? "white" : "black";
      if (turn !== youAre) return socket.emit("error", { message: "Not your turn" });

      let move;
      try {
        move = game.chess.move({
          from: payload.from,
          to: payload.to,
          promotion: payload.promotion ?? "q",
        });
      } catch {
        return socket.emit("error", { message: "Invalid move" });
      }
      if (!move) return socket.emit("error", { message: "Invalid move" });

      // Update clocks for bullet, then check flag fall
      if (game.mode === "bullet") {
        const stillHasTime = applyClockOnMove(game);
        if (!stillHasTime) {
          // Mover ran out of time as their move arrived. Treat as time loss.
          finalize(io, game, { winner: youAre === "white" ? "black" : "white", reason: "time" });
          return;
        }
      }

      pushGameState(io, game, { from: move.from, to: move.to, san: move.san });

      const over = detectGameOver(game);
      if (over) {
        finalize(io, game, over);
        return;
      }

      if (game.mode === "bullet") scheduleFlagFall(io, game);
      maybeBotMove(io, game);
    },
  );

  socket.on("game:resign", (payload: { gameId: string }) => {
    const game = games.get(payload.gameId);
    if (!game || game.status !== "in_progress") return;
    const youAre = colorFor(game, user.id);
    if (!youAre) return;
    finalize(io, game, {
      winner: youAre === "white" ? "black" : "white",
      reason: "resignation",
    });
  });

  // --- WebRTC signaling relay --------------------------------------------
  function relayIfInGame(gameId: string, event: string, payload: unknown) {
    const game = games.get(gameId);
    if (!game || game.status !== "in_progress") return;
    if (game.vsBot) return;
    if (!colorFor(game, user.id)) return;
    socket.to(gameId).emit(event, payload);
  }

  socket.on("webrtc:offer", (p: { gameId: string; sdp: RTCSessionDescriptionInit }) =>
    relayIfInGame(p.gameId, "webrtc:offer", { sdp: p.sdp }),
  );
  socket.on("webrtc:answer", (p: { gameId: string; sdp: RTCSessionDescriptionInit }) =>
    relayIfInGame(p.gameId, "webrtc:answer", { sdp: p.sdp }),
  );
  socket.on("webrtc:ice", (p: { gameId: string; candidate: RTCIceCandidateInit }) =>
    relayIfInGame(p.gameId, "webrtc:ice", { candidate: p.candidate }),
  );

  socket.on("disconnect", () => {
    for (const q of [casualQueue, bulletQueue]) {
      const i = q.findIndex((x) => x.userId === user.id);
      if (i >= 0) q.splice(i, 1);
    }
    const gameId = userToGame.get(user.id);
    if (gameId) {
      const game = games.get(gameId);
      if (game && game.status === "in_progress" && !game.vsBot) {
        socket.to(gameId).emit("game:opponent_disconnected");
      }
    }
  });
}

export const __debug = { games, casualQueue, bulletQueue, userToGame };
