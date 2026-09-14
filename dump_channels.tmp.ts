import { writeFileSync } from 'node:fs'
import { RPC_CHANNELS } from './packages/shared/src/protocol/channels.ts'

const all = new Set<string>()
const walk = (obj: unknown): void => {
  if (!obj || typeof obj !== 'object') return
  for (const v of Object.values(obj as Record<string, unknown>)) {
    if (typeof v === 'string') all.add(v)
    else walk(v)
  }
}
walk(RPC_CHANNELS)

const sorted = [...all].sort()
writeFileSync(
  'c:/Users/12260/CodeBuddy/20260912205111/channels.json',
  JSON.stringify(sorted, null, 0),
  'utf-8',
)
console.log('channels:', sorted.length)
