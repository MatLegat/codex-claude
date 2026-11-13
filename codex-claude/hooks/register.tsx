import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register, RenderChildren } from 'claude-code'

import type { ClaudeContext, CodexContext, UsageWindow } from '../types'

const PANE = 'context-all'
const CODEX_REFRESH_MS = 60_000
const CODEX_USAGE_REFRESH_MS = 5 * 60_000

const claude = atom({ plugin: 'codex-claude', key: 'claude' } as const, null, {
  shape: 'claude-1',
})
const codex = atom({ plugin: 'codex-claude', key: 'codex' } as const, null, {
  shape: 'codex-1',
})
const isClaudeOpen = atom({ plugin: 'codex-claude', key: 'isClaudeOpen' } as const, false)
const isCodexOpen = atom({ plugin: 'codex-claude', key: 'isCodexOpen' } as const, false)
const claudeUsage = atom({ plugin: 'codex-claude', key: 'claudeUsage' } as const, null, {
  shape: 'usage-1',
})
const codexUsage = atom({ plugin: 'codex-claude', key: 'codexUsage' } as const, null, {
  shape: 'usage-1',
})
const isClaudeUsageOpen = atom({ plugin: 'codex-claude', key: 'isClaudeUsageOpen' } as const, false)
const isCodexUsageOpen = atom({ plugin: 'codex-claude', key: 'isCodexUsageOpen' } as const, false)
const claudeUsageSeenAt = atom({ plugin: 'codex-claude', key: 'claudeUsageSeenAt' } as const, null)

// The last Claude reading is kept in the store, so a session with no reading yet
// (no response so far) shows the latest one any session saw.
const STORE_CLAUDE_USAGE = 'claudeUsage'
const STALE_MS = 10 * 60_000
const DAY_MS = 86_400_000
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// The host's UTC offset in minutes, from `date +%z`: the mod's own environment
// may not know the person's time zone.
const tzOffset = atom({ plugin: 'codex-claude', key: 'tzOffset' } as const, null)

const WINDOW_NAMES: Record<string, string> = { five_hour: '5h', seven_day: 'Weekly' }

function isPast(w: UsageWindow, now: number): boolean {
  return w.resetsAt !== undefined && w.resetsAt <= now
}

const CLAUDE_ICON = '✻'
const CLAUDE_COLOR = '#D97757'
const CODEX_ICON = '❂'
const CODEX_COLOR = '#10A39F'

// While a model works its icon animates: Claude cycles Claude Code's spinner
// glyphs; Codex cycles its stand-in glyphs. One frame per tick.
const FRAME_MS = 250
const CLAUDE_FRAMES = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢']
const CODEX_GLYPHS = ['֍', '⌬', '❂', '⬡', '⎔', '✺', '❁', '◎']
// While anything works, Codex's job status is checked every this many ticks (3 s).
const BUSY_POLL_TICKS = 12
// The companion subcommands that start a Codex job (not status, result, setup, ...).
const STARTS_CODEX_JOB = /codex-companion\.mjs"?\s+(task|review|adversarial-review)(\s|"|$)/
// After a Codex start is seen, "not running" is not trusted for this long: the job may not
// be registered yet (a background start returns before it is).
const CODEX_START_GRACE_MS = 20_000

const claudeBusy = atom({ plugin: 'codex-claude', key: 'claudeBusy' } as const, false)
const codexBusy = atom({ plugin: 'codex-claude', key: 'codexBusy' } as const, false)
const frame = atom({ plugin: 'codex-claude', key: 'frame' } as const, 0)
// VS Code draws each Svg as an image; one drawn while its window was in the background (a mod
// reload, say) can stay as its alt text. A new source makes it load again, so there the band
// redraws every IMAGE_REFRESH_MS with this number in each image's markup.
const IMAGE_REFRESH_MS = 30_000
const imageEpoch = atom({ plugin: 'codex-claude', key: 'imageEpoch' } as const, 0)
// Bumped once a minute: the band reads it, so the rings' time to reset stays current.
const MINUTE_MS = 60_000
const minuteTick = atom({ plugin: 'codex-claude', key: 'minuteTick' } as const, 0)

function claudeIcon(isBusy: boolean, n: number): string {
  return isBusy ? (CLAUDE_FRAMES[n % CLAUDE_FRAMES.length] ?? CLAUDE_ICON) : CLAUDE_ICON
}

function codexIcon(isBusy: boolean, n: number): string {
  return isBusy ? (CODEX_GLYPHS[n % CODEX_GLYPHS.length] ?? CODEX_ICON) : CODEX_ICON
}

// Fixed widths in cells for the band's columns, so the rows line up whatever
// the numbers: the row label, then the Claude icon and button.
const LABEL_WIDTH = 8
const CLAUDE_COLUMN = 9
// Each icon sits in a slot this wide, so its button never moves as the glyph changes.
const ICON_WIDTH = 1
// Each row ends in a model indicator, right-aligned in a fixed column with its glyph
// centered: Claude's on the Context row, Codex's on the Usage row. Gray and still while
// idle, in color and animated while that model works.
const SPINNER_WIDTH = 3
// An idle indicator's gray.
const IDLE_COLOR = '#5C5C5C'

// The band's layout, the `layout` option (/config → codex-claude, or pluginConfigs in
// settings). 'models', the default: one mirrored row, Claude's marks at the left, Codex's
// at the right, a `+` / `-` button between opening every detail above it. 'rings': a
// `Context` / `Usage` button per row opening both models' details, then the two marks.
// 'buttons': a row label, then per model a ring and a button with its percentage.
// The terminal, which has no Svg, shows `✻ 25%` in place of a bar or ring.
type BandLayout = 'models' | 'rings' | 'buttons'
// The rings layout's button column, wide enough for `Context` on every surface.
const ROW_BUTTON_WIDTH = 11
// The rings layout draws context as 'bar' (a pill that fills left to right) or 'ring'.
const CONTEXT_STYLE: 'bar' | 'ring' = 'bar'
const BAR_WIDTH = 21
const BAR_HEIGHT = 7
// Models layout: empty space at each end of the bar's image, in px. A ring's circle sits
// about 0.7px inside its image; this matches it, plus a little, so the gap from a ring to
// the bar looks the same as from ring to ring.
const BAR_PAD = 1
// Cells per model column in the rings layout: room for a bar; the usage rings center in it.
const MARK_SLOT_WIDTH = 4

