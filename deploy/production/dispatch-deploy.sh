#!/usr/bin/env bash
set -Eeuo pipefail

command_text=${SSH_ORIGINAL_COMMAND:-}
if [[ ! "$command_text" =~ ^deploy\ (sha256:[0-9a-f]{64})$ ]]; then
  echo 'Only deploy sha256:<64 lowercase hex characters> is allowed.' >&2
  exit 64
fi
digest=${BASH_REMATCH[1]}
unit="codebuddy2api-deploy-${digest:7:16}"

exec systemd-run \
  --unit="$unit" \
  --collect \
  --wait \
  --pipe \
  --property=Type=oneshot \
  /usr/local/sbin/codebuddy2api-deploy-worker "$digest"
