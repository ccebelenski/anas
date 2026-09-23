import { z } from 'zod'

/**
 * Cloud sync — remotes (story rclone.1, Epic: Cloud sync via rclone).
 *
 * Remotes live in ANAS's OWN rclone.conf (/etc/anas/rclone.conf, 0600 root) —
 * DESIGN "Cloud sync — rclone", "Remotes = ANAS's own rclone.conf". Reads go
 * through `rclone config dump`; a remote is `{name, type, options (non-secret
 * keys only), secretsSet (the secret keys that ARE set)}` — a secret value is
 * never returned. A key is secret when rclone types it as a password
 * (`IsPassword`, the obscure-in-file set) or when its name ends in `pass`,
 * `password`, `secret`, `token` or `key` (the generic name rule that stands in
 * for rclone 1.60's missing `Sensitive` flag). Writes are ANAS's own surgical
 * INI edit; password-typed values are obscured via `rclone obscure -` over
 * stdin, and no secret ever enters an argv.
 */

/**
 * A remote name — the `[name]` section in rclone.conf and the `name:` of
 * `name:path` references. No spaces or colons: the name is also used to build
 * rclone environment-variable names (`RCLONE_CONFIG_<NAME>_<KEY>`), so it must
 * stay a clean identifier.
 */
export const CloudRemoteName = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Z0-9][\w.-]*$/i, 'letters, digits, underscore, dot and dash; must start with a letter or digit')
export type CloudRemoteName = z.infer<typeof CloudRemoteName>

/** One example value of a provider option (e.g. an S3 region for a provider). */
export const CloudProviderExample = z
  .object({
    value: z.string(),
    help: z.string(),
    provider: z.string(),
  })
export type CloudProviderExample = z.infer<typeof CloudProviderExample>

/**
 * One option of a cloud backend, trimmed from `rclone config providers` to
 * what the dialog renders.
 *
 * The two booleans carry DIFFERENT facts and drive different behaviour:
 *  - `secret` (hide the value from responses): `IsPassword` OR the name rule
 *    — s3's `secret_access_key` and b2's `key` are secret here although rclone
 *    does not type them as passwords.
 *  - `password` (obscure the value in the file): rclone's `IsPassword` ONLY.
 *    A secret-by-name value is stored PLAIN — rclone would not reveal an
 *    obscured value in a non-password field.
 */
export const CloudProviderOption = z
  .object({
    name: z.string(),
    help: z.string(),
    type: z.string(),
    required: z.boolean(),
    secret: z.boolean(),
    password: z.boolean(),
    default: z.string(),
    examples: z.array(CloudProviderExample),
    /** The backend filter this option instance applies to (`AWS`, `!AWS,…`); '' = all. */
    provider: z.string(),
    advanced: z.boolean(),
  })
export type CloudProviderOption = z.infer<typeof CloudProviderOption>

/** One cloud backend from rclone's provider catalogue (46 in 1.60). */
export const CloudProvider = z
  .object({
    name: z.string(),
    description: z.string(),
    options: z.array(CloudProviderOption),
  })
export type CloudProvider = z.infer<typeof CloudProvider>

/**
 * A remote as ANAS reports it: never a secret value. `options` holds the
 * non-secret keys only; `secretsSet` names the secret keys that are set
 * (their values are never included).
 */
export const CloudRemote = z
  .object({
    name: CloudRemoteName,
    type: z.string().min(1),
    /** Non-secret keys only (the `type` key itself excluded — it is a field). */
    options: z.record(z.string(), z.string()),
    /** The secret keys that are set — the values never appear. */
    secretsSet: z.array(z.string()),
  })
export type CloudRemote = z.infer<typeof CloudRemote>

/**
 * Create a remote. Secret values arrive here in plain text and are obscured
 * (via `rclone obscure -`) before they reach the file; the response never
 * returns them.
 */
export const CloudRemoteWrite = z
  .object({
    name: CloudRemoteName,
    type: z.string().min(1),
    /** Option values by key; secret values in plain text (write-only). */
    options: z.record(z.string(), z.string()),
  })
export type CloudRemoteWrite = z.infer<typeof CloudRemoteWrite>

/**
 * Update a remote. An ABSENT secret key means unchanged (secrets are
 * write-only — the dialog cannot read one back to send it); an EMPTY string
 * for a non-secret key means "remove the key". `type` is immutable — a retype
 * is a remove + create (rclone's own posture).
 */
export const CloudRemoteUpdate = z
  .object({
    options: z.record(z.string(), z.string()),
  })
export type CloudRemoteUpdate = z.infer<typeof CloudRemoteUpdate>

/** Facts about the node's rclone binary + config file (Remotes window footer). */
export const CloudRcloneInfo = z
  .object({
    version: z.string(),
    configFile: z.string(),
    /**
     * The config file is password-encrypted: ANAS reports it as a fact and
     * refuses every mutation (`config-encrypted`) — it neither prompts nor
     * stores the passphrase.
     */
    encrypted: z.boolean(),
  })
export type CloudRcloneInfo = z.infer<typeof CloudRcloneInfo>

/** `GET /v1/cloud/remotes` — the remotes of the node's own rclone.conf. */
export const CloudRemotesResponse = z
  .object({
    rclone: CloudRcloneInfo,
    remotes: z.array(CloudRemote),
  })
export type CloudRemotesResponse = z.infer<typeof CloudRemotesResponse>

/**
 * The bounded-`lsjson` verdict of a remote Test (rclone.1 probe / later slice):
 * exit codes alone cannot tell the buckets apart (`NewFs` failures all exit 1),
 * so the verdict is a classifier over rclone's message.
 */
export const CloudRemoteTestVerdict = z
  .enum(['ok', 'unreachable', 'auth', 'not-found', 'error'])
export type CloudRemoteTestVerdict = z.infer<typeof CloudRemoteTestVerdict>

/** A Test result: the verdict bucket + rclone's line, verbatim on `error`. */
export const CloudRemoteTestResult = z
  .object({
    verdict: CloudRemoteTestVerdict,
    message: z.string(),
  })
export type CloudRemoteTestResult = z.infer<typeof CloudRemoteTestResult>
