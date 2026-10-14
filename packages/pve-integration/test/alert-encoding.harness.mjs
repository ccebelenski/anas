#!/usr/bin/env node
/*
 * ANAS — Alert encoding harness.
 *
 * Verifies that ANAS.alertMsg and ANAS.toast encode bodies by default,
 * while ANAS.alertHtml and ANAS.toastHtml pass raw HTML through.
 *
 * Loads the real 00-core.js in a vm sandbox with a stub Ext.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'src')
const corePath = join(SRC, '00-core.js')
const coreSrc = readFileSync(corePath, 'utf8')

const alerts = []
const toasts = []

const Ext = {
  String: {
    htmlEncode: function (s) {
      return ('' + s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    }
  },
  toast: function (msg) { toasts.push(msg) },
  Msg: {
    alert: function (title, msg) { alerts.push({ title, msg }) }
  }
}

const sandbox = {
  window: { ANAS: {} },
  Ext,
  console,
  gettext: function (s) { return s }
}
sandbox.window.ANAS = {}
vm.createContext(sandbox)
vm.runInContext(coreSrc, sandbox)

const ANAS = sandbox.window.ANAS

function assert(label, cond) {
  if (!cond) {
    console.error('FAIL:', label)
    process.exitCode = 1
  } else {
    console.log('ok', label)
  }
}

// Reset collectors
alerts.length = 0
toasts.length = 0

// ANAS.alertMsg should encode body
ANAS.alertMsg('t', '<img src=x onerror=1>')
assert('alertMsg encodes body', alerts[0] && alerts[0].msg === '&lt;img src=x onerror=1&gt;')

// ANAS.alertHtml should pass raw
alerts.length = 0
ANAS.alertHtml('t', '<b>x</b>')
assert('alertHtml passes raw', alerts[0] && alerts[0].msg === '<b>x</b>')

// ANAS.toast should encode
toasts.length = 0
ANAS.toast('<script>alert(1)</script>')
assert('toast encodes body', toasts[0] === '&lt;script&gt;alert(1)&lt;/script&gt;')

// ANAS.toastHtml should pass raw
toasts.length = 0
ANAS.toastHtml('<b>x</b>')
assert('toastHtml passes raw', toasts[0] === '<b>x</b>')

if (!process.exitCode) {
  console.log('All alert encoding checks passed')
}
