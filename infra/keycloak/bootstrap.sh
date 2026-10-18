#!/bin/sh
set -eu

LOCAL_SERVER=http://127.0.0.1:8081

validate_uuid() {
  printf '%s\n' "$1" | grep -Eq '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' || {
    printf '%s\n' 'A configured identifier is not a UUID' >&2
    exit 2
  }
}

validate_realm_segment() {
  printf '%s\n' "$1" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' || {
    printf '%s\n' 'The configured realm must be one safe path segment' >&2
    exit 2
  }
  case "$1" in
    [Mm][Aa][Ss][Tt][Ee][Rr])
      printf '%s\n' 'The master realm is not a supported application realm' >&2
      exit 2
      ;;
  esac
}

validate_https_origin() {
  case "$1" in
    https://*) ;;
    *) printf '%s\n' 'Identity resource URLs must use HTTPS' >&2; exit 2 ;;
  esac
  case "$1" in
    *'?'*|*'#'*|*'@'*|*' '*|*'*'*|*'"'*|*'\'*|*','*)
      printf '%s\n' 'Identity resource URLs must be exact HTTPS origins' >&2
      exit 2
      ;;
  esac
  case "$1" in
    https://*/*)
      path=${1#https://*/}
      if [ -n "$path" ]; then
        printf '%s\n' 'Identity resource URLs must not contain a path' >&2
        exit 2
      fi
      ;;
  esac
}

validate_loopback_redirect() {
  [ "$1" = 'http://127.0.0.1:18971/callback' ] || {
    printf '%s\n' 'The OAuth smoke redirect must be the exact configured loopback callback' >&2
    exit 2
  }
}

validate_public_redirect() {
  case "$1" in
    *'?'*|*'#'*|*'@'*|*' '*|*'*'*|*'"'*|*'\\'*|*','*)
      printf '%s\n' 'The public redirect URI must be exact and contain no query, fragment, credentials, wildcard, or JSON delimiters' >&2
      exit 2
      ;;
  esac
  case "$1" in
    https://*/*|http://127.0.0.1:*/*|http://localhost:*/*) ;;
    *) printf '%s\n' 'The public redirect URI must use HTTPS or a loopback HTTP callback' >&2; exit 2 ;;
  esac
}

validate_client_id() {
  case "$1" in
    ''|*[!a-zA-Z0-9._-]*) printf '%s\n' 'A configured client ID is invalid' >&2; exit 2 ;;
  esac
}

validate_username() {
  case "$1" in
    ''|*[!a-zA-Z0-9._@+-]*) printf '%s\n' 'A configured username is invalid' >&2; exit 2 ;;
  esac
}

compact_json() {
  printf '%s' "$1" | tr -d '[:space:]'
}

cleanup() {
  cleanup_status=$?
  if [ "${CLEANUP_DONE:-false}" = true ]; then
    return
  fi
  CLEANUP_DONE=true
  if [ -n "${SERVER_PID:-}" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [ "$cleanup_status" -ne 0 ] && [ -n "${SERVER_LOG:-}" ] && [ -f "$SERVER_LOG" ]; then
    sql_state=$(sed -n 's/.*SQLState: \([A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9]\).*/\1/p' "$SERVER_LOG" | tail -n 1)
    http_status=$(sed -n 's/.*HTTP[^0-9]*\([1-5][0-9][0-9]\).*/\1/p' "$SERVER_LOG" | tail -n 1)
    error_class=keycloak-operation
    if [ "${BOOTSTRAP_STAGE:-}" = keycloak-startup ]; then
      error_class=keycloak-startup
    fi
    if grep -Eiq 'password authentication failed|28P01' "$SERVER_LOG"; then
      error_class=database-authentication
    elif grep -Eiq 'SSLHandshakeException|PKIX path building failed|certificate_unknown' "$SERVER_LOG"; then
      error_class=database-tls
    elif grep -Eiq 'Connection refused|ConnectException|Connection timed out' "$SERVER_LOG"; then
      error_class=database-connectivity
    elif grep -Eiq 'unknown option|unrecognized option|invalid value' "$SERVER_LOG"; then
      error_class=keycloak-configuration
    fi
    printf '{"status":"failed","stage":"%s","error_class":"%s","http_status":"%s","sql_state":"%s"}\n' \
      "${BOOTSTRAP_STAGE:-validation}" "$error_class" "$http_status" "$sql_state" >&2
  fi
  [ -z "${KCADM_CONFIG:-}" ] || rm -f "$KCADM_CONFIG"
  [ -z "${SERVER_LOG:-}" ] || rm -f "$SERVER_LOG"
}

start_local_server() {
  umask 077
  KCADM_CONFIG=$(mktemp)
  SERVER_LOG=$(mktemp)
  trap cleanup EXIT
  trap 'cleanup; exit 129' HUP
  trap 'cleanup; exit 130' INT
  trap 'cleanup; exit 143' TERM

  export KC_BOOTSTRAP_ADMIN_USERNAME KC_BOOTSTRAP_ADMIN_PASSWORD
  export KC_HOSTNAME="$ISSUER_BASE"
  export KC_HOSTNAME_STRICT=false
  export KC_HTTP_ENABLED=true
  export KC_HTTP_HOST=127.0.0.1
  export KC_HTTP_PORT=8081
  export KC_HTTP_MANAGEMENT_PORT=9000
  export KC_HTTP_MANAGEMENT_HOST=127.0.0.1
  export KC_PROXY_HEADERS=xforwarded
  export KC_PROXY_TRUSTED_ADDRESSES=127.0.0.1,::1
  export KC_HEALTH_ENABLED=true
  export KC_DB_TLS_MODE=verify-server
  export KC_DB_POOL_MAX_SIZE=4
  export KC_CACHE=ispn
  export KC_CACHE_STACK=jdbc-ping
  BOOTSTRAP_STAGE=keycloak-startup
  /opt/keycloak/bin/kc.sh start --optimized --hostname-strict=false >"$SERVER_LOG" 2>&1 &
  SERVER_PID=$!

  BOOTSTRAP_STAGE=admin-authentication
  attempt=0
  while ! /opt/keycloak/bin/kcadm.sh config credentials \
    --config "$KCADM_CONFIG" \
    --server "$LOCAL_SERVER" \
    --realm master \
    --user "$BOOTSTRAP_USER" \
    --password "$BOOTSTRAP_PASSWORD" >/dev/null 2>&1; do
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
      printf '%s\n' 'Keycloak bootstrap server exited before becoming ready' >&2
      exit 1
    fi
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 60 ]; then
      printf '%s\n' 'Keycloak bootstrap server did not become ready' >&2
      exit 1
    fi
    sleep 5
  done
  BOOTSTRAP_STAGE=ready
}

kcadm() {
  /opt/keycloak/bin/kcadm.sh "$@" --config "$KCADM_CONFIG" 2>>"$SERVER_LOG"
}

find_id_by_exact_name() {
  search_name=$1
  resource_type=$2
  if [ "$resource_type" = scope ]; then
    lookup_csv=$(kcadm get client-scopes -r "$REALM" \
      -q "search=$search_name" --fields=id,name --format csv --noquotes)
  elif [ "$resource_type" = client ]; then
    lookup_csv=$(kcadm get clients -r "$REALM" \
      -q "clientId=$search_name" --fields=id,clientId --format csv --noquotes)
  elif [ "$resource_type" = user ]; then
    lookup_csv=$(kcadm get users -r "$REALM" \
      -q "username=$search_name" -q exact=true --fields=id,username --format csv --noquotes)
  else
    printf '%s\n' 'A Keycloak lookup resource type is invalid' >&2
    exit 2
  fi

  lookup_found_id=
  lookup_duplicate=false
  while IFS=, read -r lookup_candidate_id lookup_candidate_name; do
    [ "$lookup_candidate_name" = "$search_name" ] || continue
    [ -n "$lookup_candidate_id" ] || continue
    if [ -n "$lookup_found_id" ] && [ "$lookup_found_id" != "$lookup_candidate_id" ]; then
      lookup_duplicate=true
    else
      lookup_found_id=$lookup_candidate_id
    fi
  done <<EOF
$lookup_csv
EOF

  [ "$lookup_duplicate" = false ] || {
    printf '%s\n' 'A Keycloak resource name resolves to multiple IDs' >&2
    exit 1
  }
  printf '%s\n' "$lookup_found_id"
}

