CREATE SCHEMA audit;

CREATE SCHEMA auth;

CREATE SCHEMA core;

CREATE SCHEMA files;

CREATE SCHEMA notifications;

CREATE SCHEMA webhooks;

CREATE TYPE audit."Action" AS ENUM (
    'CREATE',
    'UPDATE',
    'DELETE',
    'MERGE',
    'ARCHIVE',
    'RESTORE',
    'LOGIN',
    'LOGOUT'
);

CREATE TYPE auth.client_type AS ENUM (
    'confidential',
    'public'
);

CREATE TYPE auth.identity_provider_kind AS ENUM (
    'oidc'
);

CREATE TYPE auth.org_member_role AS ENUM (
    'owner',
    'admin',
    'member'
);

CREATE TYPE auth.upstream_auth_purpose AS ENUM (
    'login',
    'link',
    'forced_link'
);

CREATE TYPE auth.user_type AS ENUM (
    'human',
    'service_account'
);

CREATE TYPE core.service_access_kind AS ENUM (
    'role',
    'audience'
);

CREATE TYPE core.service_access_status AS ENUM (
    'pending',
    'approved',
    'revoked'
);

CREATE TYPE files."BucketPolicy" AS ENUM (
    'public',
    'private'
);

CREATE TYPE files.share_kind AS ENUM (
    'OBJECT',
    'ARCHIVE'
);

CREATE TYPE notifications."NotificationChannel" AS ENUM (
    'email'
);

CREATE TYPE notifications."NotificationDeliveryStatus" AS ENUM (
    'pending',
    'sending',
    'sent',
    'failed'
);

CREATE TYPE notifications."NotificationStatus" AS ENUM (
    'pending',
    'sent',
    'partial',
    'failed'
);

CREATE TYPE webhooks."WebhookDeliveryStatus" AS ENUM (
    'PENDING',
    'SUCCESS',
    'FAILED'
);

CREATE TYPE webhooks."WebhookEndpointStatus" AS ENUM (
    'ACTIVE',
    'PAUSED',
    'DISABLED'
);

CREATE TABLE audit.audit_log_entries (
    id uuid NOT NULL,
    source character varying(100) NOT NULL,
    organization_id uuid,
    user_id uuid NOT NULL,
    user_email text,
    action audit."Action" NOT NULL,
    entity_type character varying(100) NOT NULL,
    entity_id text NOT NULL,
    entity_name character varying(500),
    changes jsonb,
    metadata jsonb,
    ip_address character varying(45),
    correlation_id character varying(255),
    writer_user_id uuid NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
)
PARTITION BY RANGE (created_at);

