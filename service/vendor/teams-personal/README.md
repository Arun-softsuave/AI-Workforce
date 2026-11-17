# Vendored: msteams-personal-mcp (core only)

Source: https://github.com/Vishnuhh/msteams-personal-mcp (v0.13.1, `main`), MIT licence (see LICENSE).
Reviewed on 2026-11-10 before inclusion.

| File | Origin | Changes |
|---|---|---|
| `auth.js` | `src/auth.js` | none |
| `core/oauth.js`, `core/teams.js`, `core/files.js`, `core/emojis.js` | `src/core/*` | none |
| `store.js` | **replaced** | random AES-256 key in the OS credential vault; token encrypted in `~/.ai-workforce/teams-personal.enc` |

Review notes
- Only Node built-in modules are imported (no third-party packages).
- Network calls go only to Microsoft hosts: login.microsoftonline.com, teams.live.com, *.skype.com, graph.microsoft.com.
- Works with **personal** Microsoft accounts (Teams at teams.live.com), not work/school Teams.
- Uses the Teams web client's undocumented APIs; Microsoft may change them at any time.

To update: copy the same files from a newer release, diff them, and keep `store.js` as is.
