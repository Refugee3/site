import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";

export interface FieldProps {
  label: ReactNode;
  /** The id of the control inside; also the prefix of the hint and error ids. */
  htmlFor: string;
  hint?: ReactNode;
  error?: string[];
  children: ReactNode;
}

type DescribableProps = { "aria-describedby"?: string; "aria-invalid"?: boolean | "true" | "false" };

/**
 * A labelled form control with an optional hint and error list. When the child is a single element,
 * it is linked to the hint and errors with aria-describedby and marked aria-invalid on error.
 */
export function Field({ label, htmlFor, hint, error, children }: FieldProps) {
  const errors = error ?? [];
  const hintId = hint ? `${htmlFor}-hint` : null;
  const errorId = errors.length > 0 ? `${htmlFor}-error` : null;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ");

  let control = children;
  if (describedBy && isValidElement<DescribableProps>(children)) {
    const own = children.props["aria-describedby"];
    control = cloneElement(children as ReactElement<DescribableProps>, {
      "aria-describedby": own ? `${own} ${describedBy}` : describedBy,
      ...(errorId ? { "aria-invalid": true } : {}),
    });
  }

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium text-ink">
        {label}
      </label>
      {control}
      {hintId && (
        <p id={hintId} className="text-sm text-muted">
          {hint}
        </p>
      )}
      {errorId && (
        <ul id={errorId} className="flex flex-col gap-0.5 text-sm font-medium text-danger-700">
          {errors.map((message, index) => (
            <li key={`${index}:${message}`}>{message}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
