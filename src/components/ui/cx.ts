/**
 * Joins the truthy class names. Note that a class appended by a caller does not "win" over a conflicting
 * base class: Tailwind orders utilities by property, not by their position in the attribute.
 */
export function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}
