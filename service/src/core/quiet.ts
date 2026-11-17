// Imported first by every entry point: silences Node's "SQLite is experimental" warning
// so CLI output, hook output and MCP stdio stay clean. Other warnings still print.
const original = process.emitWarning.bind(process);
(process as any).emitWarning = (warning: any, ...args: any[]) => {
  const text = typeof warning === "string" ? warning : warning?.message ?? "";
  const type = typeof args[0] === "string" ? args[0] : args[0]?.type;
  if (type === "ExperimentalWarning" && /SQLite/i.test(text)) return;
  return (original as any)(warning, ...args);
};
export {};
