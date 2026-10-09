/**
 * The assignment's instructions field. Students read the instructions only on the upload page, which they can't use
 * while student uploads are off; the grader reads them with every paper either way.
 */
export function instructionsField(studentsCanUpload: boolean): { label: string; hint: string } {
  return studentsCanUpload
    ? { label: "Instructions for students (optional)", hint: "Shown on the upload page, under the title. The grader reads them too." }
    : { label: "Instructions the students were given (optional)", hint: "The grader reads these with each paper." };
}
