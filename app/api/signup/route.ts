import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { email, username, password } = (body ?? {}) as {
    email?: unknown;
    username?: unknown;
    password?: unknown;
  };

  if (
    typeof email !== "string" ||
    typeof username !== "string" ||
    typeof password !== "string"
  ) {
    return NextResponse.json(
      { error: "email, username, and password are required" },
      { status: 400 },
    );
  }

  const cleanEmail = email.toLowerCase().trim();
  const cleanUsername = username.trim();

  if (!/^\S+@\S+\.\S+$/.test(cleanEmail)) {
    return NextResponse.json({ error: "Invalid email" }, { status: 400 });
  }
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(cleanUsername)) {
    return NextResponse.json(
      { error: "Username must be 3–20 chars, letters/numbers/underscore only" },
      { status: 400 },
    );
  }
  if (password.length < 8) {
    return NextResponse.json(
      { error: "Password must be at least 8 characters" },
      { status: 400 },
    );
  }

  try {
    const passwordHash = await bcrypt.hash(password, 10);
    await prisma.user.create({
      data: { email: cleanEmail, username: cleanUsername, passwordHash },
    });
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      const target = (err.meta?.target as string[] | undefined)?.[0];
      const field = target === "email" ? "Email" : "Username";
      return NextResponse.json(
        { error: `${field} already taken` },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
