import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { ReceiptView } from "@/components/student/receipt-view";
import { PublicPage } from "@/components/ui/public-page";
import { getPublicOrigin } from "@/lib/http/request";
import { isToken } from "@/lib/ids";
import { getReceiptView } from "@/lib/services/views";

export const metadata: Metadata = {
  title: "Your receipt",
  robots: { index: false, follow: false },
};

export default async function ReceiptPage(props: PageProps<"/r/[token]">) {
  const { token } = await props.params;
  if (!isToken(token)) notFound();

  await connection();
  const view = getReceiptView(token);
  if (!view) notFound();
  const receiptUrl = `${getPublicOrigin(await headers())}/r/${token}`;

  return (
    <PublicPage>
      <ReceiptView view={view} receiptUrl={receiptUrl} />
    </PublicPage>
  );
}
