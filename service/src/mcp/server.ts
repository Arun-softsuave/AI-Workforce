import "../core/quiet.js";
// Entry point: silence the SQLite experimental warning BEFORE node:sqlite is linked, then load the server.
await import("./tools.js");
