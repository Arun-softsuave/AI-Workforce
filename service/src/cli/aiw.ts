#!/usr/bin/env node
import "../core/quiet.js";
const { main } = await import("./main.js");
process.exitCode = await main(process.argv.slice(2)).catch((e: any) => { console.error(`aiw: ${e?.message ?? e}`); return 1; });
