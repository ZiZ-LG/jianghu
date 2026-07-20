#!/usr/bin/env bash

# Portable backup cryptography helpers. Secrets are accepted as shell variables
# and enter OpenSSL only through stdin/file descriptors, never process argv.

validate_backup_master_secret() {
  local master=${1-} database_password=${2-} normalized distinct_nibbles period unit repeated i
  [[ "$master" =~ ^[0-9a-fA-F]{64}$ ]] || {
    echo "BACKUP_MASTER_SECRET must be exactly 64 hexadecimal characters" >&2
    return 1
  }
  normalized=$(printf '%s' "$master" | tr 'A-F' 'a-f')
  distinct_nibbles=$(printf '%s' "$normalized" | fold -w 1 | sort -u | wc -l | tr -d ' ')
  [[ "$distinct_nibbles" -ge 8 ]] || {
    echo "BACKUP_MASTER_SECRET is a weak or placeholder value; generate it with openssl rand -hex 32" >&2
    return 1
  }
  for period in 1 2 4 8 16 32; do
    unit=${normalized:0:period}
    repeated=''
    for ((i = 0; i < 64 / period; i++)); do repeated="${repeated}${unit}"; done
    [[ "$normalized" != "$repeated" ]] || {
      echo "BACKUP_MASTER_SECRET is periodic; generate it with openssl rand -hex 32" >&2
      return 1
    }
  done
  [[ "$normalized" != "$(printf '%s' "$database_password" | tr 'A-F' 'a-f')" ]] || {
    echo "BACKUP_MASTER_SECRET must not reuse POSTGRES_PASSWORD" >&2
    return 1
  }
}

hex_to_bytes() {
  local hex=$1 escaped
  escaped=$(printf '%s' "$hex" | sed 's/../\\x&/g')
  printf '%b' "$escaped"
}

sha256_stream_hex() {
  openssl dgst -sha256 -r | awk '{ print $1 }'
}

derive_backup_keys() {
  local master=$1
  BACKUP_ENCRYPTION_PASSPHRASE=$(
    { hex_to_bytes "$master"; printf '%s' 'jianghu-backup-encryption-v2'; } | sha256_stream_hex
  )
  BACKUP_MAC_KEY_HEX=$(
    { hex_to_bytes "$master"; printf '%s' 'jianghu-backup-authentication-v2'; } | sha256_stream_hex
  )
}

openssl_supports_pbkdf2() {
  local help
  help=$(openssl enc -help 2>&1 || true)
  printf '%s' "$help" | grep -q -- '-pbkdf2'
}

backup_cipher_metadata() {
  cat <<'EOF'
format=jianghu-backup-v3
cipher=aes-256-cbc
kdf=sha256-domain-separated-v2
openssl_kdf=evp-bytestokey-sha256
mac=hmac-sha256
EOF
}

backup_encrypt_payload() {
  local output=$1
  # The passphrase is already derived from a random 256-bit master secret.
  # Explicit SHA-256 keeps EVP_BytesToKey output stable across OpenSSL 1.0.2+
  # without exposing raw key material in process arguments.
  openssl enc -aes-256-cbc -salt -md sha256 -pass fd:3 -out "$output" \
    3<<<"$BACKUP_ENCRYPTION_PASSPHRASE"
}

validate_backup_cipher_metadata() {
  local artifact=$1 format
  grep -Fxq 'cipher=aes-256-cbc' "$artifact/metadata" || { echo "unsupported backup cipher" >&2; return 1; }
  grep -Fxq 'kdf=sha256-domain-separated-v2' "$artifact/metadata" || { echo "unsupported backup key derivation" >&2; return 1; }
  grep -Fxq 'mac=hmac-sha256' "$artifact/metadata" || { echo "unsupported backup authentication" >&2; return 1; }
  format=$(sed -n 's/^format=//p' "$artifact/metadata" | tail -n 1)
  case "$format" in
    jianghu-backup-v2)
      openssl_supports_pbkdf2 || {
        echo "this OpenSSL cannot restore PBKDF2 backup format v2; use OpenSSL with -pbkdf2 support" >&2
        return 1
      }
      ;;
    jianghu-backup-v3)
      grep -Fxq 'openssl_kdf=evp-bytestokey-sha256' "$artifact/metadata" || {
        echo "unsupported OpenSSL backup key derivation" >&2
        return 1
      }
      ;;
    *) echo "unsupported backup format" >&2; return 1 ;;
  esac
}

