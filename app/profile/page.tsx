import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { parsePreferences } from "@/lib/openings";
import OpeningsPicker from "./OpeningsPicker";

export const dynamic = "force-dynamic";

export default async function ProfilePage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: {
      username: true,
      email: true,
      rating: true,
      wins: true,
      losses: true,
      draws: true,
      tokens: true,
      createdAt: true,
      preferredOpenings: true,
    },
  });

  if (!user) redirect("/login");

  const initialOpenings = parsePreferences(user.preferredOpenings);

  const stats = [
    { label: "ELO rating", value: user.rating },
    { label: "Tokens", value: user.tokens },
    { label: "Wins", value: user.wins },
    { label: "Losses", value: user.losses },
    { label: "Draws", value: user.draws },
  ];

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 py-16">
      <header className="flex flex-col gap-1">
        <span className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">
          Profile
        </span>
        <h1 className="text-3xl font-semibold tracking-tight">{user.username}</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">{user.email}</p>
        <p className="text-xs text-zinc-500">
          Joined {user.createdAt.toLocaleDateString()}
        </p>
      </header>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {stats.map((s) => (
          <div
            key={s.label}
            className="rounded-xl border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950"
          >
            <div className="text-xs uppercase tracking-wider text-zinc-500">
              {s.label}
            </div>
            <div className="text-2xl font-semibold">{s.value}</div>
          </div>
        ))}
      </section>

      <OpeningsPicker initial={initialOpenings} />
    </div>
  );
}
