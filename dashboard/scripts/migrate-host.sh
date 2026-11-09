#!/usr/bin/env bash
# Copy this dashboard (code + data.db + .env + photos) to another Mac.
# Does NOT delete anything on either side (no rsync --delete).
# Usage: migrate-host.sh [--dry-run] user@host [remote_path]
set -euo pipefail

DRY=0
if [[ "${1:-}" == "--dry-run" ]]; then DRY=1; shift; fi

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "Usage: $0 [--dry-run] user@host [remote_path]" >&2
  echo "  remote_path defaults to ~/Projects/photo-frame-dashboard-PF1007L" >&2
  exit 2
fi

REMOTE_SPEC="$1"
REMOTE_PATH="${2:-~/Projects/photo-frame-dashboard-PF1007L}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DASHBOARD="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO="$(cd "$DASHBOARD/.." && pwd)"
SERVER="$DASHBOARD/server"
DB="$SERVER/data.db"
ENV_FILE="$SERVER/.env"

if [[ ! -f "$DB" ]]; then
  echo "error: missing $DB" >&2
  exit 1
fi

# Photos folder: PHOTOS_DIR env > (we do not read .env values here) > server/photos.
# If PHOTOS_DIR is unset, use the default next to data.db.
PHOTOS_DIR_EFFECTIVE="${PHOTOS_DIR:-$SERVER/photos}"

echo "== migrate-host =="
echo "repo:     $REPO"
echo "db:       $DB"
echo "env:      $ENV_FILE"
echo "photos:   $PHOTOS_DIR_EFFECTIVE"
echo "remote:   $REMOTE_SPEC:$REMOTE_PATH"
[[ "$DRY" -eq 1 ]] && echo "(dry-run: no stop, checkpoint is read-only probe, rsync --dry-run)"

# --- refuse / warn if a photo move or album import looks active ---
# photos_move is persisted in settings; album "checking" is in-memory only (PIN-gated admin API),
# so we can only warn about album imports.
if command -v sqlite3 >/dev/null 2>&1; then
  MOVE_JSON="$(sqlite3 "$DB" "SELECT coalesce(value,'') FROM settings WHERE key='photos_move';" 2>/dev/null || true)"
  if [[ "$MOVE_JSON" == *'"state":"copying"'* || "$MOVE_JSON" == *'"state":"deleting"'* ]]; then
    echo "error: a photo-folder move is in progress (settings.photos_move). Finish or clear it in Admin before migrating." >&2
    exit 1
  fi
else
  echo "warn: sqlite3 CLI not found; skipped photos_move check"
fi
echo "warn: cannot detect an in-flight Google album import without the admin PIN (in-memory only)."
echo "      Make sure no album check/download is running in Admin before you continue."

# --- stop local :3030 listener (skip on dry-run) ---
stop_server() {
  local pids
  pids="$(lsof -ti tcp:3030 -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -z "$pids" ]]; then
    echo "no listener on :3030"
    return 0
  fi
  if [[ "$DRY" -eq 1 ]]; then
    echo "dry-run: would send TERM to :3030 PID(s): $pids"
    return 0
  fi
  echo "stopping :3030 PID(s): $pids"
  # shellcheck disable=SC2086
  kill -TERM $pids
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    sleep 0.5
    pids="$(lsof -ti tcp:3030 -sTCP:LISTEN 2>/dev/null || true)"
    [[ -z "$pids" ]] && break
  done
  pids="$(lsof -ti tcp:3030 -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    echo "error: :3030 still listening after TERM (PIDs: $pids). Stop it by hand and re-run." >&2
    exit 1
  fi
  echo "server stopped"
}
stop_server

