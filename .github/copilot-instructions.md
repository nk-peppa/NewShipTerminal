# Copilot instructions

`AGENTS.md` at the repository root is the single source of truth for how to work
in this repository. Read it first; this file only exists so agents that look for
`.github/copilot-instructions.md` find their way there.

Short version:

- The SLAM engine under `desktop/algo/cocommand2d/` is **vendored** (external
  delivery) — never edit it; put adaptations in `desktop/tools/`, `desktop/src/`
  or `desktop/docs/`.
- Match `pose.status` by prefix (`WAITING`, `INITIALIZING: n/3`, `TRACKING`,
  `LOST: …`, `DEGENERATE: …`); `poseValid: false` means "last known pose".
- Before claiming done, run in `desktop/`: `npm run algo:test`, `npm test`,
  `npm run slam:check`, and `$env:PSModulePath=""; npm run slam:export`.
  Do not lower algorithm or harness thresholds to make them pass.
- Commit messages in English, Conventional Commits, one concern per commit.
