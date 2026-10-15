import type { Locator, Page } from '@playwright/test'
import { expect, test } from '@playwright/test'
import { loginToPve, openAnasItem } from '../../../tests/integration/fixtures/pve-ui'
import { removeShareGroup, removeShareUser, sshExec } from '../../../tests/integration/fixtures/stunt-node'

/**
 * Wave-2 node pass, stories cr.29 / cr.29b / cr.29c in the real PVE UI
 * (80-users.js), as root@pam:
 *
 *   - New Group: a collapsed "Advanced" section holding the gid field; a group
 *     w2uigrp is created with the explicit gid 51234.
 *   - New Share User: a collapsed "Advanced" section; expanded it shows the
 *     User ID and the Primary group choice. The primary-group list offers
 *     `users` and share-band groups only (gid 1000..60000), never root; the
 *     supplementary-group picker offers share-band groups only.
 *   - w2uiuser is created with uid 51234 and primary group w2uigrp; on the
 *     node getent says uid 51234 gid 51234.
 *   - user, then group, deleted through the UI's confirm windows; both gone.
 *
 * Only objects named w2ui* are created or deleted. The ssh teardown is a
 * safety net for an aborted run only.
 */

const GROUP = 'w2uigrp'
const USER = 'w2uiuser'
const ID = 51234

