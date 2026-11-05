import { LinkButton } from "@/components/ui/link-button";
import { PublicPage } from "@/components/ui/public-page";

export default function NotFound() {
  return (
    <PublicPage>
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <p className="text-muted">
        This page doesn&apos;t exist. The grader is for teachers only: students don&apos;t hand in work or see results
        here, so older student links no longer work.
      </p>
      <LinkButton href="/" className="self-start">
        Go to your assignments
      </LinkButton>
    </PublicPage>
  );
}