// What sits before each band button: 'ring' draws a small progress ring of that
// button's percentage in the model's color; 'glyph' is the plain ✻ / ❂ icon.
// Set it back to 'glyph' to roll back. The terminal has no Svg and always draws the glyph.
const ROW_ICON_STYLE: 'ring' | 'glyph' = 'ring'
const RING_SIZE = 16
// A ring needs a wider slot than a glyph: a one-cell slot shrinks it to the cell.
// The Claude column widens by the same amount, so the space after its button stays.
const RING_SLOT_WIDTH = 2
const RING_TRACK = '#5C5C5C'
// Line thickness, in the ring's 14-unit drawing.
const RING_STROKE = 1.25
// Models layout: each model's usage is two rings, its 5h window and its weekly one, each
// with the time to its reset in the middle (its window's name with no reading); a little larger than the other rings so it reads.
// The weekly ring's line is thicker. Codex's side of the main row is mirrored, 1w then 5h;
// its expanded details keep 5h then 1w.
const USAGE_RINGS: { name: string; label: string; stroke: number }[] = [
  { name: '5h', label: '5h', stroke: 0.75 },
  { name: 'Weekly', label: '1w', stroke: 1.5 },
]
const USAGE_RING_SIZE = 20
// Models layout: the space between a model's marks (ring to ring, ring to bar).
const MARK_GAP = 'xs'
const USAGE_RING_FONT = 5.2
// Three characters (`23h`, `59m`) need a smaller size to fit the hole.
const USAGE_RING_FONT_WIDE = 4
// The label's color warns as the window fills: the first step its percentage reaches;
// below them all, and with no reading, a gray lighter than the track.
const USAGE_TEXT_STEPS: { from: number; color: string }[] = [
  { from: 90, color: '#D9534F' },
  { from: 70, color: '#D9A13B' },
  { from: 50, color: '#A89B6A' },
]
const USAGE_TEXT_GRAY = '#8E8E8E'
const usageTextColor = (percent: number | null) =>
  (percent === null ? undefined : USAGE_TEXT_STEPS.find(step => percent >= step.from)?.color) ?? USAGE_TEXT_GRAY
// true: hovering a ring shows short details in the empty part of its row;
// false: nothing on hover.
const RING_HOVER = false
// true: each ring has its logo in the middle (Claude's, Codex's), in the model's color.
const RING_LOGO = false
// 24x24 logo paths. Claude's from Simple Icons (simple-icons@13.21.0).
const CLAUDE_LOGO = 'm4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z'
// Codex's, from LobeHub icons (@lobehub/icons-static-svg@1.101.0); its prompt is a hole, drawn even-odd.
const CODEX_LOGO = 'M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z'
// The logo's side in the ring's 14-unit drawing (16px ring: 1 unit ≈ 1.14px), centered.
const LOGO_SIZE = 8.15
const LOGO_AT = (14 - LOGO_SIZE) / 2
// How far the logo's color goes from the model's color toward the track gray: 0 none, 1 all gray.
const LOGO_GRAY = 0.5

// Two #RRGGBB colors mixed: `amount` of the way from `from` to `to`.
function mix(from: string, to: string, amount: number): string {
  const channel = (hex: string, i: number) => Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16)

  return `#${[0, 1, 2]
    .map(i => Math.round(channel(from, i) + (channel(to, i) - channel(from, i)) * amount).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()}`
}

// A button's label as a number, or null when there is no reading ('—').
function labelPercent(label: string): number | null {
  const n = Number.parseFloat(label)

  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : null
}

// An image's alt text, which VS Code can show in its place: just the number, short enough to
// keep the row's layout; `—` with no reading.
const percentAlt = (percent: number | null) => (percent === null ? '—' : `${percent}%`)

// The image's refresh number, as an id on its root: changes the source, not the drawing.
const epochId = (epoch?: number) => (epoch === undefined ? '' : ` id="e${epoch}"`)

// Codex marks mirror Claude's: its bar fills from the right, its ring runs counter-clockwise.
const MIRROR_CODEX = false

// A gray track with an arc from 12 o'clock, clockwise (counter-clockwise when mirrored),
// as long as the percentage.
function ringSvg(percent: number | null, color: string, logo?: string, mirror = false, epoch?: number, label?: string, size = RING_SIZE, stroke = RING_STROKE): string {
  const r = 7 - stroke / 2 - 0.5
  const c = 2 * Math.PI * r
  const len = ((percent ?? 0) / 100) * c
  const track = `<circle cx="7" cy="7" r="${r}" fill="none" stroke="${RING_TRACK}" stroke-width="${stroke}"/>`
  const arc = len > 0
    ? `<circle cx="7" cy="7" r="${r}" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round" stroke-dasharray="${len.toFixed(2)} ${c.toFixed(2)}" transform="${mirror ? 'matrix(-1 0 0 1 14 0) ' : ''}rotate(-90 7 7)"/>`
    : ''

  // The logo fills the square that fits inside the ring's hole, with a little room.
  const mark = logo ? `<svg x="${LOGO_AT}" y="${LOGO_AT}" width="${LOGO_SIZE}" height="${LOGO_SIZE}" viewBox="0 0 24 24"><path fill="${mix(color, RING_TRACK, LOGO_GRAY)}" fill-rule="evenodd" d="${logo}"/></svg>` : ''

  // A label (the time to reset, `5h`, or a window name, `1w`) sits in the ring's hole,
  // colored by how full the window is.
  const text = label
    ? `<text x="7" y="7.1" text-anchor="middle" dominant-baseline="central" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="${label.length > 2 ? USAGE_RING_FONT_WIDE : USAGE_RING_FONT}" font-weight="600" fill="${usageTextColor(percent)}">${label}</text>`
    : ''

  return `<svg xmlns="http://www.w3.org/2000/svg"${epochId(epoch)} width="${size}" height="${size}" viewBox="0 0 14 14">${track}${arc}${mark}${text}</svg>`
}

