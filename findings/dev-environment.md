# Development environment notes

## ⛔ Never do this

- Never run `npm run sideload` (or anything else touching the Roku device) through WSL — it
  cannot reach the device, and the resulting `ENETUNREACH` looks like a device problem, not a
  networking one.
- Never let `apps/sample-app/package.json`'s `kopytko-roku-device` version drop below `^1.5.1` —
  that's the first version with the `agent: false` fix (see below); anything older reintroduces
  the `socket hang up` failure on `installChannel`.

## `npm run build` in `site/` crashes on exit with `UV_HANDLE_CLOSING` — harmless

Native Windows Node 24.x (`node-v24.18.1`) reliably prints `Assertion failed:
!(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94` and a non-zero exit code
*after* `astro build` already logged `[build] Complete!`. This is a libuv shutdown bug in this
Node build on Windows, not a build failure — verify by checking `site/dist/index.html` and
`site/dist/_astro/*` actually exist before assuming the build failed. Don't chase this; it's a
Node/Windows runtime issue, not ours to fix.

## Node.js: WSL vs. native Windows

`node`/`npm` are available in **both** places on this machine now:
- WSL2 (Ubuntu, via nvm) — fine for `packages/compiler` build/test, which never touches the
  network.
- Native Windows (installed via `winget install --id OpenJS.NodeJS.LTS`) — **required** for
  anything that talks to the Roku device.

`node_modules` populated by one is not reliably usable from the other (platform-specific native
builds) — re-run `npm install` from whichever environment you're about to run commands in if
you've been switching.

## WSL2 cannot reach the LAN Roku device

WSL2's NAT networking is a separate network from the Windows host's hotspot/LAN. Any `wsl.exe`
command that needs to reach a device on that LAN (e.g. the dev Roku Ultra, password set via
`ROKU_PASSWORD`) fails with `ENETUNREACH`, even though native Windows tools (PowerShell,
`curl.exe`) reach it fine (verified with `Test-NetConnection`/`ping`).

**⚠️ Live-verified 2026-08-03** against a Roku Ultra on a Windows-hosted hotspot.

## Don't hardcode the dev Roku's IP — it drifts, use SSDP discovery instead

The dev device's IP is DHCP-assigned on the Windows hotspot and **changes across sessions**
(observed `192.168.1.100` → `192.168.137.46` within the same day, 2026-08-03) — treating a
previously-recorded IP as durable and hardcoding it into `ROKU_HOST` wastes time chasing a
false "socket hang up"/timeout when the real cause is just a stale address. `kopytko-roku-device`
already ships an `SsdpClient` (zero-dependency, UPnP M-SEARCH over `dgram`) built exactly for
this — before assuming a device is unreachable, discover it fresh:

```js
import { SsdpClient } from 'kopytko-roku-device';
const client = new SsdpClient();
client.on('found', (d) => console.log(d)); // { ip, port, serialNumber }
await client.start();
await client.scan(4000);
client.stop();
```

Run this from inside a package that actually depends on `kopytko-roku-device` (e.g.
`apps/sample-app`) — ESM resolves the import relative to the script's own location, not `cwd`, so
a one-off script outside the workspace tree fails with `ERR_MODULE_NOT_FOUND` even with `node`
right next to it. `npm run sideload` (`kopytko-roku installer install --zip ...`, see
"Sideloading is now `kopytko-roku` CLI, not a hand-written script" below) still takes `ROKU_HOST`
as an explicit env var rather than auto-discovering, but confirm the IP via `SsdpClient` first if a
sideload times out — don't reach for a value recorded in a doc.

Fix options, in order of preference:
1. **Run device-touching commands from native Windows**, not WSL. This is what `vscode-kopytko`
   already does — its VS Code extension runs as a native Windows Node process (the Extension
   Host bundles its own runtime), so it reaches the device fine even though the *build* tooling
   (`tsc`/`esbuild`) still runs via WSL. `kopytko-roku` (the CLI each app's `sideload` script now
   runs) is a bare Node bin with no such native host, so it needs an actual native Node install —
   see above.
2. WSL2 mirrored networking (`networkingMode=mirrored` in `.wslconfig` + `wsl --shutdown`) also
   works, but restarts the whole WSL instance — riskier if something else is running there.

