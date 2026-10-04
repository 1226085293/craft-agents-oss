import { Cron } from 'croner'

export interface MemorySchedule {
  enabled: boolean
  cron: string
  timezone?: string
}

export class MemoryConsolidationScheduler {
  private inFlight = false
  private lastMinute = ''
  private job: Cron | null = null

  constructor(private schedule: MemorySchedule, private readonly run: () => Promise<unknown>) {
    if (schedule.enabled) {
      this.job = new Cron(schedule.cron, { ...(schedule.timezone ? { timezone: schedule.timezone } : {}), paused: true })
    }
  }

  async tick(now = new Date()): Promise<boolean> {
    if (!this.schedule.enabled || this.inFlight) return false
    const minute = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`
    if (minute === this.lastMinute) return false
    const next = this.job?.nextRun(new Date(now.getTime() - 60_000))
    if (!next || Math.floor(next.getTime() / 60_000) !== Math.floor(now.getTime() / 60_000)) return false
    this.lastMinute = minute
    this.inFlight = true
    try {
      await this.run()
      return true
    } finally {
      this.inFlight = false
    }
  }

  update(schedule: MemorySchedule): void {
    this.schedule = schedule
    this.job?.stop()
    this.job = schedule.enabled
      ? new Cron(schedule.cron, { ...(schedule.timezone ? { timezone: schedule.timezone } : {}), paused: true })
      : null
  }

  stop(): void {
    this.job?.stop()
    this.job = null
    this.schedule = { ...this.schedule, enabled: false }
  }
}
