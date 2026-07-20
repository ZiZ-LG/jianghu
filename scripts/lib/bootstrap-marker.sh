#!/usr/bin/env bash

write_bootstrap_marker() {
  local marker=$1 project=$2 database=$3 backup=$4 commit=$5 marker_dir backup_dir backup_name tmp
  [[ "$project" =~ ^[A-Za-z0-9_.-]+$ && "$database" =~ ^[A-Za-z0-9_]+$ && "$commit" =~ ^[0-9a-f]{40}$ ]] || return 1
  [[ -d "$backup" && "$backup" == *.backup ]] || return 1
  marker_dir=$(cd "$(dirname "$marker")" && pwd)
  backup_dir=$(cd "$(dirname "$backup")" && pwd)
  [[ "$marker_dir" == "$backup_dir" ]] || { echo "bootstrap marker and backup must share one directory" >&2; return 1; }
  backup_name=$(basename "$backup")
  [[ "$backup_name" =~ ^jianghu-[A-Za-z0-9T.-]+\.backup$ ]] || return 1
  tmp=$(mktemp "$marker_dir/.bootstrap-marker.XXXXXX")
  if ! {
    echo 'format=jianghu-bootstrap-marker-v2'
    printf 'deployment_project=%s\n' "$project"
    printf 'production_database=%s\n' "$database"
    printf 'verified_commit=%s\n' "$commit"
    printf 'backup=%s\n' "$backup_name"
    printf 'verified_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } > "$tmp"; then rm -f "$tmp"; return 1; fi
  chmod 600 "$tmp" || { rm -f "$tmp"; return 1; }
  mv "$tmp" "$marker" || { rm -f "$tmp"; return 1; }
}

verify_bootstrap_marker() {
  local marker=$1 expected_project=$2 expected_database=$3 expected_backup_dir=$4 expected_commit=$5
  local line_count format project database commit backup_name verified_at backup_root
  VERIFIED_BOOTSTRAP_BACKUP=''
  [[ -s "$marker" ]] || { echo "bootstrap marker is missing or empty" >&2; return 1; }
  line_count=$(wc -l < "$marker" | tr -d ' ')
  [[ "$line_count" == 6 ]] || { echo "bootstrap marker has invalid metadata" >&2; return 1; }
  format=$(sed -n '1s/^format=//p' "$marker")
  project=$(sed -n '2s/^deployment_project=//p' "$marker")
  database=$(sed -n '3s/^production_database=//p' "$marker")
  commit=$(sed -n '4s/^verified_commit=//p' "$marker")
  backup_name=$(sed -n '5s/^backup=//p' "$marker")
  verified_at=$(sed -n '6s/^verified_at=//p' "$marker")
  [[ "$format" == jianghu-bootstrap-marker-v2 ]] || return 1
  [[ "$project" == "$expected_project" && "$database" == "$expected_database" ]] || {
    echo "bootstrap marker deployment identity mismatch" >&2; return 1
  }
  [[ "$commit" == "$expected_commit" ]] || {
    echo "bootstrap marker code revision mismatch" >&2; return 1
  }
  [[ "$verified_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || return 1
  [[ "$backup_name" =~ ^jianghu-[A-Za-z0-9T.-]+\.backup$ && "$backup_name" != */* ]] || return 1
  backup_root=$(cd "$expected_backup_dir" && pwd)
  VERIFIED_BOOTSTRAP_BACKUP="$backup_root/$backup_name"
  [[ -d "$VERIFIED_BOOTSTRAP_BACKUP" ]] || {
    echo "bootstrap marker backup does not exist" >&2; VERIFIED_BOOTSTRAP_BACKUP=''; return 1
  }
}
