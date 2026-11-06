// One-off UI verification over CDP (port 9225, isolated dev instance).
const BASE = 'http://127.0.0.1:9225'

const targets = await (await fetch(`${BASE}/json/list`)).json()
const mainPage = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools'))

function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const i = ++id
      pending.set(i, resolve)
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    }
  }
  const ready = new Promise((r) => (ws.onopen = r))
  return { ws, send, ready }
}

const { ws, send, ready } = connect(mainPage)
await ready
const evaluate = async (expression) =>
  (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result
    ?.result?.value

const routeOf = () => evaluate(`new URL(location.href).searchParams.get('route')`)

const clickText = async (label) => {
  const box = await evaluate(`(() => {
    const t = [...document.querySelectorAll('button')].find((b) => (b.innerText||'').trim() === ${JSON.stringify(label)})
    if (!t) return null
    const r = t.getBoundingClientRect()
    return JSON.stringify({ x: r.x + r.width/2, y: r.y + r.height/2 })
  })()`)
  if (!box) return null
  const { x, y } = JSON.parse(box)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  await new Promise((r) => setTimeout(r, 1500))
  return true
}

// Land on a known route first.
await evaluate(`(() => {
  const u = new URL(location.href)
  u.searchParams.delete('windowMode')
  u.searchParams.set('route', 'tasks')
  location.href = u.toString()
})()`)
await new Promise((r) => setTimeout(r, 6000))

const text = String(await evaluate('document.body.innerText'))
console.log('hasNewSessionButton:', text.includes('新建会话'))
console.log('hasStartSession    :', text.includes('开始会话'))
console.log('crash              :', text.includes('请重启应用'))

console.log('route.before       :', await routeOf())
await clickText('任务')
console.log('route.tasks   :', await routeOf())
const afterTasks = String(await evaluate('document.body.innerText'))
console.log('tasksHintVisible   :', afterTasks.includes('从左侧选一个任务'))

ws.close()

// Settings window: click 设置 and follow the new target.
const { ws: ws2, send: send2, ready: ready2 } = connect(mainPage)
await ready2
const eval2 = async (expression) =>
  (await send2('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result
    ?.result?.value

const settingsBox = await eval2(`(() => {
  const t = [...document.querySelectorAll('button')].find((b) => (b.innerText||'').trim() === '设置')
  if (!t) return null
  const r = t.getBoundingClientRect()
  return JSON.stringify({ x: r.x + r.width/2, y: r.y + r.height/2 })
})()`)
if (settingsBox) {
  const { x, y } = JSON.parse(settingsBox)
  await send2('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await send2('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}
await new Promise((r) => setTimeout(r, 4000))
ws2.close()

const all = await (await fetch(`${BASE}/json/list`)).json()
const settings = all.find((t) => t.url.includes('windowMode=settings'))
if (!settings) {
  console.log('settingsWindow     : NOT FOUND')
  process.exit(0)
}

const { ws: ws3, send: send3, ready: ready3 } = connect(settings)
await ready3
const eval3 = async (expression) =>
  (await send3('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result
    ?.result?.value

await eval3(`(() => {
  const u = new URL(location.href)
  u.searchParams.set('route', 'settings/agents')
  location.href = u.toString()
})()`)
await new Promise((r) => setTimeout(r, 5000))

const sText = String(await eval3('document.body.innerText'))
console.log('agentsPage.title   :', sText.includes('智能体'))
console.log('agentsPage.rawKey  :', sText.includes('settings.agents.title'))
console.log('agentsPage.sections:', ['身份', '人设提示词', '默认值', '可用来源', '可用技能'].filter((k) => sText.includes(k)).join(','))
console.log('agentsPage.newAgent:', sText.includes('新建角色'))
ws3.close()
