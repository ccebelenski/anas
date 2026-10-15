import type { Page } from '@playwright/test'

/**
 * Wave-2 browser-proof helpers: a timed event log of the ANAS requests a page
 * makes (the read POST and its 202 job, every poll of GET /jobs/<id>, the
 * cancel POST and whether it carried a confirm header), and a page-side
 * sampler that records every change of a set of DOM probes (visible? text?)
 * every 50 ms — so a control that is shown for a few hundred milliseconds
 * while a fast job runs is still on the record.
 */

export interface JobTrace {
  id: string
  operation: string
  postStatus: number
  postAt: number
  polls: { t: number, http: number, status: string, progress: string }[]
  cancel?: { t: number, http: number, confirmHeader: boolean }
  result?: unknown
}

export class Recorder {
  t0 = Date.now()
  lines: string[] = []
  jobs: JobTrace[] = []
  posts: string[] = []

  constructor(page: Page, readPaths: RegExp) {
    page.on('response', async (res) => {
      const url = res.url()
      if (!url.includes('/anas/api/'))
        return
      const method = res.request().method()
      const path = url.replace(/^.*?\/v1/, '')
      if (method === 'POST' || method === 'PUT' || method === 'DELETE')
        this.posts.push(`${method} ${path}`)
      try {
        if (method === 'POST' && readPaths.test(path)) {
          const body = await res.json().catch(() => null) as { job?: { id: string, operation: string } } | null
          const job: JobTrace = {
            id: body?.job?.id ?? '',
            operation: body?.job?.operation ?? '',
            postStatus: res.status(),
            postAt: this.now(),
            polls: [],
          }
          this.jobs.push(job)
          this.note(`POST ${path} -> HTTP ${res.status()} job=${job.id} operation=${job.operation}`)
          return
        }
        const cancel = path.match(/^\/jobs\/([^/]+)\/cancel$/)
        if (method === 'POST' && cancel) {
          const job = this.jobs.find(j => j.id === cancel[1])
          const hdrs = res.request().headers()
          const confirmHeader = Object.keys(hdrs).some(h => h.toLowerCase() === 'x-anas-confirm')
          if (job)
            job.cancel = { t: this.now(), http: res.status(), confirmHeader }
          this.note(`POST /jobs/${cancel[1]}/cancel -> HTTP ${res.status()} (x-anas-confirm sent: ${confirmHeader})`)
          return
        }
        const poll = path.match(/^\/jobs\/([^/?]+)$/)
        if (method === 'GET' && poll) {
          const job = this.jobs.find(j => j.id === poll[1])
          if (!job)
            return
          const body = await res.json().catch(() => null) as { data?: Record<string, unknown>, job?: Record<string, unknown> } | null
          const j = (body?.data ?? body?.job ?? body ?? {}) as Record<string, unknown>
          const status = String(j.status ?? '?')
          const progress = String(j.progress ?? '')
          const prev = job.polls.at(-1)
          job.polls.push({ t: this.now(), http: res.status(), status, progress })
          if (j.result !== undefined)
            job.result = j.result
          if (!prev || prev.status !== status || prev.progress !== progress)
            this.note(`GET /jobs/${job.id} -> HTTP ${res.status()} status=${status}${progress ? ` progress="${progress}"` : ''}${j.result !== undefined ? ` result=${JSON.stringify(j.result).slice(0, 300)}` : ''}`)
        }
      }
      catch (e) {
        this.note(`recorder error: ${(e as Error).message}`)
      }
    })
  }

  now(): number {
    return Math.round((Date.now() - this.t0) / 100) / 10
  }

  note(what: string): void {
    const line = `[t+${this.now()}s] ${what}`
    this.lines.push(line)
    console.log(line)
  }

  reset(): void {
    this.t0 = Date.now()
  }

  last(): JobTrace | undefined {
    return this.jobs.at(-1)
  }

  lastStatus(job: JobTrace | undefined): string {
    return job?.polls.at(-1)?.status ?? ''
  }
}

/**
 * Start a page-side sampler: every 50 ms, for each named CSS probe, record
 * whether a matching element is visible and its text, keeping only changes.
 */
export async function startSampler(page: Page, probes: Record<string, string>): Promise<void> {
  await page.evaluate((p) => {
    const w = window as unknown as { __w2: { t: number, k: string, v: string }[], __w2timer?: number }
    if (w.__w2timer)
      clearInterval(w.__w2timer)
    w.__w2 = []
    const t0 = Date.now()
    const lastByKey: Record<string, string> = {}
    const shown = (el: Element): boolean => {
      const r = (el as HTMLElement).getBoundingClientRect()
      if (r.width === 0 || r.height === 0)
        return false
      if (el.closest('.x-hidden-offsets, .x-hidden-display, .x-hidden-visibility, .x-hidden'))
        return false
      return r.right > 0 && r.bottom > 0
    }
    w.__w2timer = window.setInterval(() => {
      for (const k of Object.keys(p)) {
        const els = Array.from(document.querySelectorAll(p[k])).filter(shown)
        const v = els.length ? `visible "${(els[0] as HTMLElement).innerText.replace(/\s+/g, ' ').trim().slice(0, 200)}"` : 'hidden'
        if (lastByKey[k] !== v) {
          lastByKey[k] = v
          w.__w2.push({ t: Math.round((Date.now() - t0) / 100) / 10, k, v })
        }
      }
    }, 50)
  }, probes)
}

export async function stopSampler(page: Page): Promise<{ t: number, k: string, v: string }[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __w2: { t: number, k: string, v: string }[], __w2timer?: number }
    if (w.__w2timer)
      clearInterval(w.__w2timer)
    w.__w2timer = undefined
    return w.__w2 || []
  })
}

/** Every visible Ext message box / confirm window title + text, for "no confirm appeared" checks. */
export async function visibleMessageBoxes(page: Page): Promise<string[]> {
  return page.locator('.x-message-box:visible').allInnerTexts()
}
