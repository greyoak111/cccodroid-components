# Security and scope

This is a local, opt-in protocol adapter for an API that the end user is authorized to use. It is not an account-sharing service or a public gateway. It does not read Claude subscription credentials, modify the Claude Code binary, remove model safety controls, or provide any API quota. The component maintainer [accepted this scope](https://github.com/greyoak111/cccodroid-components/pull/53#issuecomment-6419449939); the maintainer confirmed that signed-index/App verification follows merge and official CI publication, not a pre-release signed index.

- Listen only on `127.0.0.1`. Never expose the listener through port forwarding or a public reverse proxy.
- Requests, including tool results and images, are sent to the Chat Completions endpoint configured by the user. Users must review that service's privacy policy, authorization and billing rules.
- Users enter their own API keys privately. Do not request, print, commit or publish them. Local connection keys and upstream API keys are different secrets.
- Runtime state and credentials belong in a dedicated private HOME, not in the source repository or shared Android storage. Files containing credentials use mode 600.
- Do not enable debug logging with real conversations unless necessary. Upstream errors and diagnostic logs may contain sensitive data.
- Health checks test the local process only, not upstream availability or successful model inference.

## Dependency remediation carried forward from 1.0.2

CCR remains pinned to **1.0.73** to preserve its tested protocol transformation. Updating an npm dependency alone does not repair CCR's bundled implementations. The current unpublished 1.0.5 candidate addresses both layers; the table below lists its current pins, not the historical 1.0.2 pins:

1. `@fastify/static` is locked/overridden to **10.1.2**; `tmp` is overridden to **0.2.7**. This covers the static path/guard/listing advisories, including GHSA-pr96-94w5-mx2h, GHSA-x428-ghpx-8j92, GHSA-83w8-p2f5-377r and GHSA-8pvw-jcv7-9cmj, and tmp GHSA-52f5-9888-hmc6 / GHSA-ph9p-34f9-6g65.
2. `patch-ccr.js` checks the SHA-256 fingerprint of CCR's embedded static code, removes both the old directory-listing and plugin implementations, and selects the fixed external plugin.
3. An additional inspection found advisories hidden from `npm audit` in other embedded packages. The patch fingerprints and replaces **249 CommonJS modules** with external loads of these exact locked versions:

   | Package | Version |
   |---|---|
   | fastify | 5.12.7 |
   | ajv | 8.20.0 |
   | fast-uri | 3.1.9 |
   | find-my-way | 9.10.0 |
   | undici | 7.30.1 |
   | @isaacs/brace-expansion | 5.0.1 |
   | minimatch | 11.0.3 |
   | glob | 14.0.3 |
   | shell-quote | 1.12.0 |

   The bundled editor/tmp implementation is absent; tmp belongs to the external interactive-editor dependency chain. Its external copy is still upgraded rather than relying on non-use.
4. Missing/wrong dependency versions, changed fingerprints or syntax errors fail before any bundle replacement. Installation aborts before Hook changes; every supported start and watchdog restart verifies the patch before launching CCR. The replacement remains atomic and idempotent.
5. CI now gates on `npm audit --omit=dev --audit-level=moderate`, functional security regressions and `node tests/audit-bundle.cjs`. The latter examines a patched temporary copy and sends **only public npm package names and versions** to npm's advisory API; it fails closed on API errors or medium/high/critical findings.

Local checks on 2026-10-28: external npm audit **0 vulnerabilities**; the effective private bundle contains **84 remaining embedded packages**, with **0 medium/high/critical advisory matches**. These are point-in-time checks, not proof of absence of all vulnerabilities. The tests reproduce the old static guard bypass on temporary fake files and confirm rejection after repair, including encoded separators, traversal and non-canonical paths. Tests also confirm tmp rejects escape options.

The component manager's immutable CCR source and private `.orig` backup still contain upstream's old bundle. **Do not run the bundled `ccr` CLI directly**: only `openai-bridge` and the managed start scripts apply these remediations. We do not claim that the original npm release or every file in the download is fixed. No debug UI or public server is needed by this component. New upstream versions require re-auditing and new fingerprints; do not force-upgrade CCR underneath these patches.

## Hook and component lifecycle boundaries in 1.0.4

- The user-level `SessionStart` entry is limited to `startup|resume` and invokes `start-bridge.sh --hook` with a 20-second Hook timeout. It matches the full loopback authority before invoking Node, changing HOME, writing logs, checking dependencies or acquiring locks. The exact base URL and paths below it are accepted; another port with the same prefix, userinfo and foreign hosts are rejected.
- Matching Hook calls only dispatch the single-instance watchdog; they do not wait for patch verification, service locks or HTTP readiness. Manual `start` still checks readiness and reports failure. The watchdog continues to verify the pinned security patch before spawning CCR.
- The manifest points to the component package entry, never a private copy. Entry absence or invalid metadata blocks Hook, manual and direct-watchdog starts. An already-running watchdog also checks each iteration and after patching, exits on removal and cannot later rearm CCR. It intentionally does not kill an active CCR process or delete user data; explicit private `uninstall.sh --yes` remains available even after the package is gone.
- Existing private runtimes are not silently migrated by a component update. Their own managers remain available to stop/uninstall them; fresh configuration is required to receive the new lifecycle code.

## Historical decodable App-wrapper compatibility in 1.0.5-r6

The formerly tested App wrapped custom endpoints as `http://127.0.0.1:<dynamic-port>/u/<32-hex-key>/<base64url-target>` before launching Claude Code. The signed 1.0.4-r5 Hook only matches the direct endpoint and silently skips this wrapper: a stopped bridge is not automatically started. Manual `openai-bridge start` is a temporary workaround, not a passing cold-start verification.

The candidate decodes at most one loopback streamfix wrapper (also accepting the older unkeyed form), checks a bounded URL length, valid wrapper port and canonical base64url round trip, and then applies the existing exact bridge authority/path check. It does not contact the wrapper, read its live key, use Node, change HOME, write logs or take locks before the target matches. Foreign, nested and malformed wrappers remain no-ops; the extra decoder comes from the already-required coreutils base. It does not authenticate the wrapper's key; recognition only dispatches this installation's local watchdog, never a network request or provider switch.

Existing runtime copies and the installed signed package are not edited by this local fix. They require an explicitly approved reconfiguration after a new official signed release; a local candidate is not an App-market verification record.

## Additional dependency advisories in the 1.0.5 candidate

A fresh submission-preflight audit on 2026-10-31 invalidated the earlier zero-advisory result: the previous glob/minimatch tree had four moderate npm-audit entries (including dependants). The local candidate now pins and overrides **glob 14.0.3** and **minimatch 11.0.3** throughout the lockfile. Updating the direct dependencies alone is insufficient: `@fastify/static` would otherwise retain a separate older glob copy.

- [GHSA-3g3m-2fjr-6pw4](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4) / CVE-2026-118773 affects glob 9.0.0 through 14.0.1: traversal can continue after AbortSignal rejection. The selected version includes the fix introduced in 14.0.2.
- [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) / CVE-2026-118764 affects minimatch before 11.0.1: optimization-level-2 globParts expansion and subsequent pairwise work can grow excessively. The selected version includes its preprocessing bounds and large-set handling.
- The CCR patch keeps the original upstream fingerprints. It removes the obsolete embedded minimatch AST/brace-expression factories only if there are no references outside the fingerprinted minimatch blocks; an unexpected retained reference fails closed before writing. The old embedded glob entry now selects the fixed package's public CommonJS entry. The exact fixed glob/minimatch objects used by the patched CCR are checked against the locked external packages.
- Bounded fake-file tests check ordinary glob results, promise/stream abort stopping further reads, minimatch expansion limits and normal static directory listing, while retaining the original traversal/guard regressions. Separate atomic tests reject old glob/minimatch versions and unexpected references without modifying the bundle or leaving backups/temporary files.

These changes affect the unpublished source candidate only. They have **not** been applied to the installed signed 1.0.4-r5 component or an existing daily runtime; upgrading either requires its own approved release/migration process. The residual asynchronous readiness race described in `TESTING.md` is not repaired by this dependency update.

## Managed startup and retirement contract in 1.0.5-r8 (paired App required)

Current App streamfix addresses contain only an opaque HMAC route ID; their original endpoints are not recoverable from the URL. Legacy Hook decoding is not a solution for this format. The paired App source candidate instead checks the original provider endpoint before URL wrapping and before spawning Claude Code.

- Component configuration publishes a five-field, mode-600 v1 registration under the user's private HOME: schema, component ID, exact loopback endpoint, runtime directory and a random non-secret instance ID. There are no API keys, upstream URLs or executable commands in this file. A file lock and atomic rename serialize registration, and another instance is never overwritten. Uninstall only removes its own registration.
- The App only recognizes a registered root `http://127.0.0.1:<port>` endpoint for a custom, non-login, non-on-device provider; other hosts/ports/paths are not managed. It checks the component manager's installed record and calls only the fixed component `ensure` entry, not a command from registration data. That entry verifies the managed manifest, instance and port, and checks runtime scripts against its installed source before execution. This uses the component manager's existing trust boundary; it neither creates nor substitutes signature trust.
- `ensure` waits for the existing PID-identity and HTTP health checks, returns a versioned readiness response only on success, and fails if the registration is removed during startup. The paired App does not spawn the model client before readiness, merges concurrent waiters, and applies a 60-second startup-failure cooldown. A 20-second success cache still revalidates registration, installed-record and entry identity; changes invalidate the old result. This cache is not a continuous-health guarantee. Cancelling one waiter does not kill a shared startup operation; component retirement first prevents new starts and cancels its short-lived in-flight startup operation.
- The watchdog persists a three-attempt consecutive-start/patch budget. Five continuous healthy minutes reset it; persistent failure writes a fault marker and exits. Hook/manual startup will not silently rearm a faulted instance. An explicit user-confirmed `start --reset-recovery --yes` is required after diagnosing the fault. A deliberate stop of a healthy instance clears only the pending attempt count. Uninstall writes a disabled tombstone before stopping, so retained scripts cannot race to rearm it; private configuration is preserved by default.

- Fixed-entry retirement passes the registered endpoint and instance as well as the runtime directory. Identity must match before disabled-marker, registration or process changes. A valid retirement failure preserves the package and has a retirement-specific error/stage rather than a chat-readiness error. Invalid/unknown registration or unhealthy installation metadata cannot block component removal: the App executes no path from it, cleans only the fixed registration entry and continues the component manager's owned-file cleanup. A registration symlink is not followed; unverified private runtime directories and process identities are not guessed or purged. The fallback does not claim to have stopped an unverifiable process.

In r9, a private manifest's self-reported hashes are not sufficient to authorize scoped retirement: the fixed component compares runtime source bytes with both the manifest and the private copy. The stop protocol is implemented in the fixed installer and never sources or executes a private `bridge-common.sh`, even for its explicit manual cleanup path. Lock opens use directory descriptors, `O_NOFOLLOW` and no truncation, reject hard links/special files, and recheck identity under the shared registration lock. Before TERM/KILL, the installer checks the expected Node/watchdog command, runtime path, PID start time and registration again; settings writes similarly recheck the snapshot rather than overwrite a concurrent edit. These checks do not make the private manifest a signature trust root or authorize deleting unverified data. Successor-registration retention assumes writers use the shared registration flock. It is not an atomic compare-and-unlink guarantee against arbitrary noncooperating same-UID code rewriting the pathname between the final check and unlink; directory descriptors prevent parent redirection, not that same-UID mutation.

Release presence follows the official App/component release records, not a permanent "unpublished" label in this contract. Publish an App supporting the new schema while retaining the old one first, then the component; migration remains explicit. Unknown future schemas fail closed for startup but must not prevent fixed-path/owned-file uninstall cleanup. These source changes do not by themselves prove a signed release or native-App acceptance. The installed App, signed 1.0.4-r5 and daily manual bridge are not modified by this review revision. Genuine package-update recovery, final signature installation and all eight native UI delivery gates remain separate verification requirements.

## Graphical configuration boundary

The paired App's extension-card form submits only API endpoint, replacement key and model after explicit user action. Component `gui-configure` consumes bounded JSON from stdin at a fixed installed entry, not credentials in argv or a shell command. The private default runtime and Claude settings paths are fixed; request input cannot choose directories, ports, executables or purge. Existing incompatible/manual installs are refused rather than overwritten or migrated.

`gui-status` is read-only and returns no key or key suffix. A blank replacement preserves the old key only for the same origin; changing origin requires a replacement. Saving performs local configuration/readiness only, with no remote model request. The App reads only the component's validated default local connection file at runtime to persist a dedicated provider, never returns its local/remote secrets to the browser, and does not change global defaults or the current conversation. A new conversation uses it only on the user's explicit action. Configuration, installation and removal must be mutually exclusive, and active use must not be silently interrupted.

### Optional remote model discovery (1.0.5-r9)

Discovery is separate from saving/status. The form defaults to no discovery and requires an explicit opt-in naming the destination origin before automatically reading a list after endpoint/key edits. Changing origin withdraws that opt-in. The bounded App POST `/api/components/openai-bridge/models` requires `consent:true` and accepts only endpoint and optional replacement key; it calls the fixed component `gui-models` command through stdin, never argv. It is mutually exclusive with configuration/removal/installation but does not gate or restart chat readiness.

The component makes one authenticated HTTPS GET to the normalized Chat Completions URL with only the final `/chat/completions` replaced by `/models`. It retains the origin and path prefix, uses normal TLS verification, does not follow redirects, use proxy environment variables, guess additional URLs or retry. The total request deadline is 12 seconds, remote response limit 1 MiB, and the JSON result is bounded to 128 KiB / 500 unique valid model IDs. It returns IDs only, not remote metadata, bodies, headers or exceptions; errors are fixed local codes. IDs containing the actual authentication secret are excluded. A missing replacement key can only be resolved from a validated, unchanged GUI-managed instance for the same origin, with no health probe or state write. A new replacement key does not require creating a runtime.

Discovery sends authentication to the user-selected service but no conversation, tool result, image or inference request. It neither saves configuration, activates a provider nor consumes model inference; the service's own logging, rate and access rules still apply. The returned list is not proof that any model can complete an inference. Frontend results are generation-guarded, abandoned on edits/navigation/save and kept out of persistent browser storage. List failure or unavailability preserves manual entry and never authorizes implicit inference.

These program behaviors are checked with generated fake fixtures; tests do not inspect or move the user's real keys, providers or existing runtime. A source integration is not installation into the live App.

## Release and cleanup boundaries

The maintainer confirmed on October 29, 2026 that merge is followed by official CI packaging/signing, then signed-index/App install → configuration → in-app chat → complete uninstall and a separate `verified.json` contribution. No pre-release signed index is requested. Isolated tests do not satisfy that post-merge verification; no record is generated from a local archive.

`uninstall --yes` stops this runtime and removes only its own Hook, preserving private data. For a **fully disposable test install**, `uninstall --yes --purge` additionally deletes the entire managed directory, including dependency copies, credentials, logs and local backups. Obtain explicit user approval and any needed backup before purging real data. It rejects symbolic-link/unsafe targets and never deletes the separate Claude settings file or its backup.

Report security problems privately using the repository's security reporting feature when available. Do not include API keys, account credentials, conversation histories or unredacted logs in a public issue.
