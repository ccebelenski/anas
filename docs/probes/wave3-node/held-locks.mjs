// Wave-3 node pass (docs/LIVE-PROOF-0.4.4-wave3.md, row 5c): read anasd's LIVE
// lock table. The queue exposes `heldLocks()` to tests only — no route serves
// it — so this reads the running process through the V8 inspector:
//
//   node# kill -USR1 $(systemctl show -p MainPID --value anasd)   # opens 127.0.0.1:9229
//   node# node held-locks.mjs [ws-url]                             # prints the table
//
// It asks V8 for every live Map (Runtime.queryObjects on Map.prototype) and
// keeps the ones keyed by lock keys (`ahr:`, `zpool:`, `zfs:`, …): that is
// LockTable's `entries` (key → { mode, holders: Map<jobId, Job> }). Read-only:
// nothing is called on the daemon's objects but `Map.prototype` iteration.
// The inspector stays open until anasd restarts.
const url = process.argv[2] ?? (await (await fetch('http://127.0.0.1:9229/json/list')).json())[0].webSocketDebuggerUrl
const ws = new WebSocket(url)
let seq = 0
const pending = new Map()
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
  }
}
function send(method, params = {}) {
  const id = ++seq
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise(resolve => pending.set(id, resolve))
}
await new Promise(resolve => (ws.onopen = resolve))
const proto = await send('Runtime.evaluate', { expression: 'Map.prototype' })
const maps = await send('Runtime.queryObjects', { prototypeObjectId: proto.result.result.objectId })
const fn = `function () {
  const KEY = /^(ahr|ahrname|zpool|zname|zfs|disk|mount|iscsi-target|iscsi-lun|share:smb|share:nfs|uid|gid|idname|task|schedule):/
  const out = []
  for (const m of this) {
    let hit = false
    for (const [k, v] of m) {
      if (typeof k === 'string' && KEY.test(k) && v && typeof v === 'object' && 'mode' in v && v.holders instanceof Map) { hit = true; break }
    }
    if (!hit) continue
    for (const [k, v] of m)
      out.push({ key: k, mode: v.mode, holders: [...v.holders.entries()].map(([id, job]) => ({ id, operation: job && job.operation, status: job && job.status })) })
  }
  return out
}`
const res = await send('Runtime.callFunctionOn', { objectId: maps.result.objects.objectId, functionDeclaration: fn, returnByValue: true })
console.log(JSON.stringify({ at: new Date().toISOString(), held: res.result.result.value }, null, 2))
ws.close()
