"use client";

import { useEffect, useRef, useState } from "react";
import { Chess } from "chess.js";
import { Chessboard } from "react-chessboard";
import { io, Socket } from "socket.io-client";
import { useWebRTC, type WebRTCStatus } from "./useWebRTC";
import { useNSFWGuard, type NSFWStatus } from "./useNSFWGuard";

type Phase = "idle" | "queueing" | "playing" | "over";
type Color = "white" | "black";
type Mode = "casual" | "bullet";
type Clocks = { whiteMs: number; blackMs: number; lastUpdateAt: number };
type GameInfo = {
  gameId: string;
  color: Color;
  opponent: { id: string; username: string };
  fen: string;
  turn: Color;
  vsBot: boolean;
  mode: Mode;
  matchedOpening: { id: string; name: string } | null;
  clocks: Clocks | null;
};
type GameState = {
  fen: string;
  turn: Color;
  lastMove?: { from: string; to: string; san: string };
  clocks?: Clocks | null;
};
type RatingChange = {
  white: number;
  black: number;
  whiteRating: number;
  blackRating: number;
};
type TokenChange = { white: number; black: number };
type GameResult = {
  winner: Color | null;
  reason: string;
  ratingChange?: RatingChange;
  tokenChange?: TokenChange;
};

export default function PlayClient({
  username,
  initialTokens,
}: {
  username: string;
  initialTokens: number;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [game, setGame] = useState<GameInfo | null>(null);
  const [state, setState] = useState<GameState | null>(null);
  const [result, setResult] = useState<GameResult | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [tokens, setTokens] = useState<number>(initialTokens);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    const s = io({ path: "/api/socket", transports: ["websocket", "polling"] });
    socketRef.current = s;
    setSocket(s);
    s.on("connect", () => setConnected(true));
    s.on("disconnect", () => setConnected(false));
    s.on("queue:waiting", () => setPhase("queueing"));
    s.on(
      "queue:rejected",
      ({ message }: { reason: string; message: string }) => {
        setNotice(message);
        setPhase("idle");
      },
    );
    s.on("match:found", (info: GameInfo) => {
      setGame(info);
      setState({ fen: info.fen, turn: info.turn, clocks: info.clocks });
      setResult(null);
      setNotice(null);
      setPhase("playing");
      // Optimistically debit a token client-side for casual matches; the
      // canonical value is the next time the page reloads.
      if (info.mode === "casual" && !info.vsBot) {
        setTokens((t) => Math.max(0, t - 1));
      }
    });
    s.on("game:state", (st: GameState) => setState(st));
    s.on("game:over", (r: GameResult) => {
      setResult(r);
      setPhase("over");
      if (r.tokenChange) {
        setTokens(
          (t) =>
            t + ((game?.color === "white" ? r.tokenChange!.white : r.tokenChange!.black) ?? 0),
        );
      }
    });
    s.on("game:opponent_disconnected", () =>
      setNotice("Opponent disconnected — they may rejoin."),
    );
    s.on("error", (e: { message: string }) => setNotice(e.message));
    s.on("connect_error", (e) => setNotice(`Socket: ${e.message}`));
    return () => {
      s.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const webrtc = useWebRTC({
    socket,
    gameId: phase === "playing" || phase === "over" ? game?.gameId ?? null : null,
    isInitiator: game?.color === "white",
    enabled: (phase === "playing" || phase === "over") && !!game,
    localOnly: !!game?.vsBot,
  });

  // NSFW guard: scan the opponent's remote stream. Auto-report on flag.
  const [opponentVideoEl, setOpponentVideoEl] = useState<HTMLVideoElement | null>(null);
  const [reportModalOpen, setReportModalOpen] = useState(false);
  const [reportSent, setReportSent] = useState(false);
  const nsfw = useNSFWGuard({
    videoEl: opponentVideoEl,
    enabled: !!webrtc.remoteStream && !game?.vsBot,
    onFlag: () => {
      if (!game) return;
      void fetch("/api/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reportedUserId: game.opponent.id,
          gameId: game.gameId,
          reason: "nsfw_auto",
        }),
      });
    },
  });
  const opponentHidden = nsfw.status === "flagged";

  async function submitReport(reason: string, note?: string) {
    if (!game) return;
    setReportSent(false);
    const r = await fetch("/api/reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reportedUserId: game.opponent.id,
        gameId: game.gameId,
        reason,
        note,
      }),
    });
    if (r.ok) {
      setReportSent(true);
      setReportModalOpen(false);
    } else {
      const d = (await r.json().catch(() => ({}))) as { error?: string };
      setNotice(d.error ?? "Report failed");
    }
  }

  function findMatch() {
    setNotice(null);
    setResult(null);
    socketRef.current?.emit("queue:join");
  }
  function findBulletMatch() {
    setNotice(null);
    setResult(null);
    socketRef.current?.emit("queue:join_bullet");
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
      clocks: state.clocks ?? null,
    });
    socketRef.current?.emit("game:move", {
      gameId: game.gameId,
      from: sourceSquare,
      to: targetSquare,
    });
    return true;
  }

  const outOfTokens = tokens <= 0;

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
          {" · "}
          <span className="font-medium text-zinc-700 dark:text-zinc-300">
            🪙 {tokens} tokens
          </span>
        </p>
      </header>

      {phase === "idle" && (
        <Panel>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            <strong>Casual</strong> matches cost 1 token and update your rating.
            <strong> Bullet</strong> matches are free, fast (60s per side), and
            winning earns you 10 tokens. <strong>Practice</strong> vs the
            computer is always free but doesn&apos;t affect your rating.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={findMatch}
              disabled={!connected || outOfTokens}
              className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
            >
              Casual match (1 token)
            </button>
            <button
              type="button"
              onClick={findBulletMatch}
              disabled={!connected}
              className="rounded-md border border-emerald-300 bg-emerald-50 px-4 py-2 text-sm font-medium text-emerald-900 transition-colors hover:bg-emerald-100 disabled:opacity-50 dark:border-emerald-800/50 dark:bg-emerald-950/40 dark:text-emerald-200 dark:hover:bg-emerald-950/60"
            >
              Bullet match (free, win 10 tokens)
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
          {outOfTokens && (
            <p className="text-xs text-amber-700 dark:text-amber-300">
              Out of tokens — win a bullet game to earn 10 and unlock casual
              matches.
            </p>
          )}
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
            {game.mode === "bullet" && state.clocks && (
              <ClockBar
                clocks={state.clocks}
                turn={state.turn}
                youColor={game.color}
                gameOver={phase === "over"}
              />
            )}
          </div>

          <div className="flex flex-col gap-4">
            <OpponentVideo
              stream={webrtc.remoteStream}
              status={webrtc.status}
              error={webrtc.error}
              opponentName={game.opponent.username}
              vsBot={game.vsBot}
              hidden={opponentHidden}
              nsfwStatus={nsfw.status}
              onVideoEl={setOpponentVideoEl}
            />
            <Panel>
              <div className="flex flex-col gap-3 text-sm">
                <Row label="Mode" value={game.mode === "bullet" ? "Bullet (1 min)" : game.vsBot ? "Practice" : "Casual"} />
                <Row label="You" value={`${username} (${game.color})`} />
                <Row label="Opponent" value={game.opponent.username} />
                {game.matchedOpening && (
                  <Row label="Matched on" value={game.matchedOpening.name} />
                )}
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
                {result?.ratingChange && (
                  <Row
                    label="Rating"
                    value={ratingLine(result.ratingChange, game.color)}
                  />
                )}
                {result?.tokenChange && (
                  <Row
                    label="Tokens"
                    value={tokenLine(result.tokenChange, game.color)}
                  />
                )}
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {phase === "playing" && (
                  <button
                    type="button"
                    onClick={resign}
                    className="rounded-md border border-red-300 bg-red-50 px-3 py-1 text-sm text-red-700 hover:bg-red-100 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-200"
                  >
                    Resign
                  </button>
                )}
                {!game.vsBot && (phase === "playing" || phase === "over") && (
                  <button
                    type="button"
                    onClick={() => setReportModalOpen(true)}
                    className="rounded-md border border-zinc-300 bg-white px-3 py-1 text-sm text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
                  >
                    Report opponent
                  </button>
                )}
                {reportSent && (
                  <span className="self-center text-xs text-emerald-600 dark:text-emerald-400">
                    Report received.
                  </span>
                )}
                {phase === "over" && (
                  <>
                    <button
                      type="button"
                      onClick={findMatch}
                      disabled={outOfTokens}
                      className="rounded-md bg-zinc-900 px-3 py-1 text-sm text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
                    >
                      Casual again
                    </button>
                    <button
                      type="button"
                      onClick={findBulletMatch}
                      className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1 text-sm text-emerald-800 hover:bg-emerald-100 dark:border-emerald-800/50 dark:bg-emerald-950/40 dark:text-emerald-200"
                    >
                      Bullet again
                    </button>
                  </>
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

      {opponentHidden && (
        <p className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-200">
          Opponent video automatically hidden after flagged content was detected.
          A report has been filed.
        </p>
      )}

      {/* Floating draggable self-cam — rendered outside the grid so it can move freely. */}
      {(phase === "playing" || phase === "over") && (
        <SelfVideoTile stream={webrtc.localStream} />
      )}

      {reportModalOpen && (
        <ReportModal
          onCancel={() => setReportModalOpen(false)}
          onSubmit={submitReport}
        />
      )}
    </div>
  );
}

function ReportModal({
  onCancel,
  onSubmit,
}: {
  onCancel: () => void;
  onSubmit: (reason: string, note?: string) => void | Promise<void>;
}) {
  const [reason, setReason] = useState("nsfw");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-6 shadow-xl dark:border-zinc-800 dark:bg-zinc-950">
        <h3 className="text-lg font-semibold">Report opponent</h3>
        <p className="mt-1 text-sm text-zinc-500">
          Auto-ban kicks in at 4 unique reports in 30 days. False reports may
          result in your own account being limited.
        </p>
        <div className="mt-4 flex flex-col gap-2 text-sm">
          {[
            { v: "nsfw", l: "NSFW / inappropriate content" },
            { v: "harassment", l: "Harassment or hateful behavior" },
            { v: "spam", l: "Spam or bot account" },
            { v: "other", l: "Other" },
          ].map((o) => (
            <label key={o.v} className="flex items-center gap-2">
              <input
                type="radio"
                name="reason"
                value={o.v}
                checked={reason === o.v}
                onChange={() => setReason(o.v)}
              />
              {o.l}
            </label>
          ))}
        </div>
        <textarea
          placeholder="Optional note for moderators (max 500 chars)"
          value={note}
          maxLength={500}
          onChange={(e) => setNote(e.target.value)}
          className="mt-3 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          rows={3}
        />
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await onSubmit(reason, note.trim() || undefined);
              setBusy(false);
            }}
            className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
          >
            {busy ? "Sending…" : "Submit report"}
          </button>
        </div>
      </div>
    </div>
  );
}

