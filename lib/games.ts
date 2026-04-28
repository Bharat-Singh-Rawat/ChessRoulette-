import { Chess } from "chess.js";
import type { Server, Socket } from "socket.io";
import { prisma } from "./db";
import { computeNewRatings, type EloOutcome } from "./elo";

type Color = "white" | "black";
type Side = { userId: string; username: string; socketId: string };
type Game = {
  id: string;
  white: Side;
  black: Side;
  chess: Chess;
  status: "in_progress" | "finished";
  startedAt: Date;
  vsBot?: boolean;
};

const games = new Map<string, Game>();
const queue: Side[] = [];
const userToGame = new Map<string, string>();

const BOT_USER_ID = "bot:random";
const BOT_USERNAME = "ChessBot";

function colorFor(game: Game, userId: string): Color | null {
  if (game.white.userId === userId) return "white";
  if (game.black.userId === userId) return "black";
  return null;
}

function pushGameState(io: Server, game: Game, lastMove?: { from: string; to: string; san: string }) {
  io.to(game.id).emit("game:state", {
    fen: game.chess.fen(),
    turn: game.chess.turn() === "w" ? "white" : "black",
    lastMove,
  });
}

function matchFoundPayload(game: Game, color: Color) {
  const opp = color === "white" ? game.black : game.white;
  return {
    gameId: game.id,
    color,
    opponent: { username: opp.username },
    fen: game.chess.fen(),
    turn: game.chess.turn() === "w" ? ("white" as const) : ("black" as const),
    vsBot: !!game.vsBot,
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

  // Schedule cleanup regardless of how DB persistence goes.
  setTimeout(() => {
    userToGame.delete(game.white.userId);
    userToGame.delete(game.black.userId);
    games.delete(game.id);
  }, 60_000);

  // Bot games don't affect ratings or get persisted.
  if (game.vsBot) {
    io.to(game.id).emit("game:over", result);
    return;
  }

  // Persist + update ratings, then broadcast with the rating delta.
  void (async () => {
    try {
      const outcome: EloOutcome =
        result.winner === "white"
          ? "white_wins"
          : result.winner === "black"
            ? "black_wins"
            : "draw";

      const [whiteUser, blackUser] = await Promise.all([
        prisma.user.findUnique({
          where: { id: game.white.userId },
          select: { rating: true },
        }),
        prisma.user.findUnique({
          where: { id: game.black.userId },
          select: { rating: true },
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

      await prisma.$transaction([
        prisma.user.update({
          where: { id: game.white.userId },
          data: {
            rating: r.whiteRating,
            wins: { increment: whiteWon ? 1 : 0 },
            losses: { increment: blackWon ? 1 : 0 },
            draws: { increment: drew ? 1 : 0 },
          },
        }),
        prisma.user.update({
          where: { id: game.black.userId },
          data: {
            rating: r.blackRating,
            wins: { increment: blackWon ? 1 : 0 },
            losses: { increment: whiteWon ? 1 : 0 },
            draws: { increment: drew ? 1 : 0 },
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
      });
    } catch (err) {
      console.error("[games] rating update failed", err);
      io.to(game.id).emit("game:over", result);
    }
  })();
}

// --- Bot ----------------------------------------------------------------
function pickBotMove(chess: Chess): { from: string; to: string; promotion?: string } | null {
  const moves = chess.moves({ verbose: true });
  if (!moves.length) return null;
  // Slightly biased random: prefer captures and checks over plain moves.
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

export function handleConnection(io: Server, socket: Socket) {
  const user = socket.data.user as { id: string; username: string };

  socket.on("queue:join", () => {
    // If user already has an active game, resume it
    const existingGameId = userToGame.get(user.id);
    const existing = existingGameId ? games.get(existingGameId) : null;
    if (existing && existing.status === "in_progress") {
      const youAre = colorFor(existing, user.id);
      if (!youAre) return;
      if (youAre === "white") existing.white.socketId = socket.id;
      else existing.black.socketId = socket.id;
      socket.join(existing.id);
      socket.emit("match:found", matchFoundPayload(existing, youAre));
      return;
    }

    // Already queued?
    const existingIdx = queue.findIndex((q) => q.userId === user.id);
    if (existingIdx >= 0) {
      queue[existingIdx].socketId = socket.id;
      socket.emit("queue:waiting", { position: existingIdx + 1 });
      return;
    }

    queue.push({ userId: user.id, username: user.username, socketId: socket.id });

    if (queue.length >= 2) {
      const a = queue.shift()!;
      const b = queue.shift()!;
      const aIsWhite = Math.random() < 0.5;
      const white = aIsWhite ? a : b;
      const black = aIsWhite ? b : a;
      const gameId = `g_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const chess = new Chess();
      const game: Game = {
        id: gameId,
        white,
        black,
        chess,
        status: "in_progress",
        startedAt: new Date(),
      };
      games.set(gameId, game);
      userToGame.set(white.userId, gameId);
      userToGame.set(black.userId, gameId);

      const whiteSock = io.sockets.sockets.get(white.socketId);
      const blackSock = io.sockets.sockets.get(black.socketId);
      whiteSock?.join(gameId);
      blackSock?.join(gameId);

      whiteSock?.emit("match:found", matchFoundPayload(game, "white"));
      blackSock?.emit("match:found", matchFoundPayload(game, "black"));
    } else {
      socket.emit("queue:waiting", { position: queue.length });
    }
  });

  socket.on("queue:leave", () => {
    const i = queue.findIndex((q) => q.userId === user.id);
    if (i >= 0) queue.splice(i, 1);
  });

  socket.on("queue:join_bot", () => {
    // If user already has an active game, just resume it instead of starting a new one.
    const existingGameId = userToGame.get(user.id);
    const existing = existingGameId ? games.get(existingGameId) : null;
    if (existing && existing.status === "in_progress") {
      const youAre = colorFor(existing, user.id);
      if (!youAre) return;
      if (youAre === "white") existing.white.socketId = socket.id;
      else existing.black.socketId = socket.id;
      socket.join(existing.id);
      socket.emit("match:found", matchFoundPayload(existing, youAre));
      return;
    }

    // Drop from queue if waiting.
    const qi = queue.findIndex((q) => q.userId === user.id);
    if (qi >= 0) queue.splice(qi, 1);

    const humanIsWhite = Math.random() < 0.5;
    const human: Side = { userId: user.id, username: user.username, socketId: socket.id };
    const bot: Side = { userId: BOT_USER_ID, username: BOT_USERNAME, socketId: "" };
    const white = humanIsWhite ? human : bot;
    const black = humanIsWhite ? bot : human;
    const gameId = `g_bot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const chess = new Chess();
    const game: Game = {
      id: gameId,
      white,
      black,
      chess,
      status: "in_progress",
      startedAt: new Date(),
      vsBot: true,
    };
    games.set(gameId, game);
    userToGame.set(user.id, gameId);
    socket.join(gameId);
    socket.emit("match:found", matchFoundPayload(game, humanIsWhite ? "white" : "black"));

    // If bot is white, it moves first.
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

      pushGameState(io, game, { from: move.from, to: move.to, san: move.san });

      const over = detectGameOver(game);
      if (over) {
        finalize(io, game, over);
        return;
      }

      // If playing a bot, schedule the bot's reply.
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
  // We don't inspect payloads — just forward to the other peer in the room.
  // Authorization comes from the socket already being authed and the gameId
  // belonging to the user (verified before relay).
  function relayIfInGame(gameId: string, event: string, payload: unknown) {
    const game = games.get(gameId);
    if (!game || game.status !== "in_progress") return;
    if (game.vsBot) return; // bot has no peer to receive
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
    const i = queue.findIndex((q) => q.userId === user.id);
    if (i >= 0) queue.splice(i, 1);
    const gameId = userToGame.get(user.id);
    if (gameId) {
      const game = games.get(gameId);
      if (game && game.status === "in_progress" && !game.vsBot) {
        socket.to(gameId).emit("game:opponent_disconnected");
      }
    }
  });
}

export const __debug = { games, queue, userToGame };