ensure_scope() {
  BOOTSTRAP_STAGE=client-scopes
  scope_name=$1
  scope_id=$(find_id_by_exact_name "$scope_name" scope)
  if [ -z "$scope_id" ]; then
    if [ "${RENAME_MODE:-false}" = true ]; then
      printf '%s\n' 'A required source client scope is missing' >&2
      exit 1
    fi
    kcadm create client-scopes -r "$REALM" \
      -s name="$scope_name" \
      -s protocol=openid-connect \
      -s consentRequired=true >/dev/null
  else
    if [ "${RENAME_MODE:-false}" = true ]; then
      kcadm update "client-scopes/$scope_id" -r "$REALM" -s name="$scope_name" >/dev/null
    else
      kcadm update "client-scopes/$scope_id" -r "$REALM" \
        -s name="$scope_name" \
        -s protocol=openid-connect \
        -s consentRequired=true >/dev/null
    fi
  fi
  [ -n "$(find_id_by_exact_name "$scope_name" scope)" ] || {
    printf '%s\n' 'A required Keycloak client scope was not created' >&2
    exit 1
  }
}

ensure_resource_client() {
  BOOTSTRAP_STAGE=resource-clients
  resource_client_id=$1
  resource_url=$2
  client_id=$(find_id_by_exact_name "$resource_client_id" client)
  if [ -z "$client_id" ]; then
    if [ "${RENAME_MODE:-false}" = true ]; then
      printf '%s\n' 'A required source resource client is missing' >&2
      exit 1
    fi
    kcadm create clients -r "$REALM" \
      -s clientId="$resource_client_id" \
      -s name="$resource_client_id" \
      -s enabled=true \
      -s bearerOnly=true \
      -s publicClient=false \
      -s standardFlowEnabled=false \
      -s directAccessGrantsEnabled=false \
      -s implicitFlowEnabled=false \
      -s serviceAccountsEnabled=false \
      -s 'attributes={"resource_url":"'"$resource_url"'"}' >/dev/null
    client_id=$(find_id_by_exact_name "$resource_client_id" client)
  else
    kcadm update "clients/$client_id" -r "$REALM" \
      -s clientId="$resource_client_id" \
      -s enabled=true \
      -s bearerOnly=true \
      -s publicClient=false \
      -s standardFlowEnabled=false \
      -s directAccessGrantsEnabled=false \
      -s implicitFlowEnabled=false \
      -s serviceAccountsEnabled=false \
      -s 'attributes={"resource_url":"'"$resource_url"'"}' >/dev/null
  fi
  [ -n "$client_id" ] || {
    printf '%s\n' 'A required Keycloak resource client was not created' >&2
    exit 1
  }
}

ensure_scope_audience() {
  BOOTSTRAP_STAGE=audience-mapper
  scope_name=$1
  audience_client=$2
  scope_id=$(find_id_by_exact_name "$scope_name" scope)
  mapper_csv=$(kcadm get "client-scopes/$scope_id/protocol-mappers/models" -r "$REALM" \
    --fields=id,name --format csv --noquotes 2>/dev/null || true)
  mapper_id=$(find_mapper_id "$mapper_csv" "$AUDIENCE_MAPPER_NAME")
  legacy_mapper_id=$(find_mapper_id "$mapper_csv" "$SOURCE_AUDIENCE_MAPPER_NAME")
  if [ -n "$mapper_id" ] && [ -n "$legacy_mapper_id" ] && [ "$mapper_id" != "$legacy_mapper_id" ]; then
    printf '%s\n' 'Multiple resource audience mappers conflict with the configured names' >&2
    exit 1
  fi
  mapper_id=${mapper_id:-$legacy_mapper_id}
  if [ -n "$mapper_id" ]; then
    mapper_path="client-scopes/$scope_id/protocol-mappers/models/$mapper_id"
    if [ "${RENAME_MODE:-false}" = true ]; then
      case "$scope_name" in
        memory:resource:api) source_audience=${IDENTITY_SOURCE_API_URL:?IDENTITY_SOURCE_API_URL is required} ;;
        memory:resource:mcp:read) source_audience=${IDENTITY_SOURCE_API_URL%/}/mcp/read ;;
        memory:resource:mcp:write) source_audience=${IDENTITY_SOURCE_API_URL%/}/mcp/write ;;
        *) printf '%s\n' 'A resource audience scope is outside the rename contract' >&2; exit 1 ;;
      esac
      mapper_json=$(kcadm get "$mapper_path" -r "$REALM")
      mapper_config=$(extract_mapper_config "$mapper_json")
      updated_config=$(replace_mapper_config_value "$mapper_config" included.client.audience "$source_audience" "$audience_client")
      kcadm update "$mapper_path" -r "$REALM" \
        -s protocol=openid-connect \
        -s protocolMapper=oidc-audience-mapper \
        -s "config=$updated_config" >/dev/null
    else
      kcadm update "$mapper_path" -r "$REALM" \
        -s "name=$AUDIENCE_MAPPER_NAME" \
        -s protocol=openid-connect \
        -s protocolMapper=oidc-audience-mapper \
        -s 'config={"included.client.audience":"'"$audience_client"'","id.token.claim":"false","access.token.claim":"true"}' >/dev/null
    fi
  elif [ "${RENAME_MODE:-false}" = true ]; then
    printf '%s\n' 'A required source audience mapper is missing' >&2
    exit 1
  else
    kcadm create "client-scopes/$scope_id/protocol-mappers/models" -r "$REALM" \
      -s "name=$AUDIENCE_MAPPER_NAME" \
      -s protocol=openid-connect \
      -s protocolMapper=oidc-audience-mapper \
      -s 'config={"included.client.audience":"'"$audience_client"'","id.token.claim":"false","access.token.claim":"true"}' >/dev/null
  fi
}

ensure_scope_ids_mapper() {
  BOOTSTRAP_STAGE=scope-ids-mapper
  scope_id=$(find_id_by_exact_name "$SCOPE_IDS_SCOPE_NAME" scope)
  mapper_csv=$(kcadm get "client-scopes/$scope_id/protocol-mappers/models" -r "$REALM" \
    --fields=id,name --format csv --noquotes 2>/dev/null || true)
  mapper_id=$(find_mapper_id "$mapper_csv" "$SCOPE_IDS_MAPPER_NAME")
  legacy_mapper_id=$(find_mapper_id "$mapper_csv" "$SOURCE_SCOPE_IDS_MAPPER_NAME")
  if [ -n "$mapper_id" ] && [ -n "$legacy_mapper_id" ] && [ "$mapper_id" != "$legacy_mapper_id" ]; then
    printf '%s\n' 'Multiple scope IDs mappers conflict with the configured names' >&2
    exit 1
  fi
  mapper_id=${mapper_id:-$legacy_mapper_id}
  if [ -n "$mapper_id" ]; then
    mapper_path="client-scopes/$scope_id/protocol-mappers/models/$mapper_id"
    if [ "${RENAME_MODE:-false}" != true ]; then
      kcadm update "$mapper_path" -r "$REALM" \
        -s "name=$SCOPE_IDS_MAPPER_NAME" \
        -s protocol=openid-connect \
        -s protocolMapper=oidc-usermodel-attribute-mapper \
        -s 'config={"user.attribute":"scope_ids","claim.name":"scope_ids","jsonType.label":"String","multivalued":"true","access.token.claim":"true","id.token.claim":"false","userinfo.token.claim":"false"}' >/dev/null
    fi
  elif [ "${RENAME_MODE:-false}" = true ]; then
    printf '%s\n' 'A required source scope IDs mapper is missing' >&2
    exit 1
  else
    kcadm create "client-scopes/$scope_id/protocol-mappers/models" -r "$REALM" \
      -s "name=$SCOPE_IDS_MAPPER_NAME" \
      -s protocol=openid-connect \
      -s protocolMapper=oidc-usermodel-attribute-mapper \
      -s 'config={"user.attribute":"scope_ids","claim.name":"scope_ids","jsonType.label":"String","multivalued":"true","access.token.claim":"true","id.token.claim":"false","userinfo.token.claim":"false"}' >/dev/null
  fi
}

