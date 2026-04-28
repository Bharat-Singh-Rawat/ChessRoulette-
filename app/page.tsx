import PlayBoard from "./components/PlayBoard";

export default function Home() {
  return (
    <div className="min-h-screen bg-zinc-50 font-sans text-zinc-900 dark:bg-black dark:text-zinc-100">
      <main className="mx-auto flex max-w-5xl flex-col gap-12 px-6 py-16">
        <header className="flex flex-col gap-3">
          <span className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">
            ChessRoulette
          </span>
          <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
            Random chess. Real faces.
          </h1>
          <p className="max-w-2xl text-lg text-zinc-600 dark:text-zinc-400">
            Get matched with another player by your favorite opening, switch on your
            webcam, and play. Win to climb the ladder. Run out of tokens? Win a bullet
            game to earn more.
          </p>
        </header>

        <section className="flex flex-col gap-6 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-950 sm:p-8">
          <div className="flex flex-col gap-1">
            <h2 className="text-xl font-semibold">Try the board</h2>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              A local sandbox — drag pieces for both sides. Real matchmaking and live
              opponents come in the next milestones.
            </p>
          </div>
          <PlayBoard />
        </section>

        <section className="grid gap-4 sm:grid-cols-2">
          <Roadmap
            title="Done"
            tone="done"
            items={["Project scaffold", "Playable local board", "Move validation + game-over states"]}
          />
          <Roadmap
            title="Coming next"
            tone="next"
            items={[
              "Accounts + ELO ladder",
              "Real-time two-player matches",
              "Webcam + matchmaking by opening",
              "Tokens, bullet earn-back, reports & moderation",
            ]}
          />
        </section>
      </main>
    </div>
  );
}

function Roadmap({
  title,
  items,
  tone,
}: {
  title: string;
  items: string[];
  tone: "done" | "next";
}) {
  const accent =
    tone === "done"
      ? "border-emerald-200 bg-emerald-50 dark:border-emerald-900/50 dark:bg-emerald-950/30"
      : "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950";
  const dot =
    tone === "done"
      ? "bg-emerald-500"
      : "bg-zinc-400 dark:bg-zinc-600";
  return (
    <div className={`rounded-2xl border p-6 ${accent}`}>
      <h3 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">{title}</h3>
      <ul className="mt-3 flex flex-col gap-2 text-sm">
        {items.map((item) => (
          <li key={item} className="flex items-start gap-2">
            <span className={`mt-2 h-1.5 w-1.5 flex-shrink-0 rounded-full ${dot}`} />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