## `InstallerClient.installChannel` used to throw "socket hang up" — fixed upstream, resolved

**Root cause:** the Roku dev web-admin doesn't send `Connection: close` on the 401 digest-auth
challenge response, so Node's default `http.Agent` treated the socket as reusable and could hand
it to the authenticated retry — but the device had often already torn that connection down by
then, so the retry threw `Error: socket hang up` before a response was ever parsed. `curl
--digest` never hit this because it opens a fresh connection per attempt regardless of what the
server implies about persistence. `insecureHTTPParser: true` does **not** fix it — verified live
that it's a connection-reuse race, not an HTTP-parsing issue.

**Fixed upstream in `kopytko-roku-device` `1.5.1`**: every request in
`packages/roku-device/src/net/httpClient.ts` now passes `agent: false`, forcing a brand-new
connection per attempt. See that package's own `findings/roku-device-api.md` for the full
writeup. `apps/sample-app/package.json` pins `^1.5.1` — verified live end to end
(`npm run build:roku && npm run sideload`) with no error and no defensive fallback needed. This
fix lives in `installer.installChannel` itself, so it applies identically whether that's called
from a hand-written script or (as of the `kopytko-roku` CLI migration — see "Sideloading is now
`kopytko-roku` CLI" below) the CLI's `installer install` op, since both are a plain,
unconditional call into the same `InstallerClient` method.

## `installChannel` doesn't guarantee a cold restart — re-testing after a code change can run stale state

**Confirmed live.** Sideloading a new build over an already-running channel does not reliably kill
and restart the process — the old instance can keep running (Roku's Instant Resume-style behavior),
so a script that does `installChannel` then immediately drives the app via `EcpClient` can observe
**leftover state from the previous test run**, not the fresh build. Hit this directly: a focus-state
verification script showed the grid entering already-focused on a tile from three tests ago instead
of the expected first tile, even right after a fresh `installChannel` call. **Fix**: after
installing, force a real cold start — `ecp.keypress(ip, 'Home')` then `ecp.launchApp(ip, 'dev')` —
before driving/querying the app, whenever the test depends on `init()`-time state (not just "does
the latest code run at all", which a stale-but-still-running instance would already prove).

## `EcpClient.queryAppUi`/`querySgNodes` timing out while `queryActiveApp`/`queryAppState` stay fast is a red flag for a suspended BrightScript Debugger prompt, not device flakiness

**Observed live, 2026-08-15 — root cause found, don't repeat the wrong diagnosis.** After a normal
`installChannel` + cold-restart + a few `keypress` calls, `queryAppUi(ip)`/`querySgNodes(ip, 8060,
'roots')` failed with `Request to http://<ip>:8060/query/... timed out after 3000ms` on every
retry, while `checkDeviceAlive`/`queryActiveApp` (`state: active`)/`queryAppState(ip, 'dev')`
(`'active'`) all returned fast. First guess was "device/ECP-side flakiness, app is fine" — **wrong**.
The actual cause: an uncaught BrightScript runtime error (a genuine bug, `\"` used as a
JS/C-style escaped quote inside a BrightScript string literal — BrightScript has no such escape;
`Type Mismatch. Operator "\" can't be applied to "String" and "String"`) had dropped the app into
an interactive `BrightScript Debugger>` prompt on the device's debug console (port 8085), suspending
its render thread — `queryActiveApp`/`queryAppState` only check registered app metadata (still
"active" even while suspended at a breakpoint), but `queryAppUi`/`querySgNodes` need the render
thread to actually respond, so they hang until the 3000ms client timeout. **Fix/diagnosis**: when
`queryAppUi`/`querySgNodes` time out but `queryActiveApp`/`queryAppState` look fine, connect a
`ConsoleStream({host, port: 8085})` and read a few seconds of output before concluding it's
transient — a live crash's full stack trace, local-variable dump, and exact file/line are sitting
right there, unrequested (the device pushes it automatically when a thread suspends). Confirmed via
this exact debug output that `ft_not(label)` itself had already evaluated correctly and safely
(`result Boolean val:false` in the dumped locals) — the crash was one line later, in hand-written
demo text unrelated to the compiler feature being tested. **Lesson for reading a "frozen" device
screen**: don't assume ECP flakiness — check the debug console first, it's usually a real crash with
the answer already printed. The crash itself was a repeat of an already-documented mistake — see
`findings/statement-grammar-features.md`'s "String literals pass through to generated BrightScript
verbatim" entry; a second author independently made the identical `\"` mistake, so that entry's
guardrail-free warning is a real, recurring risk, not a one-off.

## `node`/`npm` aren't always on `PATH` in a fresh native-Windows shell

Node was installed via `winget install --id OpenJS.NodeJS.LTS` (`C:\Program Files\nodejs`), but a
freshly-spawned PowerShell/Bash session in this tooling doesn't always inherit that on `PATH` —
`Get-Command node`/`npm` come back empty even though `node -v` works once the directory is
prepended by hand (`$env:PATH = "C:\Program Files\nodejs;" + $env:PATH`). Since shell state
(including `PATH` edits) doesn't persist between separate tool invocations here, that prefix has
to be repeated at the start of every PowerShell command that needs `npm`/`node`, not set once.
Check `Get-Command node -ErrorAction SilentlyContinue` before assuming a "command not found" means
Node isn't installed — it may just be a PATH issue for this particular shell.

Same story for the GitHub CLI (`winget install --id GitHub.cli`, `C:\Program Files\GitHub CLI`) —
`gh: command not found` in Bash or `Get-Command gh` coming back empty doesn't mean it's missing;
check `Test-Path "C:\Program Files\GitHub CLI\gh.exe"` first, then prepend the same way
(`export PATH="/c/Program Files/GitHub CLI:$PATH"` in Bash). **`gh auth login` is itself
interactive** (opens a browser) — it has to be run by the human in their own terminal window, not
from tooling with no stdin/browser access. **Also confirmed live**: authenticating `gh` inside WSL
does not make it visible to native-Windows tooling (this repo's Bash/PowerShell run natively, not
in WSL) — `gh auth login` has to be repeated on the native-Windows side specifically, same
WSL-vs-native split as the Roku-device-reachability issue above.

## npm workspaces + Windows paths

`walkSrcTree` (in `packages/compiler/src/project-layout.ts`) works with whatever path separator
`node:path`'s `join`/`readdirSync` produce on the host OS — verified working with native Windows
backslash paths as well as WSL/POSIX forward-slash paths. No special-casing needed; don't add any.
One place this DID need special handling: `isExcluded`'s glob matcher only ever receives
posix-normalized (forward-slash) relative paths — `walkSrcTree` converts with a manual
`split('\\').join('/')` before matching, since an `exclude` pattern in `flash-theater.config.json`
is authored posix-style (`components/Foo/**`) regardless of host OS. See `findings/build-layout.md`.

## Sideloading is now `kopytko-roku` CLI, not a hand-written script

Every app used to carry its own `scripts/sideload.mjs` (byte-identical except the zip filename),
hand-calling `InstallerClient.installChannel(ip, password, zipPath)` and reading `ROKU_DEV_IP`/
`ROKU_DEV_PASSWORD` itself. `kopytko-roku-device` ships its own CLI bin (`kopytko-roku`, resolved
from `node_modules/.bin` since every app already depends on the package directly), so each app's
`"sideload"` npm script is now just `kopytko-roku installer install --zip dist/<app>.zip` — no
wrapper script, same underlying `InstallerClient.installChannel` call (see the fixed-`agent: false`
entry above, still fully applicable).

**Env var names changed**: `ROKU_DEV_IP`/`ROKU_DEV_PASSWORD` → `ROKU_HOST`/`ROKU_PASSWORD` — this
is `kopytko-roku`'s own built-in config-resolution fallback (flags > `--config <file>` > these two
env vars), not a name this repo invented. Deliberately *not* passing `--host $ROKU_HOST --password
$ROKU_PASSWORD` explicitly in the npm script string: `npm run` scripts execute through whatever
shell the OS defaults to (`cmd.exe` on this Windows machine, `sh`/`bash` on Linux/macOS), and
`$VAR`/`%VAR%` interpolation syntax is mutually incompatible across those — a single
`package.json` script string can't reference an env var portably. Relying on the CLI's own
`process.env` fallback instead sidesteps shell interpolation entirely: the env var is inherited by
the child process regardless of which shell invoked `npm run sideload`. Zero flags needed in the
common case; `--host`/`--password` still work as explicit overrides if ever needed ad hoc.
