# Browser Virtual File System (BVFS)

A fully client-side, POSIX-like virtual filesystem and shell environment running entirely within the browser. 

BVFS leverages the Origin Private File System (OPFS) for persistent, high-performance storage, completely sandboxed from the host OS. It features a custom shell with stream redirection, environment variables, and modular command execution.

## Core Architecture
- **Zero Backend:** 100% client-side execution. No telemetry, no servers.
- **VFS Layer:** Maps POSIX paths to the browser's OPFS.
- **Shell Engine:** Custom parser supporting pipes (`|`), redirection (`>`, `>>`), and quoting.
- **Extensible:** Commands are lazy-loaded ES modules.

## Project Structure
- `/modules`: Core system logic (`vfs.js`, `shell.js`, `parser.js`).
- `/modules/commands`: Individual shell utilities (e.g., `ls`, `cat`, `grep`).
- `/wasm`: WebAssembly binaries and execution bindings (Upcoming).
- `/workers`: Web Workers for heavy I/O or background processing (Upcoming).

## Running Locally
Because OPFS requires a secure context, you must serve this project via a local web server (e.g., `npx http-server` or `python3 -m http.server`) or host it on an HTTPS static provider like GitHub Pages. Opening `index.html` directly via `file://` will fail.
