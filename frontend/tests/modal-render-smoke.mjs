import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FRONTEND_ROOT = path.resolve(__dirname, '..')

// Minimal browser globals needed by React component initializers during Node SSR render
if (!globalThis.document) {
  const styleNode = {
    firstChild: { data: '' },
    setAttribute: () => {},
    appendChild: (c) => {
      if (c && typeof c.data === 'string') styleNode.firstChild = c
    },
    style: {},
    sheet: { cssRules: [], insertRule: () => {} },
  }
  const noopEl = (tag) =>
    String(tag).toLowerCase() === 'style'
      ? styleNode
      : {
          firstChild: { data: '' },
          setAttribute: () => {},
          appendChild: () => {},
          style: {},
          sheet: { cssRules: [], insertRule: () => {} },
        }
  globalThis.document = {
    head: { appendChild: () => {}, querySelector: () => styleNode },
    body: { appendChild: () => {} },
    createElement: noopEl,
    createTextNode: (t = '') => ({ data: String(t) }),
    querySelector: () => null,
    querySelectorAll: () => [],
  }
}
if (!globalThis.window) {
  globalThis.window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
    location: { origin: 'http://localhost:5173', hostname: 'localhost', pathname: '/' },
  }
}
if (!globalThis.localStorage) {
  const store = new Map()
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  }
}

/**
 * Render a React component with `isOpen=false` then `isOpen=true` through real React
 * (`renderToStaticMarkup`) while also verifying that no Rules-of-Hooks violation occurs
 * (i.e. hook count / sequence does not change when `isOpen` flips from false to true).
 */
function renderWithHookOrderCheck(Component, closedProps, openProps, label) {
  // Capture hooks called by the root component itself during render
  const hookLogClosed = []
  const hookLogOpen = []

  const internals =
    React.__SERVER_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE ||
    React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE

  function traceRender(props, log) {
    const prevH = internals?.H
    if (internals) {
      // Wrap dispatcher setter/getter via renderToStaticMarkup
      let wrapped = false
      const origDesc = Object.getOwnPropertyDescriptor(internals, 'H')
      Object.defineProperty(internals, 'H', {
        configurable: true,
        get() {
          return this._H_val
        },
        set(dispatcher) {
          if (dispatcher && !wrapped) {
            wrapped = true
            const tracked = new Proxy(dispatcher, {
              get(target, prop) {
                const fn = target[prop]
                if (typeof fn === 'function' && prop.startsWith('use')) {
                  return (...args) => {
                    log.push(prop)
                    return fn.apply(target, args)
                  }
                }
                return fn
              },
            })
            this._H_val = tracked
          } else {
            this._H_val = dispatcher
          }
        },
      })
      try {
        return renderToStaticMarkup(React.createElement(Component, props))
      } finally {
        if (origDesc) {
          Object.defineProperty(internals, 'H', origDesc)
        }
        internals.H = prevH
      }
    }
    return renderToStaticMarkup(React.createElement(Component, props))
  }

  const htmlClosed = traceRender(closedProps, hookLogClosed)
  const htmlOpen = traceRender(openProps, hookLogOpen)

  // Note: when open, child components also render hooks, so closed hook sequence
  // must be an exact prefix of open hook sequence (root component runs first).
  if (hookLogClosed.length > 0) {
    const prefix = hookLogOpen.slice(0, hookLogClosed.length)
    assert.deepEqual(
      prefix,
      hookLogClosed,
      `[${label}] Rules-of-Hooks violation! Hooks changed when isOpen flipped false -> true: closed=${JSON.stringify(hookLogClosed)} vs openPrefix=${JSON.stringify(prefix)}`
    )
  }

  return { htmlClosed, htmlOpen, hookLogClosed, hookLogOpen }
}

