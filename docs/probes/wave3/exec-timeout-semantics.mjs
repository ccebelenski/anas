// Wave-3 design pass (M1): what Node's execFile `timeout` does and does not do.
// Run on any Linux host: `node exec-timeout-semantics.mjs`. Spawns only
// /bin/sh and sleep; writes nothing.
//
// Case A: a child that exits on SIGTERM — execFile's timeout works (the
//         callback fires shortly after the deadline, err.killed=true, signal SIGTERM).
// Case B: a child that IGNORES SIGTERM — execFile's timeout sends SIGTERM once
//         and the callback never fires until the child exits by itself.
// Case C: a child that exits on SIGTERM but leaves a GRANDCHILD holding the
//         stdout pipe — execFile's callback waits for 'close' (all stdio closed),
//         would wait — but execFile's kill path destroys the stdio streams, so
//         the callback fires on time and the grandchild is ORPHANED (still running).
// Case D: the same as C with `detached: true` and a process-GROUP kill
//         (process.kill(-pid)) — the grandchild dies with it and the result is prompt.
import { execFile, execFileSync, spawn } from 'node:child_process'

const MARK = 3.0 + Math.floor(Math.random() * 1000) / 100000 // a unique 'sleep 3.0xxxx' to find

const T = 500 // ms deadline
const CAP = 4000 // we stop waiting here and report "never fired"

function caseExecFile(label, script) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    let done = false
    const cap = setTimeout(() => {
      if (!done) {
        done = true
        resolve(`${label}: callback NOT fired after ${CAP} ms (child pid ${child.pid} still holds it)`)
        try { process.kill(-child.pid, 'SIGKILL') } catch {}
        try { child.kill('SIGKILL') } catch {}
      }
    }, CAP)
    const child = execFile('/bin/sh', ['-c', script], { timeout: T }, (err) => {
      if (done) return
      done = true
      clearTimeout(cap)
      // Is anything from the child's process group (same pgid as the daemon here,
      // since execFile does not detach) still alive? Look for our marker sleep.
      let orphan = 'no'
      try {
        const out = execFileSync('/usr/bin/pgrep', ['-f', `^sleep ${MARK}$`]).toString().trim()
        if (out) orphan = `yes (pid ${out.split('\n').join(',')}, reparented)`
      } catch {}
      resolve(`${label}: callback after ${Date.now() - t0} ms, killed=${err?.killed} signal=${err?.signal} code=${err?.code}; grandchild still running: ${orphan}`)
    })
  })
}

function caseGroupKill(label, script) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const child = spawn('/bin/sh', ['-c', script], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', () => {})
    child.stderr.on('data', () => {})
    setTimeout(() => { try { process.kill(-child.pid, 'SIGTERM') } catch {} }, T)
    child.on('close', (code, signal) => resolve(`${label}: close after ${Date.now() - t0} ms, code=${code} signal=${signal}`))
  })
}

console.log(`node ${process.version}, deadline ${T} ms`)
console.log(await caseExecFile('A sleep 30 (exits on TERM)', 'exec sleep 30'))
console.log(await caseExecFile('B trap "" TERM; sleep 30 (ignores TERM)', 'trap "" TERM; sleep 3 & wait; sleep 3 & wait'))
console.log(await caseExecFile('C sh exits on TERM, grandchild sleep 3 keeps stdout', `sleep ${MARK} & exec sleep 30`))
console.log(await caseGroupKill('D as C, detached + group SIGTERM', 'sleep 3 & exec sleep 30'))
