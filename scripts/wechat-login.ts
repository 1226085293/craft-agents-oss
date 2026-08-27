/**
 * wechat-login.ts — 微信 ClawBot 扫码登录 + 凭据写入
 *
 * 在仓库根目录运行:
 *   bun run scripts/wechat-login.ts
 *
 * 流程:
 *   1. 调用 ilinkai.weixin.qq.com 的 get_bot_qrcode 获取二维码
 *   2. 终端显示二维码链接（qrcode-terminal 可选）
 *   3. 长轮询 get_qrcode_status（35s 超时）
 *   4. 用户扫码确认后获取 bot_token + baseurl + ilink_bot_id
 *   5. 写入 CredentialManager（messaging_bearer/wechat）
 *   6. 提示重启应用
 */

import { randomBytes } from 'node:crypto'
import * as readline from 'node:readline'
import { CredentialManager } from '../packages/shared/src/credentials/manager.ts'

const FIXED_BASE_URL = 'https://ilinkai.weixin.qq.com'
const BOT_TYPE = '3'
const LONG_POLL_TIMEOUT_MS = 35_000
const POLL_INTERVAL_MS = 1_000
const LOGIN_TIMEOUT_MS = 480_000
const WORKSPACE_ID = 'a35b485f-f46a-d396-8b84-fc11e5eb51eb'

function randomWechatUin(): string {
  const uint32 = randomBytes(4).readUInt32BE(0)
  return Buffer.from(String(uint32), 'utf-8').toString('base64')
}

async function fetchQRCode(): Promise<{ qrcode: string; qrcode_img_content: string }> {
  const res = await fetch(`${FIXED_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(BOT_TYPE)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'iLink-App-Id': 'bot',
      'iLink-App-ClientVersion': '131590',
      'X-WECHAT-UIN': randomWechatUin(),
    },
    body: JSON.stringify({ local_token_list: [] }),
  })
  if (!res.ok) throw new Error(`get_bot_qrcode HTTP ${res.status}: ${await res.text()}`)
  return (await res.json()) as { qrcode: string; qrcode_img_content: string }
}

async function pollQRStatus(qrcode: string, verifyCode?: string): Promise<{
  status: string
  bot_token?: string
  ilink_bot_id?: string
  baseurl?: string
  ilink_user_id?: string
  redirect_host?: string
}> {
  let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`
  if (verifyCode) endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`

  const url = `${FIXED_BASE_URL}/${endpoint}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), LONG_POLL_TIMEOUT_MS)

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'iLink-App-Id': 'bot',
        'iLink-App-ClientVersion': '131590',
        'X-WECHAT-UIN': randomWechatUin(),
      },
      signal: controller.signal,
    })
    clearTimeout(timer)
    if (!res.ok) throw new Error(`get_qrcode_status HTTP ${res.status}: ${await res.text()}`)
    return (await res.json()) as any
  } catch (err: any) {
    clearTimeout(timer)
    if (err.name === 'AbortError') return { status: 'wait' }
    throw err
  }
}

