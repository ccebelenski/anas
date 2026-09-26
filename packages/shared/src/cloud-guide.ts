/**
 * Cloud sync — the remote-form curation table (story rclone.4, operator ask
 * during the 2026-09-25 Google Drive human pass).
 *
 * The split the Add/Edit remote dialog renders: the few ESSENTIAL fields up
 * top, the optional own-OAuth-client fields in their collapsed group,
 * everything else non-advanced under "More options". A NON-OAuth curated
 * backend also carries ONE sentence naming where the essential values come
 * from; the OAuth backends carry none — their one instruction is the OAuth
 * token sentence the dialog renders with the token field itself (review
 * batch B, 2026-09-25). This is a
 * DISPLAY-side curation only — the dialog still renders every option of the
 * backend (rclone stays the authority; the full set is one advanced toggle
 * away), so "any backend rclone supports" stays true without vendor code.
 *
 * A backend NOT in this table is uncurated: no `guide`, and every option's
 * `essential` mirrors rclone's own `!advanced` — today's layout byte for byte.
 * A curated backend absent from the node's rclone (`rclone config providers`)
 * is simply never looked up — the table never invents a backend.
 */

/** The curation facts for one backend. */
export interface CloudBackendGuide {
  /**
   * ONE plain sentence naming where the essential values come from (the
   * provider's own key page or server login). Absent on the OAuth backends
   * (review batch B, 2026-09-25): their one instruction is the OAuth token
   * sentence the dialog renders with the token field — a `guide` beside it
   * said the same thing twice.
   */
  guide?: string
  /**
   * The option names the dialog renders in the primary section, in the
   * backend's own schema order. A name that is not an option of the node's
   * rclone is ignored — the table never invents a field.
   */
  essential: string[]
  /**
   * The option names for someone bringing their OWN OAuth client instead of
   * rclone's shared, rate-limited one — rendered in the collapsed
   * "Use your own OAuth client" group. Absent = the backend has no such
   * fields.
   */
  ownClient?: string[]
}

/**
 * The curation table, keyed by rclone backend name. The daemon's catalogue
 * trim (`trimProviders`) is the only consumer; the UI renders from the
 * trimmed `CloudProvider` (`curated`, `guide`, `ownClient`) and
 * `CloudProviderOption` (`essential`) and holds no copy of this knowledge.
 */
export const CLOUD_BACKEND_GUIDES: Record<string, CloudBackendGuide> = {
  drive: {
    essential: ['token'],
    ownClient: ['client_id', 'client_secret'],
  },
  onedrive: {
    essential: ['token'],
    ownClient: ['client_id', 'client_secret'],
  },
  dropbox: {
    essential: ['token'],
  },
  box: {
    essential: ['token'],
  },
  pcloud: {
    essential: ['token'],
    ownClient: ['client_id', 'client_secret'],
  },
  s3: {
    guide: 'The access key id, secret access key, region and endpoint come from your storage provider\'s access-key page; the provider row selects which S3-compatible service this remote is.',
    essential: ['provider', 'access_key_id', 'secret_access_key', 'region', 'endpoint'],
  },
  b2: {
    guide: 'The account ID and application key come from the Backblaze B2 application-keys page.',
    essential: ['account', 'key'],
  },
  sftp: {
    guide: 'The host, port, user and password are the SSH login of the server; a key file can replace the password.',
    essential: ['host', 'port', 'user', 'pass', 'key_file'],
  },
  ftp: {
    guide: 'The host, port, user and password are the login of the FTP server.',
    essential: ['host', 'port', 'user', 'pass'],
  },
  webdav: {
    guide: 'The URL, user and password are the login of the WebDAV server; the vendor row names the server software.',
    essential: ['url', 'vendor', 'user', 'pass'],
  },
  smb: {
    guide: 'The host, user, password and domain are the login of the SMB server or its domain.',
    essential: ['host', 'user', 'pass', 'domain'],
  },
  azureblob: {
    guide: 'The storage account name and its access key come from the Azure portal\'s access-keys page for the storage account.',
    essential: ['account', 'key'],
  },
}

// --- The own-OAuth-client guard (rclone.4 rider, human-pass finding
// 2026-09-26) ---------------------------------------------------------------
//
// A non-empty `client_id` silently overrides rclone's built-in client, and a
// refresh token issued by the built-in one can never be refreshed under a
// made-up client — Google answers every refresh with `invalid_client`. The
// Test verdict cannot catch it (it does not refresh), so the fields are
// validated AT SAVE TIME, at both boundaries: the daemon's create/update/test
// doors and the dialog's own-client fieldset. ONE rule here; the UI port is
// an ES5 literal pinned to the same test vectors by the dialog-contracts
// harness.

/** The verdict: a refusal always carries its sentence. */
export type OwnClientVerdict = { ok: true } | { ok: false, message: string }

/** The provider label a shape refusal names. */
const OWN_CLIENT_PROVIDERS: Record<string, string> = {
  drive: 'Google',
  onedrive: 'Microsoft',
  dropbox: 'Dropbox',
  box: 'Box',
  pcloud: 'pCloud',
}

const GOOGLE_CLIENT_ID_RE = /^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/
const MICROSOFT_CLIENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Dropbox/Box/pCloud publish no stricter shape: one token without whitespace. */
const SINGLE_TOKEN_RE = /^\S+$/

/** The pair refusal — the two fields are one decision, never either alone. */
const OWN_CLIENT_PAIR_ERROR = 'Client ID and client secret must be set together.'

function ownClientIdSentence(value: string, provider: string): string {
  return `The client ID '${value}' is not a ${provider} OAuth client ID; leave `
    + 'both client fields empty to use rclone\'s built-in client, or paste the '
    + 'ID and secret of a client you created.'
}

/** The client-id shape per provider; Dropbox/Box/pCloud publish no stricter shape than this. */
function ownClientIdShape(backend: string, id: string): boolean {
  if (backend === 'drive')
    return GOOGLE_CLIENT_ID_RE.test(id)
  if (backend === 'onedrive')
    return MICROSOFT_CLIENT_ID_RE.test(id)
  return SINGLE_TOKEN_RE.test(id)
}

/**
 * The own-OAuth-client fields of `backend` must be empty (rclone's built-in
 * client) or name a real client of the provider: the id matches the
 * provider's own client-id shape, and id and secret are set together — a lone
 * id or a lone secret is refused, and a made-up id like `gdrive` is refused
 * before it can break a token refresh an hour later. Backends outside the
 * OAuth five are not this rule's business (`ok`).
 */
export function validateOwnClient(backend: string, options: Record<string, string>): OwnClientVerdict {
  const provider = OWN_CLIENT_PROVIDERS[backend]
  if (!provider)
    return { ok: true }
  const id = (options.client_id ?? '').trim()
  const secret = (options.client_secret ?? '').trim()
  if (id !== '' && !ownClientIdShape(backend, id))
    return { ok: false, message: ownClientIdSentence(id, provider) }
  if ((id !== '') !== (secret !== ''))
    return { ok: false, message: OWN_CLIENT_PAIR_ERROR }
  return { ok: true }
}
