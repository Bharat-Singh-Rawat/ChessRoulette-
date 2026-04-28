"use client";

import { useMemo, useState } from "react";
import { Chess } from "chess.js";
import { Chessboard } from "react-chessboard";

type GameStatus =
  | { kind: "ongoing"; turn: "white" | "black" }
  | { kind: "checkmate"; winner: "white" | "black" }
  | { kind: "draw"; reason: string };

function describeStatus(game: Chess): GameStatus {
  if (game.isCheckmate()) {
    return { kind: "checkmate", winner: game.turn() === "w" ? "black" : "white" };
  }
  if (game.isStalemate()) return { kind: "draw", reason: "stalemate" };
  if (game.isThreefoldRepetition()) return { kind: "draw", reason: "threefold repetition" };
  if (game.isInsufficientMaterial()) return { kind: "draw", reason: "insufficient material" };
  if (game.isDraw()) return { kind: "draw", reason: "50-move rule" };
  return { kind: "ongoing", turn: game.turn() === "w" ? "white" : "black" };
}

export default function PlayBoard() {
  const [fen, setFen] = useState(() => new Chess().fen());

  const game = useMemo(() => new Chess(fen), [fen]);
  const status = describeStatus(game);

  function tryMove(sourceSquare: string, targetSquare: string | null): boolean {
    if (!targetSquare) return false;
    const next = new Chess(fen);
    const move = next.move({ from: sourceSquare, to: targetSquare, promotion: "q" });
    if (!move) return false;
    setFen(next.fen());
    return true;
  }

  function reset() {
    setFen(new Chess().fen());
  }

  return (
    <div className="flex flex-col items-center gap-4">
      <div className="w-full max-w-[480px]">
        <Chessboard
          options={{
            position: fen,
            onPieceDrop: ({ sourceSquare, targetSquare }) => tryMove(sourceSquare, targetSquare),
            id: "play-board",
          }}
        />
      </div>

      <div className="flex items-center gap-4 text-sm">
        <StatusPill status={status} />
        <button
          type="button"
          onClick={reset}
          className="rounded-md border border-zinc-300 bg-white px-3 py-1 text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
        >
          Reset
        </button>
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: GameStatus }) {
  if (status.kind === "checkmate") {
    return (
      <span className="rounded-full bg-emerald-100 px-3 py-1 font-medium text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200">
        Checkmate — {status.winner} wins
      </span>
    );
  }
  if (status.kind === "draw") {
    return (
      <span className="rounded-full bg-amber-100 px-3 py-1 font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
        Draw — {status.reason}
      </span>
    );
  }
  return (
    <span className="rounded-full bg-zinc-100 px-3 py-1 font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">
      {status.turn === "white" ? "White" : "Black"} to move
    </span>
  );
}