// A rounded gray track with a fill from the left (the right when mirrored) as long as the
// percentage; no reading, no fill.
function barSvg(percent: number | null, color: string, mirror = false, epoch?: number, pad = 0): string {
  const w = BAR_WIDTH
  const h = BAR_HEIGHT
  const pill = `x="${pad}" width="${w}" height="${h}" rx="${h / 2}"`
  const track = `<rect ${pill} fill="${RING_TRACK}"/>`
  // The fill is exactly the percentage of the length, clipped to the pill so its outer end
  // stays round; its inner end is a straight cut.
  const fillWidth = (w * (percent ?? 0)) / 100
  const fill = percent === null || fillWidth <= 0
    ? ''
    : `<clipPath id="pill"><rect ${pill}/></clipPath><rect x="${(pad + (mirror ? w - fillWidth : 0)).toFixed(2)}" width="${fillWidth.toFixed(2)}" height="${h}" fill="${color}" clip-path="url(#pill)"/>`

  return `<svg xmlns="http://www.w3.org/2000/svg"${epochId(epoch)} width="${w + 2 * pad}" height="${h}" viewBox="0 0 ${w + 2 * pad} ${h}">${track}${fill}</svg>`
}

// Expanded context: `✻ Claude context` in that one's color, the details indented below.
type ContextBlock = { heading: string; color: string; line: string }
const NAMED = {
  Claude: { icon: CLAUDE_ICON, color: CLAUDE_COLOR },
  Codex: { icon: CODEX_ICON, color: CODEX_COLOR },
} as const
type Who = keyof typeof NAMED

// One window's percentage, by name; null when there is none or it has reset since its reading.
function windowPercent(windows: UsageWindow[] | null, name: string, now: number): number | null {
  const w = (windows ?? []).find(v => v.name === name)

  return w && !isPast(w, now) ? Math.round(w.percent) : null
}

// Time until a window resets, in its largest whole unit: `3d`, `5h`, `42m` (at least `1m`).
// null when it has no reset time or has already reset.
function resetIn(windows: UsageWindow[] | null, name: string, now: number): string | null {
  const w = (windows ?? []).find(v => v.name === name)
  if (!w || w.resetsAt === undefined || isPast(w, now)) {
    return null
  }
  const minutes = Math.floor((w.resetsAt - now) / 60_000)
  if (minutes >= 1440) {
    return `${Math.floor(minutes / 1440)}d`
  }
  if (minutes >= 60) {
    return `${Math.floor(minutes / 60)}h`
  }

  return `${Math.max(1, minutes)}m`
}

// The busiest window that hasn't reset since its reading, as a bare percentage.
function usagePeak(windows: UsageWindow[] | null, now: number): string {
  const live = (windows ?? []).filter(w => !isPast(w, now))
  if (live.length === 0) {
    return '—'
  }

  return `${Math.round(Math.max(...live.map(w => w.percent)))}%`
}

function usageValue(windows: UsageWindow[] | null, now: number): string {
  if (!windows || windows.length === 0) {
    return '—'
  }

  return windows
    .map(w => {
      const name = w.name === 'Weekly' ? 'wk' : w.name

      return isPast(w, now) ? `${name} —` : `${name} ${Math.round(w.percent)}%`
    })
    .join(' · ')
}

function inTime(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  if (days > 0) {
    return `${days}d${hours}h`
  }

  return hours > 0 ? `${hours}h${minutes % 60}m` : `${minutes}m`
}

// A reset under a day away as a clock time (`18h16`), else as a date (`Nov 4`),
// in the host's local time.
function resetAt(at: number, now: number, offsetMin: number): string {
  const local = new Date(at + offsetMin * 60_000)
  if (at - now < DAY_MS) {
    return `${local.getUTCHours()}h${String(local.getUTCMinutes()).padStart(2, '0')}`
  }

  return `${MONTHS[local.getUTCMonth()]} ${local.getUTCDate()}`
}

async function refreshTzOffset($: EngineInterface) {
  const run = await $.process.run(['date', '+%z'], { timeoutMs: 5_000 })
  const m = /^([+-])(\d{2})(\d{2})$/.exec(run.stdout.trim())
  if (run.exitCode !== 0 || !m) {
    return
  }
  const minutes = (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]))
  await update($, tzOffset, () => minutes)
}

// `✻ Claude usage` then one row per window in three fixed-width columns:
// `42%  5h  (resets 18h16)`. Widths in cells, so every surface lines them up.
const USAGE_INDENT = 1
const PERCENT_WIDTH = 6
const WINDOW_WIDTH = 8

type UsageBlock = { heading: string; color: string; note?: string; rows: [string, string, string][] }

// Least cells between the two models' detail columns.
const DETAIL_COLUMN_GAP = 3

function usageBlock(
  who: Who,
  windows: UsageWindow[] | null,
  now: number,
  offsetMin: number,
  seenAt?: number | null,
): UsageBlock {
  const stale = seenAt && now - seenAt > STALE_MS ? ` (last reading ${inTime(now - seenAt)} ago)` : ''
  const { icon, color } = NAMED[who]
  const heading = `${icon} ${who} usage${stale}`
  if (!windows || windows.length === 0) {
    return { heading, color, note: 'no usage data yet (shows after the first reply)', rows: [] }
  }

  return {
    heading,
    color,
    rows: windows.map(w => {
      const name = w.name === 'Weekly' ? 'weekly' : w.name
      if (isPast(w, now)) {
        return ['—', name, '(reset since last reading)']
      }
      const reset = w.resetsAt === undefined ? '' : `(resets ${resetAt(w.resetsAt, now, offsetMin)})`

      return [`${Math.round(w.percent)}%`, name, reset]
    }),
  }
}

