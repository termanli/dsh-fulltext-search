# dsh-fulltext-search

A DSH (DeepSeek Harness) Web GUI plugin that searches file **contents** in the current session working directory from the sidebar file manager ([dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)), returning `file + line number + matching line preview`. Click a result to open the file in the editor.

Supports regular expressions, match case, whole-word exact matching, smart case, and include/exclude scope filters. When [ripgrep](https://github.com/BurntSushi/ripgrep) is installed it is used automatically (the same engine as VS Code search, best performance); otherwise a built-in JS engine is used with identical features.

## Installation

Prerequisites: DSH and dsh-better-sidebar installed (the sidebar is visible in `dsh web`).

> **Install order**: install dsh-better-sidebar FIRST, then this plugin; upgrade dsh-better-sidebar first as well. If the better-sidebar `registerTab` service is missing, this plugin logs a Chinese warning and skips tab registration (it never crashes the GUI).

```sh
dsh plugin --profile web add link:<path-to-this-repo>
# e.g. dsh plugin --profile web add link:D:\git\dsh-fulltext-search
```

After installing, **restart DSH** and **hard-refresh the browser** (Ctrl/Cmd+Shift+R).

Optional: install [ripgrep](https://github.com/BurntSushi/ripgrep) to enable the fastest search engine (`winget install BurntSushi.ripgrep.MSVC`, `brew install ripgrep`, or `apt install ripgrep`); when absent, the built-in JS engine is used with identical features.

## Security

- The search root is **always the server-recorded session working directory** (`sessions.get(sessionId).header.cwd`); a `cwd` field in the request body is always ignored — a forged `sessionId` cannot widen full-text search to other readable host directories via an arbitrary absolute path.
- Unknown sessions → `404 session-not-found`; sessions without a working directory → `400 no-session-cwd`. Both are rejected before any search runs, and there is no `process.cwd()` fallback.

## Usage

1. Open the sidebar, click `+` → choose **Full-Text Search** (or click the magnifier icon).
2. Type a keyword and press Enter; use the `.*` (regex), `Aa` (match case), `Ab` (whole word) buttons and the "smart case" toggle to adjust matching.
3. Click a result row → the file opens in the editor tab; click a file name → open the file.

## License

This project is released under the [Apache License 2.0](LICENSE).
