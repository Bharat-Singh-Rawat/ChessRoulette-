import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import PlayClient from "./PlayClient";

export const dynamic = "force-dynamic";

export default async function PlayPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const u = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { tokens: true },
  });

  return (
    <PlayClient
      username={session.user.username ?? "You"}
      initialTokens={u?.tokens ?? 0}
    />
  );
}
