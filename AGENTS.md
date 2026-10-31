# AGENTS.md — working rules for AI agents

This repository is the operator terminal for an unmanned surface vessel: an
Electron/TypeScript desktop app, a Rust boat-side firmware, and a **vendored 2D
lidar SLAM engine** under `desktop/algo/`. Human-facing docs are in Chinese; this
file is in English for agent consumption.

Read this before you change anything. It encodes decisions that already cost
review rounds; a PR that violates it will be rejected.

## 1. What you may edit

| Path | Owner | Rule |
|---|---|---|
| `desktop/algo/cocommand2d/**` | algorithm owner (external delivery) | **Vendor code, imported verbatim** (`tag slam-drop-v2.0.0`). Do not edit. |
| `desktop/algo/tests/**` | algorithm owner | Two delivered test files are vendor; `conftest.py` is ours. Do not change assertions to make a failure disappear. |
| `desktop/algo/README_CN.md`, `CHANGES_CN.md` | algorithm owner | Delivery originals, kept verbatim. |
| `desktop/algo/VENDOR.md` | terminal | Provenance, SHA256 table, boundary rules. Update it when an import changes. |
| `desktop/tools/**`, `desktop/src/**`, `desktop/test/**`, `desktop/docs/**` | terminal | Yours. Keep the vendor boundary intact. |

If you believe the algorithm is wrong, **do not patch vendor code**: capture the
reproducer (input file, exact command, expected vs actual) in a PR comment or
issue and hand it back to the algorithm owner.

## 2. Branch and PR flow

- SLAM work: branch from `slam-algorithm` as `slam/<topic>`; open the PR against
  `main` (or `slam-algorithm` while the engine is still being stabilised).
- `main` stays releasable: `desktop/tools/ship.mjs` and
  `firmware/tools/ship-fw.mjs` publish from it and require a clean, green tree.
- One concern per commit. **English commit messages**, Conventional Commits
  (`feat(scope): …`, `fix(scope): …`, `docs: …`, `test: …`).
- Never force-push `main`, `release`, `release-fw` or a branch under review; add
  commits instead.
- Do not commit recordings, generated maps, `__pycache__`, `.pytest_cache` or
  `node_modules` (`recordings/` and caches are already ignored).

## 3. Required checks before you claim "done"

```powershell
cd desktop
npm run algo:test        # 26 algorithm regression tests (pytest)
npm test                 # 17 node tests, including the replay-tool integration tests
npm run slam:check       # 13 end-to-end checks: sim -> TCP -> sidecar -> pose/map
$env:PSModulePath=""; npm run slam:export   # 22 checks, ZIP + PGM/YAML/CSV
```

All four must pass. Report the actual output in the PR description.

If a check fails because the engine became more conservative (three-scan
bootstrap, 60-point minimum, 0.62 inlier ratio), **report the metric — do not
loosen `SlamConfig` defaults or the harness thresholds** to make it green.
Changing those numbers requires field data and an explicit decision in the PR.

## 4. Contracts you must not break silently

| Contract | Rule |
|---|---|
| sidecar stdio JSONL, `api: 2` | One JSON object per line: `scan` / `pose` / `map` / `error` / `ready` / `reset` / `ping`. |
| `pose.status` | Vocabulary: `WAITING`, `INITIALIZING: n/3`, `TRACKING`, `LOST: …`, `DEGENERATE: …`. **Match by prefix**, never by equality or an enumerating switch. |
| `pose.poseValid` | `false` means the coordinates are the last trusted pose or the origin. The UI must not present them as the current position. |
| Scan v1 JSONL | `version: 1`, `frame: "x_forward_y_left_ccw"`, radians/metres, strictly increasing timestamps, equal-length `angles/ranges/quality/valid`. |
| `map` events | Only after the grid has observations; at most every 0.5 s; change detection by content digest of `log_odds` + `observed`. |
| C1 input | Raw SDK angles are clockwise degrees and millimetre ranges; `Scan.from_c1()` is the only conversion point. Never convert twice. |

Any change to a field, unit or status string must update
`desktop/docs/slam-integration.md` in the **same** commit.

## 5. Data, replay and verification

- Recorded sessions contain `rx.NNN.bin` (`u32 length | f64 epoch ms | raw TCP
  bytes`). Point clouds exist only there; `scan.csv` is a summary.
- Supported replay entry point:

  ```powershell
  python desktop/tools/replay-session.py --session <session-dir> [--out-root out]
  ```

  It converts into a per-run temporary JSONL and reserves a unique output
  directory with an `O_CREAT|O_EXCL` lock, so concurrent replays cannot collide.
- Calling `desktop/algo/run_slam.py` directly is allowed for experiments, but you
  own directory uniqueness there (upstream only checks `exists()`).
- Synthetic fixtures are fine for unit tests. **Never present synthetic results
  as field validation** — the engine has not been replayed against a real
  recording yet.

## 6. Environment notes for this workstation

- `gh` needs `C:\Program Files\Git\cmd` on `PATH`.
- `HTTP_PROXY` / `HTTPS_PROXY` may point at a local proxy that is not running;
  clear them for `git`/`gh` when connections fail.
- `npm run slam:export` spawns Windows PowerShell 5.1 from Node; the inherited
  PowerShell 7 `PSModulePath` breaks `Expand-Archive`. Run it with
  `$env:PSModulePath=""`.
- Python 3.10+ is required (the vendor package uses PEP 604 annotations); the
  sidecar reports this explicitly instead of restarting in a loop.

## 7. Review etiquette

Copilot and Codex review every PR automatically. For each comment: either fix it
in a commit and reply with the hash plus the verification output, or rebut it
with evidence. Resolve the thread once it is addressed. Do not mark a thread
resolved without a code change or an explicit technical answer.

## 8. Map of the SLAM area

```
desktop/algo/cocommand2d/      vendor engine (do not edit)
  scan.py                      Scan v1 observation type, C1 conversion
  slam/core.py                 LidarSlam: bootstrap, matching, acceptance
  slam/grid.py                 occupancy grid, three-frame confirmation
  slam/preprocessing.py        filtering, deskew, attitude projection
  recording/io.py              Recorder / replay / save_result
desktop/algo/tests/            delivered regression tests + our conftest
desktop/algo/VENDOR.md         provenance and vendor boundary
desktop/tools/algo-sidecar.py  stdio JSONL bridge used by the desktop app
desktop/tools/scan-log-to-jsonl.py   rx.NNN.bin -> Scan v1 JSONL
desktop/tools/replay-session.py      one-command offline replay
desktop/tools/slam-check.cjs          end-to-end self-test (sim + sidecar)
desktop/tools/slam-export-check.cjs   export self-test (ZIP, PGM, CSV)
desktop/docs/slam-integration.md      pose contract + replay workflow
```