CREATE TABLE auth.access_tokens (
    id uuid NOT NULL,
    jti character varying(64) NOT NULL,
    client_id uuid NOT NULL,
    user_id uuid NOT NULL,
    organization_id uuid,
    auth_code_id uuid,
    refresh_token_id uuid,
    scopes text[],
    expires_at timestamp(3) without time zone NOT NULL,
    revoked_at timestamp(3) without time zone,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE auth.authorization_codes (
    id uuid NOT NULL,
    code_hash character varying(128) NOT NULL,
    client_id uuid NOT NULL,
    user_id uuid NOT NULL,
    organization_id uuid,
    redirect_uri character varying(2048) NOT NULL,
    scopes text[],
    code_challenge character varying(128) NOT NULL,
    code_challenge_method character varying(10) NOT NULL,
    nonce character varying(512),
    auth_time timestamp(3) without time zone NOT NULL,
    max_age integer,
    acr_values character varying(512),
    auth_methods text[] DEFAULT ARRAY[]::text[],
    expires_at timestamp(3) without time zone NOT NULL,
    used_at timestamp(3) without time zone,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    user_session_id uuid
);

CREATE TABLE auth.consent_sessions (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    client_id uuid NOT NULL,
    organization_id uuid,
    redirect_uri character varying(2048) NOT NULL,
    scopes text[],
    state character varying(512),
    code_challenge character varying(128) NOT NULL,
    code_challenge_method character varying(10) NOT NULL,
    nonce character varying(512),
    auth_time timestamp(3) without time zone NOT NULL,
    max_age integer,
    acr_values character varying(512),
    prompt character varying(50),
    auth_methods text[] DEFAULT ARRAY[]::text[],
    expires_at timestamp(3) without time zone NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    token_hash character varying(64) NOT NULL,
    user_session_id uuid
);

CREATE TABLE auth.identity_invites (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    provider_id uuid NOT NULL,
    created_by uuid NOT NULL,
    expires_at timestamp(3) without time zone NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE auth.identity_link_grants (
    id uuid NOT NULL,
    token_hash character varying(64) NOT NULL,
    user_id uuid NOT NULL,
    client_id uuid NOT NULL,
    redirect_uri character varying(2048) NOT NULL,
    scopes text[],
    state character varying(512),
    code_challenge character varying(128) NOT NULL,
    code_challenge_method character varying(10) NOT NULL,
    nonce character varying(512),
    max_age integer,
    acr_values character varying(512),
    prompt character varying(50),
    expires_at timestamp(3) without time zone NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE auth.identity_provider_domain_roles (
    id uuid NOT NULL,
    domain_id uuid NOT NULL,
    role_id uuid NOT NULL
);

CREATE TABLE auth.identity_provider_domains (
    id uuid NOT NULL,
    provider_id uuid NOT NULL,
    domain character varying(255) NOT NULL,
    organization_id uuid NOT NULL,
    auto_accept boolean DEFAULT false NOT NULL,
    sso_only boolean DEFAULT false NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL
);

CREATE TABLE auth.identity_providers (
    id uuid NOT NULL,
    slug character varying(50) NOT NULL,
    display_name character varying(100) NOT NULL,
    kind auth.identity_provider_kind NOT NULL,
    issuer character varying(512),
    client_id character varying(255) NOT NULL,
    client_secret text NOT NULL,
    scopes text[] DEFAULT ARRAY['openid'::text, 'email'::text, 'profile'::text],
    counts_as_mfa boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    CONSTRAINT identity_providers_oidc_issuer CHECK (((kind <> 'oidc'::auth.identity_provider_kind) OR (issuer IS NOT NULL)))
);

CREATE TABLE auth.oauth_clients (
    id uuid NOT NULL,
    client_id character varying(64) NOT NULL,
    client_secret character varying(255),
    client_type auth.client_type DEFAULT 'confidential'::auth.client_type NOT NULL,
    name character varying(100) NOT NULL,
    redirect_uris text[],
    post_logout_redirect_uris text[] DEFAULT ARRAY[]::text[],
    scopes text[],
    grant_types text[],
    audience text[] DEFAULT ARRAY[]::text[],
    owner_id uuid NOT NULL,
    organization_id uuid,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    previous_secret_expires_at timestamp(3) without time zone,
    previous_secret_hash character varying(255)
);

CREATE TABLE auth.org_selection_sessions (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    client_id uuid NOT NULL,
    redirect_uri character varying(2048) NOT NULL,
    scopes text[],
    state character varying(512),
    code_challenge character varying(128) NOT NULL,
    code_challenge_method character varying(10) NOT NULL,
    nonce character varying(512),
    auth_time timestamp(3) without time zone NOT NULL,
    max_age integer,
    acr_values character varying(512),
    prompt character varying(50),
    auth_methods text[] DEFAULT ARRAY[]::text[],
    expires_at timestamp(3) without time zone NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    token_hash character varying(64) NOT NULL
);

CREATE TABLE auth.organization_members (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    user_id uuid NOT NULL,
    member_role auth.org_member_role DEFAULT 'member'::auth.org_member_role NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE auth.organizations (
    id uuid NOT NULL,
    name character varying(255) NOT NULL,
    slug character varying(100) NOT NULL,
    code character varying(6) NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    archived_at timestamp(3) without time zone
);

CREATE TABLE auth.permissions (
    id uuid NOT NULL,
    name character varying(100) NOT NULL,
    display_name character varying(255) NOT NULL,
    description character varying(500),
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    missing_since timestamp(3) without time zone,
    retired_at timestamp(3) without time zone,
    service_id uuid NOT NULL,
    org_assignable boolean DEFAULT false NOT NULL
);

CREATE TABLE auth.recovery_codes (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    code_hash character varying(255) NOT NULL,
    used_at timestamp(3) without time zone,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE auth.refresh_tokens (
    id uuid NOT NULL,
    token_hash character varying(255) NOT NULL,
    token_prefix character varying(16) NOT NULL,
    client_id uuid NOT NULL,
    user_id uuid NOT NULL,
    organization_id uuid,
    auth_code_id uuid,
    scopes text[],
    expires_at timestamp(3) without time zone NOT NULL,
    revoked_at timestamp(3) without time zone,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    rotated_at timestamp(3) without time zone
);

CREATE TABLE auth.role_permissions (
    id uuid NOT NULL,
    role_id uuid NOT NULL,
    permission_id uuid NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE auth.roles (
    id uuid NOT NULL,
    name character varying(100) NOT NULL,
    display_name character varying(255) NOT NULL,
    description character varying(500),
    is_active boolean DEFAULT true NOT NULL,
    requires_2fa boolean DEFAULT false NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    archived_at timestamp(3) without time zone,
    missing_since timestamp(3) without time zone,
    retired_at timestamp(3) without time zone,
    service_id uuid
);

CREATE TABLE auth.scopes (
    id uuid NOT NULL,
    name character varying(50) NOT NULL,
    description character varying(255)
);

CREATE TABLE auth.system_settings (
    id uuid NOT NULL,
    key character varying(100) NOT NULL,
    value text NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL
);

CREATE TABLE auth.totp_setup_grants (
    id uuid NOT NULL,
    token_hash character varying(64) NOT NULL,
    user_id uuid NOT NULL,
    client_id uuid NOT NULL,
    redirect_uri character varying(2048) NOT NULL,
    scopes text[],
    state character varying(512),
    code_challenge character varying(128) NOT NULL,
    code_challenge_method character varying(10) NOT NULL,
    nonce character varying(512),
    max_age integer,
    acr_values character varying(512),
    prompt character varying(50),
    expires_at timestamp(3) without time zone NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    first_factor text[] DEFAULT ARRAY['pwd'::text]
);

CREATE TABLE auth.totp_setup_sessions (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    token_hash character varying(64) CONSTRAINT totp_setup_sessions_setup_token_not_null NOT NULL,
    totp_secret character varying(255) NOT NULL,
    expires_at timestamp(3) without time zone NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    client_id uuid,
    redirect_uri character varying(2048),
    state character varying(512),
    scope character varying(512),
    code_challenge character varying(128),
    code_challenge_method character varying(10),
    nonce character varying(512),
    max_age integer,
    acr_values character varying(512),
    prompt character varying(50)
);

CREATE TABLE auth.totp_verifications (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    client_id uuid NOT NULL,
    redirect_uri character varying(2048) NOT NULL,
    scopes text[],
    state character varying(512),
    code_challenge character varying(128) NOT NULL,
    code_challenge_method character varying(10) NOT NULL,
    nonce character varying(512),
    max_age integer,
    acr_values character varying(512),
    prompt character varying(50),
    expires_at timestamp(3) without time zone NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    token_hash character varying(64) NOT NULL,
    first_factor text[] DEFAULT ARRAY['pwd'::text]
);

CREATE TABLE auth.upstream_auth_sessions (
    id uuid NOT NULL,
    state_hash character varying(64) NOT NULL,
    provider_id uuid NOT NULL,
    purpose auth.upstream_auth_purpose NOT NULL,
    user_id uuid,
    nonce character varying(128) NOT NULL,
    code_verifier character varying(128) NOT NULL,
    client_id uuid,
    redirect_uri character varying(2048),
    scopes text[] DEFAULT ARRAY[]::text[],
    state character varying(512),
    code_challenge character varying(128),
    code_challenge_method character varying(10),
    client_nonce character varying(512),
    max_age integer,
    acr_values character varying(512),
    prompt character varying(50),
    link_grant_id uuid,
    expires_at timestamp(3) without time zone NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE auth.user_identities (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    provider_id uuid NOT NULL,
    subject character varying(255) NOT NULL,
    email character varying(255),
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    last_login_at timestamp(3) without time zone
);

CREATE TABLE auth.user_roles (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    role_id uuid NOT NULL,
    organization_id uuid,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    expires_at timestamp(3) without time zone,
    service_access_id uuid
);

CREATE TABLE auth.user_sessions (
    id uuid NOT NULL,
    token_hash character varying(64) CONSTRAINT user_sessions_session_token_not_null NOT NULL,
    user_id uuid NOT NULL,
    organization_id uuid,
    auth_time timestamp(3) without time zone NOT NULL,
    auth_methods text[] DEFAULT ARRAY[]::text[],
    acr_value character varying(100),
    expires_at timestamp(3) without time zone NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE auth.users (
    id uuid NOT NULL,
    email character varying(255) NOT NULL,
    password_hash character varying(255),
    name character varying(100),
    first_name character varying(100),
    last_name character varying(100),
    user_type auth.user_type DEFAULT 'human'::auth.user_type NOT NULL,
    oauth_client_id uuid,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    totp_secret character varying(255),
    totp_enabled boolean DEFAULT false NOT NULL,
    totp_enabled_at timestamp(3) without time zone,
    photo_object_id uuid,
    totp_last_window integer,
    CONSTRAINT users_email_lowercase CHECK (((email)::text = lower((email)::text)))
);

CREATE TABLE core.instance (
    id smallint DEFAULT 1 NOT NULL,
    setup_completed_at timestamp(3) without time zone,
    setup_completed_by uuid,
    CONSTRAINT instance_singleton CHECK ((id = 1))
);

CREATE TABLE core.outbox (
    id uuid NOT NULL,
    destination character varying(64) NOT NULL,
    payload jsonb NOT NULL,
    traceparent character varying(64),
    tracestate character varying(512),
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    next_attempt_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    claimed_at timestamp(3) without time zone,
    claimed_by text,
    attempts integer DEFAULT 0 NOT NULL,
    last_error character varying(1000),
    dead_lettered_at timestamp(3) without time zone
);

CREATE TABLE core.secrets (
    name character varying(128) NOT NULL,
    value text NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE core.service_access (
    id uuid NOT NULL,
    service_id uuid NOT NULL,
    kind core.service_access_kind NOT NULL,
    target character varying(200) NOT NULL,
    status core.service_access_status DEFAULT 'pending'::core.service_access_status NOT NULL,
    requested_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    decided_at timestamp(3) without time zone,
    decided_by uuid,
    approved_permission_ids uuid[] DEFAULT ARRAY[]::uuid[]
);

CREATE TABLE core.services (
    id uuid NOT NULL,
    slug character varying(64) NOT NULL,
    name character varying(100) NOT NULL,
    namespace character varying(64) NOT NULL,
    client_id uuid,
    is_active boolean DEFAULT true NOT NULL,
    declaration_hash character(64),
    declared_at timestamp(3) without time zone,
    created_by uuid NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    declaration_version character varying(64)
);

CREATE TABLE core.setup_tokens (
    hash character(64) NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    expires_at timestamp(3) without time zone NOT NULL
);

CREATE TABLE files.access_logs (
    id bigint NOT NULL,
    bucket_id integer,
    object_id uuid,
    user_id uuid,
    operation character varying(50) NOT NULL,
    status_code integer NOT NULL,
    ip_address character varying(45) NOT NULL,
    user_agent character varying(500),
    request_id character varying(64),
    error_message character varying(1000),
    "timestamp" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE SEQUENCE files.access_logs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE files.access_logs_id_seq OWNED BY files.access_logs.id;

CREATE TABLE files.archive_request_objects (
    archive_request_id uuid NOT NULL,
    "position" integer NOT NULL,
    version_id uuid NOT NULL
);

CREATE TABLE files.archive_requests (
    id uuid NOT NULL,
    bucket_id integer NOT NULL,
    prefix character varying(1024),
    format character varying(8) NOT NULL,
    filename character varying(255) NOT NULL,
    object_count integer NOT NULL,
    total_size_bytes bigint NOT NULL,
    expires_at timestamp(3) without time zone NOT NULL,
    created_by_user_id uuid,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    downloaded_at timestamp(3) without time zone
);

CREATE TABLE files.bucket_lifecycle_policies (
    id integer NOT NULL,
    bucket_id integer NOT NULL,
    expire_objects_after_days integer,
    expire_versions_after_days integer,
    purge_soft_deleted_after_days integer,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL
);

CREATE SEQUENCE files.bucket_lifecycle_policies_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE files.bucket_lifecycle_policies_id_seq OWNED BY files.bucket_lifecycle_policies.id;

CREATE TABLE files.bucket_permissions (
    id integer NOT NULL,
    bucket_id integer NOT NULL,
    user_id uuid NOT NULL,
    can_read boolean DEFAULT false NOT NULL,
    can_write boolean DEFAULT false NOT NULL,
    can_delete boolean DEFAULT false NOT NULL,
    granted_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    granted_by uuid NOT NULL,
    revoked_at timestamp(3) without time zone,
    revoked_by uuid
);

CREATE SEQUENCE files.bucket_permissions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE files.bucket_permissions_id_seq OWNED BY files.bucket_permissions.id;

CREATE TABLE files.buckets (
    id integer NOT NULL,
    name character varying(255) NOT NULL,
    description character varying(500),
    policy files."BucketPolicy" DEFAULT 'private'::files."BucketPolicy" NOT NULL,
    storage_quota_bytes bigint,
    current_usage_bytes bigint DEFAULT 0 NOT NULL,
    versioning_enabled boolean DEFAULT false NOT NULL,
    auto_thumbnails boolean DEFAULT false NOT NULL,
    cors_config jsonb,
    rate_limit_config jsonb,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    created_by uuid NOT NULL,
    deleted_at timestamp(3) without time zone,
    deleted_by uuid,
    organization_id uuid,
    missing_since timestamp(3) without time zone,
    retired_at timestamp(3) without time zone,
    service_id uuid
);

CREATE SEQUENCE files.buckets_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE files.buckets_id_seq OWNED BY files.buckets.id;

CREATE TABLE files.content_blobs (
    hash character varying(64) NOT NULL,
    size_bytes bigint NOT NULL,
    fs_path character varying(1024) NOT NULL,
    ref_count integer DEFAULT 0 NOT NULL,
    wrapped_dek bytea NOT NULL,
    iv bytea NOT NULL,
    master_key_version integer NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    orphaned_at timestamp(3) without time zone
);

CREATE TABLE files.idempotency_records (
    id bigint NOT NULL,
    scope character varying(128) NOT NULL,
    key character varying(255) NOT NULL,
    request_hash character varying(64) NOT NULL,
    response_status integer NOT NULL,
    response_body jsonb NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    expires_at timestamp(3) without time zone NOT NULL
);

CREATE SEQUENCE files.idempotency_records_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE files.idempotency_records_id_seq OWNED BY files.idempotency_records.id;

CREATE TABLE files.multipart_parts (
    id integer NOT NULL,
    upload_id uuid NOT NULL,
    part_number integer NOT NULL,
    size_bytes bigint NOT NULL,
    etag character varying(64) NOT NULL,
    fs_path character varying(1024) NOT NULL,
    uploaded_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE SEQUENCE files.multipart_parts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE files.multipart_parts_id_seq OWNED BY files.multipart_parts.id;

CREATE TABLE files.multipart_uploads (
    id uuid NOT NULL,
    bucket_id integer NOT NULL,
    object_key character varying(1024) NOT NULL,
    content_type character varying(255) NOT NULL,
    metadata jsonb,
    tags text[] DEFAULT ARRAY[]::text[],
    expected_size bigint,
    wrapped_staging_dek bytea NOT NULL,
    staging_dek_master_key_version integer NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_by uuid NOT NULL,
    expires_at timestamp(3) without time zone NOT NULL,
    completed_at timestamp(3) without time zone,
    aborted_at timestamp(3) without time zone
);

CREATE TABLE files.object_versions (
    id uuid NOT NULL,
    object_id uuid NOT NULL,
    content_blob_hash character varying(64),
    etag character varying(64),
    content_type character varying(255),
    metadata jsonb,
    tags text[] DEFAULT ARRAY[]::text[],
    is_current boolean DEFAULT false NOT NULL,
    is_delete_marker boolean DEFAULT false NOT NULL,
    restored_from_version_id uuid,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_by uuid NOT NULL,
    deleted_at timestamp(3) without time zone,
    deleted_by uuid
);

CREATE TABLE files.objects (
    id uuid NOT NULL,
    bucket_id integer NOT NULL,
    object_key character varying(1024) NOT NULL,
    delete_after timestamp(3) without time zone,
    thumbnail_for uuid,
    thumbnail_size character varying(16),
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    created_by uuid NOT NULL,
    deleted_at timestamp(3) without time zone,
    deleted_by uuid
);

CREATE TABLE files.shares (
    id uuid NOT NULL,
    token character varying(64) NOT NULL,
    bucket_id integer NOT NULL,
    kind files.share_kind NOT NULL,
    object_id uuid,
    version_id uuid,
    archive_request_id uuid,
    url_filename character varying(255),
    password_hash text,
    expires_at timestamp(3) without time zone,
    max_downloads integer,
    download_count integer DEFAULT 0 NOT NULL,
    revoked_at timestamp(3) without time zone,
    revoked_by_user_id uuid,
    note character varying(500),
    created_by_user_id uuid NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    CONSTRAINT shares_kind_target_check CHECK ((((kind = 'OBJECT'::files.share_kind) AND (object_id IS NOT NULL) AND (archive_request_id IS NULL)) OR ((kind = 'ARCHIVE'::files.share_kind) AND (archive_request_id IS NOT NULL) AND (object_id IS NULL) AND (version_id IS NULL))))
);

CREATE TABLE notifications.connections (
    id uuid NOT NULL,
    channel notifications."NotificationChannel" NOT NULL,
    slug character varying(50) NOT NULL,
    display_name character varying(100) NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    is_enabled boolean DEFAULT true NOT NULL,
    settings jsonb NOT NULL,
    secrets text,
    max_per_minute integer,
    created_by uuid NOT NULL,
    updated_by uuid NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL
);

CREATE TABLE notifications.deliveries (
    id uuid NOT NULL,
    notification_id uuid NOT NULL,
    notification_created_at timestamp(3) without time zone NOT NULL,
    connection_id uuid,
    recipients jsonb NOT NULL,
    status notifications."NotificationDeliveryStatus" DEFAULT 'pending'::notifications."NotificationDeliveryStatus" NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    last_error character varying(2048),
    provider_message_id character varying(255),
    provider_response character varying(4096),
    sent_at timestamp(3) without time zone,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL
)
PARTITION BY RANGE (notification_created_at);

CREATE TABLE notifications.notifications (
    id uuid NOT NULL,
    channel notifications."NotificationChannel" NOT NULL,
    connection_id uuid,
    sender_user_id uuid NOT NULL,
    organization_id uuid,
    recipients jsonb NOT NULL,
    content jsonb,
    summary character varying(998),
    attachments jsonb NOT NULL,
    status notifications."NotificationStatus" DEFAULT 'pending'::notifications."NotificationStatus" NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    sender_access jsonb
)
PARTITION BY RANGE (created_at);

CREATE TABLE webhooks.event_types (
    event_type character varying(100) NOT NULL,
    description text,
    source character varying(100) NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    missing_since timestamp(3) without time zone,
    retired_at timestamp(3) without time zone,
    service_id uuid NOT NULL,
    read_permission character varying(200)
);

CREATE TABLE webhooks.outbox_fanouts (
    outbox_id uuid NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE webhooks.webhook_deliveries (
    id uuid NOT NULL,
    webhook_endpoint_id uuid NOT NULL,
    event_type character varying(100) NOT NULL,
    payload jsonb NOT NULL,
    status webhooks."WebhookDeliveryStatus" DEFAULT 'PENDING'::webhooks."WebhookDeliveryStatus" NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    last_attempt_at timestamp(3) without time zone,
    http_status integer,
    response_body character varying(4096),
    error_message character varying(2048),
    completed_at timestamp(3) without time zone,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL
)
PARTITION BY RANGE (created_at);

CREATE TABLE webhooks.webhook_endpoint_event_types (
    webhook_endpoint_id uuid NOT NULL,
    event_type character varying(100) NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE webhooks.webhook_endpoints (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    url character varying(2048) NOT NULL,
    description text,
    signing_secret text NOT NULL,
    status webhooks."WebhookEndpointStatus" DEFAULT 'ACTIVE'::webhooks."WebhookEndpointStatus" NOT NULL,
    custom_headers jsonb,
    consecutive_failures integer DEFAULT 0 NOT NULL,
    archived_at timestamp(3) without time zone,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    created_by uuid NOT NULL,
    previous_secret_expires_at timestamp(3) without time zone,
    previous_signing_secret text,
    signing_secret_hint character varying(8)
);

ALTER TABLE ONLY files.access_logs ALTER COLUMN id SET DEFAULT nextval('files.access_logs_id_seq'::regclass);

ALTER TABLE ONLY files.bucket_lifecycle_policies ALTER COLUMN id SET DEFAULT nextval('files.bucket_lifecycle_policies_id_seq'::regclass);

ALTER TABLE ONLY files.bucket_permissions ALTER COLUMN id SET DEFAULT nextval('files.bucket_permissions_id_seq'::regclass);

ALTER TABLE ONLY files.buckets ALTER COLUMN id SET DEFAULT nextval('files.buckets_id_seq'::regclass);

ALTER TABLE ONLY files.idempotency_records ALTER COLUMN id SET DEFAULT nextval('files.idempotency_records_id_seq'::regclass);

ALTER TABLE ONLY files.multipart_parts ALTER COLUMN id SET DEFAULT nextval('files.multipart_parts_id_seq'::regclass);

ALTER TABLE ONLY audit.audit_log_entries
    ADD CONSTRAINT audit_log_entries_pkey PRIMARY KEY (id, created_at);

ALTER TABLE ONLY auth.access_tokens
    ADD CONSTRAINT access_tokens_pkey PRIMARY KEY (id);

ALTER TABLE ONLY auth.authorization_codes
    ADD CONSTRAINT authorization_codes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY auth.consent_sessions
    ADD CONSTRAINT consent_sessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY auth.identity_invites
    ADD CONSTRAINT identity_invites_pkey PRIMARY KEY (id);

ALTER TABLE ONLY auth.identity_link_grants
    ADD CONSTRAINT identity_link_grants_pkey PRIMARY KEY (id);

ALTER TABLE ONLY auth.identity_provider_domain_roles
    ADD CONSTRAINT identity_provider_domain_roles_pkey PRIMARY KEY (id);

ALTER TABLE ONLY auth.identity_provider_domains
    ADD CONSTRAINT identity_provider_domains_pkey PRIMARY KEY (id);

ALTER TABLE ONLY auth.identity_providers
    ADD CONSTRAINT identity_providers_pkey PRIMARY KEY (id);

ALTER TABLE ONLY auth.oauth_clients
    ADD CONSTRAINT oauth_clients_pkey PRIMARY KEY (id);

ALTER TABLE ONLY auth.org_selection_sessions
    ADD CONSTRAINT org_selection_sessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY auth.organization_members
    ADD CONSTRAINT organization_members_pkey PRIMARY KEY (id);

ALTER TABLE ONLY auth.organizations
    ADD CONSTRAINT organizations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY auth.permissions
    ADD CONSTRAINT permissions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY auth.recovery_codes
    ADD CONSTRAINT recovery_codes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY auth.refresh_tokens
    ADD CONSTRAINT refresh_tokens_pkey PRIMARY KEY (id);

ALTER TABLE ONLY auth.role_permissions
    ADD CONSTRAINT role_permissions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY auth.roles
    ADD CONSTRAINT roles_pkey PRIMARY KEY (id);

ALTER TABLE ONLY auth.scopes
    ADD CONSTRAINT scopes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY auth.system_settings
    ADD CONSTRAINT system_settings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY auth.totp_setup_grants
    ADD CONSTRAINT totp_setup_grants_pkey PRIMARY KEY (id);

ALTER TABLE ONLY auth.totp_setup_sessions
    ADD CONSTRAINT totp_setup_sessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY auth.totp_verifications
    ADD CONSTRAINT totp_verifications_pkey PRIMARY KEY (id);

ALTER TABLE ONLY auth.upstream_auth_sessions
    ADD CONSTRAINT upstream_auth_sessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY auth.user_identities
    ADD CONSTRAINT user_identities_pkey PRIMARY KEY (id);

ALTER TABLE ONLY auth.user_roles
    ADD CONSTRAINT user_roles_pkey PRIMARY KEY (id);

ALTER TABLE ONLY auth.user_sessions
    ADD CONSTRAINT user_sessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY auth.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

ALTER TABLE ONLY core.instance
    ADD CONSTRAINT instance_pkey PRIMARY KEY (id);

ALTER TABLE ONLY core.outbox
    ADD CONSTRAINT outbox_pkey PRIMARY KEY (id);

ALTER TABLE ONLY core.secrets
    ADD CONSTRAINT secrets_pkey PRIMARY KEY (name);

ALTER TABLE ONLY core.service_access
    ADD CONSTRAINT service_access_pkey PRIMARY KEY (id);

ALTER TABLE ONLY core.services
    ADD CONSTRAINT services_pkey PRIMARY KEY (id);

ALTER TABLE ONLY core.setup_tokens
    ADD CONSTRAINT setup_tokens_pkey PRIMARY KEY (hash);

ALTER TABLE ONLY files.access_logs
    ADD CONSTRAINT access_logs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY files.archive_request_objects
    ADD CONSTRAINT archive_request_objects_pkey PRIMARY KEY (archive_request_id, "position");

ALTER TABLE ONLY files.archive_requests
    ADD CONSTRAINT archive_requests_pkey PRIMARY KEY (id);

ALTER TABLE ONLY files.bucket_lifecycle_policies
    ADD CONSTRAINT bucket_lifecycle_policies_pkey PRIMARY KEY (id);

ALTER TABLE ONLY files.bucket_permissions
    ADD CONSTRAINT bucket_permissions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY files.buckets
    ADD CONSTRAINT buckets_pkey PRIMARY KEY (id);

ALTER TABLE ONLY files.content_blobs
    ADD CONSTRAINT content_blobs_pkey PRIMARY KEY (hash);

ALTER TABLE ONLY files.idempotency_records
    ADD CONSTRAINT idempotency_records_pkey PRIMARY KEY (id);

ALTER TABLE ONLY files.multipart_parts
    ADD CONSTRAINT multipart_parts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY files.multipart_uploads
    ADD CONSTRAINT multipart_uploads_pkey PRIMARY KEY (id);

ALTER TABLE ONLY files.object_versions
    ADD CONSTRAINT object_versions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY files.objects
    ADD CONSTRAINT objects_pkey PRIMARY KEY (id);

ALTER TABLE ONLY files.shares
    ADD CONSTRAINT shares_pkey PRIMARY KEY (id);

ALTER TABLE ONLY notifications.connections
    ADD CONSTRAINT connections_pkey PRIMARY KEY (id);

ALTER TABLE ONLY notifications.deliveries
    ADD CONSTRAINT deliveries_pkey PRIMARY KEY (id, notification_created_at);

ALTER TABLE ONLY notifications.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id, created_at);

ALTER TABLE ONLY webhooks.event_types
    ADD CONSTRAINT event_types_pkey PRIMARY KEY (event_type);

ALTER TABLE ONLY webhooks.outbox_fanouts
    ADD CONSTRAINT outbox_fanouts_pkey PRIMARY KEY (outbox_id);

ALTER TABLE ONLY webhooks.webhook_deliveries
    ADD CONSTRAINT webhook_deliveries_pkey PRIMARY KEY (id, created_at);

ALTER TABLE ONLY webhooks.webhook_endpoint_event_types
    ADD CONSTRAINT webhook_endpoint_event_types_pkey PRIMARY KEY (webhook_endpoint_id, event_type);

ALTER TABLE ONLY webhooks.webhook_endpoints
    ADD CONSTRAINT webhook_endpoints_pkey PRIMARY KEY (id);

CREATE INDEX audit_log_entries_correlation_id_idx ON ONLY audit.audit_log_entries USING btree (correlation_id);

CREATE INDEX audit_log_entries_created_at_idx ON ONLY audit.audit_log_entries USING btree (created_at);

CREATE INDEX audit_log_entries_entity_type_entity_id_idx ON ONLY audit.audit_log_entries USING btree (entity_type, entity_id);

CREATE INDEX audit_log_entries_organization_id_idx ON ONLY audit.audit_log_entries USING btree (organization_id);

CREATE INDEX audit_log_entries_source_idx ON ONLY audit.audit_log_entries USING btree (source);

CREATE INDEX audit_log_entries_user_email_idx ON ONLY audit.audit_log_entries USING btree (user_email);

CREATE INDEX audit_log_entries_user_id_idx ON ONLY audit.audit_log_entries USING btree (user_id);

CREATE INDEX audit_log_entries_writer_user_id_idx ON ONLY audit.audit_log_entries USING btree (writer_user_id);

CREATE INDEX access_tokens_auth_code_id_revoked_at_expires_at_idx ON auth.access_tokens USING btree (auth_code_id, revoked_at, expires_at);

CREATE INDEX access_tokens_client_id_revoked_at_expires_at_idx ON auth.access_tokens USING btree (client_id, revoked_at, expires_at);

CREATE UNIQUE INDEX access_tokens_jti_key ON auth.access_tokens USING btree (jti);

CREATE INDEX access_tokens_organization_id_idx ON auth.access_tokens USING btree (organization_id);

CREATE INDEX access_tokens_refresh_token_id_revoked_at_expires_at_idx ON auth.access_tokens USING btree (refresh_token_id, revoked_at, expires_at);

CREATE INDEX access_tokens_revoked_at_idx ON auth.access_tokens USING btree (revoked_at);

CREATE INDEX access_tokens_user_id_revoked_at_expires_at_idx ON auth.access_tokens USING btree (user_id, revoked_at, expires_at);

CREATE INDEX authorization_codes_client_id_idx ON auth.authorization_codes USING btree (client_id);

CREATE UNIQUE INDEX authorization_codes_code_hash_key ON auth.authorization_codes USING btree (code_hash);

CREATE INDEX authorization_codes_expires_at_idx ON auth.authorization_codes USING btree (expires_at);

CREATE INDEX authorization_codes_organization_id_idx ON auth.authorization_codes USING btree (organization_id);

CREATE INDEX authorization_codes_user_id_idx ON auth.authorization_codes USING btree (user_id);

CREATE INDEX authorization_codes_user_session_id_idx ON auth.authorization_codes USING btree (user_session_id);

CREATE INDEX consent_sessions_client_id_idx ON auth.consent_sessions USING btree (client_id);

CREATE INDEX consent_sessions_expires_at_idx ON auth.consent_sessions USING btree (expires_at);

CREATE INDEX consent_sessions_organization_id_idx ON auth.consent_sessions USING btree (organization_id);

CREATE UNIQUE INDEX consent_sessions_token_hash_key ON auth.consent_sessions USING btree (token_hash);

CREATE INDEX consent_sessions_user_id_client_id_expires_at_idx ON auth.consent_sessions USING btree (user_id, client_id, expires_at);

CREATE INDEX consent_sessions_user_session_id_idx ON auth.consent_sessions USING btree (user_session_id);

CREATE INDEX identity_invites_expires_at_idx ON auth.identity_invites USING btree (expires_at);

CREATE INDEX identity_invites_provider_id_idx ON auth.identity_invites USING btree (provider_id);

CREATE UNIQUE INDEX identity_invites_user_id_provider_id_key ON auth.identity_invites USING btree (user_id, provider_id);

CREATE INDEX identity_link_grants_expires_at_idx ON auth.identity_link_grants USING btree (expires_at);

CREATE UNIQUE INDEX identity_link_grants_token_hash_key ON auth.identity_link_grants USING btree (token_hash);

CREATE INDEX identity_link_grants_user_id_idx ON auth.identity_link_grants USING btree (user_id);

CREATE UNIQUE INDEX identity_provider_domain_roles_domain_id_role_id_key ON auth.identity_provider_domain_roles USING btree (domain_id, role_id);

CREATE INDEX identity_provider_domain_roles_role_id_idx ON auth.identity_provider_domain_roles USING btree (role_id);

CREATE UNIQUE INDEX identity_provider_domains_domain_key ON auth.identity_provider_domains USING btree (domain);

CREATE INDEX identity_provider_domains_organization_id_idx ON auth.identity_provider_domains USING btree (organization_id);

CREATE INDEX identity_provider_domains_provider_id_idx ON auth.identity_provider_domains USING btree (provider_id);

CREATE UNIQUE INDEX identity_providers_slug_key ON auth.identity_providers USING btree (slug);

CREATE UNIQUE INDEX oauth_clients_client_id_key ON auth.oauth_clients USING btree (client_id);

CREATE INDEX oauth_clients_organization_id_idx ON auth.oauth_clients USING btree (organization_id);

CREATE INDEX oauth_clients_owner_id_idx ON auth.oauth_clients USING btree (owner_id);

CREATE INDEX org_selection_sessions_expires_at_idx ON auth.org_selection_sessions USING btree (expires_at);

CREATE UNIQUE INDEX org_selection_sessions_token_hash_key ON auth.org_selection_sessions USING btree (token_hash);

CREATE INDEX org_selection_sessions_user_id_idx ON auth.org_selection_sessions USING btree (user_id);

CREATE UNIQUE INDEX organization_members_organization_id_user_id_key ON auth.organization_members USING btree (organization_id, user_id);

CREATE INDEX organization_members_user_id_idx ON auth.organization_members USING btree (user_id);

CREATE INDEX organizations_archived_at_idx ON auth.organizations USING btree (archived_at);

CREATE UNIQUE INDEX organizations_code_key ON auth.organizations USING btree (code);

CREATE INDEX organizations_is_active_idx ON auth.organizations USING btree (is_active);

CREATE UNIQUE INDEX organizations_slug_key ON auth.organizations USING btree (slug);

CREATE UNIQUE INDEX permissions_name_key ON auth.permissions USING btree (name);

CREATE INDEX permissions_retired_at_idx ON auth.permissions USING btree (retired_at);

CREATE INDEX permissions_service_id_idx ON auth.permissions USING btree (service_id);

CREATE INDEX recovery_codes_user_id_used_at_idx ON auth.recovery_codes USING btree (user_id, used_at);

CREATE INDEX refresh_tokens_auth_code_id_revoked_at_idx ON auth.refresh_tokens USING btree (auth_code_id, revoked_at);

CREATE INDEX refresh_tokens_client_id_revoked_at_idx ON auth.refresh_tokens USING btree (client_id, revoked_at);

CREATE INDEX refresh_tokens_organization_id_idx ON auth.refresh_tokens USING btree (organization_id);

CREATE INDEX refresh_tokens_revoked_at_idx ON auth.refresh_tokens USING btree (revoked_at);

CREATE UNIQUE INDEX refresh_tokens_token_hash_key ON auth.refresh_tokens USING btree (token_hash);

CREATE INDEX refresh_tokens_token_prefix_idx ON auth.refresh_tokens USING btree (token_prefix);

CREATE INDEX refresh_tokens_user_id_revoked_at_expires_at_idx ON auth.refresh_tokens USING btree (user_id, revoked_at, expires_at);

CREATE INDEX role_permissions_permission_id_idx ON auth.role_permissions USING btree (permission_id);

CREATE UNIQUE INDEX role_permissions_role_id_permission_id_key ON auth.role_permissions USING btree (role_id, permission_id);

CREATE INDEX roles_archived_at_idx ON auth.roles USING btree (archived_at);

CREATE UNIQUE INDEX roles_custom_name_key ON auth.roles USING btree (name) WHERE (service_id IS NULL);

CREATE INDEX roles_name_idx ON auth.roles USING btree (name);

CREATE UNIQUE INDEX roles_service_id_name_key ON auth.roles USING btree (service_id, name);

CREATE UNIQUE INDEX scopes_name_key ON auth.scopes USING btree (name);

CREATE UNIQUE INDEX system_settings_key_key ON auth.system_settings USING btree (key);

CREATE INDEX totp_setup_grants_expires_at_idx ON auth.totp_setup_grants USING btree (expires_at);

CREATE UNIQUE INDEX totp_setup_grants_token_hash_key ON auth.totp_setup_grants USING btree (token_hash);

CREATE INDEX totp_setup_grants_user_id_idx ON auth.totp_setup_grants USING btree (user_id);

CREATE INDEX totp_setup_sessions_expires_at_idx ON auth.totp_setup_sessions USING btree (expires_at);

CREATE UNIQUE INDEX totp_setup_sessions_token_hash_key ON auth.totp_setup_sessions USING btree (token_hash);

CREATE INDEX totp_setup_sessions_user_id_expires_at_idx ON auth.totp_setup_sessions USING btree (user_id, expires_at);

CREATE INDEX totp_verifications_expires_at_idx ON auth.totp_verifications USING btree (expires_at);

CREATE UNIQUE INDEX totp_verifications_token_hash_key ON auth.totp_verifications USING btree (token_hash);

CREATE INDEX totp_verifications_user_id_idx ON auth.totp_verifications USING btree (user_id);

CREATE INDEX upstream_auth_sessions_expires_at_idx ON auth.upstream_auth_sessions USING btree (expires_at);

CREATE INDEX upstream_auth_sessions_provider_id_idx ON auth.upstream_auth_sessions USING btree (provider_id);

CREATE UNIQUE INDEX upstream_auth_sessions_state_hash_key ON auth.upstream_auth_sessions USING btree (state_hash);

CREATE INDEX upstream_auth_sessions_user_id_idx ON auth.upstream_auth_sessions USING btree (user_id);

CREATE UNIQUE INDEX user_identities_provider_id_subject_key ON auth.user_identities USING btree (provider_id, subject);

CREATE UNIQUE INDEX user_identities_user_id_provider_id_key ON auth.user_identities USING btree (user_id, provider_id);

CREATE INDEX user_roles_organization_id_idx ON auth.user_roles USING btree (organization_id);

CREATE INDEX user_roles_role_id_idx ON auth.user_roles USING btree (role_id);

CREATE UNIQUE INDEX user_roles_service_access_id_key ON auth.user_roles USING btree (service_access_id);

CREATE INDEX user_roles_user_id_idx ON auth.user_roles USING btree (user_id);

CREATE UNIQUE INDEX user_roles_user_id_role_id_global_key ON auth.user_roles USING btree (user_id, role_id) WHERE (organization_id IS NULL);

CREATE UNIQUE INDEX user_roles_user_id_role_id_org_id_key ON auth.user_roles USING btree (user_id, role_id, organization_id) WHERE (organization_id IS NOT NULL);

CREATE INDEX user_sessions_expires_at_idx ON auth.user_sessions USING btree (expires_at);

CREATE INDEX user_sessions_organization_id_idx ON auth.user_sessions USING btree (organization_id);

CREATE UNIQUE INDEX user_sessions_token_hash_key ON auth.user_sessions USING btree (token_hash);

CREATE INDEX user_sessions_user_id_expires_at_idx ON auth.user_sessions USING btree (user_id, expires_at);

CREATE INDEX users_created_at_idx ON auth.users USING btree (created_at);

CREATE UNIQUE INDEX users_email_key ON auth.users USING btree (email);

CREATE INDEX users_is_active_idx ON auth.users USING btree (is_active);

CREATE UNIQUE INDEX users_oauth_client_id_key ON auth.users USING btree (oauth_client_id);

CREATE INDEX users_user_type_idx ON auth.users USING btree (user_type);

CREATE INDEX outbox_dead_lettered_at_idx ON core.outbox USING btree (dead_lettered_at);

CREATE INDEX outbox_next_attempt_at_idx ON core.outbox USING btree (next_attempt_at);

CREATE INDEX outbox_pending_idx ON core.outbox USING btree (next_attempt_at) WHERE (dead_lettered_at IS NULL);

CREATE UNIQUE INDEX service_access_service_id_kind_target_key ON core.service_access USING btree (service_id, kind, target);

CREATE INDEX service_access_status_idx ON core.service_access USING btree (status);

CREATE UNIQUE INDEX services_client_id_key ON core.services USING btree (client_id);

CREATE UNIQUE INDEX services_namespace_key ON core.services USING btree (namespace);

CREATE UNIQUE INDEX services_slug_key ON core.services USING btree (slug);

CREATE INDEX setup_tokens_expires_at_idx ON core.setup_tokens USING btree (expires_at);

CREATE INDEX access_logs_bucket_id_timestamp_idx ON files.access_logs USING btree (bucket_id, "timestamp");

CREATE INDEX access_logs_object_id_timestamp_idx ON files.access_logs USING btree (object_id, "timestamp");

CREATE INDEX access_logs_timestamp_idx ON files.access_logs USING btree ("timestamp");

CREATE INDEX access_logs_user_id_timestamp_idx ON files.access_logs USING btree (user_id, "timestamp");

CREATE INDEX archive_request_objects_version_id_idx ON files.archive_request_objects USING btree (version_id);

CREATE INDEX archive_requests_bucket_id_idx ON files.archive_requests USING btree (bucket_id);

CREATE INDEX archive_requests_expires_at_idx ON files.archive_requests USING btree (expires_at);

CREATE UNIQUE INDEX bucket_lifecycle_policies_bucket_id_key ON files.bucket_lifecycle_policies USING btree (bucket_id);

CREATE INDEX bucket_lifecycle_policies_enabled_idx ON files.bucket_lifecycle_policies USING btree (enabled);

CREATE UNIQUE INDEX bucket_permissions_bucket_id_user_id_key ON files.bucket_permissions USING btree (bucket_id, user_id);

CREATE INDEX bucket_permissions_revoked_at_idx ON files.bucket_permissions USING btree (revoked_at);

CREATE INDEX bucket_permissions_user_id_idx ON files.bucket_permissions USING btree (user_id);

CREATE INDEX buckets_created_at_idx ON files.buckets USING btree (created_at);

CREATE INDEX buckets_deleted_at_idx ON files.buckets USING btree (deleted_at);

CREATE UNIQUE INDEX buckets_live_name_key ON files.buckets USING btree (name) WHERE (deleted_at IS NULL);

CREATE INDEX buckets_organization_id_idx ON files.buckets USING btree (organization_id);

CREATE INDEX buckets_policy_idx ON files.buckets USING btree (policy);

CREATE INDEX buckets_service_id_idx ON files.buckets USING btree (service_id);

CREATE INDEX content_blobs_orphaned_at_idx ON files.content_blobs USING btree (orphaned_at);

CREATE INDEX idempotency_records_expires_at_idx ON files.idempotency_records USING btree (expires_at);

CREATE UNIQUE INDEX idempotency_records_scope_key_key ON files.idempotency_records USING btree (scope, key);

CREATE UNIQUE INDEX multipart_parts_upload_id_part_number_key ON files.multipart_parts USING btree (upload_id, part_number);

CREATE INDEX multipart_uploads_bucket_id_completed_at_idx ON files.multipart_uploads USING btree (bucket_id, completed_at);

CREATE INDEX multipart_uploads_expires_at_idx ON files.multipart_uploads USING btree (expires_at);

CREATE INDEX object_versions_content_blob_hash_idx ON files.object_versions USING btree (content_blob_hash);

CREATE INDEX object_versions_expiration_scan ON files.object_versions USING btree (is_current, created_at) WHERE (deleted_at IS NULL);

CREATE INDEX object_versions_object_id_created_at_idx ON files.object_versions USING btree (object_id, created_at);

CREATE INDEX object_versions_object_id_is_current_idx ON files.object_versions USING btree (object_id, is_current);

CREATE UNIQUE INDEX object_versions_one_current_per_object ON files.object_versions USING btree (object_id) WHERE ((is_current = true) AND (deleted_at IS NULL));

CREATE INDEX object_versions_restored_from_version_id_idx ON files.object_versions USING btree (restored_from_version_id);

CREATE INDEX object_versions_tags_idx ON files.object_versions USING gin (tags);

CREATE INDEX objects_bucket_id_object_key_idx ON files.objects USING btree (bucket_id, object_key);

CREATE UNIQUE INDEX objects_bucket_live_key ON files.objects USING btree (bucket_id, object_key) WHERE (deleted_at IS NULL);

CREATE INDEX objects_bucket_prefix_scan ON files.objects USING btree (bucket_id, object_key text_pattern_ops) WHERE ((deleted_at IS NULL) AND (thumbnail_for IS NULL));

CREATE INDEX objects_created_at_idx ON files.objects USING btree (created_at);

CREATE INDEX objects_delete_after_idx ON files.objects USING btree (delete_after);

CREATE INDEX objects_deleted_at_idx ON files.objects USING btree (deleted_at);

CREATE INDEX objects_object_key_idx ON files.objects USING btree (object_key);

CREATE INDEX objects_thumbnail_for_idx ON files.objects USING btree (thumbnail_for);

CREATE INDEX shares_archive_request_id_idx ON files.shares USING btree (archive_request_id);

CREATE INDEX shares_bucket_id_created_at_idx ON files.shares USING btree (bucket_id, created_at DESC);

CREATE INDEX shares_created_by_user_id_idx ON files.shares USING btree (created_by_user_id);

CREATE INDEX shares_expires_at_idx ON files.shares USING btree (expires_at);

CREATE INDEX shares_object_id_idx ON files.shares USING btree (object_id);

CREATE INDEX shares_revoked_at_idx ON files.shares USING btree (revoked_at);

CREATE UNIQUE INDEX shares_token_key ON files.shares USING btree (token);

CREATE UNIQUE INDEX connections_channel_slug_key ON notifications.connections USING btree (channel, slug);

CREATE UNIQUE INDEX connections_default_per_channel ON notifications.connections USING btree (channel) WHERE is_default;

CREATE INDEX deliveries_notification_id_notification_created_at_idx ON ONLY notifications.deliveries USING btree (notification_id, notification_created_at);

CREATE INDEX deliveries_status_updated_at_idx ON ONLY notifications.deliveries USING btree (status, updated_at);

CREATE INDEX notifications_created_at_idx ON ONLY notifications.notifications USING btree (created_at);

CREATE INDEX notifications_sender_user_id_created_at_idx ON ONLY notifications.notifications USING btree (sender_user_id, created_at);

CREATE INDEX notifications_status_idx ON ONLY notifications.notifications USING btree (status);

CREATE INDEX event_types_service_id_idx ON webhooks.event_types USING btree (service_id);

CREATE INDEX event_types_source_idx ON webhooks.event_types USING btree (source);

CREATE INDEX outbox_fanouts_created_at_idx ON webhooks.outbox_fanouts USING btree (created_at);

CREATE INDEX webhook_deliveries_status_idx ON ONLY webhooks.webhook_deliveries USING btree (status);

CREATE INDEX webhook_deliveries_webhook_endpoint_id_created_at_idx ON ONLY webhooks.webhook_deliveries USING btree (webhook_endpoint_id, created_at);

CREATE INDEX webhook_endpoint_event_types_event_type_idx ON webhooks.webhook_endpoint_event_types USING btree (event_type);

CREATE INDEX webhook_endpoints_archived_at_idx ON webhooks.webhook_endpoints USING btree (archived_at);

CREATE INDEX webhook_endpoints_organization_id_status_idx ON webhooks.webhook_endpoints USING btree (organization_id, status);

ALTER TABLE audit.audit_log_entries
    ADD CONSTRAINT audit_log_entries_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES auth.organizations(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE audit.audit_log_entries
    ADD CONSTRAINT audit_log_entries_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE audit.audit_log_entries
    ADD CONSTRAINT audit_log_entries_writer_user_id_fkey FOREIGN KEY (writer_user_id) REFERENCES auth.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY auth.access_tokens
    ADD CONSTRAINT access_tokens_auth_code_id_fkey FOREIGN KEY (auth_code_id) REFERENCES auth.authorization_codes(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY auth.access_tokens
    ADD CONSTRAINT access_tokens_client_id_fkey FOREIGN KEY (client_id) REFERENCES auth.oauth_clients(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY auth.access_tokens
    ADD CONSTRAINT access_tokens_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES auth.organizations(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY auth.access_tokens
    ADD CONSTRAINT access_tokens_refresh_token_id_fkey FOREIGN KEY (refresh_token_id) REFERENCES auth.refresh_tokens(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY auth.access_tokens
    ADD CONSTRAINT access_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY auth.authorization_codes
    ADD CONSTRAINT authorization_codes_client_id_fkey FOREIGN KEY (client_id) REFERENCES auth.oauth_clients(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY auth.authorization_codes
    ADD CONSTRAINT authorization_codes_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES auth.organizations(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY auth.authorization_codes
    ADD CONSTRAINT authorization_codes_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY auth.authorization_codes
    ADD CONSTRAINT authorization_codes_user_session_id_fkey FOREIGN KEY (user_session_id) REFERENCES auth.user_sessions(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY auth.consent_sessions
    ADD CONSTRAINT consent_sessions_client_id_fkey FOREIGN KEY (client_id) REFERENCES auth.oauth_clients(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY auth.consent_sessions
    ADD CONSTRAINT consent_sessions_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES auth.organizations(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY auth.consent_sessions
    ADD CONSTRAINT consent_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY auth.consent_sessions
    ADD CONSTRAINT consent_sessions_user_session_id_fkey FOREIGN KEY (user_session_id) REFERENCES auth.user_sessions(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY auth.identity_invites
    ADD CONSTRAINT identity_invites_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY auth.identity_invites
    ADD CONSTRAINT identity_invites_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES auth.identity_providers(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY auth.identity_invites
    ADD CONSTRAINT identity_invites_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY auth.identity_link_grants
    ADD CONSTRAINT identity_link_grants_client_id_fkey FOREIGN KEY (client_id) REFERENCES auth.oauth_clients(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY auth.identity_link_grants
    ADD CONSTRAINT identity_link_grants_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY auth.identity_provider_domain_roles
    ADD CONSTRAINT identity_provider_domain_roles_domain_id_fkey FOREIGN KEY (domain_id) REFERENCES auth.identity_provider_domains(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY auth.identity_provider_domain_roles
    ADD CONSTRAINT identity_provider_domain_roles_role_id_fkey FOREIGN KEY (role_id) REFERENCES auth.roles(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY auth.identity_provider_domains
    ADD CONSTRAINT identity_provider_domains_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY auth.identity_provider_domains
    ADD CONSTRAINT identity_provider_domains_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES auth.organizations(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY auth.identity_provider_domains
    ADD CONSTRAINT identity_provider_domains_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES auth.identity_providers(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY auth.identity_providers
    ADD CONSTRAINT identity_providers_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY auth.oauth_clients
    ADD CONSTRAINT oauth_clients_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES auth.organizations(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY auth.oauth_clients
    ADD CONSTRAINT oauth_clients_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY auth.org_selection_sessions
    ADD CONSTRAINT org_selection_sessions_client_id_fkey FOREIGN KEY (client_id) REFERENCES auth.oauth_clients(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY auth.org_selection_sessions
    ADD CONSTRAINT org_selection_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY auth.organization_members
    ADD CONSTRAINT organization_members_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES auth.organizations(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY auth.organization_members
    ADD CONSTRAINT organization_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY auth.permissions
    ADD CONSTRAINT permissions_service_id_fkey FOREIGN KEY (service_id) REFERENCES core.services(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY auth.recovery_codes
    ADD CONSTRAINT recovery_codes_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY auth.refresh_tokens
    ADD CONSTRAINT refresh_tokens_auth_code_id_fkey FOREIGN KEY (auth_code_id) REFERENCES auth.authorization_codes(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY auth.refresh_tokens
    ADD CONSTRAINT refresh_tokens_client_id_fkey FOREIGN KEY (client_id) REFERENCES auth.oauth_clients(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY auth.refresh_tokens
    ADD CONSTRAINT refresh_tokens_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES auth.organizations(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY auth.refresh_tokens
    ADD CONSTRAINT refresh_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY auth.role_permissions
    ADD CONSTRAINT role_permissions_permission_id_fkey FOREIGN KEY (permission_id) REFERENCES auth.permissions(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY auth.role_permissions
    ADD CONSTRAINT role_permissions_role_id_fkey FOREIGN KEY (role_id) REFERENCES auth.roles(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY auth.roles
    ADD CONSTRAINT roles_service_id_fkey FOREIGN KEY (service_id) REFERENCES core.services(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY auth.totp_setup_grants
    ADD CONSTRAINT totp_setup_grants_client_id_fkey FOREIGN KEY (client_id) REFERENCES auth.oauth_clients(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY auth.totp_setup_grants
    ADD CONSTRAINT totp_setup_grants_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY auth.totp_setup_sessions
    ADD CONSTRAINT totp_setup_sessions_client_id_fkey FOREIGN KEY (client_id) REFERENCES auth.oauth_clients(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY auth.totp_setup_sessions
    ADD CONSTRAINT totp_setup_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY auth.totp_verifications
    ADD CONSTRAINT totp_verifications_client_id_fkey FOREIGN KEY (client_id) REFERENCES auth.oauth_clients(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY auth.totp_verifications
    ADD CONSTRAINT totp_verifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY auth.upstream_auth_sessions
    ADD CONSTRAINT upstream_auth_sessions_client_id_fkey FOREIGN KEY (client_id) REFERENCES auth.oauth_clients(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY auth.upstream_auth_sessions
    ADD CONSTRAINT upstream_auth_sessions_link_grant_id_fkey FOREIGN KEY (link_grant_id) REFERENCES auth.identity_link_grants(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY auth.upstream_auth_sessions
    ADD CONSTRAINT upstream_auth_sessions_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES auth.identity_providers(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY auth.upstream_auth_sessions
    ADD CONSTRAINT upstream_auth_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY auth.user_identities
    ADD CONSTRAINT user_identities_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES auth.identity_providers(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY auth.user_identities
    ADD CONSTRAINT user_identities_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY auth.user_roles
    ADD CONSTRAINT user_roles_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES auth.organizations(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY auth.user_roles
    ADD CONSTRAINT user_roles_role_id_fkey FOREIGN KEY (role_id) REFERENCES auth.roles(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY auth.user_roles
    ADD CONSTRAINT user_roles_service_access_id_fkey FOREIGN KEY (service_access_id) REFERENCES core.service_access(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY auth.user_roles
    ADD CONSTRAINT user_roles_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY auth.user_sessions
    ADD CONSTRAINT user_sessions_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES auth.organizations(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY auth.user_sessions
    ADD CONSTRAINT user_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY auth.users
    ADD CONSTRAINT users_oauth_client_id_fkey FOREIGN KEY (oauth_client_id) REFERENCES auth.oauth_clients(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY core.instance
    ADD CONSTRAINT instance_setup_completed_by_fkey FOREIGN KEY (setup_completed_by) REFERENCES auth.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY core.service_access
    ADD CONSTRAINT service_access_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES auth.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY core.service_access
    ADD CONSTRAINT service_access_service_id_fkey FOREIGN KEY (service_id) REFERENCES core.services(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY core.services
    ADD CONSTRAINT services_client_id_fkey FOREIGN KEY (client_id) REFERENCES auth.oauth_clients(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY core.services
    ADD CONSTRAINT services_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY files.access_logs
    ADD CONSTRAINT access_logs_bucket_id_fkey FOREIGN KEY (bucket_id) REFERENCES files.buckets(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY files.access_logs
    ADD CONSTRAINT access_logs_object_id_fkey FOREIGN KEY (object_id) REFERENCES files.objects(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY files.access_logs
    ADD CONSTRAINT access_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY files.archive_request_objects
    ADD CONSTRAINT archive_request_objects_archive_request_id_fkey FOREIGN KEY (archive_request_id) REFERENCES files.archive_requests(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY files.archive_request_objects
    ADD CONSTRAINT archive_request_objects_version_id_fkey FOREIGN KEY (version_id) REFERENCES files.object_versions(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY files.archive_requests
    ADD CONSTRAINT archive_requests_bucket_id_fkey FOREIGN KEY (bucket_id) REFERENCES files.buckets(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY files.archive_requests
    ADD CONSTRAINT archive_requests_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES auth.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY files.bucket_lifecycle_policies
    ADD CONSTRAINT bucket_lifecycle_policies_bucket_id_fkey FOREIGN KEY (bucket_id) REFERENCES files.buckets(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY files.bucket_permissions
    ADD CONSTRAINT bucket_permissions_bucket_id_fkey FOREIGN KEY (bucket_id) REFERENCES files.buckets(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY files.bucket_permissions
    ADD CONSTRAINT bucket_permissions_granted_by_fkey FOREIGN KEY (granted_by) REFERENCES auth.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY files.bucket_permissions
    ADD CONSTRAINT bucket_permissions_revoked_by_fkey FOREIGN KEY (revoked_by) REFERENCES auth.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY files.bucket_permissions
    ADD CONSTRAINT bucket_permissions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY files.buckets
    ADD CONSTRAINT buckets_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY files.buckets
    ADD CONSTRAINT buckets_deleted_by_fkey FOREIGN KEY (deleted_by) REFERENCES auth.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY files.buckets
    ADD CONSTRAINT buckets_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES auth.organizations(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY files.buckets
    ADD CONSTRAINT buckets_service_id_fkey FOREIGN KEY (service_id) REFERENCES core.services(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY files.idempotency_records
    ADD CONSTRAINT idempotency_records_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY files.multipart_parts
    ADD CONSTRAINT multipart_parts_upload_id_fkey FOREIGN KEY (upload_id) REFERENCES files.multipart_uploads(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY files.multipart_uploads
    ADD CONSTRAINT multipart_uploads_bucket_id_fkey FOREIGN KEY (bucket_id) REFERENCES files.buckets(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY files.multipart_uploads
    ADD CONSTRAINT multipart_uploads_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY files.object_versions
    ADD CONSTRAINT object_versions_content_blob_hash_fkey FOREIGN KEY (content_blob_hash) REFERENCES files.content_blobs(hash) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY files.object_versions
    ADD CONSTRAINT object_versions_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY files.object_versions
    ADD CONSTRAINT object_versions_deleted_by_fkey FOREIGN KEY (deleted_by) REFERENCES auth.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY files.object_versions
    ADD CONSTRAINT object_versions_object_id_fkey FOREIGN KEY (object_id) REFERENCES files.objects(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY files.object_versions
    ADD CONSTRAINT object_versions_restored_from_version_id_fkey FOREIGN KEY (restored_from_version_id) REFERENCES files.object_versions(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY files.objects
    ADD CONSTRAINT objects_bucket_id_fkey FOREIGN KEY (bucket_id) REFERENCES files.buckets(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY files.objects
    ADD CONSTRAINT objects_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY files.objects
    ADD CONSTRAINT objects_deleted_by_fkey FOREIGN KEY (deleted_by) REFERENCES auth.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY files.objects
    ADD CONSTRAINT objects_thumbnail_for_fkey FOREIGN KEY (thumbnail_for) REFERENCES files.objects(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY files.shares
    ADD CONSTRAINT shares_archive_request_id_fkey FOREIGN KEY (archive_request_id) REFERENCES files.archive_requests(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY files.shares
    ADD CONSTRAINT shares_bucket_id_fkey FOREIGN KEY (bucket_id) REFERENCES files.buckets(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY files.shares
    ADD CONSTRAINT shares_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES auth.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY files.shares
    ADD CONSTRAINT shares_object_id_fkey FOREIGN KEY (object_id) REFERENCES files.objects(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY files.shares
    ADD CONSTRAINT shares_revoked_by_user_id_fkey FOREIGN KEY (revoked_by_user_id) REFERENCES auth.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY files.shares
    ADD CONSTRAINT shares_version_id_fkey FOREIGN KEY (version_id) REFERENCES files.object_versions(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY notifications.connections
    ADD CONSTRAINT connections_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY notifications.connections
    ADD CONSTRAINT connections_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE notifications.deliveries
    ADD CONSTRAINT deliveries_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES notifications.connections(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE notifications.deliveries
    ADD CONSTRAINT deliveries_notification_id_notification_created_at_fkey FOREIGN KEY (notification_id, notification_created_at) REFERENCES notifications.notifications(id, created_at) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE notifications.notifications
    ADD CONSTRAINT notifications_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES notifications.connections(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE notifications.notifications
    ADD CONSTRAINT notifications_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES auth.organizations(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE notifications.notifications
    ADD CONSTRAINT notifications_sender_user_id_fkey FOREIGN KEY (sender_user_id) REFERENCES auth.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY webhooks.event_types
    ADD CONSTRAINT event_types_service_id_fkey FOREIGN KEY (service_id) REFERENCES core.services(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE webhooks.webhook_deliveries
    ADD CONSTRAINT webhook_deliveries_event_type_fkey FOREIGN KEY (event_type) REFERENCES webhooks.event_types(event_type) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE webhooks.webhook_deliveries
    ADD CONSTRAINT webhook_deliveries_webhook_endpoint_id_fkey FOREIGN KEY (webhook_endpoint_id) REFERENCES webhooks.webhook_endpoints(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY webhooks.webhook_endpoint_event_types
    ADD CONSTRAINT webhook_endpoint_event_types_event_type_fkey FOREIGN KEY (event_type) REFERENCES webhooks.event_types(event_type) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY webhooks.webhook_endpoint_event_types
    ADD CONSTRAINT webhook_endpoint_event_types_webhook_endpoint_id_fkey FOREIGN KEY (webhook_endpoint_id) REFERENCES webhooks.webhook_endpoints(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY webhooks.webhook_endpoints
    ADD CONSTRAINT webhook_endpoints_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY webhooks.webhook_endpoints
    ADD CONSTRAINT webhook_endpoints_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES auth.organizations(id) ON UPDATE CASCADE ON DELETE RESTRICT;

-- Rows core needs before its first start: the system user every actor column can
-- name, core's own service and the instance singleton. The seed adds the rest.
INSERT INTO "auth"."users" ("id", "email", "password_hash", "name", "user_type", "is_active", "updated_at")
VALUES ('00000000-0000-7000-8000-000000000001', 'system@tereo.internal', '!', 'tereo', 'service_account', true, now());

INSERT INTO "core"."services" ("id", "slug", "name", "namespace", "created_by", "updated_at")
VALUES ('00000000-0000-7000-8000-000000000002', 'core', 'tereo', 'core', '00000000-0000-7000-8000-000000000001', now());

INSERT INTO "core"."instance" ("id") VALUES (1);
