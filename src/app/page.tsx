import { redirect } from "next/navigation";
import { connection } from "next/server";
import { getCurrentTeacher } from "@/lib/auth/dal";

/** The app is for teachers only: the start page sends them to their assignments, or to log in. */
export default async function HomePage() {
  await connection();
  redirect((await getCurrentTeacher()) ? "/teacher" : "/login");
}