# --- WAL checkpoint ---
checkpoint_db() {
  if [[ "$DRY" -eq 1 ]]; then
    echo "dry-run: would PRAGMA wal_checkpoint(TRUNCATE) on $DB"
    return 0
  fi
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$DB" 'PRAGMA wal_checkpoint(TRUNCATE);'
    echo "checkpointed via sqlite3"
  elif command -v node >/dev/null 2>&1; then
    (cd "$DASHBOARD" && node --input-type=module -e "
      import { createRequire } from 'node:module';
      const require = createRequire(import.meta.url);
      let db;
      try {
        const { DatabaseSync } = require('node:sqlite');
        db = new DatabaseSync(process.argv[1]);
        db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
        db.close();
      } catch {
        const Database = require('better-sqlite3');
        db = new Database(process.argv[1]);
        db.pragma('wal_checkpoint(TRUNCATE)');
        db.close();
      }
    " "$DB")
    echo "checkpointed via node"
  else
    echo "error: need sqlite3 or node to checkpoint $DB" >&2
    exit 1
  fi
}
checkpoint_db

# --- rsync (no --delete) ---
RSYNC=(rsync -a --checksum
  --exclude node_modules/
  --exclude dashboard/dist/
  --exclude dashboard/kiosk/build/
  --exclude .git/
  --exclude 'backups/'
  --exclude 'diagnostics/'
  --exclude 'log/'
)
[[ "$DRY" -eq 1 ]] && RSYNC+=(--dry-run)

echo "rsync repo → remote …"
# Repo tree (code). data.db / .env are under server/ and may be gitignored; rsync still copies them
# when present on disk. photos/ is large — sync explicitly after.
"${RSYNC[@]}" "$REPO/" "$REMOTE_SPEC:$REMOTE_PATH/"

echo "rsync data.db …"
"${RSYNC[@]}" "$DB" "$REMOTE_SPEC:$REMOTE_PATH/dashboard/server/data.db"

if [[ -f "$ENV_FILE" ]]; then
  echo "rsync .env …"
  "${RSYNC[@]}" "$ENV_FILE" "$REMOTE_SPEC:$REMOTE_PATH/dashboard/server/.env"
else
  echo "warn: no $ENV_FILE on this host"
fi

if [[ -d "$PHOTOS_DIR_EFFECTIVE" ]]; then
  echo "rsync photos …"
  # Ensure remote photos dir exists, then sync contents.
  if [[ "$DRY" -eq 0 ]]; then
    ssh "$REMOTE_SPEC" "mkdir -p \"$REMOTE_PATH/dashboard/server/photos\""
  fi
  if [[ "$PHOTOS_DIR_EFFECTIVE" -ef "$SERVER/photos" ]]; then
    "${RSYNC[@]}" "$PHOTOS_DIR_EFFECTIVE/" "$REMOTE_SPEC:$REMOTE_PATH/dashboard/server/photos/"
  else
    echo "note: PHOTOS_DIR is $PHOTOS_DIR_EFFECTIVE (not server/photos); syncing to remote server/photos/."
    echo "      Set PHOTOS_DIR on the remote or copy elsewhere if you keep photos off-repo."
    "${RSYNC[@]}" "$PHOTOS_DIR_EFFECTIVE/" "$REMOTE_SPEC:$REMOTE_PATH/dashboard/server/photos/"
  fi
else
  echo "warn: photos dir missing: $PHOTOS_DIR_EFFECTIVE"
fi

# --- verify checksums / counts (skip deep verify on dry-run) ---
if [[ "$DRY" -eq 1 ]]; then
  echo "dry-run complete (skipped sha256 / photo-count verify)"
else
  echo "verifying …"
  LOCAL_DB_SUM="$(shasum -a 256 "$DB" | awk '{print $1}')"
  REMOTE_DB_SUM="$(ssh "$REMOTE_SPEC" "shasum -a 256 \"$REMOTE_PATH/dashboard/server/data.db\"" | awk '{print $1}')"
  echo "data.db local=$LOCAL_DB_SUM"
  echo "data.db remote=$REMOTE_DB_SUM"
  if [[ "$LOCAL_DB_SUM" != "$REMOTE_DB_SUM" ]]; then
    echo "error: data.db checksum mismatch" >&2
    exit 1
  fi

  if [[ -f "$ENV_FILE" ]]; then
    LOCAL_ENV_SUM="$(shasum -a 256 "$ENV_FILE" | awk '{print $1}')"
    REMOTE_ENV_SUM="$(ssh "$REMOTE_SPEC" "shasum -a 256 \"$REMOTE_PATH/dashboard/server/.env\"" | awk '{print $1}')"
    echo ".env   local=$LOCAL_ENV_SUM"
    echo ".env   remote=$REMOTE_ENV_SUM"
    if [[ "$LOCAL_ENV_SUM" != "$REMOTE_ENV_SUM" ]]; then
      echo "error: .env checksum mismatch" >&2
      exit 1
    fi
  fi

  if [[ -d "$PHOTOS_DIR_EFFECTIVE" ]]; then
    LOCAL_N="$(find "$PHOTOS_DIR_EFFECTIVE" -type f | wc -l | tr -d ' ')"
    REMOTE_N="$(ssh "$REMOTE_SPEC" "find \"$REMOTE_PATH/dashboard/server/photos\" -type f | wc -l" | tr -d ' ')"
    echo "photos files local=$LOCAL_N remote=$REMOTE_N"
    if [[ "$LOCAL_N" != "$REMOTE_N" ]]; then
      echo "error: photos file count mismatch" >&2
      exit 1
    fi
  fi
  echo "verify ok"
fi

cat << NEXT

Next steps on the remote host:
  cd $REMOTE_PATH/dashboard
  npm ci
  npm rebuild better-sqlite3
  npm run build
  # smoke-test: PORT=3030 node server/index.js
  # then install LaunchAgent from scripts/com.mindfruit.photoframe.plist.template
  #   - set WorkingDirectory to …/dashboard
  #   - set ProgramArguments[0] to \$(which node)
  #   launchctl bootstrap gui/\$(id -u) ~/Library/LaunchAgents/com.mindfruit.photoframe.plist
  # reserve a fixed IP (eero DHCP), repoint frames to http://<ip>:3030/
  # Google Connect must be done in a browser on that host (localhost:3030 callback)

NEXT
