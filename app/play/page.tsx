import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import PlayClient from "./PlayClient";

export const dynamic = "force-dynamic";

export default async function PlayPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  return <PlayClient username={session.user.username ?? "You"} />;
}