assert_exact_mapper_model() {
  mapper_json=$1
  expected_protocol_mapper=$2
  expected_config=$3
  compact_mapper=$(compact_json "$mapper_json")
  printf '%s' "$compact_mapper" | grep -Fq '"protocol":"openid-connect"' || {
    printf '%s\n' 'A required source mapper uses an unexpected protocol' >&2
    exit 1
  }
  printf '%s' "$compact_mapper" | grep -Fq "\"protocolMapper\":\"$expected_protocol_mapper\"" || {
    printf '%s\n' 'A required source mapper uses an unexpected mapper type' >&2
    exit 1
  }
  actual_config=$(extract_mapper_config "$compact_mapper")
  [ -n "$actual_config" ] || {
    printf '%s\n' 'A required source mapper configuration is missing' >&2
    exit 1
  }
  while IFS= read -r pair; do
    [ -n "$pair" ] || continue
    printf '%s' "$actual_config" | grep -Fq "$pair" || {
      printf '%s\n' 'A required source mapper configuration does not match the migration contract' >&2
      exit 1
    }
  done <<EOF
$expected_config
EOF
}

extract_mapper_config() {
  compact_mapper=$(compact_json "$1")
  printf '%s' "$compact_mapper" | sed -n 's/.*"config":\({[^}]*}\).*/\1/p'
}

replace_mapper_config_value() {
  mapper_config=$1
  config_key=$2
  source_value=$3
  target_value=$4
  source_pair="\"$config_key\":\"$source_value\""
  target_pair="\"$config_key\":\"$target_value\""
  if printf '%s' "$mapper_config" | grep -Fq "$target_pair"; then
    printf '%s\n' "$mapper_config"
    return
  fi
  printf '%s' "$mapper_config" | grep -Fq "$source_pair" || {
    printf '%s\n' 'A resource audience mapper no longer matches its source or target audience' >&2
    exit 1
  }
  escaped_source=$(printf '%s' "$source_pair" | sed 's/\./\\./g')
  printf '%s' "$mapper_config" | sed "s|$escaped_source|$target_pair|"
}

assert_scope_ids_mapper_source() {
  BOOTSTRAP_STAGE=scope-ids-mapper-preflight
  scope_id=$(find_id_by_exact_name "$SOURCE_SCOPE_IDS_SCOPE_NAME" scope)
  if [ -z "$scope_id" ]; then
    scope_id=$(find_id_by_exact_name "$SCOPE_IDS_SCOPE_NAME" scope)
  fi
  [ -n "$scope_id" ] || {
    printf '%s\n' 'The source scope_ids client scope is missing' >&2
    exit 1
  }
  mapper_csv=$(kcadm get "client-scopes/$scope_id/protocol-mappers/models" -r "$REALM" \
    --fields=id,name --format csv --noquotes)
  source_mapper_id=$(find_mapper_id "$mapper_csv" "$SOURCE_SCOPE_IDS_MAPPER_NAME")
  target_mapper_id=$(find_mapper_id "$mapper_csv" "$SCOPE_IDS_MAPPER_NAME")
  if [ -n "$source_mapper_id" ] && [ -n "$target_mapper_id" ] && [ "$source_mapper_id" != "$target_mapper_id" ]; then
    printf '%s\n' 'Multiple scope_ids mapper IDs conflict with the configured migration names' >&2
    exit 1
  fi
  mapper_id=${source_mapper_id:-$target_mapper_id}
  [ -n "$mapper_id" ] || {
    printf '%s\n' 'The required source scope_ids mapper is missing' >&2
    exit 1
  }
  SOURCE_SCOPE_IDS_SCOPE_ID=$scope_id
  SOURCE_SCOPE_IDS_MAPPER_ID=$mapper_id
  mapper_json=$(kcadm get "client-scopes/$scope_id/protocol-mappers/models/$mapper_id" -r "$REALM")
  expected_config=$(printf '%s\n' \
    '"access.token.claim":"true"' \
    '"claim.name":"scope_ids"' \
    '"id.token.claim":"false"' \
    '"jsonType.label":"String"' \
    '"multivalued":"true"' \
    '"user.attribute":"scope_ids"' \
    '"userinfo.token.claim":"false"')
  assert_exact_mapper_model "$mapper_json" oidc-usermodel-attribute-mapper "$expected_config"
}

assert_audience_mapper_source() {
  source_scope_name=$1
  target_scope_name=$2
  source_client_name=$3
  target_client_name=$4
  scope_id=$(find_id_by_exact_name "$source_scope_name" scope)
  if [ -z "$scope_id" ]; then
    scope_id=$(find_id_by_exact_name "$target_scope_name" scope)
  fi
  [ -n "$scope_id" ] || {
    printf '%s\n' 'A required source audience scope is missing' >&2
    exit 1
  }
  if [ -n "$(find_id_by_exact_name "$source_client_name" client)" ]; then
    expected_audience=$source_client_name
  else
    expected_audience=$target_client_name
  fi
  mapper_csv=$(kcadm get "client-scopes/$scope_id/protocol-mappers/models" -r "$REALM" \
    --fields=id,name --format csv --noquotes)
  source_mapper_id=$(find_mapper_id "$mapper_csv" "$SOURCE_AUDIENCE_MAPPER_NAME")
  target_mapper_id=$(find_mapper_id "$mapper_csv" "$AUDIENCE_MAPPER_NAME")
  if [ -n "$source_mapper_id" ] && [ -n "$target_mapper_id" ] && [ "$source_mapper_id" != "$target_mapper_id" ]; then
    printf '%s\n' 'Multiple audience mapper IDs conflict with the configured migration names' >&2
    exit 1
  fi
  mapper_id=${source_mapper_id:-$target_mapper_id}
  [ -n "$mapper_id" ] || {
    printf '%s\n' 'A required source audience mapper is missing' >&2
    exit 1
  }
  case "$source_scope_name" in
    "$IDENTITY_SOURCE_API_SCOPE_NAME")
      SOURCE_API_AUDIENCE_SCOPE_ID=$scope_id
      SOURCE_API_AUDIENCE_MAPPER_ID=$mapper_id
      ;;
    "$IDENTITY_SOURCE_READ_SCOPE_NAME")
      SOURCE_READ_AUDIENCE_SCOPE_ID=$scope_id
      SOURCE_READ_AUDIENCE_MAPPER_ID=$mapper_id
      ;;
    "$IDENTITY_SOURCE_WRITE_SCOPE_NAME")
      SOURCE_WRITE_AUDIENCE_SCOPE_ID=$scope_id
      SOURCE_WRITE_AUDIENCE_MAPPER_ID=$mapper_id
      ;;
    *) printf '%s\n' 'The configured audience mapper scope is outside the rename contract' >&2; exit 1 ;;
  esac
  mapper_json=$(kcadm get "client-scopes/$scope_id/protocol-mappers/models/$mapper_id" -r "$REALM")
  expected_config=$(printf '%s\n' \
    '"access.token.claim":"true"' \
    '"id.token.claim":"false"' \
    "\"included.client.audience\":\"$expected_audience\"")
  assert_exact_mapper_model "$mapper_json" oidc-audience-mapper "$expected_config"
}