function describeResult(r: GameResult, you: Color): string {
  if (r.winner === null) return `Draw (${r.reason.replaceAll("_", " ")})`;
  if (r.winner === you) return `You won (${r.reason})`;
  return `You lost (${r.reason})`;
}

function ratingLine(rc: RatingChange, you: Color): string {
  const delta = you === "white" ? rc.white : rc.black;
  const newRating = you === "white" ? rc.whiteRating : rc.blackRating;
  const sign = delta > 0 ? "+" : "";
  return `${newRating} (${sign}${delta})`;
}

function tokenLine(tc: TokenChange, you: Color): string {
  const delta = you === "white" ? tc.white : tc.black;
  if (delta === 0) return "no change";
  return `+${delta}`;
}

function ClockBar({
  clocks,
  turn,
  youColor,
  gameOver,
}: {
  clocks: Clocks;
  turn: Color;
  youColor: Color;
  gameOver: boolean;
}) {
  // Tick every 100ms to update the active clock visually; server is authoritative.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (gameOver) return;
    const id = setInterval(() => setTick((n) => n + 1), 100);
    return () => clearInterval(id);
  }, [gameOver]);
  // Rebase: subtract elapsed since clocks.lastUpdateAt from the active side.
  const now = Date.now();
  const elapsed = gameOver ? 0 : now - clocks.lastUpdateAt;
  const whiteMs = turn === "white" ? Math.max(0, clocks.whiteMs - elapsed) : clocks.whiteMs;
  const blackMs = turn === "black" ? Math.max(0, clocks.blackMs - elapsed) : clocks.blackMs;
  // Force a recalc when tick changes (variable used so eslint doesn't complain).
  void tick;

  const yourMs = youColor === "white" ? whiteMs : blackMs;
  const oppMs = youColor === "white" ? blackMs : whiteMs;

  return (
    <div className="mt-3 flex items-center justify-between gap-2 text-sm">
      <ClockChip label="Opponent" ms={oppMs} active={!gameOver && turn !== youColor} />
      <ClockChip label="You" ms={yourMs} active={!gameOver && turn === youColor} />
    </div>
  );
}