async function main() {
  const vite = await createServer({
    root: FRONTEND_ROOT,
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'error',
  })

  try {
    const [{ default: DongCaModal }, { default: PrintBridgeModal }, { parseStaffQuickList }] =
      await Promise.all([
        vite.ssrLoadModule('/src/pages/pos/components/DongCaModal.jsx'),
        vite.ssrLoadModule('/src/pages/pos/components/PrintBridgeModal.jsx'),
        vite.ssrLoadModule('/src/utils/staffQuickList.js'),
      ])

    // 1. DongCaModal: isOpen=false -> isOpen=true with preCloseCheck & outboxPendingCount > 0
    const dongCaResult = renderWithHookOrderCheck(
      DongCaModal,
      {
        isOpen: false,
        onClose: () => {},
        currentShift: { maCaThuNgan: 101 },
        onShiftClosed: () => {},
      },
      {
        isOpen: true,
        onClose: () => {},
        currentShift: { maCaThuNgan: 101 },
        preCloseCheck: {
          openOrders: [{ maHoaDon: 'HD-01' }, { maHoaDon: 'HD-02' }],
          parkedOrdersCount: 3,
          blockingReasons: ['Còn 2 bàn đang mở chưa thanh toán'],
        },
        outboxPendingCount: 4,
        onShiftClosed: () => {},
      },
      'DongCaModal'
    )
    assert.equal(dongCaResult.htmlClosed, '', 'DongCaModal with isOpen=false must render empty markup')
    assert.ok(
      dongCaResult.htmlOpen.includes('HD') || dongCaResult.htmlOpen.includes('Còn 2 hóa đơn/bàn đang mở'),
      'DongCaModal must render openOrders count from preCloseCheck'
    )
    assert.ok(
      dongCaResult.htmlOpen.includes('Còn 3 đơn lưu tạm chưa xử lý'),
      'DongCaModal must render parkedOrdersCount from preCloseCheck'
    )
    assert.ok(
      dongCaResult.htmlOpen.includes('Còn 2 bàn đang mở chưa thanh toán'),
      'DongCaModal must render blockingReasons from preCloseCheck'
    )
    assert.ok(
      dongCaResult.htmlOpen.includes('Còn 4 đơn offline (Outbox) chưa đồng bộ'),
      'DongCaModal must render outboxPendingCount > 0 warning'
    )

    // 2. PrintBridgeModal: isOpen=false -> isOpen=true
    const printBridgeResult = renderWithHookOrderCheck(
      PrintBridgeModal,
      {
        isOpen: false,
        onClose: () => {},
        user: { tenantId: 'T_TEST', maNV: 'NV01', tenNV: 'Tester' },
      },
      {
        isOpen: true,
        onClose: () => {},
        user: { tenantId: 'T_TEST', maNV: 'NV01', tenNV: 'Tester' },
      },
      'PrintBridgeModal'
    )
    assert.equal(printBridgeResult.htmlClosed, '', 'PrintBridgeModal with isOpen=false must render empty markup')
    assert.ok(
      printBridgeResult.htmlOpen.length > 100 && printBridgeResult.htmlOpen.includes('Print Bridge'),
      'PrintBridgeModal with isOpen=true must render modal content'
    )

    // 3. staff-quick-list helper: supports both raw array [...] and { danhSachNV: [...] }
    const rawArray = [{ maNV: 'NV01', tenNV: 'An', coQuyenDuyetPin: true, daDatPin: true }]
    const wrappedObj = { danhSachNV: [{ maNV: 'NV02', tenNV: 'Binh', coQuyenDuyetPin: false, daDatPin: true }] }
    assert.deepEqual(parseStaffQuickList(rawArray), rawArray, 'parseStaffQuickList must parse raw JSON array')
    assert.deepEqual(parseStaffQuickList(wrappedObj), wrappedObj.danhSachNV, 'parseStaffQuickList must parse { danhSachNV: [...] }')
    assert.deepEqual(parseStaffQuickList(null), [], 'parseStaffQuickList must safely handle null')

    console.log('✅ Frontend Modal Render Smoke Test PASSED (DongCaModal, PrintBridgeModal, staff-quick-list)')
  } finally {
    await vite.close()
  }
}

main().catch((err) => {
  console.error('❌ Frontend Modal Render Smoke Test FAILED:', err)
  process.exit(1)
})