find_mapper_id() {
  mapper_csv=$1
  mapper_name=$2
  mapper_found_id=
  mapper_duplicate=false
  while IFS=, read -r mapper_candidate_id mapper_candidate_name; do
    [ "$mapper_candidate_name" = "$mapper_name" ] || continue
    [ -n "$mapper_candidate_id" ] || continue
    if [ -n "$mapper_found_id" ] && [ "$mapper_found_id" != "$mapper_candidate_id" ]; then
      mapper_duplicate=true
    else
      mapper_found_id=$mapper_candidate_id
    fi
  done <<EOF
$mapper_csv
EOF
  [ "$mapper_duplicate" = false ] || {
    printf '%s\n' 'A configured mapper name resolves to multiple IDs' >&2
    exit 1
  }
  printf '%s\n' "$mapper_found_id"
}

ensure_scope_ids_admin_only() {
  BOOTSTRAP_STAGE=user-profile
  kcadm update users/profile -r "$REALM" -s unmanagedAttributePolicy=ADMIN_EDIT >/dev/null
  profile_json=$(kcadm get users/profile -r "$REALM")
  printf '%s' "$profile_json" | grep -Fq 'ADMIN_EDIT' || {
    printf '%s\n' 'The scope_ids user profile is not restricted to admin edits' >&2
    exit 1
  }
}

assert_scope_ids_admin_only() {
  profile_json=$(kcadm get users/profile -r "$REALM")
  printf '%s' "$profile_json" | grep -Fq 'ADMIN_EDIT' || {
    printf '%s\n' 'The source scope_ids user profile is not restricted to admin edits' >&2
    exit 1
  }
}

attach_scopes() {
  attached_client_id=$1
  shift
  default_scope_id=$(find_id_by_exact_name "$SCOPE_IDS_SCOPE_NAME" scope)
  kcadm update "clients/$attached_client_id/default-client-scopes/$default_scope_id" -r "$REALM" -n >/dev/null
  for optional_scope in "$@"; do
    optional_scope_id=$(find_id_by_exact_name "$optional_scope" scope)
    kcadm update "clients/$attached_client_id/optional-client-scopes/$optional_scope_id" -r "$REALM" -n >/dev/null
  done
}

ensure_public_client() {
  BOOTSTRAP_STAGE=public-client
  public_client_id=$1
  redirect_uri=$2
  validate_client_id "$public_client_id"
  client_id=$(find_id_by_exact_name "$public_client_id" client)
  if [ -z "$client_id" ]; then
    if [ "${RENAME_MODE:-false}" = true ]; then
      printf '%s\n' 'A required source public client is missing' >&2
      exit 1
    fi
    kcadm create clients -r "$REALM" \
      -s clientId="$public_client_id" \
      -s name="$public_client_id" \
      -s enabled=true \
      -s publicClient=true \
      -s standardFlowEnabled=true \
      -s directAccessGrantsEnabled=false \
      -s implicitFlowEnabled=false \
      -s serviceAccountsEnabled=false \
      -s consentRequired=true \
      -s 'redirectUris=["'"$redirect_uri"'"]' \
      -s 'webOrigins=["'"$(origin_from_redirect "$redirect_uri")"'"]' \
      -s 'attributes={"pkce.code.challenge.method":"S256"}' >/dev/null
    client_id=$(find_id_by_exact_name "$public_client_id" client)
  else
    kcadm update "clients/$client_id" -r "$REALM" \
      -s clientId="$public_client_id" \
      -s enabled=true \
      -s publicClient=true \
      -s standardFlowEnabled=true \
      -s directAccessGrantsEnabled=false \
      -s implicitFlowEnabled=false \
      -s serviceAccountsEnabled=false \
      -s consentRequired=true \
      -s 'redirectUris=["'"$redirect_uri"'"]' \
      -s 'webOrigins=["'"$(origin_from_redirect "$redirect_uri")"'"]' \
      -s 'attributes={"pkce.code.challenge.method":"S256"}' >/dev/null
  fi
  [ -n "$client_id" ] || {
    printf '%s\n' 'A required public OAuth client was not created' >&2
    exit 1
  }
  attach_scopes "$client_id" memory:read memory:write memory:admin \
    memory:resource:api memory:resource:mcp:read memory:resource:mcp:write
}

origin_from_redirect() {
  case "$1" in
    https://*) host_and_path=${1#https://}; printf '%s' "https://${host_and_path%%/*}" ;;
    http://127.0.0.1:*) host_and_path=${1#http://}; printf '%s' "http://${host_and_path%%/*}" ;;
    http://localhost:*) host_and_path=${1#http://}; printf '%s' "http://${host_and_path%%/*}" ;;
    *) printf '%s\n' 'The public redirect URI must be HTTPS or an exact loopback HTTP URI' >&2; exit 2 ;;
  esac
}

ensure_owner_user() {
  BOOTSTRAP_STAGE=owner-user
  validate_username "$OWNER_USERNAME"
  if [ -n "${IDENTITY_OWNER_SUBJECT_ID:-}" ]; then
    owner_user_id=$IDENTITY_OWNER_SUBJECT_ID
    validate_uuid "$owner_user_id"
    owner_json=$(kcadm get "users/$owner_user_id" -r "$REALM")
    compact_owner=$(compact_json "$owner_json")
    printf '%s' "$compact_owner" | grep -Fq "\"id\":\"$owner_user_id\"" || {
      printf '%s\n' 'The configured owner subject ID changed' >&2
      exit 1
    }
    printf '%s' "$compact_owner" | grep -Fq "\"username\":\"$OWNER_USERNAME\"" || {
      printf '%s\n' 'The configured owner subject has an unexpected username' >&2
      exit 1
    }
    return 0
  fi
  owner_user_id=$(find_id_by_exact_name "$OWNER_USERNAME" user)
  if [ -z "$owner_user_id" ]; then
    kcadm create users -r "$REALM" \
      -s username="$OWNER_USERNAME" \
      -s enabled=true \
      -s emailVerified=true \
      -s 'attributes.scope_ids=["'"$OWNER_SCOPE_ID"'"]' \
      -s 'requiredActions=["UPDATE_PASSWORD","CONFIGURE_TOTP"]' >/dev/null
    owner_user_id=$(find_id_by_exact_name "$OWNER_USERNAME" user)
  fi

  [ -n "$owner_user_id" ] || {
    printf '%s\n' 'The Keycloak-generated owner subject ID could not be resolved by exact username' >&2
    exit 1
  }
  validate_uuid "$owner_user_id"
  owner_json=$(kcadm get "users/$owner_user_id" -r "$REALM")
  compact_owner=$(compact_json "$owner_json")
  printf '%s' "$compact_owner" | grep -Fq "\"username\":\"$OWNER_USERNAME\"" || {
    printf '%s\n' 'The resolved owner subject is assigned to a different username' >&2
    exit 1
  }
  printf '%s' "$compact_owner" | grep -Fq "\"scope_ids\":[\"$OWNER_SCOPE_ID\"]" || {
    printf '%s\n' 'The owner user has a conflicting or non-exclusive scope_ids value' >&2
    exit 1
  }

  owner_credentials=$(kcadm get "users/$owner_user_id/credentials" -r "$REALM" \
    --fields=type --format csv --noquotes)
  if ! printf '%s\n' "$owner_credentials" | grep -Fxq password; then
    owner_password=${OWNER_INITIAL_PASSWORD:?OWNER_INITIAL_PASSWORD is required when the owner has no password credential}
    kcadm set-password -r "$REALM" --userid "$owner_user_id" \
      --new-password "$owner_password" --temporary >/dev/null
    kcadm update "users/$owner_user_id" -r "$REALM" \
      -s 'requiredActions=["UPDATE_PASSWORD","CONFIGURE_TOTP"]' >/dev/null
  fi
}

