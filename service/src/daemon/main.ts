import "../core/quiet.js";
// Entry point: silence the SQLite experimental warning BEFORE node:sqlite is linked, then start the service.
await import("./agentd.js");