backup_decrypt_payload() {
  local artifact=$1 format
  format=$(sed -n 's/^format=//p' "$artifact/metadata" | tail -n 1)
  case "$format" in
    jianghu-backup-v2)
      openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass fd:3 \
        3<<<"$BACKUP_ENCRYPTION_PASSPHRASE" < "$artifact/payload.enc"
      ;;
    jianghu-backup-v3)
      openssl enc -d -aes-256-cbc -md sha256 -pass fd:3 \
        3<<<"$BACKUP_ENCRYPTION_PASSPHRASE" < "$artifact/payload.enc"
      ;;
    *) echo "unsupported backup format" >&2; return 1 ;;
  esac
}

xor_pad_hex() {
  local key_hex=$1 mask=$2 padded pair value out='' i
  padded="${key_hex}$(printf '%064s' '' | tr ' ' 0)"
  padded=${padded:0:128}
  i=0
  while [[ $i -lt 128 ]]; do
    pair=${padded:$i:2}
    value=$((16#$pair ^ mask))
    printf -v pair '%02x' "$value"
    out="${out}${pair}"
    i=$((i + 2))
  done
  printf '%s' "$out"
}

artifact_auth_stream() {
  local artifact=$1 metadata_size payload_size
  metadata_size=$(wc -c < "$artifact/metadata" | tr -d ' ')
  payload_size=$(wc -c < "$artifact/payload.enc" | tr -d ' ')
  printf 'jianghu-backup-auth-v2\nmetadata-bytes=%s\n' "$metadata_size"
  cat "$artifact/metadata"
  printf '\npayload-bytes=%s\n' "$payload_size"
  cat "$artifact/payload.enc"
}

hmac_artifact_hex() {
  local key_hex=$1 artifact=$2 ipad opad inner
  ipad=$(xor_pad_hex "$key_hex" 54)
  opad=$(xor_pad_hex "$key_hex" 92)
  inner=$(mktemp "${TMPDIR:-/tmp}/jianghu-hmac.XXXXXX")
  {
    hex_to_bytes "$ipad"
    artifact_auth_stream "$artifact"
  } | openssl dgst -sha256 -binary > "$inner"
  {
    hex_to_bytes "$opad"
    cat "$inner"
  } | sha256_stream_hex
  rm -f "$inner"
}

constant_time_equal_hex() {
  local left=$1 right=$2 diff=0 i
  [[ ${#left} -eq 64 && ${#right} -eq 64 ]] || return 1
  for ((i = 0; i < 64; i++)); do
    diff=$((diff | $(printf '%d' "'${left:$i:1}") ^ $(printf '%d' "'${right:$i:1}")))
  done
  [[ $diff -eq 0 ]]
}

write_artifact_integrity() {
  local artifact=$1 checksum auth
  checksum=$(openssl dgst -sha256 -r "$artifact/payload.enc" | awk '{ print $1 }')
  printf '%s\n' "$checksum" > "$artifact/payload.sha256"
  auth=$(hmac_artifact_hex "$BACKUP_MAC_KEY_HEX" "$artifact")
  printf '%s\n' "$auth" > "$artifact/auth.hmac"
}

verify_artifact_auth() {
  local artifact=$1 expected_auth actual_auth expected_checksum actual_checksum
  [[ -f "$artifact/metadata" && -f "$artifact/payload.enc" && -f "$artifact/auth.hmac" && -f "$artifact/payload.sha256" ]] || {
    echo "backup artifact is incomplete" >&2
    return 1
  }
  expected_auth=$(tr -d '[:space:]' < "$artifact/auth.hmac")
  [[ "$expected_auth" =~ ^[0-9a-fA-F]{64}$ ]] || { echo "invalid backup authentication marker" >&2; return 1; }
  actual_auth=$(hmac_artifact_hex "$BACKUP_MAC_KEY_HEX" "$artifact")
  constant_time_equal_hex "$expected_auth" "$actual_auth" || { echo "backup authentication failed" >&2; return 1; }

  expected_checksum=$(tr -d '[:space:]' < "$artifact/payload.sha256")
  [[ "$expected_checksum" =~ ^[0-9a-fA-F]{64}$ ]] || { echo "invalid backup checksum" >&2; return 1; }
  actual_checksum=$(openssl dgst -sha256 -r "$artifact/payload.enc" | awk '{ print $1 }')
  constant_time_equal_hex "$expected_checksum" "$actual_checksum" || { echo "backup checksum mismatch" >&2; return 1; }
}
