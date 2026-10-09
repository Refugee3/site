import type { Metadata, Viewport } from "next";
import { APP_NAME } from "@/components/ui/public-page";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: APP_NAME, template: `%s · ${APP_NAME}` },
  description: "Hand in work as a PDF or photos; the teacher's AI-assisted grader reads it against the answer key.",
};

export const viewport: Viewport = {
  themeColor: "#ffffff",
};

// System fonts only (see globals.css), so builds never fetch from the network.
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full">
      <body className="flex min-h-full flex-col bg-canvas text-ink antialiased">{children}</body>
    </html>
  );
}