ensure_smoke_user() {
  BOOTSTRAP_STAGE=smoke-user
  smoke_username=${OAUTH_SMOKE_USERNAME:?OAUTH_SMOKE_USERNAME is required}
  smoke_scope_id=${OAUTH_SMOKE_SCOPE_ID:?OAUTH_SMOKE_SCOPE_ID is required}
  smoke_password=${OAUTH_SMOKE_PASSWORD:?OAUTH_SMOKE_PASSWORD is required}
  smoke_email=cloud-smoke-${smoke_scope_id}@example.invalid
  validate_uuid "$smoke_scope_id"
  validate_username "$smoke_username"
  smoke_user_id=$(find_id_by_exact_name "$smoke_username" user)
  if [ -z "$smoke_user_id" ]; then
    kcadm create users -r "$REALM" \
      -s username="$smoke_username" \
      -s firstName=Cloud \
      -s lastName=Smoke \
      -s email="$smoke_email" \
      -s enabled=true \
      -s emailVerified=true \
      -s 'attributes.scope_ids=["'"$smoke_scope_id"'"]' \
      -s 'requiredActions=[]' >/dev/null
    smoke_user_id=$(find_id_by_exact_name "$smoke_username" user)
  fi

  [ -n "$smoke_user_id" ] || {
    printf '%s\n' 'The Keycloak-generated smoke subject ID could not be resolved by exact username' >&2
    exit 1
  }
  validate_uuid "$smoke_user_id"
  smoke_json=$(kcadm get "users/$smoke_user_id" -r "$REALM")
  compact_smoke=$(compact_json "$smoke_json")
  printf '%s' "$compact_smoke" | grep -Fq "\"username\":\"$smoke_username\"" || {
    printf '%s\n' 'The resolved smoke subject is assigned to a different username' >&2
    exit 1
  }
  printf '%s' "$compact_smoke" | grep -Fq "\"scope_ids\":[\"$smoke_scope_id\"]" || {
    printf '%s\n' 'The smoke user has a conflicting or non-exclusive scope_ids value' >&2
    exit 1
  }
  kcadm update "users/$smoke_user_id" -r "$REALM" \
    -s firstName=Cloud \
    -s lastName=Smoke \
    -s email="$smoke_email" \
    -s enabled=true \
    -s emailVerified=true \
    -s 'requiredActions=[]' >/dev/null
  smoke_json=$(kcadm get "users/$smoke_user_id" -r "$REALM")
  compact_smoke=$(compact_json "$smoke_json")
  printf '%s' "$compact_smoke" | grep -Fq '"firstName":"Cloud"' || {
    printf '%s\n' 'The smoke user profile did not retain its synthetic first name' >&2
    exit 1
  }
  printf '%s' "$compact_smoke" | grep -Fq '"lastName":"Smoke"' || {
    printf '%s\n' 'The smoke user profile did not retain its synthetic last name' >&2
    exit 1
  }
  printf '%s' "$compact_smoke" | grep -Fq "\"email\":\"$smoke_email\"" || {
    printf '%s\n' 'The smoke user profile did not retain its synthetic email' >&2
    exit 1
  }

  smoke_credentials=$(kcadm get "users/$smoke_user_id/credentials" -r "$REALM" \
    --fields=type --format csv --noquotes)
  if ! printf '%s\n' "$smoke_credentials" | grep -Fxq password; then
    kcadm set-password -r "$REALM" --userid "$smoke_user_id" \
      --new-password "$smoke_password" >/dev/null
  fi
}

delete_smoke_user() {
  BOOTSTRAP_STAGE=smoke-user-cleanup
  validate_username "${OAUTH_SMOKE_USERNAME:?OAUTH_SMOKE_USERNAME is required for deletion}"
  smoke_scope_id=${OAUTH_SMOKE_SCOPE_ID:?OAUTH_SMOKE_SCOPE_ID is required for deletion}
  validate_uuid "$smoke_scope_id"
  smoke_user_id=$(find_id_by_exact_name "$OAUTH_SMOKE_USERNAME" user)
  if [ -n "$smoke_user_id" ]; then
    validate_uuid "$smoke_user_id"
    smoke_json=$(kcadm get "users/$smoke_user_id" -r "$REALM")
    compact_smoke=$(compact_json "$smoke_json")
    printf '%s' "$compact_smoke" | grep -Fq "\"username\":\"$OAUTH_SMOKE_USERNAME\"" || {
      printf '%s\n' 'The resolved smoke subject is assigned to a different username' >&2
      exit 1
    }
    printf '%s' "$compact_smoke" | grep -Fq "\"scope_ids\":[\"$smoke_scope_id\"]" || {
      printf '%s\n' 'The smoke user has a conflicting or non-exclusive scope_ids value' >&2
      exit 1
    }
    kcadm delete "users/$smoke_user_id" -r "$REALM" >/dev/null
  fi
}

configure_realm() {
  BOOTSTRAP_STAGE=realm-settings
  if kcadm get "realms/$REALM" >/dev/null 2>&1; then
    kcadm update "realms/$REALM" \
      -s "attributes.frontendUrl=$IDENTITY_PUBLIC_URL" \
      -s enabled=true \
      -s registrationAllowed=false \
      -s loginWithEmailAllowed=false \
      -s resetPasswordAllowed=true \
      -s rememberMe=false \
      -s bruteForceProtected=true \
      -s failureFactor=5 \
      -s waitIncrementSeconds=60 \
      -s maxFailureWaitSeconds=900 \
      -s accessTokenLifespan=300 \
      -s revokeRefreshToken=true \
      -s refreshTokenMaxReuse=0 >/dev/null
  else
    if [ "${RENAME_MODE:-false}" = true ]; then
      printf '%s\n' 'The configured target realm is missing; refusing to create it' >&2
      exit 1
    fi
    kcadm create realms \
      -s realm="$REALM" \
      -s "attributes.frontendUrl=$IDENTITY_PUBLIC_URL" \
      -s enabled=true \
      -s registrationAllowed=false \
      -s loginWithEmailAllowed=false \
      -s resetPasswordAllowed=true \
      -s rememberMe=false \
      -s bruteForceProtected=true \
      -s failureFactor=5 \
      -s waitIncrementSeconds=60 \
      -s maxFailureWaitSeconds=900 \
      -s accessTokenLifespan=300 \
      -s revokeRefreshToken=true \
      -s refreshTokenMaxReuse=0 >/dev/null
  fi

  for scope_name in memory:read memory:write memory:admin memory:resource:api \
    memory:resource:mcp:read memory:resource:mcp:write "$SCOPE_IDS_SCOPE_NAME"; do
    ensure_scope "$scope_name"
  done
  ensure_scope_audience memory:resource:api "$API_RESOURCE_URL"
  ensure_scope_audience memory:resource:mcp:read "$READ_RESOURCE_URL"
  ensure_scope_audience memory:resource:mcp:write "$WRITE_RESOURCE_URL"
  ensure_scope_ids_mapper
  ensure_scope_ids_admin_only

  ensure_resource_client "$API_RESOURCE_URL" "$API_RESOURCE_URL"
  ensure_resource_client "$READ_RESOURCE_URL" "$READ_RESOURCE_URL"
  ensure_resource_client "$WRITE_RESOURCE_URL" "$WRITE_RESOURCE_URL"

  public_client_id=${OAUTH_PUBLIC_CLIENT_ID:-memory-public-app}
  public_redirect_uri=${OAUTH_PUBLIC_REDIRECT_URI:?OAUTH_PUBLIC_REDIRECT_URI must be one exact HTTPS or loopback URI}
  validate_public_redirect "$public_redirect_uri"
  ensure_public_client "$public_client_id" "$public_redirect_uri"
  ensure_public_client "$SMOKE_CLIENT_ID" "$SMOKE_REDIRECT_URI"
  ensure_account_console_url

  ensure_owner_user
}