function isUsageWindow(v: unknown): v is UsageWindow {
  const w = v as UsageWindow
  return typeof w === 'object' && w !== null && typeof w.name === 'string' && typeof w.percent === 'number'
}

async function saveClaudeUsage($: EngineInterface, limits: readonly { kind: string; percentUsed: number; resetsAt?: string }[]) {
  if (limits.length === 0) {
    return
  }
  const windows = claudeWindows(limits)
  const seenAt = await $.clock.now()
  await update($, claudeUsage, () => windows)
  await update($, claudeUsageSeenAt, () => seenAt)
  await $.store.set(STORE_CLAUDE_USAGE, { windows, seenAt })
}

async function loadClaudeUsage($: EngineInterface) {
  const stored = (await $.store.get(STORE_CLAUDE_USAGE)) as { windows?: unknown; seenAt?: unknown } | undefined
  if (!stored || !Array.isArray(stored.windows) || typeof stored.seenAt !== 'number') {
    return
  }
  const windows = stored.windows.filter(isUsageWindow)
  const seenAt = stored.seenAt
  await update($, claudeUsage, () => windows)
  await update($, claudeUsageSeenAt, () => seenAt)
}

function claudeWindows(limits: readonly { kind: string; percentUsed: number; resetsAt?: string }[]): UsageWindow[] {
  return limits.map(l => {
    const reset = l.resetsAt === undefined ? NaN : Date.parse(l.resetsAt)

    return {
      name: WINDOW_NAMES[l.kind] ?? l.kind,
      percent: l.percentUsed,
      resetsAt: Number.isNaN(reset) ? undefined : reset,
    }
  })
}

// 253800 → 254k, 1000000 → 1M.
function compact(tokens: number): string {
  return tokens >= 1_000_000 ? `${Number((tokens / 1_000_000).toFixed(1))}M` : `${Math.round(tokens / 1000)}k`
}

// The short line hovering a context ring shows.
function contextHover(tokens: number | undefined, window: number | undefined): string {
  return tokens === undefined || !window ? 'no reading yet' : `${compact(tokens)} / ${compact(window)} tokens`
}

