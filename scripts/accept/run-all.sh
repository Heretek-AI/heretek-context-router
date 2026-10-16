#!/usr/bin/env bash
# Runs every wave accept script in numeric order (wave-1, wave-2, ...,
# wave-10) and stops at the first failure. Fail-closed: no scripts found is
# an error.
set -euo pipefail

cd "$(dirname "$0")/../.."

mapfile -t scripts < <(find scripts/accept -maxdepth 1 -name 'wave-*.sh' -print | sort -V)
if [ "${#scripts[@]}" -eq 0 ]; then
  echo "FAIL: no scripts/accept/wave-*.sh found" >&2
  exit 1
fi

for script in "${scripts[@]}"; do
  echo "##### running ${script} #####"
  if ! bash "${script}"; then
    echo "FAIL: ${script} failed; later waves not run" >&2
    exit 1
  fi
done
echo "##### all ${#scripts[@]} wave accept scripts passed #####"
