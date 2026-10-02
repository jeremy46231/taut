// Taut Schedules: when a schedule's weekly windows are on

import { type ScheduleWindow, WEEKDAYS } from '../shared/Plugin'

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
/** a chain of back-to-back windows is cut off this far out */
const MAX_CHAIN = 7 * DAY

const formatters = new Map<string, Intl.DateTimeFormat>()

/** the wall clock in `timeZone` at `instant`, as a UTC timestamp */
function toWall(instant: number, timeZone?: string): number {
  const key = timeZone ?? ''
  let format = formatters.get(key)
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
    formatters.set(key, format)
  }
  const part: Record<string, number> = {}
  for (const { type, value } of format.formatToParts(instant)) {
    part[type] = Number(value)
  }
  return (
    Date.UTC(part.year, part.month - 1, part.day, part.hour, part.minute) +
    part.second * 1000 +
    (instant % 1000)
  )
}

/** the instant a wall clock time happens in `timeZone` */
function fromWall(wall: number, timeZone?: string): number {
  const guess = wall - (toWall(wall, timeZone) - wall)
  // once more, for a guess that landed across a daylight saving change
  return wall - (toWall(guess, timeZone) - guess)
}

const minutes = (time: string) => {
  const [hours, mins] = time.split(':').map(Number)
  return hours * 60 + mins
}

function runsAround(window: ScheduleWindow, wall: number) {
  const runs: { start: number; end: number }[] = []
  const start = minutes(window.start)
  const end = minutes(window.end)
  const today = Math.floor(wall / DAY) * DAY
  for (const offset of [-1, 0, 1]) {
    const day = today + offset * DAY
    if (!window.days.includes(WEEKDAYS[new Date(day).getUTCDay()])) continue
    runs.push({
      start: day + start * MINUTE,
      end: day + end * MINUTE + (end <= start ? DAY : 0),
    })
  }
  return runs
}

/** when the window on now ends, back-to-back windows merged up to a week out, null if none is on */
export function scheduleEnd(
  windows: readonly ScheduleWindow[],
  timeZone?: string
): number | null {
  const wallNow = toWall(Date.now(), timeZone)
  let end: number | null = null
  for (const window of windows) {
    for (const run of runsAround(window, wallNow)) {
      if (run.start <= wallNow && wallNow < run.end && run.end > (end ?? 0)) {
        end = run.end
      }
    }
  }
  if (end === null) return null

  const limit = wallNow + MAX_CHAIN
  for (let extended = true; extended && end < limit; ) {
    extended = false
    for (const window of windows) {
      for (const run of runsAround(window, end)) {
        if (run.start <= end && run.end > end) {
          end = run.end
          extended = true
        }
      }
    }
  }
  return fromWall(Math.min(end, limit), timeZone)
}
