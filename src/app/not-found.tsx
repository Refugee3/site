import { LinkButton } from "@/components/ui/link-button";
import { PublicPage } from "@/components/ui/public-page";

export default function NotFound() {
  return (
    <PublicPage>
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <p className="text-muted">
        If you typed an assignment code, check it and try again. If you followed a link from your teacher, the
        assignment may have been removed or its code changed — ask your teacher for the current one.
      </p>
      <LinkButton href="/" className="self-start">
        Enter a code
      </LinkButton>
    </PublicPage>
  );
}
