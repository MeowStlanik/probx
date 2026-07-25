#!/usr/bin/env bash
# Build a judge/share zip from git-tracked files ONLY (never .env / .secrets / out).
# Usage: pnpm pack:release
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Not a git repo — refuse to pack (would risk secrets)." >&2
  exit 1
fi

# Ensure secrets paths stay ignored
if git check-ignore -q .secrets 2>/dev/null; then
  :
else
  echo "WARNING: .secrets is not gitignored" >&2
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${PACK_OUT:-$ROOT/../probx-release-$STAMP.zip}"
# Prefer committed tree; include staged+unstaged via temporary commitless archive of HEAD + note
# If you have uncommitted work you care about, commit first (local only is fine).
git archive --format=zip --prefix=probx/ -o "$OUT" HEAD

# Verify no secrets leaked
if unzip -l "$OUT" | grep -Eiq '(\.secrets/|CIRCLE_ENTITY_SECRET|\.env$|recovery_file_)'; then
  echo "ABORT: archive contains secrets-like paths" >&2
  rm -f "$OUT"
  exit 1
fi

echo "Wrote $OUT"
ls -lh "$OUT"
echo "Contents sample:"
unzip -l "$OUT" | head -30
