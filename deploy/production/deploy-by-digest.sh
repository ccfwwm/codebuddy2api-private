#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly EXPECTED_IMAGE='ghcr.io/ccfwwm/codebuddy2api-private'
readonly APP_DIR='/opt/codebuddy2api'
readonly COMPOSE_FILE='/opt/codebuddy2api/docker-compose.yml'
readonly ENV_FILE='/opt/codebuddy2api/.env'
readonly NETWORK='sub2api-deploy_sub2api-network'

digest=${1:-}
if [[ ! "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo 'A valid immutable sha256 digest is required.' >&2
  exit 64
fi
image="$EXPECTED_IMAGE@$digest"

test -f "$COMPOSE_FILE"
test -f "$ENV_FILE"
docker network inspect "$NETWORK" >/dev/null

previous_image=$(python3 - "$ENV_FILE" <<'PY'
import pathlib, sys
for line in pathlib.Path(sys.argv[1]).read_text().splitlines():
    if line.startswith('CODEBUDDY2API_IMAGE='):
        print(line.split('=', 1)[1])
        break
PY
)
if [[ -z "$previous_image" ]]; then
  echo 'CODEBUDDY2API_IMAGE is missing from production .env.' >&2
  exit 1
fi

update_image() {
  python3 - "$ENV_FILE" "$1" <<'PY'
import os, pathlib, sys, tempfile
path = pathlib.Path(sys.argv[1])
value = sys.argv[2]
lines = path.read_text().splitlines()
key = 'CODEBUDDY2API_IMAGE='
matches = [i for i, line in enumerate(lines) if line.startswith(key)]
if len(matches) != 1:
    raise SystemExit('production .env must contain exactly one CODEBUDDY2API_IMAGE')
lines[matches[0]] = key + value
fd, temp = tempfile.mkstemp(dir=path.parent, prefix='.env.')
try:
    with os.fdopen(fd, 'w') as output:
        output.write('\n'.join(lines) + '\n')
    os.chmod(temp, 0o600)
    os.replace(temp, path)
finally:
    if os.path.exists(temp):
        os.unlink(temp)
PY
}

wait_healthy() {
  local deadline=$((SECONDS + 180))
  while (( SECONDS < deadline )); do
    if [[ "$(docker inspect -f '{{.State.Health.Status}}' codebuddy2api 2>/dev/null || true)" == healthy ]] &&
       curl --fail --silent --show-error --max-time 5 http://127.0.0.1:8787/health >/dev/null; then
      return 0
    fi
    sleep 3
  done
  docker logs --tail 100 codebuddy2api >&2 || true
  return 1
}

restore_previous() {
  local backup=$1
  local image=$2
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" stop codebuddy2api || true
  local restore_dir
  restore_dir=$(mktemp -d "$APP_DIR/.restore-auth.XXXXXX")
  tar -xzf "$backup" -C "$restore_dir"
  rm -rf "$APP_DIR/auth"
  mv "$restore_dir/auth" "$APP_DIR/auth"
  rmdir "$restore_dir"
  update_image "$image"
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d --no-deps --pull never codebuddy2api
  wait_healthy
}

gh auth token | docker login ghcr.io -u ccfwwm --password-stdin >/dev/null
docker pull "$image"
if ! docker image inspect "$image" --format '{{range .RepoDigests}}{{println .}}{{end}}' | grep -Fxq "$image"; then
  echo "Pulled image does not carry the requested repository digest $image." >&2
  exit 1
fi

cd "$APP_DIR"
install -d -m 700 "$APP_DIR/backups"
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
backup="$APP_DIR/backups/auth-before-${timestamp}-${digest:7:12}.tar.gz"
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" stop codebuddy2api
if ! tar -czf "$backup" -C "$APP_DIR" auth || ! tar -tzf "$backup" >/dev/null; then
  rm -f "$backup"
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d --no-deps --pull never codebuddy2api || true
  echo 'Cannot create and verify the pre-deployment auth backup.' >&2
  exit 1
fi
chmod 600 "$backup"
printf 'AUTH_BACKUP=%s\n' "$backup"

update_image "$image"
if docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d --no-deps --pull never codebuddy2api && wait_healthy; then
  install -d -m 700 "$APP_DIR/state"
  printf '%s\n' "$image" > "$APP_DIR/state/last-good-image"
  chmod 600 "$APP_DIR/state/last-good-image"
  printf 'DEPLOYED_IMAGE=%s\n' "$image"
  exit 0
fi

echo 'New image failed health checks; restoring the previous image reference.' >&2
if restore_previous "$backup" "$previous_image"; then
  echo 'Previous image and auth snapshot restored.' >&2
else
  echo 'Automatic rollback did not become healthy; inspect this service before retrying.' >&2
fi
docker logs --tail 100 codebuddy2api >&2 || true
exit 1
