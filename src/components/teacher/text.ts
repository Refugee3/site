/** "1 paper", "3 papers"; pass `pluralForm` for irregular nouns. */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}
