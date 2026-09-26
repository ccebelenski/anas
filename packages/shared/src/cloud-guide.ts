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
