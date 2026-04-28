import { Chess } from "chess.js";
import type { Server, Socket } from "socket.io";

type Color = "white" | "black";
type Side = { userId: string; username: string; socketId: string };
type Game = {
  id: string;
  white: Side;
  black: Side;
  chess: Chess;
  status: "in_progress" | "finished";
  startedAt: Date;
};

const games = new Map<string, Game>();
const queue: Side[] = [];
const userToGame = new Map<string, string>();

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
  };
}

function finalize(io: Server, game: Game, result: { winner: Color | null; reason: string }) {
  game.status = "finished";
  io.to(game.id).emit("game:over", result);
  setTimeout(() => {
    userToGame.delete(game.white.userId);
    userToGame.delete(game.black.userId);
    games.delete(game.id);
  }, 60_000);
}

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

      if (game.chess.isGameOver()) {
        let result: { winner: Color | null; reason: string };
        if (game.chess.isCheckmate()) {
          result = {
            winner: game.chess.turn() === "w" ? "black" : "white",
            reason: "checkmate",
          };
        } else if (game.chess.isStalemate()) {
          result = { winner: null, reason: "stalemate" };
        } else if (game.chess.isThreefoldRepetition()) {
          result = { winner: null, reason: "threefold_repetition" };
        } else if (game.chess.isInsufficientMaterial()) {
          result = { winner: null, reason: "insufficient_material" };
        } else {
          result = { winner: null, reason: "draw" };
        }
        finalize(io, game, result);
      }
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

  socket.on("disconnect", () => {
    const i = queue.findIndex((q) => q.userId === user.id);
    if (i >= 0) queue.splice(i, 1);
    const gameId = userToGame.get(user.id);
    if (gameId) {
      const game = games.get(gameId);
      if (game && game.status === "in_progress") {
        socket.to(gameId).emit("game:opponent_disconnected");
      }
    }
  });
}

export const __debug = { games, queue, userToGame };
