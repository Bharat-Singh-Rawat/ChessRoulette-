import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { Prisma } from "@prisma/client";

const VALID_REASONS = new Set(["nsfw", "harassment", "spam", "nsfw_auto", "other"]);
const REPORT_THRESHOLD = 4; // unique reporters in window
const WINDOW_DAYS = 30;

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { reportedUserId, gameId, reason, note } = (body ?? {}) as {
    reportedUserId?: unknown;
    gameId?: unknown;
    reason?: unknown;
    note?: unknown;
  };

  if (typeof reportedUserId !== "string" || !reportedUserId) {
    return NextResponse.json({ error: "reportedUserId required" }, { status: 400 });
  }
  if (typeof reason !== "string" || !VALID_REASONS.has(reason)) {
    return NextResponse.json({ error: "Invalid reason" }, { status: 400 });
  }
  if (reportedUserId === session.user.id) {
    return NextResponse.json({ error: "You can't report yourself" }, { status: 400 });
  }

  try {
    await prisma.report.create({
      data: {
        reporterId: session.user.id,
        reportedId: reportedUserId,
        gameId: typeof gameId === "string" ? gameId : null,
        reason,
        note: typeof note === "string" ? note.slice(0, 500) : null,
      },
    });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      // Already reported this user for this game — treat as success.
      return NextResponse.json({ ok: true, dedup: true });
    }
    throw err;
  }

  // Auto-ban check: distinct reporters in the last WINDOW_DAYS days.
  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const distinctReporters = await prisma.report.findMany({
    where: { reportedId: reportedUserId, createdAt: { gte: since } },
    distinct: ["reporterId"],
    select: { reporterId: true },
  });

  if (distinctReporters.length >= REPORT_THRESHOLD) {
    await prisma.user
      .update({
        where: { id: reportedUserId },
        data: {
          banned: true,
          bannedAt: new Date(),
          banReason: `Auto-ban: ${distinctReporters.length} unique reports in ${WINDOW_DAYS}d`,
        },
      })
      .catch(() => {});
  }

  return NextResponse.json({ ok: true });
}