ensure_account_console_url() {
  BOOTSTRAP_STAGE=account-console
  account_client_id=$(find_id_by_exact_name account-console client)
  [ -n "$account_client_id" ] || {
    printf '%s\n' 'The Keycloak account console client is missing' >&2
    exit 1
  }
  kcadm update "clients/$account_client_id" -r "$REALM" \
    -s "rootUrl=$ACCOUNT_CONSOLE_URL" \
    -s "baseUrl=$ACCOUNT_CONSOLE_URL" \
    -s 'redirectUris=["'"$ACCOUNT_CONSOLE_URL"'*"]' \
    -s 'webOrigins=["'"$IDENTITY_PUBLIC_URL"'"]' >/dev/null
}

delete_smoke_client() {
  BOOTSTRAP_STAGE=smoke-client-cleanup
  client_id=$(find_id_by_exact_name "$SMOKE_CLIENT_ID" client)
  if [ -n "$client_id" ]; then
    kcadm delete "clients/$client_id" -r "$REALM" >/dev/null
  fi
}

rename_named_resource() {
  resource_kind=$1
  source_name=$2
  target_name=$3
  [ "$source_name" != "$target_name" ] || return 0
  case "$resource_kind" in
    scope)
      printf '%s' "$source_name$target_name" | grep -Eq '^[A-Za-z0-9:._-]+$' || {
        printf '%s\n' 'A configured scope rename contains an invalid name' >&2
        exit 2
      }
      ;;
    client)
      printf '%s' "$source_name$target_name" | grep -Eq '^[A-Za-z0-9:._/-]+$' || {
        printf '%s\n' 'A configured client rename contains an invalid name' >&2
        exit 2
      }
      ;;
    *) printf '%s\n' 'A Keycloak rename resource type is invalid' >&2; exit 2 ;;
  esac

  source_id=$(find_id_by_exact_name "$source_name" "$resource_kind")
  target_id=$(find_id_by_exact_name "$target_name" "$resource_kind")
  if [ -n "$source_id" ] && [ -n "$target_id" ]; then
    [ "$source_id" = "$target_id" ] || {
      printf '%s\n' 'Both source and target Keycloak resources exist with different IDs' >&2
      exit 1
    }
    return 0
  fi
  if [ -z "$source_id" ]; then
    [ -n "$target_id" ] || {
      printf '%s\n' 'A required source Keycloak resource is missing' >&2
      exit 1
    }
    return 0
  fi

  if [ "$resource_kind" = scope ]; then
    kcadm update "client-scopes/$source_id" -r "$REALM" -s "name=$target_name" >/dev/null
  else
    kcadm update "clients/$source_id" -r "$REALM" \
      -s "clientId=$target_name" -s "name=$target_name" >/dev/null
  fi
  target_id=$(find_id_by_exact_name "$target_name" "$resource_kind")
  [ "$target_id" = "$source_id" ] || {
    printf '%s\n' 'A Keycloak resource rename did not preserve its internal ID' >&2
    exit 1
  }
}

apply_renames() {
  mapping=$1
  resource_kind=$2
  [ -n "$mapping" ] || {
    printf '%s\n' 'The existing identity migration has no resource rename mapping' >&2
    exit 2
  }
  remaining=$mapping
  while [ -n "$remaining" ]; do
    pair=${remaining%%,*}
    if [ "$remaining" = "$pair" ]; then remaining=; else remaining=${remaining#*,}; fi
    case "$pair" in
      *=*) source_name=${pair%%=*}; target_name=${pair#*=} ;;
      *) printf '%s\n' 'A configured Keycloak rename mapping is malformed' >&2; exit 2 ;;
    esac
    [ -n "$source_name" ] && [ -n "$target_name" ] || {
      printf '%s\n' 'A configured Keycloak rename mapping is empty' >&2
      exit 2
    }
    rename_named_resource "$resource_kind" "$source_name" "$target_name"
  done
}

preflight_rename_mapping() {
  mapping=$1
  resource_kind=$2
  [ -n "$mapping" ] || {
    printf '%s\n' 'The existing identity migration has no resource rename mapping' >&2
    exit 2
  }
  remaining=$mapping
  while [ -n "$remaining" ]; do
    pair=${remaining%%,*}
    if [ "$remaining" = "$pair" ]; then remaining=; else remaining=${remaining#*,}; fi
    case "$pair" in
      *=*) source_name=${pair%%=*}; target_name=${pair#*=} ;;
      *) printf '%s\n' 'A configured Keycloak rename mapping is malformed' >&2; exit 2 ;;
    esac
    [ -n "$source_name" ] && [ -n "$target_name" ] || {
      printf '%s\n' 'A configured Keycloak rename mapping is empty' >&2
      exit 2
    }
    case "$resource_kind" in
      scope)
        printf '%s' "$source_name$target_name" | grep -Eq '^[A-Za-z0-9:._-]+$' || {
          printf '%s\n' 'A configured scope rename contains an invalid name' >&2
          exit 2
        }
        ;;
      client)
        printf '%s' "$source_name$target_name" | grep -Eq '^[A-Za-z0-9:._/-]+$' || {
          printf '%s\n' 'A configured client rename contains an invalid name' >&2
          exit 2
        }
        ;;
      *) printf '%s\n' 'A Keycloak rename resource type is invalid' >&2; exit 2 ;;
    esac
    source_id=$(find_id_by_exact_name "$source_name" "$resource_kind")
    target_id=$(find_id_by_exact_name "$target_name" "$resource_kind")
    if [ -n "$source_id" ] && [ -n "$target_id" ] && [ "$source_id" != "$target_id" ]; then
      printf '%s\n' 'Both source and target Keycloak resources exist with different IDs' >&2
      exit 1
    fi
    [ -n "$source_id" ] || [ -n "$target_id" ] || {
      printf '%s\n' 'A required source Keycloak resource is missing' >&2
      exit 1
    }
  done
}

preflight_existing_identity() {
  BOOTSTRAP_STAGE=rename-preflight
  [ -n "${IDENTITY_SOURCE_API_URL:-}" ] || {
    printf '%s\n' 'IDENTITY_SOURCE_API_URL is required for rename-existing' >&2
    exit 2
  }
  validate_https_origin "$IDENTITY_SOURCE_API_URL"
  [ -n "${IDENTITY_SOURCE_API_SCOPE_NAME:-}" ] &&
    [ -n "${IDENTITY_SOURCE_READ_SCOPE_NAME:-}" ] &&
    [ -n "${IDENTITY_SOURCE_WRITE_SCOPE_NAME:-}" ] || {
    printf '%s\n' 'The source audience scope names are required for rename-existing' >&2
    exit 2
  }
  preflight_rename_mapping "$IDENTITY_SCOPE_RENAMES" scope
  preflight_rename_mapping "$IDENTITY_CLIENT_RENAMES" client
  assert_scope_ids_mapper_source
  assert_audience_mapper_source "$IDENTITY_SOURCE_API_SCOPE_NAME" memory:resource:api \
    "$IDENTITY_SOURCE_API_URL" "$API_RESOURCE_URL"
  assert_audience_mapper_source "$IDENTITY_SOURCE_READ_SCOPE_NAME" memory:resource:mcp:read \
    "${IDENTITY_SOURCE_API_URL%/}/mcp/read" "${API_RESOURCE_URL%/}/mcp/read"
  assert_audience_mapper_source "$IDENTITY_SOURCE_WRITE_SCOPE_NAME" memory:resource:mcp:write \
    "${IDENTITY_SOURCE_API_URL%/}/mcp/write" "${API_RESOURCE_URL%/}/mcp/write"
  assert_scope_ids_admin_only
  account_client_id=$(find_id_by_exact_name account-console client)
  [ -n "$account_client_id" ] || {
    printf '%s\n' 'The required account-console client is missing' >&2
    exit 1
  }
}