function log(s: string): void {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`)
}

async function getent(kind: 'passwd' | 'group', name: string): Promise<string> {
  return sshExec(`getent ${kind} ${name} || true`)
}

/** The gid of every group name, from the node (source of truth). */
async function gidsOf(names: string[]): Promise<Record<string, number | null>> {
  const out: Record<string, number | null> = {}
  for (const n of names) {
    const line = await getent('group', n)
    out[n] = line ? Number(line.split(':')[2]) : null
  }
  return out
}

function inBand(gid: number | null): boolean {
  return gid !== null && gid >= 1000 && gid <= 60000
}

async function listItems(page: Page, field: Locator): Promise<string[]> {
  await field.locator('.x-form-trigger').first().click()
  const list = page.locator('.x-boundlist:visible').last()
  await expect(list).toBeVisible({ timeout: 15_000 })
  await expect(list.locator('.x-boundlist-item').first()).toBeVisible({ timeout: 15_000 })
  const items = (await list.locator('.x-boundlist-item').allInnerTexts()).map(s => s.trim())
  await page.keyboard.press('Escape')
  await expect(list).toBeHidden({ timeout: 5_000 }).catch(() => {})
  return items
}

/** Follow a daemon confirm (an Ext.Msg confirm) if one comes; return its text. */
async function followConfirm(page: Page, ms: number): Promise<string | null> {
  const box = page.locator('.x-message-box:visible')
  if (!(await box.isVisible({ timeout: ms }).catch(() => false)))
    return null
  const text = (await box.innerText()).replace(/\s+/g, ' ').trim()
  log(`confirm shown: "${text}"`)
  const yes = box.getByRole('button', { name: /^(Yes|OK)$/ })
  await yes.first().click()
  return text
}

function gridRow(page: Page, grid: string, name: string): Locator {
  return page.locator(`${grid} .x-grid-row`, {
    has: page.locator('.x-grid-cell-inner', { hasText: new RegExp(`^${name}$`) }),
  })
}

test.describe.serial('cr.29/29b/29c identity dialogs', () => {
  test.beforeAll(async () => {
    expect(await getent('passwd', USER)).toBe('')
    expect(await getent('group', GROUP)).toBe('')
    expect(await sshExec(`getent passwd ${ID} || true`)).toBe('')
    expect(await sshExec(`getent group ${ID} || true`)).toBe('')
  })

  test.afterAll(async () => {
    // Safety net only — the test deletes both through the UI.
    if (await getent('passwd', USER))
      await removeShareUser(USER)
    if (await getent('group', GROUP))
      await removeShareGroup(GROUP)
  })

  test('Advanced sections, band-only group pickers, explicit uid/gid, delete through the UI', async ({ page }) => {
    test.setTimeout(300_000)
    await loginToPve(page)
    await openAnasItem(page, 'Share Users')
    await expect(page.locator('.anas-grid-users')).toBeVisible({ timeout: 45_000 })
    await expect(page.locator('.anas-grid-groups')).toBeVisible({ timeout: 45_000 })

    // ---- New Group with an explicit gid in its Advanced section ------------
    await page.locator('.anas-btn-group-add').click()
    const gwin = page.locator('.anas-win-group-create')
    await expect(gwin).toBeVisible({ timeout: 20_000 })
    const gAdv = gwin.locator('.anas-fs-group-advanced')
    await expect(gAdv).toBeVisible()
    await expect(gAdv).toHaveClass(/x-fieldset-collapsed/)
    await expect(gwin.locator('.anas-fld-group-gid input')).toBeHidden()
    log(`group dialog: Advanced fieldset "${(await gAdv.locator('legend').innerText()).trim()}" collapsed, gid field hidden`)
    await gAdv.locator('legend .x-fieldset-header-text, legend').first().click()
    await expect(gwin.locator('.anas-fld-group-gid input')).toBeVisible({ timeout: 5_000 })
    log(`group dialog: expanded; field label "${(await gwin.locator('.anas-fld-group-gid .x-form-item-label').innerText()).trim()}"`)
    await gwin.locator('.anas-fld-group-name input').fill(GROUP)
    await gwin.locator('.anas-fld-group-gid input').fill(String(ID))
    await page.waitForTimeout(400)
    await gwin.locator('.anas-btn-group-create-submit').click()
    const gConfirm = await followConfirm(page, 3_000)
    log(`group create confirm: ${gConfirm === null ? 'none' : gConfirm}`)
    await expect.poll(() => getent('group', GROUP), { timeout: 60_000 }).not.toBe('')
    const gline = await getent('group', GROUP)
    log(`node: getent group ${GROUP} -> ${gline}`)
    expect(gline.split(':')[2]).toBe(String(ID))
    await expect(gwin).toBeHidden({ timeout: 30_000 })
    await expect(gridRow(page, '.anas-grid-groups', GROUP)).toBeVisible({ timeout: 30_000 })

    // ---- New Share User: Advanced, the two group pickers --------------------
    await page.locator('.anas-btn-user-add').click()
    const uwin = page.locator('.anas-win-user-create')
    await expect(uwin).toBeVisible({ timeout: 20_000 })
    const uAdv = uwin.locator('.anas-fs-user-advanced')
    await expect(uAdv).toHaveClass(/x-fieldset-collapsed/)
    await expect(uwin.locator('.anas-fld-user-uid input')).toBeHidden()
    await expect(uwin.locator('.anas-fld-user-primary-group input')).toBeHidden()
    log('user dialog: Advanced fieldset collapsed; uid and primary group hidden')
    await uAdv.locator('legend').first().click()
    await expect(uwin.locator('.anas-fld-user-uid input')).toBeVisible({ timeout: 5_000 })
    await expect(uwin.locator('.anas-fld-user-primary-group input')).toBeVisible()
    log(`user dialog: expanded; labels ${JSON.stringify(await uAdv.locator('.x-form-item-label').allInnerTexts())}; primary group value "${await uwin.locator('.anas-fld-user-primary-group input').inputValue()}"`)

    // The node has groups outside the band (root, …), so the filter has work to do.
    const allGroups = (await sshExec('getent group | cut -d: -f1,3')).split('\n')
    const outside = allGroups.filter(l => !inBand(Number(l.split(':')[1]))).map(l => l.split(':')[0])
    log(`node: ${allGroups.length} groups, ${outside.length} outside 1000..60000 (e.g. ${outside.slice(0, 6).join(', ')})`)

    // Give the group-name read time to land (both stores load on open).
    await page.waitForTimeout(1500)
    const primary = await listItems(page, uwin.locator('.anas-fld-user-primary-group'))
    const pg = await gidsOf(primary)
    log(`primary-group list: ${JSON.stringify(primary.map(n => `${n}(${pg[n]})`))}`)
    expect(primary[0]).toBe('users')
    expect(primary).toContain(GROUP)
    expect(primary).not.toContain('root')
    for (const n of primary.slice(1))
      expect(inBand(pg[n]), `${n} gid ${pg[n]} in band`).toBe(true)

    const supp = await listItems(page, uwin.locator('.anas-fld-user-groups'))
    const sg = await gidsOf(supp)
    log(`supplementary-group picker: ${JSON.stringify(supp.map(n => `${n}(${sg[n]})`))}`)
    expect(supp).toContain(GROUP)
    expect(supp).not.toContain('root')
    for (const n of supp)
      expect(inBand(sg[n]), `${n} gid ${sg[n]} in band`).toBe(true)

    // ---- Create w2uiuser: uid 51234, primary group w2uigrp ------------------
    await uwin.locator('.anas-fld-user-name input').fill(USER)
    await uwin.locator('.anas-fld-user-uid input').fill(String(ID))
    await uwin.locator('.anas-fld-user-primary-group .x-form-trigger').first().click()
    await page.locator('.x-boundlist:visible .x-boundlist-item', { hasText: new RegExp(`^${GROUP}$`) }).first().click()
    await expect(uwin.locator('.anas-fld-user-primary-group input')).toHaveValue(GROUP)
    await page.waitForTimeout(400)
    let createBody = ''
    page.on('request', (req) => {
      if (req.method() === 'POST' && /\/v1\/identity\/users$/.test(req.url()))
        createBody = req.postData() ?? ''
    })
    await uwin.locator('.anas-btn-user-create-submit').click()
    const uConfirm = await followConfirm(page, 3_000)
    log(`user create request body: ${createBody}`)
    log(`user create confirm: ${uConfirm === null ? 'none' : uConfirm}`)
    expect(JSON.parse(createBody)).toEqual({ name: USER, uid: ID, primaryGroup: GROUP })
    await expect.poll(() => getent('passwd', USER), { timeout: 60_000 }).not.toBe('')
    const pline = await getent('passwd', USER)
    log(`node: getent passwd ${USER} -> ${pline}`)
    const [, , uid, gid] = pline.split(':')
    expect(uid).toBe(String(ID))
    expect(gid).toBe(String(ID))
    await expect(uwin).toBeHidden({ timeout: 30_000 })
    const urow = gridRow(page, '.anas-grid-users', USER)
    await expect(urow).toBeVisible({ timeout: 30_000 })
    log(`users grid row: "${(await urow.innerText()).replace(/\s+/g, ' ').trim()}"`)

    // ---- Delete the user, then the group, through the UI --------------------
    await urow.click()
    await expect(page.locator('.anas-btn-user-delete')).toBeEnabled({ timeout: 20_000 })
    await page.locator('.anas-btn-user-delete').click()
    const dwin = page.locator('.anas-win-user-delete')
    await expect(dwin).toBeVisible({ timeout: 20_000 })
    log(`user delete confirm: "${(await dwin.innerText()).replace(/\s+/g, ' ').trim()}"`)
    await dwin.locator('.anas-btn-user-delete-confirm').click()
    await expect.poll(() => getent('passwd', USER), { timeout: 60_000 }).toBe('')
    await expect(urow).toBeHidden({ timeout: 30_000 })
    log(`node: getent passwd ${USER} -> (absent); group still: ${await getent('group', GROUP)}`)

    const grow = gridRow(page, '.anas-grid-groups', GROUP)
    await grow.click()
    await expect(page.locator('.anas-btn-group-delete')).toBeEnabled({ timeout: 20_000 })
    await page.locator('.anas-btn-group-delete').click()
    const gdwin = page.locator('.anas-win-group-delete')
    await expect(gdwin).toBeVisible({ timeout: 20_000 })
    log(`group delete confirm: "${(await gdwin.innerText()).replace(/\s+/g, ' ').trim()}"`)
    await gdwin.locator('.anas-btn-group-delete-confirm').click()
    await expect.poll(() => getent('group', GROUP), { timeout: 60_000 }).toBe('')
    await expect(grow).toBeHidden({ timeout: 30_000 })
    log(`node: getent passwd ${USER} -> "${await getent('passwd', USER)}", getent group ${GROUP} -> "${await getent('group', GROUP)}", getent passwd/group ${ID} -> "${await sshExec(`getent passwd ${ID}; getent group ${ID}; true`)}"`)
  })
})
