"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { LinkButton } from "@/components/ui/link-button";

export default function ErrorPage({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-4 px-4 py-10">
      <h1 className="text-2xl font-semibold">Something went wrong</h1>
      <p className="text-muted">
        This page couldn&apos;t be loaded. Try again; if it keeps happening, wait a minute and reload.
      </p>
      {error.digest && (
        <p className="text-sm text-muted">
          Reference for the administrator: <code className="font-mono">{error.digest}</code>
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        <Button onClick={retry}>Try again</Button>
        <LinkButton href="/" variant="secondary">
          Go to the start page
        </LinkButton>
      </div>
    </main>
  );
}