rename_existing_realm() {
  BOOTSTRAP_STAGE=realm-preflight
  realm_source_id=$(realm_id "$SOURCE_REALM") || realm_source_id=
  realm_target_id=$(realm_id "$REALM") || realm_target_id=
  if [ -z "$realm_source_id" ]; then
    [ -n "$realm_target_id" ] || {
      printf '%s\n' 'The configured source realm does not exist' >&2
      exit 1
    }
    verify_owner_subject
    preflight_existing_identity
  else
    [ -z "$realm_target_id" ] || {
      printf '%s\n' 'The target realm already exists with a different identity' >&2
      exit 1
    }
    REALM=$SOURCE_REALM
    verify_owner_subject
    preflight_existing_identity
    source_confirm=$(realm_id "$SOURCE_REALM")
    [ "$source_confirm" = "$realm_source_id" ] || {
      printf '%s\n' 'The source realm changed during preflight' >&2
      exit 1
    }
    kcadm update "realms/$SOURCE_REALM" -s realm="$TARGET_REALM" >/dev/null
    realm_target_id=$(realm_id "$TARGET_REALM")
    [ "$realm_target_id" = "$realm_source_id" ] || {
      printf '%s\n' 'Realm rename did not preserve the internal realm ID' >&2
      exit 1
    }
    REALM=$TARGET_REALM
  fi

  STAGE=client-scope-rename
  apply_renames "$IDENTITY_SCOPE_RENAMES" scope
  STAGE=client-rename
  apply_renames "$IDENTITY_CLIENT_RENAMES" client
  RENAME_MODE=true
  configure_realm
  assert_renamed_mapper_readback
  verify_owner_subject
  final_id=$(realm_id "$TARGET_REALM")
  [ "$final_id" = "$realm_target_id" ] || {
    printf '%s\n' 'The target realm ID changed during reconciliation' >&2
    exit 1
  }
  printf '{"status":"renamed-existing","realm":"%s","realm_id":"%s","owner_subject_id":"%s","same_id":true}\n' \
    "$TARGET_REALM" "$final_id" "$IDENTITY_OWNER_SUBJECT_ID"
}

assert_renamed_mapper_readback() {
  BOOTSTRAP_STAGE=mapper-readback
  expected_config=$(printf '%s\n' \
    '"access.token.claim":"true"' \
    '"id.token.claim":"false"' \
    "\"included.client.audience\":\"$API_RESOURCE_URL\"")
  assert_target_mapper_readback memory:resource:api "$AUDIENCE_MAPPER_NAME" \
    "$SOURCE_API_AUDIENCE_SCOPE_ID" "$SOURCE_API_AUDIENCE_MAPPER_ID" oidc-audience-mapper \
    "$expected_config"
  expected_config=$(printf '%s\n' \
    '"access.token.claim":"true"' \
    '"id.token.claim":"false"' \
    "\"included.client.audience\":\"$READ_RESOURCE_URL\"")
  assert_target_mapper_readback memory:resource:mcp:read "$AUDIENCE_MAPPER_NAME" \
    "$SOURCE_READ_AUDIENCE_SCOPE_ID" "$SOURCE_READ_AUDIENCE_MAPPER_ID" oidc-audience-mapper \
    "$expected_config"
  expected_config=$(printf '%s\n' \
    '"access.token.claim":"true"' \
    '"id.token.claim":"false"' \
    "\"included.client.audience\":\"$WRITE_RESOURCE_URL\"")
  assert_target_mapper_readback memory:resource:mcp:write "$AUDIENCE_MAPPER_NAME" \
    "$SOURCE_WRITE_AUDIENCE_SCOPE_ID" "$SOURCE_WRITE_AUDIENCE_MAPPER_ID" oidc-audience-mapper \
    "$expected_config"
  assert_target_mapper_readback "$SCOPE_IDS_SCOPE_NAME" "$SCOPE_IDS_MAPPER_NAME" \
    "$SOURCE_SCOPE_IDS_SCOPE_ID" "$SOURCE_SCOPE_IDS_MAPPER_ID" oidc-usermodel-attribute-mapper \
    '"access.token.claim":"true"
"claim.name":"scope_ids"
"id.token.claim":"false"
"jsonType.label":"String"
"multivalued":"true"
"user.attribute":"scope_ids"
"userinfo.token.claim":"false"'
}

assert_target_mapper_readback() {
  target_scope_name=$1
  target_mapper_name=$2
  expected_scope_id=$3
  expected_mapper_id=$4
  expected_mapper_type=$5
  expected_config=$6
  scope_id=$(find_id_by_exact_name "$target_scope_name" scope)
  [ "$scope_id" = "$expected_scope_id" ] || {
    printf '%s\n' 'A renamed client scope did not preserve its configured ID' >&2
    exit 1
  }
  mapper_csv=$(kcadm get "client-scopes/$scope_id/protocol-mappers/models" -r "$REALM" \
    --fields=id,name --format csv --noquotes)
  target_mapper_id=$(find_mapper_id "$mapper_csv" "$target_mapper_name")
  source_mapper_id=$(find_mapper_id "$mapper_csv" "$SOURCE_AUDIENCE_MAPPER_NAME")
  if [ "$target_mapper_name" = "$SCOPE_IDS_MAPPER_NAME" ]; then
    source_mapper_id=$(find_mapper_id "$mapper_csv" "$SOURCE_SCOPE_IDS_MAPPER_NAME")
  fi
  [ "$target_mapper_id" = "$expected_mapper_id" ] && [ -z "$source_mapper_id" ] || {
    printf '%s\n' 'A renamed protocol mapper name or ID failed its readback check' >&2
    exit 1
  }
  mapper_json=$(kcadm get "client-scopes/$scope_id/protocol-mappers/models/$target_mapper_id" -r "$REALM")
  compact_mapper=$(compact_json "$mapper_json")
  printf '%s' "$compact_mapper" | grep -Fq "\"name\":\"$target_mapper_name\"" || {
    printf '%s\n' 'A renamed protocol mapper name failed its readback check' >&2
    exit 1
  }
  assert_exact_mapper_model "$mapper_json" "$expected_mapper_type" "$expected_config"
}

realm_id() {
  realm_json=$(kcadm get "realms/$1") || return 1
  printf '%s' "$realm_json" | grep -Eo '"id"[[:space:]]*:[[:space:]]*"[^"]+"' | head -n 1 | sed 's/^[^:]*:[[:space:]]*"//; s/"$//'
}

verify_owner_subject() {
  owner_json=$(kcadm get "users/$IDENTITY_OWNER_SUBJECT_ID" -r "$REALM") || {
    printf '%s\n' 'The configured owner subject does not exist' >&2
    exit 1
  }
  compact_owner=$(compact_json "$owner_json")
  printf '%s' "$compact_owner" | grep -Fq "\"id\":\"$IDENTITY_OWNER_SUBJECT_ID\"" || {
    printf '%s\n' 'The configured owner subject ID changed' >&2
    exit 1
  }
  printf '%s' "$compact_owner" | grep -Fq "\"username\":\"$OWNER_USERNAME\"" || {
    printf '%s\n' 'The configured owner subject has an unexpected username' >&2
    exit 1
  }
  printf '%s' "$compact_owner" | grep -Fq "\"scope_ids\":[\"$OWNER_SCOPE_ID\"]" || {
    printf '%s\n' 'The configured owner scope_ids claim differs from the migration baseline' >&2
    exit 1
  }
}