function readLine(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

async function main() {
  console.log('')
  console.log('╔══════════════════════════════════════════════════════════════╗')
  console.log('║        微信 ClawBot 扫码登录                               ║')
  console.log('║  请用手机微信扫描二维码，将个人微信账号授权为机器人         ║')
  console.log('╚══════════════════════════════════════════════════════════════╝')
  console.log('')

  const qr = await fetchQRCode()
  const qrcodeUrl = qr.qrcode_img_content
  console.log('二维码链接（复制到浏览器打开，或用手机微信扫码）:')
  console.log(qrcodeUrl)
  console.log('')

  try {
    const qrterm = await import('qrcode-terminal')
    qrterm.default.generate(qrcodeUrl, { small: true })
    console.log('')
  } catch {
    console.log('(提示: 安装 qrcode-terminal 可在终端显示二维码)')
    console.log('')
  }

  console.log('等待扫码中...（最长 8 分钟）')
  console.log('')

  const deadline = Date.now() + LOGIN_TIMEOUT_MS
  let qrCode = qr.qrcode
  let pendingVerifyCode: string | undefined
  let currentBaseUrl = FIXED_BASE_URL
  let qrRefreshCount = 0
  const MAX_QR_REFRESH = 3

  while (Date.now() < deadline) {
    const status = await pollQRStatus(qrCode, pendingVerifyCode)

    switch (status.status) {
      case 'wait':
        process.stdout.write('.')
        break

      case 'scaned':
        if (pendingVerifyCode) {
          pendingVerifyCode = undefined
          console.log('\n✅ 验证码通过')
        } else {
          console.log('\n📱 已扫码，等待确认...')
        }
        break

      case 'need_verifycode': {
        const prompt = pendingVerifyCode
          ? '\n❌ 验证码不匹配，请重新输入微信显示的数字：'
          : '\n🔑 请在手机微信上确认，然后输入微信显示的数字：'
        const code = await readLine(prompt)
        pendingVerifyCode = code
        continue
      }

      case 'expired':
        qrRefreshCount++
        if (qrRefreshCount > MAX_QR_REFRESH) {
          console.log('\n❌ 二维码多次过期，登录失败。请稍后重试。')
          process.exit(1)
        }
        console.log(`\n🔄 二维码已过期，正在刷新 (${qrRefreshCount}/${MAX_QR_REFRESH})...`)
        const newQR = await fetchQRCode()
        qrCode = newQR.qrcode
        console.log('新二维码链接:', newQR.qrcode_img_content)
        try {
          const qrterm = await import('qrcode-terminal')
          qrterm.default.generate(newQR.qrcode_img_content, { small: true })
        } catch {}
        console.log('')
        break

      case 'scaned_but_redirect':
        if (status.redirect_host) {
          currentBaseUrl = `https://${status.redirect_host}`
          console.log(`\n🔄 重定向到 ${status.redirect_host}`)
        }
        break

      case 'binded_redirect':
        console.log('\n✅ 此账号已绑定，已有凭据仍然有效。')
        console.log('如需重新绑定，请先删除旧凭据。')
        process.exit(1)

      case 'confirmed': {
        const botToken = status.bot_token
        const botId = status.ilink_bot_id
        const baseUrl = status.baseurl || currentBaseUrl
        const userId = status.ilink_user_id

        if (!botToken || !botId) {
          console.log('\n❌ 登录确认失败：缺少 bot_token 或 ilink_bot_id')
          process.exit(1)
        }

        console.log('\n')
        console.log('╔══════════════════════════════════════════════════════════════╗')
        console.log('║  ✅ 登录成功！                                           ║')
        console.log(`║  机器人 ID: ${botId.padEnd(40)}║`)
        console.log(`║  用户 ID:   ${(userId ?? '?').padEnd(40)}║`)
        console.log(`║  API 地址:  ${baseUrl.padEnd(40)}║`)
        console.log('╚══════════════════════════════════════════════════════════════╝')
        console.log('')

        // 写入凭据管理器
        const creds = { botToken, baseUrl, botId, userId }
        const cm = new CredentialManager()
        await cm.set(
          { type: 'messaging_bearer', workspaceId: WORKSPACE_ID, name: 'wechat' },
          { value: JSON.stringify(creds) },
        )
        console.log('✅ 凭据已写入加密存储')
        console.log('')

        // 验证 round-trip
        const verify = await cm.get({ type: 'messaging_bearer', workspaceId: WORKSPACE_ID, name: 'wechat' })
        if (!verify) throw new Error('凭据验证失败：写入后读取不到')
        const parsed = JSON.parse(verify.value)
        if (parsed.botToken !== botToken) throw new Error('凭据验证失败：botToken 不匹配')
        console.log('✅ 凭据 round-trip 验证通过')
        console.log('')

        console.log('╔══════════════════════════════════════════════════════════════╗')
        console.log('║  下一步：重启 Craft Agents 应用以启用微信连接             ║')
        console.log('║  重启后微信适配器会自动连接，开始接收消息                 ║')
        console.log('╚══════════════════════════════════════════════════════════════╝')
        return
      }

      default:
        console.log(`\n⚠️ 未知状态: ${status.status}`)
        break
    }

    await sleep(POLL_INTERVAL_MS)
  }

  console.log('\n❌ 登录超时（8 分钟），请重新运行脚本。')
  process.exit(1)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

main().catch((err) => {
  console.error('登录失败:', err)
  process.exit(1)
})