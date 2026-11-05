// Every test worker imports node:sqlite, and Node prints "SQLite is an experimental feature" once per process: drop
// exactly that warning in tests (the app still prints it once at startup). Listed before setup.ts, which imports it.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const message = typeof warning === "string" ? warning : warning.message;
  if (message.startsWith("SQLite is an experimental feature")) return;
  (emitWarning as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;