function exact(tokens: number): string {
  return String(Math.round(tokens)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function short(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${+(tokens / 1_000_000).toFixed(1)}M`
  }

  return `${Math.round(tokens / 1000)}K`
}

function codexOk(x: CodexContext | null) {
  return x && !('error' in x) ? x : null
}

function claudeValue(c: ClaudeContext | null): string {
  return c ? `${c.percent ?? 0}%` : '—'
}

function codexValue(x: CodexContext | null): string {
  const ok = codexOk(x)

  // No thread in this session yet (or no reading): a dash and an empty ring, not 0%.
  return ok ? `${ok.percent}%` : '—'
}

function contextBlock(who: Who, line: string): ContextBlock {
  const { icon, color } = NAMED[who]

  return { heading: `${icon} ${who} context`, color, line }
}

function claudeDetails(c: ClaudeContext | null): ContextBlock {
  if (!c) {
    return contextBlock('Claude', 'no data yet')
  }
  const used = c.tokens === undefined ? 'no response yet' : `${exact(c.tokens)} / ${exact(c.window)} tokens`

  return contextBlock('Claude', `${c.model ?? '?'} · ${used}`)
}

function codexDetails(x: CodexContext | null): ContextBlock {
  const ok = codexOk(x)
  if (!ok) {
    return contextBlock('Codex', 'no Codex thread in this session yet')
  }

  return contextBlock('Codex', `${ok.model ?? '?'}, ${ok.effort ?? '?'} · ${exact(ok.tokens)} / ${exact(ok.window)} tokens`)
}

async function refreshClaude($: EngineInterface, context: { tokens?: number; window: number; percent?: number }) {
  const model = await $.session.model()
  const next: ClaudeContext = {
    model,
    tokens: context.tokens,
    window: context.window,
    percent: context.percent,
  }
  await update($, claude, () => next)
}

// The Codex scripts ship in the mod's own `scripts` folder.
const script = ($: EngineInterface, name: string) => `${$.plugin.root}/scripts/${name}`

async function refreshCodexUsage($: EngineInterface) {
  const run = await $.process.run(['python3', '-I', script($, 'usage-codex.py'), '--json'], {
    timeoutMs: 30_000,
  })
  if (run.exitCode !== 0) {
    return
  }
  const parsed = JSON.parse(run.stdout) as { windows?: UsageWindow[] }
  if (!Array.isArray(parsed.windows)) {
    return
  }
  const windows = parsed.windows
  await update($, codexUsage, () => windows)
}

// Claude's figures as Claude Code holds them now: context, and usage when it has a reading.
async function refreshClaudeNow($: EngineInterface) {
  const usage = await $.session.usage()
  await refreshClaude($, usage.context)
  await saveClaudeUsage($, usage.rateLimits)
}

// A button press: flip its details open or closed, and fetch fresh figures on open.
async function toggle($: EngineInterface, isOpen: boolean, flip: () => Promise<unknown>, refresh: () => Promise<unknown>) {
  await flip()
  if (!isOpen) {
    await refresh().catch(() => undefined)
  }
}

async function refreshCodex($: EngineInterface) {
  // Only Codex threads this Claude session started count: a new session starts at 0%.
  const session = await $.session.id()
  const run = await $.process.run(['python3', '-I', script($, 'context-codex.py'), '--json', '--session', session], {
    timeoutMs: 15_000,
  })
  if (run.exitCode !== 0) {
    return
  }
  const parsed = JSON.parse(run.stdout) as CodexContext & { running?: boolean }
  const { running, ...context } = parsed
  // Once the job is seen running, its "not running" is trusted: the grace is over.
  if (running === true) {
    codexStartedAt = -Infinity
  }
  const isStarting = (await $.clock.now()) - codexStartedAt < CODEX_START_GRACE_MS
  await update($, codex, () => context as CodexContext)
  await update($, codexBusy, () => running === true || isStarting)
}

// When Claude last started a Codex job (Bash) or a Codex subagent: epoch ms.
let codexStartedAt = -Infinity

async function markCodexStarting($: EngineInterface) {
  codexStartedAt = await $.clock.now()
  await update($, codexBusy, () => true)
}

export const register: Register = (on, options) => {
  const layout: BandLayout = options.layout === 'buttons' || options.layout === 'rings' ? options.layout : 'models'
  on('session.start', async ($, e, next) => {
    const started = await next(e)

    await $.command.register({
      name: PANE,
      description: 'Show Claude and Codex context usage in a pane',
    })
    $.clock.every(CODEX_REFRESH_MS, () => {
      void refreshCodex($).catch(() => undefined)
    })
    let ticks = 0
    $.clock.every(FRAME_MS, () => {
      void (async () => {
        const isBusy = (await read($, claudeBusy)) || (await read($, codexBusy))
        if (!isBusy) {
          return
        }
        ticks += 1
        await update($, frame, n => (n + 1) % 1000)
        if (ticks % BUSY_POLL_TICKS === 0) {
          await refreshCodex($)
        }
      })().catch(() => undefined)
    })
    $.clock.every(IMAGE_REFRESH_MS, () => {
      void update($, imageEpoch, n => (n + 1) % 1000).catch(() => undefined)
    })
    $.clock.every(MINUTE_MS, () => {
      void update($, minuteTick, n => (n + 1) % 1000).catch(() => undefined)
    })
    $.clock.every(CODEX_USAGE_REFRESH_MS, () => {
      void refreshCodexUsage($).catch(() => undefined)
    })
    await refreshTzOffset($).catch(() => undefined)
    const usage = await $.session.usage()
    await refreshClaude($, usage.context)
    if (usage.rateLimits.length > 0) {
      await saveClaudeUsage($, usage.rateLimits)
    } else {
      await loadClaudeUsage($)
    }
    await refreshCodex($).catch(() => undefined)
    void refreshCodexUsage($).catch(() => undefined)

    return started
  })

  // A Bash call that starts a Codex job through the plugin's companion script marks
  // Codex as working at once, without waiting for the next status check. Once the
  // call returns, a check settles it: still running for a background job, done for
  // a foreground one.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!STARTS_CODEX_JOB.test(String(e.command ?? ''))) {
      return next(e)
    }
    await markCodexStarting($)
    const result = await next(e)
    // A foreground job is over when its call returns: no grace to wait out.
    if (!/\s--background(\s|"|$)/.test(String(e.command ?? ''))) {
      codexStartedAt = -Infinity
    }
    void refreshCodex($).catch(() => undefined)

    return result
  })

  // A Codex subagent (`codex:codex-rescue`) starts its job from inside itself, so mark Codex
  // as working when it launches, not only when its Bash call is seen.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    if (!String(e.subagent_type ?? '').startsWith('codex:')) {
      return next(e)
    }
    await markCodexStarting($)
    const result = await next(e)
    void refreshCodex($).catch(() => undefined)

    return result
  })

  // Claude's own turns (not a subagent's) mark Claude as working.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      await update($, claudeBusy, () => true)
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      await update($, claudeBusy, () => false)
    }

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    void refreshTzOffset($).catch(() => undefined)
    await refreshClaude($, e.context)
    await saveClaudeUsage($, e.rateLimits)
    void refreshCodex($).catch(() => undefined)
    void refreshCodexUsage($).catch(() => undefined)

    return next(e)
  })

  on('command.run', { command: PANE }, async $ => {
    await refreshCodex($).catch(() => undefined)
    await refreshCodexUsage($).catch(() => undefined)
    await $.ui.open({ id: PANE, title: 'Context' })

    return { text: 'Context pane opened.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }
    const c = await read($, claude)
    const x = await read($, codex)
    const claudeOpen = await read($, isClaudeOpen)
    const codexOpen = await read($, isCodexOpen)
    const cu = await read($, claudeUsage)
    const xu = await read($, codexUsage)
    const claudeUsageOpen = await read($, isClaudeUsageOpen)
    const cuSeenAt = await read($, claudeUsageSeenAt)
    const codexUsageOpen = await read($, isCodexUsageOpen)
    const now = await $.clock.now()
    const offsetMin = (await read($, tzOffset)) ?? 0
    const contexts = [...(claudeOpen ? [claudeDetails(c)] : []), ...(codexOpen ? [codexDetails(x)] : [])]
    const blocks = [
      ...(claudeUsageOpen ? [usageBlock('Claude', cu, now, offsetMin, cuSeenAt)] : []),
      ...(codexUsageOpen ? [usageBlock('Codex', xu, now, offsetMin)] : []),
    ]
    const { Box, Button, Text } = $.ui.resolve(e)
    const elements = $.ui.resolve(e) as Partial<Pick<Elements['desktop'], 'Svg'>>
    const Svg = ROW_ICON_STYLE === 'ring' && e.surface !== 'terminal' ? elements.Svg : undefined
    const epoch = e.surface === 'vscode' ? await read($, imageEpoch) : undefined
    await read($, minuteTick)
    // The icon before a button: a ring of its percentage where the surface draws Svg, else the glyph.
    const rowIcon = (who: Who, what: string, label: string) => {
      const { icon, color } = NAMED[who]
      if (!Svg) {
        return <Text color={color}>{icon}</Text>
      }
      const percent = labelPercent(label)

      const logo = RING_LOGO ? (who === 'Claude' ? CLAUDE_LOGO : CODEX_LOGO) : undefined

      return <Svg source={ringSvg(percent, color, logo, MIRROR_CODEX && who === 'Codex', epoch)} alt={percentAlt(percent)} width={RING_SIZE} height={RING_SIZE} />
    }
    const iconWidth = Svg ? RING_SLOT_WIDTH : ICON_WIDTH
    const claudeColumn = CLAUDE_COLUMN + iconWidth - ICON_WIDTH
    // Hovering a ring lights its scope, which reveals that ring's line in the row's empty space.
    const hovers = RING_HOVER && Svg
    const scopeOf = (name: string) => `ring-${name}`
    const slotHover = (name: string) => (hovers ? { scope: scopeOf(name) } : undefined)
    const hoverLine = (name: string, text: string) =>
      hovers ? (
        <Box key={`hover-${name}`} position="absolute" left={1} right={0} top={0} bottom={0} alignItems="center" display="none" hover={{ scope: scopeOf(name), display: 'flex' }}>
          <Text dimColor wrap="truncate-end">{text}</Text>
        </Box>
      ) : null
    const xc = codexOk(x)
    // A detail's heading, with its bar or ring after it when one is given.
    const heading = (text: string, color: string, after?: RenderChildren) =>
      after ? (
        <Box gap={1} alignItems="center">
          <Text color={color}>{text}</Text>
          {after}
        </Box>
      ) : (
        <Text color={color}>{text}</Text>
      )
    const drawContext = (b: ContextBlock, after?: RenderChildren) => (
      <Box flexDirection="column">
        {heading(b.heading, b.color, after)}
        <Box paddingLeft={USAGE_INDENT}>
          <Text dimColor>{b.line}</Text>
        </Box>
      </Box>
    )
    const drawUsage = (b: UsageBlock, after?: RenderChildren) => (
      <Box flexDirection="column">
        {heading(b.heading, b.color, after)}
        {b.note && (
          <Box paddingLeft={USAGE_INDENT}>
            <Text dimColor>{b.note}</Text>
          </Box>
        )}
        {b.rows.map(([pct, name, reset]) => (
          <Box paddingLeft={USAGE_INDENT}>
            <Box width={PERCENT_WIDTH}>
              <Text dimColor>{pct}</Text>
            </Box>
            <Box width={WINDOW_WIDTH}>
              <Text dimColor>{name}</Text>
            </Box>
            <Text dimColor>{reset}</Text>
          </Box>
        ))}
      </Box>
    )

    // The desktop draws native buttons taller than a line: a line between rows keeps them apart.
    const rowGap = e.surface === 'desktop' ? 1 : 0
    // Between expanded sections (models layout): none, on every surface.
    const detailGap = 0
    const isClaudeBusy = e.props.isWorking || (await read($, claudeBusy))
    const isCodexBusy = await read($, codexBusy)
    const n = await read($, frame)
    // The row icons stay still; each row's right-end indicator animates while its model works.
    const claudeSpinner = claudeIcon(true, n)
    const codexSpinner = codexIcon(true, n)
    const claudeIndicator = (
      <Box width={SPINNER_WIDTH} justifyContent="center">
        {isClaudeBusy ? <Text bold color={CLAUDE_COLOR}>{claudeSpinner}</Text> : <Text color={IDLE_COLOR}>{CLAUDE_ICON}</Text>}
      </Box>
    )
    const codexIndicator = (
      <Box width={SPINNER_WIDTH} justifyContent="center">
        {isCodexBusy ? <Text bold color={CODEX_COLOR}>{codexSpinner}</Text> : <Text color={IDLE_COLOR}>{CODEX_ICON}</Text>}
      </Box>
    )
    const refreshCodexUsageNow = async () => {
      await refreshTzOffset($)
      await refreshCodexUsage($)
    }

    // A model's context or usage mark: a bar or a ring where the surface draws Svg, else `✻ 25%`.
    // `ringSlot`: the cells a ring takes; the rings layout widens it to line rings up under bars.
    const mark = (who: Who, what: string, label: string, ringSlot = MARK_SLOT_WIDTH) => {
      const { icon, color } = NAMED[who]

      if (Svg && what === 'context' && CONTEXT_STYLE === 'bar') {
        const percent = labelPercent(label)

        return (
          <Box width={MARK_SLOT_WIDTH} justifyContent="center" alignItems="center">
            <Svg source={barSvg(percent, color, MIRROR_CODEX && who === 'Codex', epoch)} alt={percentAlt(percent)} width={BAR_WIDTH} height={BAR_HEIGHT} />
          </Box>
        )
      }

      return Svg ? (
        <Box width={ringSlot} justifyContent="center" alignItems="center">
          {rowIcon(who, what, label)}
        </Box>
      ) : (
        <Text color={color}>{`${icon} ${label}`}</Text>
      )
    }

    // A model's usage as its 5h and 1w rings side by side, where the surface draws Svg;
    // else its busiest window as text, like the other marks.
    // The rings and the bar take their own width, with no slot around them, so the one gap
    // of the Box holding them is the only space between them: ring to ring, ring to bar.
    // `mirrored`: Codex's side of the main row runs 1w then 5h; everywhere else, 5h then 1w.
    const usageRingNodes = (who: Who, windows: UsageWindow[] | null, mirrored = false) => {
      const { icon, color } = NAMED[who]
      if (!Svg) {
        return [<Text color={color}>{`${icon} ${usagePeak(windows, now)}`}</Text>]
      }

      return (mirrored ? [...USAGE_RINGS].reverse() : USAGE_RINGS).map(({ name, label: windowLabel, stroke }) => {
        const percent = windowPercent(windows, name, now)
        // The time to its reset; with no reading, the window's own name.
        const label = resetIn(windows, name, now) ?? windowLabel

        return (
          <Svg
            source={ringSvg(percent, color, undefined, MIRROR_CODEX && who === 'Codex', epoch, label, USAGE_RING_SIZE, stroke)}
            alt={percentAlt(percent)}
            width={USAGE_RING_SIZE}
            height={USAGE_RING_SIZE}
          />
        )
      })
    }
    const usageRings = (who: Who, windows: UsageWindow[] | null) => (
      <Box gap={MARK_GAP} alignItems="center">
        {usageRingNodes(who, windows)}
      </Box>
    )
    const contextBar = (who: Who, label: string) => {
      const { icon, color } = NAMED[who]
      if (!Svg) {
        return <Text color={color}>{`${icon} ${label}`}</Text>
      }
      const percent = labelPercent(label)

      return <Svg source={barSvg(percent, color, MIRROR_CODEX && who === 'Codex', epoch, BAR_PAD)} alt={percentAlt(percent)} width={BAR_WIDTH + 2 * BAR_PAD} height={BAR_HEIGHT} />
    }

    if (layout === 'models') {
      // One mirrored row: Claude's thinking indicator, usage and context at the left; the
      // `+` button centered; Codex's context, usage and thinking indicator at the right.
      // `+` opens every detail above the row; it reads `-` while any is open and closes them all.
      const isAnyOpen = claudeOpen || codexOpen || claudeUsageOpen || codexUsageOpen

      // Details by model; each heading repeats its bar or ring after it.
      const claudeContextBlock = claudeDetails(c)
      const claudeUsageBlock = usageBlock('Claude', cu, now, offsetMin, cuSeenAt)
      const codexContextBlock = codexDetails(x)
      const codexUsageBlock = usageBlock('Codex', xu, now, offsetMin)
      const claudeContext = claudeOpen ? drawContext(claudeContextBlock, Svg && mark('Claude', 'context', claudeValue(c))) : null
      const claudeUsage = claudeUsageOpen ? drawUsage(claudeUsageBlock, Svg && usageRings('Claude', cu)) : null
      const codexContext = codexOpen ? drawContext(codexContextBlock, Svg && mark('Codex', 'context', codexValue(x))) : null
      const codexUsage = codexUsageOpen ? drawUsage(codexUsageBlock, Svg && usageRings('Codex', xu)) : null

      // A column per model, in a row that wraps: where both fit, Claude's on the left and Codex's
      // on the right, so the contexts line up and the usages line up (a context is always two
      // lines). Narrower, Codex's column wraps below Claude's. Each column keeps its text's own
      // width (no shrinking), so the wrap follows the surface's font rather than a cell count.
      // Claude's is at least half the band, so Codex's starts in the middle; its right padding
      // is the gap when Claude's text is wider than that.
      const setAll = async (open: boolean) => {
        await update($, isClaudeOpen, () => open)
        await update($, isClaudeUsageOpen, () => open)
        await update($, isCodexOpen, () => open)
        await update($, isCodexUsageOpen, () => open)
      }

      return (
        <Box flexDirection="column" rowGap={rowGap}>
          {/* Details by model: Claude's context and usage, then Codex's. */}
          {/* Each heading repeats its bar or ring after it; the terminal's numbers are in the details. */}
          {/* The sections sit closer together than the full line that keeps the row's button apart. */}
          {isAnyOpen ? (
            <Box flexWrap="wrap" rowGap={detailGap}>
              <Box flexDirection="column" flexShrink={0} minWidth="50%" paddingRight={DETAIL_COLUMN_GAP} rowGap={detailGap}>
                {claudeContext}
                {claudeUsage}
              </Box>
              <Box flexDirection="column" flexShrink={0} rowGap={detailGap}>
                {codexContext}
                {codexUsage}
              </Box>
            </Box>
          ) : null}
          <Box gap={1} alignItems="center">
            {claudeIndicator}
            <Box gap={MARK_GAP} alignItems="center">
              {usageRingNodes('Claude', cu)}
              {contextBar('Claude', claudeValue(c))}
            </Box>
            <Box flexGrow={1} />
            <Button key="expand" label={isAnyOpen ? '-' : '+'} onPress={() =>
                toggle($, isAnyOpen, () => setAll(!isAnyOpen), () => Promise.all([refreshClaudeNow($), refreshCodex($), refreshCodexUsageNow()]))
              } />
            <Box flexGrow={1} />
            <Box gap={MARK_GAP} alignItems="center">
              {contextBar('Codex', codexValue(x))}
              {usageRingNodes('Codex', xu, true)}
            </Box>
            {codexIndicator}
          </Box>
        </Box>
      )
    }

    if (layout === 'rings') {
      // One button per row opens (or closes) both models' details, drawn under that row;
      // the rings carry the numbers.
      const isContextOpen = claudeOpen || codexOpen
      const isUsageOpen = claudeUsageOpen || codexUsageOpen

      return (
        <Box flexDirection="column" rowGap={rowGap}>
          <Box gap={1}>
            <Box width={ROW_BUTTON_WIDTH}>
              <Button key="context" label="Context" onPress={() =>
                  toggle($, isContextOpen, async () => {
                    await update($, isClaudeOpen, () => !isContextOpen)
                    await update($, isCodexOpen, () => !isContextOpen)
                  }, () => Promise.all([refreshClaudeNow($), refreshCodex($)]))
                } />
            </Box>
            {mark('Claude', 'context', claudeValue(c))}
            {mark('Codex', 'context', codexValue(x))}
            <Box flexGrow={1} />
            {claudeIndicator}
          </Box>
          {contexts.map(drawContext)}
          <Box gap={1}>
            <Box width={ROW_BUTTON_WIDTH}>
              <Button key="usage" label="Usage" onPress={() =>
                  toggle($, isUsageOpen, async () => {
                    await update($, isClaudeUsageOpen, () => !isUsageOpen)
                    await update($, isCodexUsageOpen, () => !isUsageOpen)
                  }, () => Promise.all([refreshClaudeNow($), refreshCodexUsageNow()]))
                } />
            </Box>
            {mark('Claude', 'usage', usagePeak(cu, now))}
            {mark('Codex', 'usage', usagePeak(xu, now))}
            <Box flexGrow={1} />
            {codexIndicator}
          </Box>
          {blocks.map(drawUsage)}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" rowGap={rowGap}>
        <Box gap={1}>
          <Box width={LABEL_WIDTH}>
            <Text dimColor>Context:</Text>
          </Box>
          <Box gap={1} width={claudeColumn}>
            <Box width={iconWidth} justifyContent="center" hover={slotHover('claude-context')}>
              {rowIcon('Claude', 'context', claudeValue(c))}
            </Box>
            <Button key="claude" label={claudeValue(c)} onPress={() => toggle($, claudeOpen, () => update($, isClaudeOpen, v => !v), () => refreshClaudeNow($))} />
          </Box>
          <Box gap={1}>
            <Box width={iconWidth} justifyContent="center" hover={slotHover('codex-context')}>
              {rowIcon('Codex', 'context', codexValue(x))}
            </Box>
            <Button key="codex" label={codexValue(x)} onPress={() => toggle($, codexOpen, () => update($, isCodexOpen, v => !v), () => refreshCodex($))} />
          </Box>
          <Box flexGrow={1}>
            {hoverLine('claude-context', contextHover(c?.tokens, c?.window))}
            {hoverLine('codex-context', xc ? contextHover(xc.tokens, xc.window) : 'no Codex thread yet')}
          </Box>
          <Box width={SPINNER_WIDTH} justifyContent="center">
            {isClaudeBusy ? <Text bold color={CLAUDE_COLOR}>{claudeSpinner}</Text> : <Text color={IDLE_COLOR}>{CLAUDE_ICON}</Text>}
          </Box>
        </Box>
        <Box gap={1}>
          <Box width={LABEL_WIDTH}>
            <Text dimColor>Usage:</Text>
          </Box>
          <Box gap={1} width={claudeColumn}>
            <Box width={iconWidth} justifyContent="center" hover={slotHover('claude-usage')}>
              {rowIcon('Claude', 'usage', usagePeak(cu, now))}
            </Box>
            <Button key="claude-usage" label={usagePeak(cu, now)} onPress={() => toggle($, claudeUsageOpen, () => update($, isClaudeUsageOpen, v => !v), () => refreshClaudeNow($))} />
          </Box>
          <Box gap={1}>
            <Box width={iconWidth} justifyContent="center" hover={slotHover('codex-usage')}>
              {rowIcon('Codex', 'usage', usagePeak(xu, now))}
            </Box>
            <Button key="codex-usage" label={usagePeak(xu, now)} onPress={() =>
                toggle($, codexUsageOpen, () => update($, isCodexUsageOpen, v => !v), async () => {
                  await refreshTzOffset($)
                  await refreshCodexUsage($)
                })
              } />
          </Box>
          <Box flexGrow={1}>
            {hoverLine('claude-usage', usageValue(cu, now))}
            {hoverLine('codex-usage', usageValue(xu, now))}
          </Box>
          <Box width={SPINNER_WIDTH} justifyContent="center">
            {isCodexBusy ? <Text bold color={CODEX_COLOR}>{codexSpinner}</Text> : <Text color={IDLE_COLOR}>{CODEX_ICON}</Text>}
          </Box>
        </Box>
        {contexts.map(drawContext)}
        {blocks.map(drawUsage)}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const c = await read($, claude)
    const x = await read($, codex)
    const cu = await read($, claudeUsage)
    const xu = await read($, codexUsage)
    const now = await $.clock.now()
    const offsetMin = (await read($, tzOffset)) ?? 0
    const { Box, Text } = $.ui.resolve(e)
    const drawContext = (b: ContextBlock) => (
      <Box flexDirection="column">
        <Text color={b.color}>{b.heading}</Text>
        <Box paddingLeft={USAGE_INDENT}>
          <Text dimColor>{b.line}</Text>
        </Box>
      </Box>
    )
    const drawUsage = (b: UsageBlock) => (
      <Box flexDirection="column">
        <Text color={b.color}>{b.heading}</Text>
        {b.note && (
          <Box paddingLeft={USAGE_INDENT}>
            <Text dimColor>{b.note}</Text>
          </Box>
        )}
        {b.rows.map(([pct, name, reset]) => (
          <Box paddingLeft={USAGE_INDENT}>
            <Box width={PERCENT_WIDTH}>
              <Text dimColor>{pct}</Text>
            </Box>
            <Box width={WINDOW_WIDTH}>
              <Text dimColor>{name}</Text>
            </Box>
            <Text dimColor>{reset}</Text>
          </Box>
        ))}
      </Box>
    )

    return (
      <Box flexDirection="column">
        <Text>
          Context: <Text color={CLAUDE_COLOR}>{CLAUDE_ICON}</Text> Claude {claudeValue(c)} · <Text color={CODEX_COLOR}>{CODEX_ICON}</Text> Codex {codexValue(x)}
        </Text>
        {[claudeDetails(c), codexDetails(x)].map(drawContext)}
        <Text>
          Usage: <Text color={CLAUDE_COLOR}>{CLAUDE_ICON}</Text> Claude {usageValue(cu, now)} · <Text color={CODEX_COLOR}>{CODEX_ICON}</Text> Codex {usageValue(xu, now)}
        </Text>
        {drawUsage(usageBlock('Claude', cu, now, offsetMin, await read($, claudeUsageSeenAt)))}
        {drawUsage(usageBlock('Codex', xu, now, offsetMin))}
      </Box>
    )
  })
}
