# Security review: claude-mem v13.11.0 → v15.0.1

2026-10-23. Read only: git diff/show/grep on the tags; nothing installed,
built or run. Five reviews (hooks, network, supply chain, secrets/PII,
exec/files), one agent each. The deciding claims were checked by hand
(marked ✓). The diff is 1,315 commits, +85.8k lines in src/. This covers
those surfaces in depth, not every line.

## Verdict: GO, through the fork, with hardening first

v13.11.0, which is installed now, is the riskier version:
- ✓ `GET /api/settings` returns every key in settings.json in plaintext,
  without auth (v13 `SettingsRoutes.ts:37-42`). v15 masks them.
- ✓ `POST /api/settings` accepts `CLAUDE_CODE_PATH`, the binary the worker
  runs, from any `http://localhost:*` page (v13 `SettingsRoutes.ts:94`).
  So a local web page can make the worker run a program of its choosing.
  v15 makes that key file-only.
- The v13 MCP file tools (`smart_outline`/`unfold`/`search`) read any path
  (~/.ssh, ~/.aws). v15 confines them to the workspace.

But v15 adds risks of its own. Those are fixed in the fork, not worked
around, before its `main` moves. **Don't update with `npx claude-mem
install`**: its interactive flow requires a cmem.ai login (✓
`install.ts:2930-2936`). Update the fork, then the plugin from the
marketplace.

Until then (v13): stop the worker while you're on untrusted localhost web
pages, or at least don't open any.

## Findings, by what we do about them

### Fixed in the fork before `main` moves (Phase 1, small commits, tests first)
| # | Finding | Sev | Where (v15.0.1) | Fix |
|---|---|---|---|---|
| H1 | Every hook runs the bare `claude-mem` found on PATH. A SessionStart hook compiles it into `~/.local/bin`, ad-hoc signs it, and appends a PATH line to `~/.zshrc`. An unreadable rc file gets truncated. | MED | ✓ `plugin/hooks/hooks.json`; `src/launcher/install-launcher.ts:237-295,483-496,623-719` | Hooks call `node ${CLAUDE_PLUGIN_ROOT}/scripts/…` by absolute path, as in v13; drop the ensure-launcher hook |
| H2 | ✓ `CLAUDE_MEM_DATA_DIR` is writable over HTTP. A new `settings.json` there sets `CLAUDE_CODE_PATH`, or a planted grammar `.dylib` is loaded with no check. Both run code outside the sandbox. The provider base URLs (where keys and transcripts go) are writable over HTTP too. | MED | `SettingsRoutes.ts:257,264,272`; `smart-file-read/parser.ts:426-444` | Make the path- and URL-valued keys file-only (and `FOLDER_CLAUDEMD_ENABLED`) |
| H3 | The Setup hook runs `bun install` without `--frozen-lockfile`, with install scripts on (tree-sitter-cli). A binary that answers `--version` is never hash-checked. | MED | `plugin/scripts/version-check.js:11,233`; `tree-sitter-cli-provision.ts:209` | `--frozen-lockfile --ignore-scripts`; always check the pinned SHA-256 |
| H4 | Raw tool I/O is spooled to `~/.claude-mem/state/hook-spool/` before stripping or redaction, with no file mode (0644). `expired/` and `corrupt/` are never purged. | MED-HIGH | `cli/handlers/observation.ts:20-30`; `shared/hook-spool.ts:145,315,523` | Strip and redact before spooling; 0600 files, 0700 dir; purge after 7 days |
| H5 | Deleting an observation or prompt leaves its raw I/O in `tool_uses`, which the model can read back (`get_tool_uses`). | MED | `DataRoutes.ts:505`; `tool-uses.ts` purge | Delete the linked `tool_uses` rows. Phase 2's deletion invariant builds on this |

### Settings, in `~/.claude-mem/settings.json` and the environment (no code)
- `DO_NOT_TRACK=1` in the shell profile, and `claude-mem telemetry
  disable`. PostHog is on by default, sends before it asks, and includes
  plan tier, model names, GeoIP, and error text with file names.
- `CLAUDE_MEM_DATA_DIR` set in the environment (env beats the file: a
  second guard for H2).
- `CLAUDE_MEM_REDACT_ENABLED=true`, `CLAUDE_MEM_REDACT_GENERIC_ENABLED=true`
- `CLAUDE_MEM_TOOL_USES_RETENTION_DAYS=7` (default 0 = forever, up to
  64 KB of raw I/O per call)
- `CLAUDE_MEM_FILE_READ_GATE_ENABLED=false`. Otherwise Reads of files of
  32 KB or more that have history are denied, replaced by stored titles
  (stale, and open to injection).
- `CLAUDE_MEM_MEMORY_INSTRUCTIONS_ENABLED=false`. Otherwise each session
  is told to `save_memory` "preferences"; those saves skip stripping, and
  a prompt-injected session can plant durable ones.
- `CLAUDE_MEM_HOOK_SPOOL_TRANSPORT=filesystem`; keep
  `CLAUDE_MEM_WORKER_HOST=127.0.0.1`
- Leave cloud sync, TeamBrain, Telegram, Grok webhook and the cmem
  gateway unset. Check afterwards that `CLAUDE_MEM_CLOUD_SYNC_*` and
  `*_BASE_URL` are empty.
- `chmod 700 ~/.claude-mem`

### Accepted, or later
- Any `http://localhost:*` page can read all memory and raw tool I/O and
  write memories (CORS trust, `middleware.ts:244-271`; also in v13). A
  later fork fix: an own-page origin check on every write and on raw-data
  GETs.
- The committed bundles (worker 2.5 → 4.1 MB) can't be rebuilt and
  compared (no root lockfile). Since we're building in the fork anyway,
  we run bundles built from src at our commit with a lockfile, which
  closes this for us.
- A folder CLAUDE.md write follows symlinks out of the repo. Off by
  default; kept off (H2 makes it file-only).
- The orphan chroma-mcp sweep can kill a chroma-mcp it didn't start. We
  don't run one.
- MCP file tools are confined to cwd, so launching from `~` reaches
  ~/.ssh again. Don't launch from `~`.
- Plain-HTTP remote spool and `ws://` sync: only with options we don't
  use.

### Improvements v15 brings
Settings masked on GET; spawn paths file-only; MCP file reads confined;
a DNS-rebinding Host check; a cross-origin DELETE guard; prefix secret
redaction (opt-in); a rewritten `<private>` stripper with no lost call
sites; settings.json written 0600; tree-sitter downloads SHA-256 pinned;
the observer model denied every tool; `$SHELL -lc` gone from hooks.

## Phase 1 order
1. Back up `~/.claude-mem/` (v13 schema → 67 in place) and `~/.zshrc`.
2. Branch `hardening` off v15.0.1: H1–H5, one commit each, a failing test
   first, `bun test tests` green.
3. Build the plugin bundles from src with a lockfile.
4. **You approve:** push to bobaseb-oc `main` (= v15.0.1 + hardening).
5. Apply the settings above; update the plugin from the marketplace;
   restart Claude Code.
6. Verify: `which -a claude-mem` is empty; `~/.zshrc` unchanged; the
   worker is on 127.0.0.1; `GET /api/settings` masked; a `POST
   /api/settings` of `CLAUDE_MEM_DATA_DIR` ignored; spool files 0600;
   this repo's old observations found; the SessionStart block whole.
