#!/usr/bin/env node
/*
 * ANAS — cr3 (review 2026-11-14), area `cloud`: the panel halves.
 *
 * Loads the REAL 00-core.js, 10-api.js, 69-schedules-common.js and
 * 72-cloud.js in a vm sandbox (a permissive ExtJS stub: the checks call the
 * pure helpers 72-cloud.js exports on ANAS.cloud, and the real ANAS.readJob):
 *
 *   CLOUD-C1  a user without Sys.Modify who presses Test on an unsaved remote
 *             gets the daemon's 403 SENTENCE in the dialog (readJob's onError
 *             carries the server message; the verdict renderer shows it),
 *             never a bare "failed";
 *   CLOUD-M5  an edit of a remote with its own OAuth client: a blank client
 *             secret field is the STORED secret, so the pair is whole and Save
 *             and Test are not held shut; a lone secret still refuses;
 *   CLOUD-L11 an edit's Test: untouched → the saved remote by name; changed →
 *             inline with keepStoredSecrets, the dialog's values over the
 *             stored options it does not hold, a cleared field tested cleared;
 *   cr3 (coordinator) a failed list read says so, with the reason, and says
 *             what the rows below are (stale, or nothing read).
 *
 *   node packages/pve-integration/test/cr3-cloud.harness.mjs
 *
 * Exit 0 = all checks pass; exit 1 prints the failures.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'src')

let checks = 0
const failures = []
function ok(name, cond, detail) {
  checks++
  if (!cond) { failures.push(detail === undefined ? name : `${name} — ${detail}`) }
}
function eq(name, actual, expected) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)
}

function htmlEncode(v) {
  return String(v).replace(/&/g, '&amp;').replace(/>/g, '&gt;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
}

function permissive() {
  const fn = function () { return proxy }
  const proxy = new Proxy(fn, {
    get(_t, key) {
      if (key === Symbol.toPrimitive) { return () => '' }
      if (key === 'then') { return undefined }
      if (key === 'String') { return { htmlEncode } }
      return proxy
    },
    apply() { return proxy },
    construct() { return proxy },
  })
  return proxy
}

function loadUi() {
  const doc = {
    hidden: false,
    head: { appendChild() {} },
    addEventListener() {},
    removeEventListener() {},
    getElementById: () => null,
    getElementsByTagName: () => [{ appendChild() {} }],
    createTextNode: text => ({ text }),
    createElement: () => ({ style: {}, appendChild() {}, setAttribute() {} }),
  }
  const win = { document: doc }
  const sandbox = {
    window: win,
    document: doc,
    Ext: permissive(),
    console,
    Promise,
    Date,
    setTimeout: () => 1,
    clearTimeout: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
  }
  for (const file of ['00-core.js', '10-api.js', '69-schedules-common.js', '72-cloud.js'])
    vm.runInNewContext(readFileSync(join(SRC, file), 'utf8'), sandbox, { filename: file })
  return win.ANAS
}

const ANAS = loadUi()
const C = ANAS.cloud

for (const name of ['ownClientEffective', 'editTestBody', 'verdictSentence', 'loadFailedHtml', 'validateOwnClient', 'nestedNoteText', 'nestedDetailNote', 'clearSecretNote', 'keptSecrets', 'editTaskClears', 'unsavedTestHandle', 'previewErrorHtml', 'hiddenValueNote', 'confirmedCancelHandle'])
  ok(`72-cloud.js exports ${name} for this harness`, typeof (C && C[name]) === 'function')

// ---------------------------------------------------------------------------
//  CLOUD-C1 — the refused unsaved Test reads as the daemon's sentence
// ---------------------------------------------------------------------------
{
  const SENTENCE = 'Permission check failed (/, Sys.Modify): auditor@pve does not have it. '
    + 'ANAS asks the privilege PVE asks for its own disk and ZFS operations.'
  const err = new Error(SENTENCE)
  err.status = 403
  err.body = { error: { code: 'FORBIDDEN', message: SENTENCE } }
  ANAS.api = ANAS.api || {}
  ANAS.api.post = () => Promise.reject(err)
  let got = null
  ANAS.readJob({
    node: 'pve1',
    path: '/cloud/remotes/test',
    body: { remote: { name: 'x', type: 'webdav', options: { url: 'http://h/' } } },
    onError: (msg) => { got = msg },
    onResult: () => { got = 'RESULT' },
  })
  await new Promise(r => setImmediate(r))
  eq('C1: a 403 on the Test POST reaches the dialog\'s onError carrying the daemon\'s sentence', got, SENTENCE)
  const shown = C.verdictSentence('error', got)
  ok('C1: the verdict line names the missing privilege, not a bare failure', shown === `Error — ${SENTENCE}`, shown)
}

// ---------------------------------------------------------------------------
//  CLOUD-M5 — the own-client pair an edit leaves
// ---------------------------------------------------------------------------
{
  const ID = '1234567890-abc123def456.apps.googleusercontent.com'
  const pair = (vals, isEdit, stored) => C.validateOwnClient('drive', C.ownClientEffective(vals, isEdit, stored))
  ok('M5: an EDIT with the id pre-filled and the secret field blank (stored) is a whole pair',
    pair({ client_id: ID, client_secret: '' }, true, ['client_secret', 'token']).ok === true)
  ok('M5: rotating the secret on an edit is a whole pair',
    pair({ client_id: ID, client_secret: 'GOCSPX-new' }, true, ['client_secret']).ok === true)
  ok('M5: an ADD with a lone id still refuses (nothing is stored)',
    pair({ client_id: ID, client_secret: '' }, false, ['client_secret']).ok === false)
  ok('M5: an EDIT whose remote stores no secret still refuses a lone id',
    pair({ client_id: ID, client_secret: '' }, true, ['token']).ok === false)
  const lone = pair({ client_id: '', client_secret: '' }, true, ['client_secret'])
  ok('M5: clearing the id while a secret stays stored refuses with the pair sentence (a lone secret breaks the refresh)',
    lone.ok === false && /must be set together/.test(lone.message), JSON.stringify(lone))
  ok('fix 8: spaces in the secret field are a typed value, judged empty — the pair is refused (one rule with the daemon)',
    pair({ client_id: ID, client_secret: '   ' }, true, ['client_secret']).ok === false)
  ok('M5: the stand-in never carries a value — a typed secret is judged as typed',
    C.ownClientEffective({ client_id: ID, client_secret: 'typed' }, true, ['client_secret']).client_secret === 'typed')
}

// ---------------------------------------------------------------------------
//  CLOUD-L11 — what an edit's Test sends
// ---------------------------------------------------------------------------
{
  const stored = { account: 'acct123', endpoint: 'https://s3.example', shell_type: 'unix' }
  eq('L11: an untouched edit tests the SAVED remote by name (a read)',
    C.editTestBody('b2gt', 'b2', {}, { account: 'acct123' }, { account: 'acct123', key: '' }, stored),
    { name: 'b2gt' })
  eq('L11: a typed secret rides inline with keepStoredSecrets; stored options the dialog does not hold ride as stored',
    C.editTestBody('b2gt', 'b2', { key: 'typedkey' }, { account: 'acct123', key: 'typedkey' }, { account: 'acct123', key: 'typedkey' }, stored),
    { remote: { name: 'b2gt', type: 'b2', options: { endpoint: 'https://s3.example', shell_type: 'unix', account: 'acct123', key: 'typedkey' } }, keepStoredSecrets: true })
  eq('L11: a CLEARED non-secret field is tested cleared, not with its stored value',
    C.editTestBody('b2gt', 'b2', { endpoint: '' }, { account: 'acct123' }, { account: 'acct123', endpoint: '', key: '' }, stored),
    { remote: { name: 'b2gt', type: 'b2', options: { shell_type: 'unix', account: 'acct123' } }, keepStoredSecrets: true })
  eq('L11: a changed non-secret with no secret typed tests the EDIT (before cr3 it tested the stored remote)',
    C.editTestBody('b2gt', 'b2', { account: 'other' }, { account: 'other' }, { account: 'other', key: '' }, stored),
    { remote: { name: 'b2gt', type: 'b2', options: { endpoint: 'https://s3.example', shell_type: 'unix', account: 'other' } }, keepStoredSecrets: true })
}

// ---------------------------------------------------------------------------
//  cr3 — a failed list read says so (never "no tasks" / "no remotes")
// ---------------------------------------------------------------------------
{
  const first = C.loadFailedHtml('cloud sync tasks', 'EACCES <b>x</b>', false)
  ok('load: a failed first read names the list and the reason, encoded', /Could not read the cloud sync tasks: EACCES &lt;b&gt;x&lt;\/b&gt;\./.test(first), first)
  ok('load: …and says nothing was read — not an empty list', /this is not an empty list/.test(first), first)
  const stale = C.loadFailedHtml('rclone remotes', 'exit 1', true)
  ok('load: a failed reload marks the kept rows as from the last successful read', /last successful read and may be out of date/.test(stale), stale)
}

// ---------------------------------------------------------------------------
//  cr3 (operator ruling 2026-11-14) — nested filesystems said per mode
// ---------------------------------------------------------------------------
{
  const snap = C.nestedNoteText(1, 'snapshot', ['/tank/p/raw'])
  ok('nested: a snapshot task\'s wizard note says not included, with the destination note',
    snap === 'Contains 1 nested filesystem that will not be included: /tank/p/raw (a snapshot holds one filesystem; their copies at the destination are left as they are)', snap)
  const live = C.nestedNoteText(2, 'live', ['/mnt/nas/a', '/mnt/nas/b'])
  ok('nested: a live task\'s wizard note says they WILL be included, never "not included"',
    live === 'Contains 2 nested filesystems that will be included: /mnt/nas/a, /mnt/nas/b (a live copy reads through them)' && !/not included/.test(live), live)
  const unknown = C.nestedNoteText(1, undefined, ['/x/y'])
  ok('nested: no derived consistency says it cannot tell', /could not be read/.test(unknown) && !/will not be included|will be included/.test(unknown), unknown)
  ok('nested: the Details line per mode', /^not included \(a snapshot holds one filesystem/.test(C.nestedDetailNote('snapshot'))
    && /^included \(a live copy reads through them\)$/.test(C.nestedDetailNote('live'))
    && /unknown/.test(C.nestedDetailNote(null)))
}

// ---------------------------------------------------------------------------
//  cr3 (operator ruling 2026-11-14) — removing a STORED secret
// ---------------------------------------------------------------------------
{
  const ID = '1234567890-abc123def456.apps.googleusercontent.com'
  const stored = ['client_secret', 'token']
  const kept = C.keptSecrets(stored, { client_secret: true })
  eq('clear: a secret ticked for removal is no longer stored for the gates', kept, ['token'])
  const lone = C.validateOwnClient('drive', C.ownClientEffective({ client_id: ID, client_secret: '' }, true, kept))
  ok('clear: removing the client secret while the id stays is refused with the pair sentence (Save held shut)',
    lone.ok === false && /must be set together/.test(lone.message), JSON.stringify(lone))
  const both = C.validateOwnClient('drive', C.ownClientEffective({ client_id: '', client_secret: '' }, true, kept))
  ok('clear: removing both returns the remote to the built-in client', both.ok === true)
  ok('clear: the client-secret note names the way back to the built-in client and the refused half',
    /Remove the client ID too to return the remote to rclone's built-in OAuth client; a client ID without its secret is refused\./.test(C.clearSecretNote('client_secret')))
  ok('clear: every note says it cannot be restored', /cannot be read back or restored/.test(C.clearSecretNote('pass')))
  eq('clear: an edit\'s Test with a removed secret names it in clearedSecrets and does not carry it',
    C.editTestBody('cr', 'crypt', { password2: null }, { remote: 's3e:b' }, { remote: 's3e:b', password: '', password2: '' }, { remote: 's3e:b' }, ['password2']),
    { remote: { name: 'cr', type: 'crypt', options: { remote: 's3e:b' } }, keepStoredSecrets: true, clearedSecrets: ['password2'] })
}

// ---------------------------------------------------------------------------
//  Review of cr3, fix 3 — what a cleared task field sends on an edit
// ---------------------------------------------------------------------------
{
  eq('task edit: an emptied bandwidth limit rides as null', C.editTaskClears({ name: 't' }, true), { name: 't', bwlimit: null })
  eq('task edit: a set limit rides as set', C.editTaskClears({ name: 't', bwlimit: '8M' }, true), { name: 't', bwlimit: '8M' })
  eq('task create: an empty limit stays absent', C.editTaskClears({ name: 't' }, false), { name: 't' })
}

// ---------------------------------------------------------------------------
//  Review of cr3 (C1 depth) — the unsaved Test's Cancel answers its confirm
// ---------------------------------------------------------------------------
{
  const sent = []
  ANAS.api.post = (node, path, body, opts) => {
    sent.push({ path, code: opts && opts.confirmCode })
    if (!(opts && opts.confirmCode)) {
      const e = new Error('Cancel the remote test?')
      e.status = 409
      e.confirmCode = 'CODE-1'
      e.body = { error: { code: 'CONFIRMATION_REQUIRED' } }
      return Promise.reject(e)
    }
    return Promise.resolve({ job: { id: 'cancel-job' } })
  }
  const alerts = []
  ANAS.alertMsg = (title, msg) => alerts.push(`${title}: ${msg}`)
  const fakeWin = { destroyed: false, destroying: false, down: () => null }
  const raw = { jobId: () => 'job-7', cancel: () => { sent.push({ path: 'readJob.cancel' }); return true } }
  const handle = C.unsavedTestHandle(raw, 'pve1', fakeWin)
  ok('C1 depth: the handle keeps the readJob it wraps (the runner\'s staleness check)', handle.raw === raw && handle.jobId() === 'job-7')
  handle.cancel()
  await new Promise(r => setImmediate(r))
  await new Promise(r => setImmediate(r))
  eq('C1 depth: Cancel posts the cancel, then replays the confirm code the door answered with',
    sent, [{ path: '/jobs/job-7/cancel', code: undefined }, { path: '/jobs/job-7/cancel', code: 'CODE-1' }])
  ok('C1 depth: no alert when the replay is accepted', alerts.length === 0, alerts.join(' | '))
}

// ---------------------------------------------------------------------------
//  Second review — an inline preview needs Sys.Modify: the window says why
// ---------------------------------------------------------------------------
{
  const msg = 'Permission check failed (/, Sys.Modify): auditor@pve does not have it.'
  const html = C.previewErrorHtml(msg, { status: 403 })
  ok('preview 403: the line says an unsaved preview needs what saving needs, and where saved tasks are previewed',
    /Previewing an unsaved task needs Sys\.Modify, the same privilege as saving it\. Saved tasks can be previewed from the task list\./.test(html) && html.includes('auditor@pve'), html)
  const plain = C.previewErrorHtml('the source does not exist', { status: 400 })
  ok('preview 400: no privilege lead on another refusal', !/Sys\.Modify/.test(plain), plain)
}

// ---------------------------------------------------------------------------
//  Third review — the hidden-value note; the inline preview's Cancel replay
// ---------------------------------------------------------------------------
{
  ok('hidden: a whole hidden value says it is kept unless retyped',
    /hidden because it carries inline settings; it stays as stored unless you retype the whole value/.test(C.hiddenValueNote('[hidden: this value carries inline settings]')))
  ok('hidden: a URL with [secret] parts says so', /Parts of this address are hidden/.test(C.hiddenValueNote('https://[secret]@h/p?[secret]')))
  ok('hidden: a plain value carries no note', C.hiddenValueNote('gt:path') === '' && C.hiddenValueNote('https://h/p') === '')

  // The inline preview (a Sys.Modify job) cancels through confirmedCancelHandle: the
  // window's own "cancelling" state shows, the door's confirm code is replayed at once.
  const sent = []
  ANAS.api.post = (node, path, body, opts) => {
    sent.push({ path, code: opts && opts.confirmCode })
    if (!(opts && opts.confirmCode)) {
      const e = new Error('Cancel the preview?')
      e.status = 409
      e.confirmCode = 'CODE-P'
      e.body = { error: { code: 'CONFIRMATION_REQUIRED' } }
      return Promise.reject(e)
    }
    return Promise.resolve({ job: { id: 'cancel-p' } })
  }
  let cancelling = 0
  const raw = { jobId: () => 'preview-9', cancel: () => true }
  const handle = C.confirmedCancelHandle(raw, 'pve1', { destroyed: false, destroying: false, down: () => null }, () => { cancelling++ })
  handle.cancel()
  await new Promise(r => setImmediate(r))
  await new Promise(r => setImmediate(r))
  eq('inline preview Cancel: the cancel is posted, then the confirm code replayed',
    sent, [{ path: '/jobs/preview-9/cancel', code: undefined }, { path: '/jobs/preview-9/cancel', code: 'CODE-P' }])
  ok('inline preview Cancel: the window shows it is cancelling', cancelling === 1)
  sent.length = 0
  handle.cancel({ quiet: true })
  await new Promise(r => setImmediate(r))
  await new Promise(r => setImmediate(r))
  ok('inline preview Cancel (window closing): quiet, still replayed, no cancelling state', sent.length === 2 && cancelling === 1)
}

if (failures.length) {
  console.error(`FAIL — ${failures.length} of ${checks} checks failed:`)
  for (const f of failures) { console.error(`  ✗ ${f}`) }
  process.exit(1)
}
console.log(`ok — ${checks} cr3 cloud panel checks passed`)