function ClockChip({ label, ms, active }: { label: string; ms: number; active: boolean }) {
  const totalSec = Math.ceil(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  const danger = ms <= 10_000;
  return (
    <div
      className={`flex flex-1 flex-col items-center rounded-md border px-3 py-2 ${
        active
          ? danger
            ? "border-red-500 bg-red-100 text-red-900 dark:border-red-700 dark:bg-red-950/40 dark:text-red-200"
            : "border-emerald-400 bg-emerald-50 text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-200"
          : "border-zinc-200 bg-white text-zinc-700 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300"
      }`}
    >
      <span className="text-[10px] uppercase tracking-wider opacity-70">{label}</span>
      <span className="font-mono text-xl tabular-nums">
        {m}:{s.toString().padStart(2, "0")}
      </span>
    </div>
  );
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

const TILE_W = 160;
const TILE_H = 120;
const EDGE = 8;

function clampToViewport(left: number, top: number) {
  const maxLeft = window.innerWidth - TILE_W - EDGE;
  const maxTop = window.innerHeight - TILE_H - EDGE;
  return {
    left: Math.max(EDGE, Math.min(left, maxLeft)),
    top: Math.max(EDGE, Math.min(top, maxTop)),
  };
}

function SelfVideoTile({ stream }: { stream: MediaStream | null }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = stream;
  }, [stream]);

  useEffect(() => {
    function onResize() {
      setPos((p) => (p ? clampToViewport(p.left, p.top) : p));
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const offsetX = e.clientX - rect.left;
    const offsetY = e.clientY - rect.top;

    function onMove(ev: PointerEvent) {
      setPos(clampToViewport(ev.clientX - offsetX, ev.clientY - offsetY));
    }
    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  if (!stream) return null;

  const style: React.CSSProperties = pos
    ? { top: pos.top, left: pos.left }
    : { bottom: 16, right: 16 };

  return (
    <div
      onPointerDown={onPointerDown}
      style={{ position: "fixed", touchAction: "none", width: TILE_W, height: TILE_H, ...style }}
      className="z-50 cursor-grab overflow-hidden rounded-md border-2 border-white/80 bg-black shadow-lg active:cursor-grabbing"
      title="Drag to move"
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="pointer-events-none h-full w-full object-cover"
      />
      <span className="pointer-events-none absolute left-1 top-1 rounded bg-black/50 px-1.5 py-0.5 text-[10px] text-white/90">
        You · drag
      </span>
    </div>
  );
}

function OpponentVideo({
  stream,
  status,
  error,
  opponentName,
  vsBot,
  hidden,
  nsfwStatus,
  onVideoEl,
}: {
  stream: MediaStream | null;
  status: WebRTCStatus;
  error: string | null;
  opponentName: string;
  vsBot: boolean;
  hidden: boolean;
  nsfwStatus: NSFWStatus;
  onVideoEl: (el: HTMLVideoElement | null) => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
    onVideoEl(ref.current);
    return () => onVideoEl(null);
  }, [stream, onVideoEl]);

  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-2xl border border-zinc-200 bg-zinc-900 dark:border-zinc-800">
      {vsBot ? (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-center text-zinc-300">
          <span className="text-5xl">🤖</span>
          <span className="text-base font-medium">{opponentName}</span>
          <span className="text-xs text-zinc-500">Bots don&apos;t have webcams</span>
        </div>
      ) : stream ? (
        <>
          <video
            ref={ref}
            autoPlay
            playsInline
            className={`h-full w-full object-cover ${hidden ? "invisible" : ""}`}
          />
          {hidden && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-zinc-900 text-center text-zinc-300">
              <span className="text-3xl">🚫</span>
              <span className="text-sm font-medium">Video hidden</span>
              <span className="text-xs text-zinc-500">
                Flagged as inappropriate
              </span>
            </div>
          )}
        </>
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-center text-sm text-zinc-300">
          <span className="text-base font-medium">{opponentName}</span>
          <span className="text-xs text-zinc-500">{statusText(status, error)}</span>
        </div>
      )}
      <span className="absolute left-2 top-2 rounded-md bg-black/50 px-2 py-0.5 text-xs text-white backdrop-blur">
        {opponentName}
      </span>
      {!vsBot && nsfwStatus === "watching" && stream && (
        <span className="absolute right-2 top-2 rounded-md bg-emerald-600/80 px-2 py-0.5 text-[10px] uppercase tracking-wider text-white">
          AI guard on
        </span>
      )}
      {!vsBot && nsfwStatus === "loading_model" && stream && (
        <span className="absolute right-2 top-2 rounded-md bg-zinc-700/80 px-2 py-0.5 text-[10px] uppercase tracking-wider text-white">
          Loading guard…
        </span>
      )}
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
