"use client";

import { useEffect, useRef, useState } from "react";
import { Chess } from "chess.js";
import { Chessboard } from "react-chessboard";
import { io, Socket } from "socket.io-client";
import { useWebRTC, type WebRTCStatus } from "./useWebRTC";

type Phase = "idle" | "queueing" | "playing" | "over";
type Color = "white" | "black";
type GameInfo = {
  gameId: string;
  color: Color;
  opponent: { username: string };
  fen: string;
  turn: Color;
  vsBot: boolean;
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
  const [socket, setSocket] = useState<Socket | null>(null);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    const s = io({ path: "/api/socket", transports: ["websocket", "polling"] });
    socketRef.current = s;
    setSocket(s);
    s.on("connect", () => setConnected(true));
    s.on("disconnect", () => setConnected(false));
    s.on("queue:waiting", () => setPhase("queueing"));
    s.on("match:found", (info: GameInfo) => {
      setGame(info);
      setState({ fen: info.fen, turn: info.turn });
      setResult(null);
      setNotice(null);
      setPhase("playing");
    });
    s.on("game:state", (st: GameState) => setState(st));
    s.on("game:over", (r: GameResult) => {
      setResult(r);
      setPhase("over");
    });
    s.on("game:opponent_disconnected", () =>
      setNotice("Opponent disconnected — they may rejoin."),
    );
    s.on("error", (e: { message: string }) => setNotice(e.message));
    s.on("connect_error", (e) => setNotice(`Socket: ${e.message}`));
    return () => {
      s.disconnect();
    };
  }, []);

  // White is the WebRTC initiator. Hook tears down between matches via gameId dep.
  // In bot games, only the local camera turns on (no peer to connect to).
  const webrtc = useWebRTC({
    socket,
    gameId: phase === "playing" || phase === "over" ? game?.gameId ?? null : null,
    isInitiator: game?.color === "white",
    enabled: (phase === "playing" || phase === "over") && !!game,
    localOnly: !!game?.vsBot,
  });

  function findMatch() {
    setNotice(null);
    setResult(null);
    socketRef.current?.emit("queue:join");
  }

  function findBotMatch() {
    setNotice(null);
    setResult(null);
    socketRef.current?.emit("queue:join_bot");
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
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-12">
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
            Pair with a real player (FIFO matchmaking) or jump straight into a
            practice game vs a computer opponent. Either way the browser will ask
            for your camera and mic — you can deny and still play.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={findMatch}
              disabled={!connected}
              className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
            >
              Find a match
            </button>
            <button
              type="button"
              onClick={findBotMatch}
              disabled={!connected}
              className="rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-800 transition-colors hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
            >
              Practice vs computer
            </button>
          </div>
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
        <div className="grid gap-6 lg:grid-cols-[480px_1fr]">
          <div className="relative w-full max-w-[480px]">
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
            <SelfVideoTile stream={webrtc.localStream} />
          </div>

          <div className="flex flex-col gap-4">
            <OpponentVideo
              stream={webrtc.remoteStream}
              status={webrtc.status}
              error={webrtc.error}
              opponentName={game.opponent.username}
              vsBot={game.vsBot}
            />
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
                {state.lastMove && (
                  <Row label="Last move" value={state.lastMove.san} />
                )}
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

function SelfVideoTile({ stream }: { stream: MediaStream | null }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  if (!stream) return null;
  return (
    <div className="absolute bottom-2 right-2 h-24 w-32 overflow-hidden rounded-md border-2 border-white/80 bg-black shadow-lg">
      <video
        ref={ref}
        autoPlay
        playsInline
        muted
        className="h-full w-full object-cover"
      />
    </div>
  );
}

function OpponentVideo({
  stream,
  status,
  error,
  opponentName,
  vsBot,
}: {
  stream: MediaStream | null;
  status: WebRTCStatus;
  error: string | null;
  opponentName: string;
  vsBot: boolean;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);

  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-2xl border border-zinc-200 bg-zinc-900 dark:border-zinc-800">
      {vsBot ? (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-center text-zinc-300">
          <span className="text-5xl">🤖</span>
          <span className="text-base font-medium">{opponentName}</span>
          <span className="text-xs text-zinc-500">Bots don't have webcams</span>
        </div>
      ) : stream ? (
        <video
          ref={ref}
          autoPlay
          playsInline
          className="h-full w-full object-cover"
        />
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-center text-sm text-zinc-300">
          <span className="text-base font-medium">{opponentName}</span>
          <span className="text-xs text-zinc-500">{statusText(status, error)}</span>
        </div>
      )}
      <span className="absolute left-2 top-2 rounded-md bg-black/50 px-2 py-0.5 text-xs text-white backdrop-blur">
        {opponentName}
      </span>
    </div>
  );
}

function statusText(status: WebRTCStatus, error: string | null): string {
  if (status === "requesting_camera") return "Waiting for camera permission…";
  if (status === "connecting") return "Connecting video…";
  if (status === "failed_camera") return error ?? "Camera unavailable";
  if (status === "failed_connection") return "Video connection failed";
  return "Setting up video…";
}
