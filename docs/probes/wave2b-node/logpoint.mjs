// Wave-2b node pass, row 3: a LOGPOINT in the running anasd through the V8 inspector (opened by
// `kill -USR1 <anasd pid>`, as wave 3's held-locks.mjs does). A breakpoint whose condition logs and
// answers false never pauses the daemon; it only writes one console.log line to the journal each
// time the line runs (and this session prints it from Runtime.consoleAPICalled). Nothing on disk changes; the breakpoint goes away when this session closes.
//
//   node# node logpoint.mjs <urlRegex> <0-based line> <expression> <seconds>
//
// Used for packages/daemon/dist/routes/backup.js line 1083 (`if (unlocked)`), right after
// `const unlocked = unlockedSourcesLine(source.unlocked)`: the direct run's first progress line,
// which is replaced within a millisecond and so cannot be seen by polling the job.
const [urlRegex, line, expr, secs] = process.argv.slice(2)
const url = (await (await fetch('http://127.0.0.1:9229/json/list')).json())[0].webSocketDebuggerUrl
const ws = new WebSocket(url)
let seq = 0
const pending = new Map()
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  // The logged line arrives here too (Runtime.consoleAPICalled): print it, timestamped.
  if (msg.method === 'Runtime.consoleAPICalled')
    console.log(new Date().toISOString(), msg.params.args.map(a => a.value ?? a.description).join(' '))
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
await send('Runtime.enable')
await send('Debugger.enable')
const bp = await send('Debugger.setBreakpointByUrl', {
  urlRegex,
  lineNumber: Number(line),
  condition: `(console.log('W2B-LOGPOINT ' + (${expr})), false)`,
})
console.log(JSON.stringify(bp.result ?? bp.error))
await new Promise(resolve => setTimeout(resolve, Number(secs) * 1000))
await send('Debugger.removeBreakpoint', { breakpointId: bp.result.breakpointId })
await send('Debugger.disable')
ws.close()
console.log('logpoint removed')
