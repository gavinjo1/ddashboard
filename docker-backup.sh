#!/bin/sh
# Dumps both databases on a loop. No cron: one less moving part in a container
# that exists only to do this.
set -eu

KEEP=${BACKUP_KEEP:-14}
EVERY=${BACKUP_EVERY_SECONDS:-86400}

while true; do
  stamp=$(date +%Y-%m-%d_%H%M%S)
  out="/backups/ddashboard-${stamp}.sql.gz"

  # Written under .part and renamed only on success, so an interrupted dump
  # can never be mistaken for a good backup — which is how people discover at
  # restore time that they have none.
  if pg_dumpall --clean --if-exists | gzip > "${out}.part"; then
    mv "${out}.part" "$out"
    echo "$(date -Iseconds) backup ok: $out ($(wc -c < "$out") bytes)"
  else
    rm -f "${out}.part"
    echo "$(date -Iseconds) BACKUP FAILED" >&2
  fi

  # Keep the newest $KEEP, drop the rest.
  ls -1t /backups/ddashboard-*.sql.gz 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
    rm -f "$old" && echo "$(date -Iseconds) pruned: $old"
  done

  sleep "$EVERY"
done
