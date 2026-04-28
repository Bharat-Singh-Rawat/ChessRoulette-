import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function LeaderboardPage() {
  const users = await prisma.user.findMany({
    orderBy: [{ rating: "desc" }, { wins: "desc" }],
    take: 50,
    select: {
      username: true,
      rating: true,
      wins: true,
      losses: true,
      draws: true,
    },
  });

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-12">
      <header className="flex flex-col gap-1">
        <span className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">
          Leaderboard
        </span>
        <h1 className="text-3xl font-semibold tracking-tight">Top players</h1>
        <p className="text-sm text-zinc-500">
          Ranked by ELO rating. Bot games don&apos;t count. Everyone starts at 1200.
        </p>
      </header>

      {users.length === 0 ? (
        <div className="rounded-2xl border border-zinc-200 bg-white p-6 text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400">
          No ranked games yet. Play a match to land on the board.
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
          <table className="w-full text-sm">
            <thead className="border-b border-zinc-200 bg-zinc-50 text-left text-xs uppercase tracking-wider text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900">
              <tr>
                <th className="px-4 py-3 w-12">#</th>
                <th className="px-4 py-3">Player</th>
                <th className="px-4 py-3 text-right">Rating</th>
                <th className="px-4 py-3 text-right">W</th>
                <th className="px-4 py-3 text-right">L</th>
                <th className="px-4 py-3 text-right">D</th>
                <th className="px-4 py-3 text-right">Win %</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u, i) => {
                const total = u.wins + u.losses + u.draws;
                const pct = total > 0 ? Math.round((u.wins / total) * 100) : null;
                return (
                  <tr
                    key={u.username}
                    className="border-b border-zinc-100 last:border-0 dark:border-zinc-900"
                  >
                    <td className="px-4 py-3 text-zinc-500">{i + 1}</td>
                    <td className="px-4 py-3 font-medium">{u.username}</td>
                    <td className="px-4 py-3 text-right font-mono">{u.rating}</td>
                    <td className="px-4 py-3 text-right text-emerald-700 dark:text-emerald-400">
                      {u.wins}
                    </td>
                    <td className="px-4 py-3 text-right text-red-700 dark:text-red-400">
                      {u.losses}
                    </td>
                    <td className="px-4 py-3 text-right text-zinc-600 dark:text-zinc-400">
                      {u.draws}
                    </td>
                    <td className="px-4 py-3 text-right text-zinc-500">
                      {pct === null ? "—" : `${pct}%`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
