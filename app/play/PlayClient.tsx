"use client";

import { useEffect, useRef, useState } from "react";
import { Chess } from "chess.js";
import { Chessboard } from "react-chessboard";
import { io, Socket } from "socket.io-client";

type Phase = "idle" | "queueing" | "playing" | "over";
type Color = "white" | "black";
type GameInfo = {
  gameId: string;
  color: Color;
  opponent: { username: string };
  fen: string;
  turn: Color;
};
type GameState = {
  fen: string;
  turn: Color;
  lastMove?: { from: string; to: string; san: string };
};
type GameResult = { winner: Color | null; reason: string };

export default function PlayClient({ username }: { username: string }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [game, setGame] = useState<GameInfo | null>(null);
  const [state, setState] = useState<GameState | null>(null);
  const [result, setResult] = useState<GameResult | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    const socket = io({ path: "/api/socket", transports: ["websocket", "polling"] });
    socketRef.current = socket;
    socket.on("connect", () => setConnected(true));
    socket.on("disconnect", () => setConnected(false));
    socket.on("queue:waiting", () => setPhase("queueing"));
    socket.on("match:found", (info: GameInfo) => {
      setGame(info);
      setState({ fen: info.fen, turn: info.turn });
      setResult(null);
      setNotice(null);
      setPhase("playing");
    });
    socket.on("game:state", (st: GameState) => setState(st));
    socket.on("game:over", (r: GameResult) => {
      setResult(r);
      setPhase("over");
    });
    socket.on("game:opponent_disconnected", () =>
      setNotice("Opponent disconnected — they may rejoin."),
    );
    socket.on("error", (e: { message: string }) => setNotice(e.message));
    socket.on("connect_error", (e) => setNotice(`Socket: ${e.message}`));
    return () => {
      socket.disconnect();
    };
  }, []);

  function findMatch() {
    setNotice(null);
    setResult(null);
    socketRef.current?.emit("queue:join");
  }

  function leaveQueue() {
    socketRef.current?.emit("queue:leave");
    setPhase("idle");
  }

  function resign() {
    if (game) socketRef.current?.emit("game:resign", { gameId: game.gameId });
  }

  function tryMove(sourceSquare: string, targetSquare: string | null): boolean {
    if (!game || !state || !targetSquare) return false;
    if (state.turn !== game.color) return false;
    const local = new Chess(state.fen);
    let move;
    try {
      move = local.move({ from: sourceSquare, to: targetSquare, promotion: "q" });
    } catch {
      return false;
    }
    if (!move) return false;
    setState({
      fen: local.fen(),
      turn: local.turn() === "w" ? "white" : "black",
      lastMove: { from: move.from, to: move.to, san: move.san },
    });
    socketRef.current?.emit("game:move", {
      gameId: game.gameId,
      from: sourceSquare,
      to: targetSquare,
    });
    return true;
  }

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-6 py-12">
      <header className="flex flex-col gap-1">
        <span className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">
          Live game
        </span>
        <h1 className="text-3xl font-semibold tracking-tight">Play a match</h1>
        <p className="text-sm text-zinc-500">
          Signed in as <span className="font-medium">{username}</span>
          {" · "}
          <span className={connected ? "text-emerald-600" : "text-amber-600"}>
            {connected ? "connected" : "connecting…"}
          </span>
        </p>
      </header>

      {phase === "idle" && (
        <Panel>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            FIFO matchmaking — first two waiting players get paired. Open this page in
            a second browser (or incognito with another account) to test.
          </p>
          <button
            type="button"
            onClick={findMatch}
            disabled={!connected}
            className="self-start rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            Find a match
          </button>
        </Panel>
      )}

      {phase === "queueing" && (
        <Panel>
          <p className="text-sm">Looking for an opponent…</p>
          <button
            type="button"
            onClick={leaveQueue}
            className="self-start rounded-md border border-zinc-300 px-3 py-1 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            Cancel
          </button>
        </Panel>
      )}

      {(phase === "playing" || phase === "over") && game && state && (
        <div className="grid gap-6 sm:grid-cols-[480px_1fr]">
          <div className="w-full max-w-[480px]">
            <Chessboard
              options={{
                position: state.fen,
                boardOrientation: game.color,
                allowDragging: phase === "playing" && state.turn === game.color,
                onPieceDrop: ({ sourceSquare, targetSquare }) =>
                  tryMove(sourceSquare, targetSquare),
                id: "live-board",
              }}
            />
          </div>
          <Panel>
            <div className="flex flex-col gap-3 text-sm">
              <Row label="You" value={`${username} (${game.color})`} />
              <Row label="Opponent" value={game.opponent.username} />
              <Row
                label="Turn"
                value={
                  phase === "over"
                    ? "—"
                    : state.turn === game.color
                      ? "Your move"
                      : "Opponent's move"
                }
              />
              {state.lastMove && <Row label="Last move" value={state.lastMove.san} />}
              {result && (
                <Row
                  label="Result"
                  value={describeResult(result, game.color)}
                  emphasize
                />
              )}
            </div>
            <div className="mt-2 flex gap-2">
              {phase === "playing" && (
                <button
                  type="button"
                  onClick={resign}
                  className="rounded-md border border-red-300 bg-red-50 px-3 py-1 text-sm text-red-700 hover:bg-red-100 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-200"
                >
                  Resign
                </button>
              )}
              {phase === "over" && (
                <button
                  type="button"
                  onClick={findMatch}
                  className="rounded-md bg-zinc-900 px-3 py-1 text-sm text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
                >
                  Find another match
                </button>
              )}
            </div>
          </Panel>
        </div>
      )}

      {notice && (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
          {notice}
        </p>
      )}
    </div>
  );
}

function describeResult(r: GameResult, you: Color): string {
  if (r.winner === null) return `Draw (${r.reason.replaceAll("_", " ")})`;
  if (r.winner === you) return `You won (${r.reason})`;
  return `You lost (${r.reason})`;
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
      {children}
    </div>
  );
}

function Row({
  label,
  value,
  emphasize,
}: {
  label: string;
  value: string;
  emphasize?: boolean;
}) {
  return (
    <div className="flex justify-between gap-3 border-b border-zinc-100 pb-2 last:border-0 dark:border-zinc-900">
      <span className="text-zinc-500">{label}</span>
      <span className={emphasize ? "font-semibold" : "font-medium"}>{value}</span>
    </div>
  );
}
