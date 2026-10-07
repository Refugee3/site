import { Alert } from "@/components/ui/alert";

/** Shown instead of the code box and the upload form while teachers have turned student uploads off. */
export function UploadsOffNotice() {
  return (
    <Alert tone="info" title="Your teacher isn't accepting online submissions">
      Hand your paper to your teacher instead. If your teacher gave you a receipt link, open it to see your feedback.
    </Alert>
  );
}
