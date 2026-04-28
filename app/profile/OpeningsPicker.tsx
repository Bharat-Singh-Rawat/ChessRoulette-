"use client";

import { useState } from "react";
import { OPENINGS } from "@/lib/openings";

export default function OpeningsPicker({ initial }: { initial: string[] }) {
  const [selected, setSelected] = useState<Set<string>>(new Set(initial));
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setSavedAt(null);
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/profile/openings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ openings: [...selected] }),
      });
      if (!r.ok) {
        const d = (await r.json().catch(() => ({}))) as { error?: string };
        setError(d.error ?? "Save failed");
      } else {
        setSavedAt(Date.now());
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
      <div>
        <h2 className="text-lg font-semibold">Preferred openings</h2>
        <p className="text-sm text-zinc-500">
          Pick what you like to play. Matchmaking tries to pair you with someone
          whose preferences overlap. Empty = match anyone.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {OPENINGS.map((o) => (
          <label
            key={o.id}
            className="flex cursor-pointer items-center gap-2 rounded-md border border-zinc-200 px-3 py-2 text-sm hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900"
          >
            <input
              type="checkbox"
              checked={selected.has(o.id)}
              onChange={() => toggle(o.id)}
              className="h-4 w-4"
            />
            <span>{o.name}</span>
          </label>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          {busy ? "Saving…" : "Save preferences"}
        </button>
        {savedAt && (
          <span className="text-xs text-emerald-600 dark:text-emerald-400">
            Saved.
          </span>
        )}
        {error && (
          <span className="text-xs text-red-600 dark:text-red-400">{error}</span>
        )}
      </div>
    </section>
  );
}