main() {
  REALM=${IDENTITY_REALM:-memory}
  TARGET_REALM=$REALM
  SOURCE_REALM=${IDENTITY_SOURCE_REALM:-}
  IDENTITY_PUBLIC_URL=${IDENTITY_PUBLIC_URL:?IDENTITY_PUBLIC_URL is required}
  ISSUER_BASE=$IDENTITY_PUBLIC_URL
  API_RESOURCE_URL=${API_RESOURCE_URL:?API_RESOURCE_URL is required}
  MCP_RESOURCE_BASE_URL=${MCP_RESOURCE_BASE_URL:?MCP_RESOURCE_BASE_URL is required}
  OWNER_ID=${IDENTITY_OWNER_ID:?IDENTITY_OWNER_ID is required}
  OWNER_SCOPE_ID=${IDENTITY_OWNER_SCOPE_ID:?IDENTITY_OWNER_SCOPE_ID is required}
  OWNER_USERNAME=${IDENTITY_OWNER_USERNAME:-owner}
  OWNER_INITIAL_PASSWORD=${IDENTITY_OWNER_INITIAL_PASSWORD:-}
  BOOTSTRAP_USER=${KC_BOOTSTRAP_ADMIN_USERNAME:?KC_BOOTSTRAP_ADMIN_USERNAME is required}
  BOOTSTRAP_PASSWORD=${KC_BOOTSTRAP_ADMIN_PASSWORD:?KC_BOOTSTRAP_ADMIN_PASSWORD is required}
  SMOKE_CLIENT_ID=${OAUTH_SMOKE_CLIENT_ID:-memory-cloud-oauth-smoke}
  SMOKE_REDIRECT_URI=${OAUTH_SMOKE_REDIRECT_URI:-http://127.0.0.1:18971/callback}
  PUBLIC_CLIENT_ID=${OAUTH_PUBLIC_CLIENT_ID:-memory-public-app}
  PUBLIC_REDIRECT_URI=${OAUTH_PUBLIC_REDIRECT_URI:?OAUTH_PUBLIC_REDIRECT_URI is required}
  AUDIENCE_MAPPER_NAME=${IDENTITY_AUDIENCE_MAPPER_NAME:-memory-resource-audience}
  SOURCE_AUDIENCE_MAPPER_NAME=${IDENTITY_SOURCE_AUDIENCE_MAPPER_NAME:-$AUDIENCE_MAPPER_NAME}
  SCOPE_IDS_MAPPER_NAME=${IDENTITY_SCOPE_IDS_MAPPER_NAME:-memory-scope-ids}
  SOURCE_SCOPE_IDS_MAPPER_NAME=${IDENTITY_SOURCE_SCOPE_IDS_MAPPER_NAME:-$SCOPE_IDS_MAPPER_NAME}
  SCOPE_IDS_SCOPE_NAME=${IDENTITY_SCOPE_IDS_SCOPE_NAME:-memory:scope_ids}
  SOURCE_SCOPE_IDS_SCOPE_NAME=${IDENTITY_SOURCE_SCOPE_IDS_SCOPE_NAME:-$SCOPE_IDS_SCOPE_NAME}
  ACCOUNT_CONSOLE_URL=${IDENTITY_PUBLIC_URL%/}/realms/$REALM/account/
  READ_RESOURCE_URL=${MCP_RESOURCE_BASE_URL%/}/mcp/read
  WRITE_RESOURCE_URL=${MCP_RESOURCE_BASE_URL%/}/mcp/write

  validate_uuid "$OWNER_ID"
  validate_uuid "$OWNER_SCOPE_ID"
  validate_realm_segment "$REALM"
  [ -z "$SOURCE_REALM" ] || validate_realm_segment "$SOURCE_REALM"
  validate_https_origin "$ISSUER_BASE"
  validate_https_origin "$API_RESOURCE_URL"
  validate_https_origin "$MCP_RESOURCE_BASE_URL"
  validate_loopback_redirect "$SMOKE_REDIRECT_URI"
  validate_client_id "$SMOKE_CLIENT_ID"
  validate_client_id "$PUBLIC_CLIENT_ID"
  validate_username "$OWNER_USERNAME"
  [ -z "${IDENTITY_OWNER_SUBJECT_ID:-}" ] || validate_uuid "$IDENTITY_OWNER_SUBJECT_ID"
  [ -z "$SOURCE_REALM" ] || [ "$SOURCE_REALM" != "$REALM" ] || {
    printf '%s\n' 'The source and target realms must differ' >&2
    exit 2
  }

  ISSUER_BASE=${ISSUER_BASE%/}
  IDENTITY_PUBLIC_URL=$ISSUER_BASE
  API_RESOURCE_URL=${API_RESOURCE_URL%/}
  MCP_RESOURCE_BASE_URL=${MCP_RESOURCE_BASE_URL%/}
  export ISSUER_BASE API_RESOURCE_URL MCP_RESOURCE_BASE_URL OWNER_ID OWNER_SCOPE_ID
  export IDENTITY_PUBLIC_URL OWNER_USERNAME OWNER_INITIAL_PASSWORD REALM
  export IDENTITY_OWNER_SUBJECT_ID SOURCE_REALM TARGET_REALM
  export AUDIENCE_MAPPER_NAME SOURCE_AUDIENCE_MAPPER_NAME
  export SCOPE_IDS_MAPPER_NAME SOURCE_SCOPE_IDS_MAPPER_NAME SCOPE_IDS_SCOPE_NAME SOURCE_SCOPE_IDS_SCOPE_NAME
  export ACCOUNT_CONSOLE_URL PUBLIC_CLIENT_ID PUBLIC_REDIRECT_URI

  start_local_server
  case "${OAUTH_SMOKE_ACTION:-configure}" in
    configure)
      configure_realm
      owner_user_id=${owner_user_id:-}
      if [ -n "${OAUTH_SMOKE_USERNAME:-}" ]; then
        ensure_smoke_user
        printf '{"status":"configured","realm":"%s","owner_subject_id":"%s","smoke_subject_id":"%s","resource_indicators":"experimental-enabled","bootstrap_password_emitted":false}\n' \
          "$REALM" "$owner_user_id" "$smoke_user_id"
      else
        printf '{"status":"configured","realm":"%s","owner_subject_id":"%s","resource_indicators":"experimental-enabled","bootstrap_password_emitted":false}\n' \
          "$REALM" "${owner_user_id:-}"
      fi
      ;;
    ensure-smoke-user)
      configure_realm
      ensure_smoke_user
      printf '{"status":"smoke-user-created-or-verified","realm":"%s","owner_subject_id":"%s","smoke_subject_id":"%s"}\n' \
        "$REALM" "$owner_user_id" "$smoke_user_id"
      ;;
    delete-smoke-user)
      delete_smoke_user
      delete_smoke_client
      printf '%s\n' '{"status":"smoke-user-and-client-removed","user_id_emitted":false}'
      ;;
    rename-existing)
      [ -n "$SOURCE_REALM" ] || {
        printf '%s\n' 'IDENTITY_SOURCE_REALM is required for rename-existing' >&2
        exit 2
      }
      [ -n "${IDENTITY_OWNER_SUBJECT_ID:-}" ] || {
        printf '%s\n' 'IDENTITY_OWNER_SUBJECT_ID is required for rename-existing' >&2
        exit 2
      }
      RENAME_MODE=true
      export RENAME_MODE
      rename_existing_realm
      ;;
    *) printf '%s\n' 'OAUTH_SMOKE_ACTION is invalid' >&2; exit 2 ;;
  esac
}

main "$@"
