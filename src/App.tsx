import { Fragment, useEffect, useRef, useState } from 'react'
import {
  BrowserRouter,
  Link,
  Navigate,
  Route,
  Routes,
  useNavigate,
  useParams,
} from 'react-router-dom'
import './App.css'
import {
  buildTournamentBracket,
  type BracketMatch,
  type BracketRound,
} from './tournament'
import { subscribeToPwaUpdates } from './pwa'
import {
  TOURNAMENT_STORAGE_KEY,
  DEFAULT_MATCH_DURATION_SECONDS,
  cloneSingles,
  cloneTeams,
  createEmptyTournamentDraft,
  createSoloEntry,
  createTeamEntry,
  createTeamMember,
  createTournamentRecord,
  type SoloEntry,
  type TeamEntry,
  type TeamMember,
  type TournamentDraft,
  type TournamentRecord,
  type ScoreAwardAmount,
  type ScoreEvent,
  type ScoreSide,
  type MatchScore,
  type MatchTimerState,
  toTournamentEntrants,
} from './app-model'

const DOC_SCREENSHOTS = {
  home: new URL('../docs/screenshots/01-home.png', import.meta.url).href,
  basics: new URL('../docs/screenshots/02-basics.png', import.meta.url).href,
  entrants: new URL('../docs/screenshots/03-entrants.png', import.meta.url).href,
  review: new URL('../docs/screenshots/04-review.png', import.meta.url).href,
  bracket: new URL('../docs/screenshots/05-live-bracket.png', import.meta.url).href,
  scoring: new URL('../docs/screenshots/06-score-match.png', import.meta.url).href,
  graph: new URL('../docs/screenshots/07-bracket-graph.png', import.meta.url).href,
  saved: new URL('../docs/screenshots/08-home-active.png', import.meta.url).href,
} as const

const DOC_STEPS = [
  {
    id: 'open-desk',
    title: 'Open the tournament desk',
    body: 'Start on the tournament desk. Saved tournaments are grouped into Active, Queued, and Archived tabs.',
    bullets: [
      'Active tournaments have at least one result but no champion yet.',
      'Queued tournaments are created but not started.',
      'Archived tournaments already have a champion.',
    ],
    image: DOC_SCREENSHOTS.home,
    alt: 'Tournament desk home screen',
  },
  {
    id: 'basics',
    title: 'Enter tournament basics',
    body: 'Create a new tournament, then set the name, event type, knockout format, and match time.',
    bullets: [
      'Use Single tournament for individual kendoka.',
      'Use Team tournament for team shiai.',
      'Match time accepts seconds or m:ss format.',
    ],
    image: DOC_SCREENSHOTS.basics,
    alt: 'Tournament basics setup step',
  },
  {
    id: 'entrants',
    title: 'Add entrants',
    body: 'Add competitors for a single tournament, or add teams and team members for a team tournament.',
    bullets: [
      'Use Add competitor or Add team when you need more rows.',
      'Use Remove to delete a row before the bracket starts.',
      'Team member order becomes the roster order used for bout lineups.',
    ],
    image: DOC_SCREENSHOTS.entrants,
    alt: 'Entrants step with sample competitors',
  },
  {
    id: 'review',
    title: 'Review and create',
    body: 'Check the summary before saving. The review step shows the tournament name, type, format, entrant count, and entrant list.',
    bullets: [
      'You need at least two entrants before creating a tournament.',
      'Select Create tournament to save the bracket and open the workbench.',
    ],
    image: DOC_SCREENSHOTS.review,
    alt: 'Review tournament setup step',
  },
  {
    id: 'run-bracket',
    title: 'Run the live bracket',
    body: 'The tournament workbench shows the next bout, bracket controls, match cards, timers, and scoring controls.',
    bullets: [
      'The next pending match is highlighted.',
      'Start a match timer before adding scores.',
      'Use settings before the bracket starts if you need to adjust entrants or format.',
    ],
    image: DOC_SCREENSHOTS.bracket,
    alt: 'Live bracket workbench',
  },
  {
    id: 'score',
    title: 'Score matches',
    body: 'Use each match card to run time and award points. When a result is decided, the winner advances automatically.',
    bullets: [
      'Use +1 or +1/2 to award points.',
      'Use undo to remove the last score event for that side.',
      'Locked-in matches can be reset with the match reset control.',
    ],
    image: DOC_SCREENSHOTS.scoring,
    alt: 'Scored match and bracket advancement',
  },
  {
    id: 'graph',
    title: 'View the bracket graph',
    body: 'Open the bracket graph from the top-right controls for a compact overview of the bracket.',
    bullets: [
      'The graph shows match codes, current entrants, and pending matches.',
      'Select a match in the graph to jump back to that match card.',
    ],
    image: DOC_SCREENSHOTS.graph,
    alt: 'Bracket graph overview',
  },
  {
    id: 'saved',
    title: 'Return to saved tournaments',
    body: 'Use the back button to return to the tournament desk. Tournaments stay saved in the same browser through local storage.',
    bullets: [
      'Select a tournament card to reopen it.',
      'Use the delete control on a card to remove it from local storage.',
    ],
    image: DOC_SCREENSHOTS.saved,
    alt: 'Tournament desk with a saved active tournament',
  },
] as const

function getNextPendingMatch(rounds: BracketRound[]): BracketMatch | null {
  for (const round of rounds) {
    for (const match of round.matches) {
      if (!match.isComplete && match.options.length > 1) {
        return match
      }
    }
  }

  return null
}

// ── team match scoring helpers ──────────────────────────────────────

// Traditional kendo team position names, keyed by team size then index.
const KENDO_POSITIONS: Record<number, string[]> = {
  3: ['先鋒', '中堅', '大将'],
  5: ['先鋒', '次鋒', '中堅', '副将', '大将'],
  7: ['先鋒', '次鋒', '中堅', '副将', '五将', '六将', '大将'],
}

function getKendoPosition(index: number, total: number): string {
  return KENDO_POSITIONS[total]?.[index] ?? `#${index + 1}`
}

function getTournamentKindKanji(kind: TournamentRecord['kind']): string {
  return kind === 'single' ? '個人戦' : '団体戦'
}

function getTournamentFormatKanji(format: TournamentRecord['format']): string {
  return format === 'single' ? '勝抜戦' : '敗者復活'
}

function getMatchStageKanji(stage: BracketMatch['stage']): string {
  switch (stage) {
    case 'losers':
      return '敗'
    case 'final':
    case 'reset':
      return '決'
    case 'winners':
    default:
      return '勝'
  }
}

function getMatchStateMeta(match: BracketMatch, isProgressing: boolean) {
  if (match.isComplete) {
    return {
      className: 'is-complete',
      label: match.isAutoAdvance ? 'Auto-advanced' : 'Locked in',
    }
  }

  if (isProgressing) {
    return {
      className: 'is-progressing',
      label: 'Progressing',
    }
  }

  return {
    className: 'is-pending',
    label: 'Pending',
  }
}

function scrollMatchCardIntoView(matchCard: HTMLElement) {
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const behavior: ScrollBehavior = prefersReducedMotion ? 'auto' : 'smooth'
  const stickyStack = document.querySelector<HTMLElement>('.workbench-sticky-stack')
  const headerOffset = (stickyStack?.getBoundingClientRect().height ?? 0) + 24
  const cardRect = matchCard.getBoundingClientRect()
  window.scrollTo({
    top: Math.max(0, window.scrollY + cardRect.top - headerOffset),
    behavior,
  })
}

function scrollToNextBoutCard() {
  const nextMatchCard = document.querySelector<HTMLElement>('.match-card.is-next-bout')
  if (!nextMatchCard) return
  scrollMatchCardIntoView(nextMatchCard)
}

function scrollToMatchCard(matchId: string) {
  const matchCard = document.querySelector<HTMLElement>(`.match-card[data-match-id="${matchId}"]`)
  if (!matchCard) return

  scrollMatchCardIntoView(matchCard)
  matchCard.classList.remove('is-graph-jump-target')
  window.setTimeout(() => {
    matchCard.classList.add('is-graph-jump-target')
    window.setTimeout(() => matchCard.classList.remove('is-graph-jump-target'), 1400)
  }, 80)
}

function getBoutKey(matchId: string, boutIndex: number): string {
  return `${matchId}:bout:${boutIndex}`
}

function getTimerRemainingMs(timer: MatchTimerState | undefined, durationSeconds: number): number {
  if (!timer) return durationSeconds * 1000
  if (timer.runningSince == null) return Math.max(0, timer.remainingMs)
  return Math.max(0, timer.remainingMs - (Date.now() - timer.runningSince))
}

function stopTimerState(
  timer: MatchTimerState | undefined,
  now = Date.now(),
): MatchTimerState | undefined {
  if (!timer || timer.runningSince == null) return timer
  return {
    ...timer,
    remainingMs: Math.max(0, timer.remainingMs - (now - timer.runningSince)),
    runningSince: null,
  }
}

function stopTimerInMap(
  timers: Record<string, MatchTimerState> | undefined,
  key: string,
  now = Date.now(),
): Record<string, MatchTimerState> {
  const currentTimers = timers ?? {}
  const stopped = stopTimerState(currentTimers[key], now)
  if (!stopped || stopped === currentTimers[key]) return currentTimers
  return { ...currentTimers, [key]: stopped }
}

function stopMatchTimers(
  timers: Record<string, MatchTimerState> | undefined,
  matchId: string,
  now = Date.now(),
): Record<string, MatchTimerState> {
  const currentTimers = timers ?? {}
  let nextTimers = currentTimers

  for (const [key, timer] of Object.entries(currentTimers)) {
    if (key !== matchId && !key.startsWith(`${matchId}:bout:`)) continue
    const stopped = stopTimerState(timer, now)
    if (!stopped || stopped === timer) continue
    if (nextTimers === currentTimers) nextTimers = { ...currentTimers }
    nextTimers[key] = stopped
  }

  return nextTimers
}

function isTimerExpired(timer: MatchTimerState | undefined, durationSeconds: number): boolean {
  if (!timer) return false
  return getTimerRemainingMs(timer, durationSeconds) <= 0
}

function isEnchoTimer(timer: MatchTimerState | undefined): boolean {
  return timer?.phase === 'encho'
}

function hasMatchTimerStarted(
  matchId: string,
  timers: Record<string, MatchTimerState> | undefined,
  kind: TournamentRecord['kind'],
): boolean {
  if (kind === 'single') return Boolean(timers?.[matchId])
  return Object.keys(timers ?? {}).some((key) => key.startsWith(`${matchId}:bout:`))
}

function formatTimerMs(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

function parseDurationInput(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  if (trimmed.includes(':')) {
    const [mStr, sStr] = trimmed.split(':')
    const m = Number(mStr)
    const s = Number(sStr ?? '0')
    if (!Number.isFinite(m) || !Number.isFinite(s) || m < 0 || s < 0 || s >= 60) return null
    return Math.round(m * 60 + s)
  }
  const n = Number(trimmed)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.round(n)
}

// Resolves the ordered member list for one team in a specific match.
// Uses the per-match saved order if present; falls back to the global roster.
// Any members added to the roster after the lineup was saved are appended.
function resolveMatchLineup(team: TeamEntry | undefined, savedOrder: string[] | undefined): TeamMember[] {
  if (!team) return []
  if (!savedOrder || savedOrder.length === 0) return team.members
  const memberMap = new Map(team.members.map((m) => [m.id, m]))
  const ordered = savedOrder.flatMap((id) => {
    const m = memberMap.get(id)
    return m ? [m] : []
  })
  const orderedIds = new Set(savedOrder)
  const extras = team.members.filter((m) => !orderedIds.has(m.id))
  return [...ordered, ...extras]
}

function isBoutScoreDecided(score: MatchScore | undefined): boolean {
  return !!score && (score.left >= 2 || score.right >= 2)
}

function getScoreLeader(score: MatchScore | undefined): ScoreSide | null {
  if (!score) return null
  if (score.left > score.right) return 'left'
  if (score.right > score.left) return 'right'
  return null
}

function isTeamBoutComplete(
  score: MatchScore | undefined,
  timer: MatchTimerState | undefined,
  durationSeconds: number,
): boolean {
  return isBoutScoreDecided(score) || isTimerExpired(timer, durationSeconds)
}

function getBoutMatchInfo(key: string): { matchId: string; boutIndex: number } | null {
  const marker = ':bout:'
  const markerIndex = key.lastIndexOf(marker)
  if (markerIndex < 0) return null
  const matchId = key.slice(0, markerIndex)
  const boutIndex = Number(key.slice(markerIndex + marker.length))
  if (!matchId || !Number.isInteger(boutIndex) || boutIndex < 0) return null
  return { matchId, boutIndex }
}

function computeTeamStats(
  boutScores: Array<MatchScore | undefined>,
  boutsTotal: number,
  completedBouts?: boolean[],
) {
  let leftWins = 0
  let rightWins = 0
  let leftTotal = 0
  let rightTotal = 0
  let finishedBouts = 0

  for (let index = 0; index < boutsTotal; index += 1) {
    const score = boutScores[index]
    const boutFinished = completedBouts?.[index] ?? isBoutScoreDecided(score)

    if (score) {
      leftTotal += score.left
      rightTotal += score.right
    }

    if (boutFinished) {
      finishedBouts++
    }

    if (boutFinished) {
      const scoreLeader = getScoreLeader(score)
      if (scoreLeader === 'left') leftWins++
      else if (scoreLeader === 'right') rightWins++
    }
  }

  const pendingBouts = Math.max(0, boutsTotal - finishedBouts)
  let teamWinner: 'left' | 'right' | null = null

  if (pendingBouts > 0) {
    teamWinner = null
  } else if (leftWins > rightWins) {
    teamWinner = 'left'
  } else if (rightWins > leftWins) {
    teamWinner = 'right'
  } else if (leftWins === rightWins) {
    // All bouts finished and team score is tied — use ippon tally as tiebreaker
    if (leftTotal > rightTotal) teamWinner = 'left'
    else if (rightTotal > leftTotal) teamWinner = 'right'
    // else perfect tie — no auto-winner
  }

  return { leftWins, rightWins, leftTotal, rightTotal, finishedBouts, pendingBouts, teamWinner }
}

function getNextBoutStripInfo(tournament: TournamentRecord, match: BracketMatch) {
  if (tournament.kind !== 'team') {
    return {
      left: match.left.label,
      right: match.right.label,
      position: null as string | null,
      detail: null as string | null,
    }
  }

  const leftTeam = tournament.teams.find((team) => team.id === match.left.entrant?.id)
  const rightTeam = tournament.teams.find((team) => team.id === match.right.entrant?.id)
  const lineup = tournament.lineups?.[match.id]
  const leftMembers = resolveMatchLineup(leftTeam, lineup?.left)
  const rightMembers = resolveMatchLineup(rightTeam, lineup?.right)
  const boutsTotal = Math.min(leftMembers.length, rightMembers.length)

  if (boutsTotal === 0) {
    return {
      left: match.left.label,
      right: match.right.label,
      position: null,
      detail: null,
    }
  }

  const durationSeconds = tournament.matchDurationSeconds ?? DEFAULT_MATCH_DURATION_SECONDS
  const nextBoutIndex = Array.from({ length: boutsTotal }, (_, index) => index).find((index) => {
    const boutKey = getBoutKey(match.id, index)
    return !isTeamBoutComplete(tournament.scores?.[boutKey], tournament.timers?.[boutKey], durationSeconds)
  })

  if (nextBoutIndex == null) {
    return {
      left: match.left.label,
      right: match.right.label,
      position: '判定',
      detail: 'Declare match winner',
    }
  }

  return {
    left: leftMembers[nextBoutIndex]?.name.trim() || 'Open slot',
    right: rightMembers[nextBoutIndex]?.name.trim() || 'Open slot',
    position: getKendoPosition(nextBoutIndex, boutsTotal),
    detail: `${match.left.label} 対 ${match.right.label}`,
  }
}

function getTournamentMatchPairing(tournament: TournamentRecord, match: BracketMatch): string {
  const info = getNextBoutStripInfo(tournament, match)
  const position = info.position ? `${info.position} ` : ''
  return `${position}${info.left} 対 ${info.right}`
}

function ScoreboardClock({
  timer,
  durationSeconds,
}: {
  timer: MatchTimerState | undefined
  durationSeconds: number
}) {
  const [, setTick] = useState(0)
  const isRunning = timer?.runningSince != null
  useEffect(() => {
    if (!isRunning) return
    const id = window.setInterval(() => setTick((n) => n + 1), 250)
    return () => window.clearInterval(id)
  }, [isRunning])
  const remaining = getTimerRemainingMs(timer, durationSeconds)
  const expired = remaining <= 0 && timer != null
  const isEncho = isEnchoTimer(timer)
  return (
    <span className={`scoreboard-clock${isRunning ? ' is-running' : ''}${expired ? ' is-expired' : ''}`}>
      {isEncho ? <span className="scoreboard-clock-phase">延長</span> : null}
      {formatTimerMs(remaining)}
    </span>
  )
}

function DurationField({
  seconds,
  onChange,
  label = 'Match time',
  disabled = false,
}: {
  seconds: number
  onChange: (seconds: number) => void
  label?: string
  disabled?: boolean
}) {
  const [draftText, setDraftText] = useState(() => ({
    seconds,
    value: formatTimerMs(seconds * 1000),
  }))
  const text = draftText.seconds === seconds ? draftText.value : formatTimerMs(seconds * 1000)

  return (
    <label className={`field-block duration-field${disabled ? ' is-disabled' : ''}`}>
      <span>{label}</span>
      <input
        type="text"
        inputMode="numeric"
        value={text}
        disabled={disabled}
        onChange={(e) => setDraftText({ seconds, value: e.target.value })}
        onBlur={() => {
          const next = parseDurationInput(text)
          if (next == null || next < 1) {
            setDraftText({ seconds, value: formatTimerMs(seconds * 1000) })
          } else {
            onChange(next)
            setDraftText({ seconds, value: formatTimerMs(next * 1000) })
          }
        }}
        placeholder="2:00"
      />
      <small className="field-hint">
        {disabled ? 'Locked once the tournament has started.' : 'Format m:ss (e.g. 2:00). Default 2:00.'}
      </small>
    </label>
  )
}

function fmtScore(n: number) {
  return n % 1 === 0 ? String(n) : n.toFixed(1)
}

function getFallbackUndoAmount(score: number): ScoreAwardAmount | null {
  if (score <= 0) return null
  return score % 1 === 0.5 ? 0.5 : 1
}

function getUndoAmount(
  events: Record<string, ScoreEvent[]> | undefined,
  scoreKey: string,
  side: ScoreSide,
  score: number,
): ScoreAwardAmount | null {
  const scoreEvents = events?.[scoreKey] ?? []
  for (let index = scoreEvents.length - 1; index >= 0; index -= 1) {
    const event = scoreEvents[index]
    if (event.side === side) return event.amount
  }

  return getFallbackUndoAmount(score)
}

function appendScoreEvent(
  events: Record<string, ScoreEvent[]> | undefined,
  scoreKey: string,
  event: ScoreEvent,
): Record<string, ScoreEvent[]> {
  const current = events ?? {}
  return {
    ...current,
    [scoreKey]: [...(current[scoreKey] ?? []), event],
  }
}

function removeLastScoreEvent(
  events: Record<string, ScoreEvent[]> | undefined,
  scoreKey: string,
  side: ScoreSide,
): Record<string, ScoreEvent[]> {
  const current = events ?? {}
  const scoreEvents = current[scoreKey] ?? []
  const removeIndex = (() => {
    for (let index = scoreEvents.length - 1; index >= 0; index -= 1) {
      if (scoreEvents[index].side === side) return index
    }
    return -1
  })()

  if (removeIndex < 0) return current

  const nextScoreEvents = [
    ...scoreEvents.slice(0, removeIndex),
    ...scoreEvents.slice(removeIndex + 1),
  ]
  const nextEvents = { ...current }
  if (nextScoreEvents.length > 0) {
    nextEvents[scoreKey] = nextScoreEvents
  } else {
    delete nextEvents[scoreKey]
  }
  return nextEvents
}

function removeScoreEventKey(
  events: Record<string, ScoreEvent[]> | undefined,
  scoreKey: string,
): Record<string, ScoreEvent[]> {
  const nextEvents = { ...(events ?? {}) }
  delete nextEvents[scoreKey]
  return nextEvents
}

function removeScoreEventKeysByPrefix(
  events: Record<string, ScoreEvent[]> | undefined,
  prefix: string,
): Record<string, ScoreEvent[]> {
  return Object.fromEntries(
    Object.entries(events ?? {}).filter(([key]) => !key.startsWith(prefix)),
  )
}

function ScoreboardLink({
  href,
  ready,
}: {
  href: string
  ready: boolean
}) {
  if (!ready) {
    return (
      <span
        className="scoreboard-link is-disabled"
        aria-disabled="true"
        title="Start the timer to open scoreboard"
      >
        ↗ Scoreboard
      </span>
    )
  }

  return (
    <a
      className="scoreboard-link"
      href={href}
      target="_blank"
      rel="noreferrer"
      title="Open public scoreboard"
    >
      ↗ Scoreboard
    </a>
  )
}

function MatchResetButton({
  disabled,
  onClick,
  label,
}: {
  disabled: boolean
  onClick: () => void
  label: string
}) {
  return (
    <button
      type="button"
      className="score-reset-btn"
      disabled={disabled}
      onClick={onClick}
      title={label}
      aria-label={label}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path
          d="M3.2 8a4.8 4.8 0 1 0 1.45-3.43"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
        <path
          d="M2 2.6v3.6h3.6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  )
}

function ScorePlate({
  score,
  side,
  canScore,
  onScore,
  onUndo,
  isLocked,
}: {
  score: number
  side: 'left' | 'right'
  canScore: boolean
  onScore: (amount: ScoreAwardAmount) => void
  onUndo: () => void
  isLocked?: boolean
}) {
  const canUndo = score > 0
  const showUndo = !isLocked || canUndo

  return (
    <div className={`score-plate score-plate-${side}`}>
      <div className={`score-plate-inline score-plate-inline-${side}${isLocked ? ' is-locked' : ''}`}>
        {side === 'left' ? <span className="score-plate-inline-value">{fmtScore(score)}</span> : null}
        {!isLocked && (
          <>
            <button
              type="button"
              className="score-plate-inline-btn"
              disabled={!canScore}
              onClick={() => onScore(1)}
            >
              +1
            </button>
            <button
              type="button"
              className="score-plate-inline-btn"
              disabled={!canScore}
              onClick={() => onScore(0.5)}
            >
              +½
            </button>
          </>
        )}
        {showUndo ? (
            <button
              type="button"
              className="score-plate-inline-btn is-undo"
              disabled={!canUndo}
              onClick={onUndo}
              aria-label="Undo last score"
              title="Undo last score"
            >
              <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <path
                  d="M5.2 4.4H10a4 4 0 1 1-3.18 6.43"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                />
                <path
                  d="M5.4 1.8 2.8 4.4l2.6 2.6"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
        ) : null}
        {side === 'right' ? <span className="score-plate-inline-value">{fmtScore(score)}</span> : null}
      </div>
    </div>
  )
}

function MatchTimer({
  timer,
  durationSeconds,
  locked,
  disableStart,
  disabled,
  onStart,
  onPause,
  onReset,
  onExpire,
  compact,
}: {
  timer: MatchTimerState | undefined
  durationSeconds: number
  locked?: boolean
  disableStart?: boolean
  disabled?: boolean
  onStart: () => void
  onPause: () => void
  onReset: () => void
  onExpire: () => void
  compact?: boolean
}) {
  const [, setTick] = useState(0)
  const isRunning = timer?.runningSince != null
  const isEncho = isEnchoTimer(timer)
  const remaining = getTimerRemainingMs(timer, durationSeconds)
  const expired = remaining <= 0 && timer != null
  const controlsDisabled = disabled || disableStart

  useEffect(() => {
    if (!isRunning) return
    const id = window.setInterval(() => setTick((n) => n + 1), 200)
    return () => window.clearInterval(id)
  }, [isRunning])

  useEffect(() => {
    if (isRunning && remaining <= 0) {
      onExpire()
    }
  }, [isRunning, remaining, onExpire])

  return (
    <div className={`match-timer${expired ? ' is-expired' : ''}${isRunning ? ' is-running' : ''}${disabled && !isRunning ? ' is-disabled' : ''}${compact ? ' is-compact' : ''}`}>
      {isEncho ? (
        <span className="match-timer-phase">
          <span aria-hidden="true">延長</span>
          Encho
        </span>
      ) : null}
      <span className="match-timer-display">{formatTimerMs(remaining)}</span>
      {!locked ? (
        <div className="match-timer-controls">
          {!expired && !isRunning ? (
            <button
              type="button"
              className="timer-btn timer-btn-icon timer-btn-start"
              onClick={onStart}
              disabled={controlsDisabled}
              aria-label={timer && timer.remainingMs < durationSeconds * 1000 ? 'Resume' : 'Start'}
              title={timer && timer.remainingMs < durationSeconds * 1000 ? 'Resume' : 'Start'}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <path d="M4 2.8v10.4c0 .62.68 1 1.2.66l8.05-5.2a.79.79 0 0 0 0-1.32L5.2 2.14C4.68 1.8 4 2.18 4 2.8Z" fill="currentColor" />
              </svg>
            </button>
          ) : null}
          {isRunning ? (
            <button
              type="button"
              className="timer-btn timer-btn-icon timer-btn-pause"
              onClick={onPause}
              aria-label="Pause"
              title="Pause"
            >
              <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <rect x="3.5" y="2.5" width="3.2" height="11" rx="0.8" fill="currentColor" />
                <rect x="9.3" y="2.5" width="3.2" height="11" rx="0.8" fill="currentColor" />
              </svg>
            </button>
          ) : null}
          {timer && !isRunning ? (
            <button
              type="button"
              className="timer-btn timer-btn-icon timer-btn-ghost"
              onClick={onReset}
              disabled={controlsDisabled}
              aria-label="Reset"
              title="Reset"
            >
              <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <path
                  d="M3.2 8a4.8 4.8 0 1 0 1.45-3.43"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                />
                <path d="M2 2.6v3.6h3.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function MatchCard({
  match,
  matchScore,
  showScoring,
  isNextBout,
  tournamentId,
  timer,
  durationSeconds,
  disableStartIfOtherActive,
  onSelectWinner,
  onAddScore,
  onUndoScore,
  onResetScore,
  onTimerStart,
  onTimerPause,
  onTimerReset,
  onTimerExpire,
}: {
  match: BracketMatch
  matchScore?: MatchScore
  showScoring?: boolean
  isNextBout?: boolean
  tournamentId?: string
  timer?: MatchTimerState
  durationSeconds: number
  disableStartIfOtherActive?: boolean
  onSelectWinner: (matchId: string, entrantId: string) => void
  onAddScore?: (matchId: string, side: ScoreSide, amount: ScoreAwardAmount) => void
  onUndoScore?: (matchId: string, side: ScoreSide) => void
  onResetScore?: (matchId: string) => void
  onTimerStart?: (matchId: string) => void
  onTimerPause?: (matchId: string) => void
  onTimerReset?: (matchId: string) => void
  onTimerExpire?: (matchId: string) => void
}) {
  const canScore = showScoring && !match.isAutoAdvance
  const matchReady = !!match.left.entrant && !!match.right.entrant
  const hasScore = matchScore && (matchScore.left > 0 || matchScore.right > 0)
  const timeExpired = isTimerExpired(timer, durationSeconds)
  const isEncho = isEnchoTimer(timer)
  const scoringLocked = match.isComplete || timeExpired
  const matchState = getMatchStateMeta(match, !!hasScore || !!timer)
  const scoreboardReady = !!timer
  const canResetScore = scoreboardReady || !!hasScore || match.isComplete
  const timeoutLeader = timeExpired ? getScoreLeader(matchScore) : null

  useEffect(() => {
    if (!timeExpired || match.isComplete || !timeoutLeader) return
    const winner = timeoutLeader === 'left' ? match.left.entrant : match.right.entrant
    if (winner) onSelectWinner(match.id, winner.id)
  }, [match.id, match.isComplete, match.left.entrant, match.right.entrant, onSelectWinner, timeExpired, timeoutLeader])

  useEffect(() => {
    if (!timeExpired || match.isComplete || timeoutLeader) return
    onTimerExpire?.(match.id)
  }, [match.id, match.isComplete, onTimerExpire, timeExpired, timeoutLeader])

  return (
    <article
      className={`match-card stage-${match.stage}${isNextBout ? ' is-next-bout' : ''}`}
      data-match-id={match.id}
      data-stage-kanji={getMatchStageKanji(match.stage)}
    >
      <header className="match-header">
        <div>
          <p className="match-code">
            <span className="match-stage-kanji" aria-hidden="true">{getMatchStageKanji(match.stage)}</span>
            {match.code}
          </p>
          <h4>{match.title}</h4>
        </div>
        <div className="match-header-actions">
          {isNextBout ? <span className="next-bout-cue">Next bout</span> : null}
          <span className={`match-state ${matchState.className}`}>
            {matchState.label}
          </span>
          {tournamentId && !match.isAutoAdvance && match.left.entrant && match.right.entrant ? (
            <ScoreboardLink
              href={`${import.meta.env.BASE_URL}tournaments/${tournamentId}/match/${match.id}/scoreboard`}
              ready={scoreboardReady}
            />
          ) : null}
          {canScore ? (
            <MatchResetButton
              disabled={!canResetScore}
              onClick={() => onResetScore?.(match.id)}
              label="Reset score"
            />
          ) : null}
        </div>
      </header>

      {canScore ? (
        <>
          <MatchTimer
            timer={timer}
            durationSeconds={durationSeconds}
            locked={match.isComplete}
            disabled={!matchReady}
            disableStart={disableStartIfOtherActive}
            onStart={() => onTimerStart?.(match.id)}
            onPause={() => onTimerPause?.(match.id)}
            onReset={() => onTimerReset?.(match.id)}
            onExpire={() => onTimerExpire?.(match.id)}
          />
          <div className="match-scoring-row">
            {([{ slot: match.left, side: 'left' as const }, { slot: match.right, side: 'right' as const }]).map(
              ({ slot, side }, idx) => {
                const entrant = slot.entrant
                const score = side === 'left' ? (matchScore?.left ?? 0) : (matchScore?.right ?? 0)
                const isWinner = entrant?.id === match.selectedWinnerId
                return (
                  <Fragment key={side}>
                    {idx === 1 && (
                      <span className="match-vs-kanji" aria-hidden="true">対</span>
                    )}
                    <div
                      className={`score-slot score-slot-${side}${isWinner ? ' is-winner' : ''}${slot.isBye ? ' is-bye' : ''}`}
                    >
                      <span className="score-slot-name">{slot.label}</span>
                      <ScorePlate
                        score={score}
                        side={side}
                        canScore={!!entrant && scoreboardReady && !scoringLocked}
                        onScore={(amount) => entrant && onAddScore?.(match.id, side, amount)}
                        onUndo={() => entrant && onUndoScore?.(match.id, side)}
                        isLocked={match.isComplete}
                      />
                    </div>
                  </Fragment>
                )
              },
            )}
          </div>
          {timeExpired && !match.isComplete && !timeoutLeader ? (
            <div className="timer-expired-block">
              <p className="timer-expired-note">Time — scores tied. Encho starts next; first score wins.</p>
            </div>
          ) : null}
          {isEncho && !match.isComplete && !timeExpired ? (
            <div className="encho-note">
              <span aria-hidden="true">延長</span>
              <p>Encho — first score wins.</p>
            </div>
          ) : null}
        </>
      ) : (
        [match.left, match.right].map((slot, index) => {
          const entrant = slot.entrant
          const selected = entrant?.id === match.selectedWinnerId
          const clickable = entrant && match.options.length > 1

          return (
            <button
              key={`${match.id}-${index}`}
              type="button"
              className={`slot-button ${selected ? 'is-selected' : ''} ${slot.isBye ? 'is-bye' : ''}`}
              onClick={() => entrant && onSelectWinner(match.id, entrant.id)}
              disabled={!clickable}
            >
              <span className="slot-label">{slot.label}</span>
              {slot.details.length > 0 ? (
                <span className="slot-details">
                  {slot.details.map((detail) => (
                    <span key={detail}>{detail}</span>
                  ))}
                </span>
              ) : null}
            </button>
          )
        })
      )}
    </article>
  )
}

function RoundColumns({
  title,
  rounds,
  nextMatchId,
  scores,
  showScoring,
  teams,
  lineups,
  tournamentId,
  timers,
  durationSeconds,
  activeTimerKey,
  onSelectWinner,
  onAddScore,
  onResetScore,
  onAddBoutScore,
  onUndoScore,
  onUndoBoutScore,
  onResetTeamScore,
  onReorderMatchLineup,
  onTimerStart,
  onTimerPause,
  onTimerReset,
  onTimerExpire,
}: {
  title: string
  rounds: BracketRound[]
  nextMatchId?: string | null
  scores: Record<string, MatchScore>
  showScoring?: boolean
  teams?: TeamEntry[]
  lineups?: Record<string, { left: string[]; right: string[] }>
  tournamentId?: string
  timers: Record<string, MatchTimerState>
  durationSeconds: number
  activeTimerKey: string | null
  onSelectWinner: (matchId: string, entrantId: string) => void
  onAddScore?: (matchId: string, side: ScoreSide, amount: ScoreAwardAmount) => void
  onUndoScore?: (matchId: string, side: ScoreSide) => void
  onResetScore?: (matchId: string) => void
  onAddBoutScore?: (matchId: string, boutIndex: number, side: ScoreSide, amount: ScoreAwardAmount) => void
  onUndoBoutScore?: (matchId: string, boutIndex: number, side: ScoreSide) => void
  onResetTeamScore?: (matchId: string) => void
  onReorderMatchLineup?: (matchId: string, side: 'left' | 'right', memberId: string, toIndex: number) => void
  onTimerStart: (key: string) => void
  onTimerPause: (key: string) => void
  onTimerReset: (key: string) => void
  onTimerExpire: (key: string) => void
}) {
  if (rounds.length === 0) {
    return null
  }

  return (
    <section className="bracket-section">
      <div className="section-heading">
        <p>{title}</p>
      </div>
      <div className="rounds-grid">
        {rounds.map((round) => (
          <div key={round.id} className="round-column">
            <header className="round-header">
              <p>{round.title}</p>
              <span>{round.subtitle}</span>
            </header>
            <div className="round-matches">
              {round.matches.map((match) =>
                teams ? (
                  <TeamMatchCard
                    key={match.id}
                    match={match}
                    isNextBout={match.id === nextMatchId}
                    leftTeam={teams.find((t) => t.id === match.left.entrant?.id)}
                    rightTeam={teams.find((t) => t.id === match.right.entrant?.id)}
                    scores={scores}
                    lineups={lineups ?? {}}
                    tournamentId={tournamentId}
                    timers={timers}
                    durationSeconds={durationSeconds}
                    activeTimerKey={activeTimerKey}
                    onSelectWinner={onSelectWinner}
                    onAddBoutScore={onAddBoutScore!}
                    onUndoBoutScore={onUndoBoutScore!}
                    onResetTeamScore={onResetTeamScore!}
                    onReorderMatchLineup={onReorderMatchLineup!}
                    onTimerStart={onTimerStart}
                    onTimerPause={onTimerPause}
                    onTimerReset={onTimerReset}
                    onTimerExpire={onTimerExpire}
                  />
                ) : (
                  <MatchCard
                    key={match.id}
                    match={match}
                    isNextBout={match.id === nextMatchId}
                    matchScore={scores[match.id]}
                    showScoring={showScoring}
                    tournamentId={tournamentId}
                    timer={timers[match.id]}
                    durationSeconds={durationSeconds}
                    disableStartIfOtherActive={activeTimerKey != null && activeTimerKey !== match.id}
                    onSelectWinner={onSelectWinner}
                    onAddScore={onAddScore}
                    onUndoScore={onUndoScore}
                    onResetScore={onResetScore}
                    onTimerStart={onTimerStart}
                    onTimerPause={onTimerPause}
                    onTimerReset={onTimerReset}
                    onTimerExpire={onTimerExpire}
                  />
                ),
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

function TeamMatchCard({
  match,
  isNextBout,
  leftTeam,
  rightTeam,
  scores,
  lineups,
  tournamentId,
  timers,
  durationSeconds,
  activeTimerKey,
  onSelectWinner,
  onAddBoutScore,
  onUndoBoutScore,
  onResetTeamScore,
  onReorderMatchLineup,
  onTimerStart,
  onTimerPause,
  onTimerReset,
  onTimerExpire,
}: {
  match: BracketMatch
  isNextBout?: boolean
  leftTeam?: TeamEntry
  rightTeam?: TeamEntry
  scores: Record<string, MatchScore>
  lineups: Record<string, { left: string[]; right: string[] }>
  tournamentId?: string
  timers: Record<string, MatchTimerState>
  durationSeconds: number
  activeTimerKey: string | null
  onSelectWinner: (matchId: string, entrantId: string) => void
  onAddBoutScore: (matchId: string, boutIndex: number, side: ScoreSide, amount: ScoreAwardAmount) => void
  onUndoBoutScore: (matchId: string, boutIndex: number, side: ScoreSide) => void
  onResetTeamScore: (matchId: string) => void
  onReorderMatchLineup: (matchId: string, side: 'left' | 'right', memberId: string, toIndex: number) => void
  onTimerStart: (key: string) => void
  onTimerPause: (key: string) => void
  onTimerReset: (key: string) => void
  onTimerExpire: (key: string) => void
}) {
  const [lineupDrag, setLineupDrag] = useState<{ side: 'left' | 'right'; memberId: string } | null>(null)
  const [lineupOver, setLineupOver] = useState<{ side: 'left' | 'right'; index: number } | null>(null)

  const leftMembers = resolveMatchLineup(leftTeam, lineups[match.id]?.left)
  const rightMembers = resolveMatchLineup(rightTeam, lineups[match.id]?.right)
  const boutsTotal = Math.min(leftMembers.length, rightMembers.length)

  const boutScoresList = Array.from({ length: boutsTotal }, (_, i) => scores[getBoutKey(match.id, i)])
  const boutCompletionList = Array.from({ length: boutsTotal }, (_, i) =>
    isTeamBoutComplete(boutScoresList[i], timers[getBoutKey(match.id, i)], durationSeconds),
  )
  const stats = computeTeamStats(boutScoresList, boutsTotal, boutCompletionList)
  const hasAnyScore = boutScoresList.some((s) => s && (s.left > 0 || s.right > 0))
  const hasAnyTimer = Array.from({ length: boutsTotal }, (_, i) => timers[getBoutKey(match.id, i)]).some(Boolean)
  const lineupLocked = hasAnyScore || match.isComplete
  const isTiebreaker = stats.leftWins === stats.rightWins && (stats.leftTotal > 0 || stats.rightTotal > 0)
  const showManualSelect = !match.isComplete && stats.pendingBouts === 0 && stats.teamWinner === null && match.options.length > 1
  const matchState = getMatchStateMeta(match, hasAnyScore || hasAnyTimer)
  const canResetTeamScore = hasAnyTimer || hasAnyScore || match.isComplete

  // No members or auto-advance: fall back to click-to-select slot buttons
  if (match.isAutoAdvance || boutsTotal === 0) {
    return (
      <article
        className={`match-card stage-${match.stage}${isNextBout ? ' is-next-bout' : ''}`}
        data-match-id={match.id}
        data-stage-kanji={getMatchStageKanji(match.stage)}
      >
        <header className="match-header">
          <div>
            <p className="match-code">
              <span className="match-stage-kanji" aria-hidden="true">{getMatchStageKanji(match.stage)}</span>
              {match.code}
            </p>
            <h4>{match.title}</h4>
          </div>
          <div className="match-header-actions">
            {isNextBout ? <span className="next-bout-cue">Next bout</span> : null}
            <span className={`match-state ${matchState.className}`}>
              {matchState.label}
            </span>
          </div>
        </header>
        {[match.left, match.right].map((slot, index) => {
          const entrant = slot.entrant
          const selected = entrant?.id === match.selectedWinnerId
          const clickable = entrant && match.options.length > 1
          return (
            <button
              key={`${match.id}-${index}`}
              type="button"
              className={`slot-button ${selected ? 'is-selected' : ''} ${slot.isBye ? 'is-bye' : ''}`}
              onClick={() => entrant && onSelectWinner(match.id, entrant.id)}
              disabled={!clickable}
            >
              <span className="slot-label">{slot.label}</span>
              {slot.details.length > 0 ? (
                <span className="slot-details">
                  {slot.details.map((detail) => (
                    <span key={detail}>{detail}</span>
                  ))}
                </span>
              ) : null}
            </button>
          )
        })}
      </article>
    )
  }

  function fmtScore(n: number) {
    return n % 1 === 0 ? String(n) : n.toFixed(1)
  }

  return (
    <article
      className={`match-card team-match-card stage-${match.stage}${isNextBout ? ' is-next-bout' : ''}`}
      data-match-id={match.id}
      data-stage-kanji={getMatchStageKanji(match.stage)}
    >
      <header className="match-header">
        <div>
          <p className="match-code">
            <span className="match-stage-kanji" aria-hidden="true">{getMatchStageKanji(match.stage)}</span>
            {match.code}
          </p>
          <h4>{match.title}</h4>
        </div>
        <div className="match-header-actions">
          {isNextBout ? <span className="next-bout-cue">Next bout</span> : null}
          <span className={`match-state ${matchState.className}`}>
            {matchState.label}
          </span>
          {tournamentId && match.left.entrant && match.right.entrant ? (
            <ScoreboardLink
              href={`${import.meta.env.BASE_URL}tournaments/${tournamentId}/match/${match.id}/scoreboard`}
              ready={hasAnyTimer}
            />
          ) : null}
          <MatchResetButton
            disabled={!canResetTeamScore}
            onClick={() => onResetTeamScore(match.id)}
            label="Reset scorecard"
          />
        </div>
      </header>

      {/* Per-match lineup editor — draggable until scoring starts */}
      <div className={`match-lineup${lineupLocked ? ' is-locked' : ''}`}>
        {(['left', 'right'] as const).map((side) => {
          const members = side === 'left' ? leftMembers : rightMembers
          const teamLabel = side === 'left' ? match.left.label : match.right.label
          return (
            <div
              key={side}
              className="lineup-col"
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) setLineupOver(null)
              }}
            >
              <span className="lineup-col-label">{teamLabel}</span>
              {lineupLocked ? (
                members.map((member, idx) => (
                  <div key={member.id} className="lineup-member-row is-locked">
                    <span className="lineup-pos">{getKendoPosition(idx, boutsTotal)}</span>
                    <span className="lineup-member-name">{member.name.trim() || 'Open slot'}</span>
                  </div>
                ))
              ) : (
                <>
                  {lineupOver?.side === side && lineupOver.index === 0 && <div className="drop-line" />}
                  {members.map((member, idx) => (
                    <Fragment key={member.id}>
                      <div
                        className={`lineup-member-row${lineupDrag?.side === side && lineupDrag.memberId === member.id ? ' is-dragging' : ''}`}
                        draggable
                        onDragStart={(e) => {
                          e.dataTransfer.effectAllowed = 'move'
                          setLineupDrag({ side, memberId: member.id })
                        }}
                        onDragOver={(e) => {
                          if (!lineupDrag || lineupDrag.side !== side) return
                          e.preventDefault()
                          const rect = e.currentTarget.getBoundingClientRect()
                          const insertIndex = e.clientY < rect.top + rect.height / 2 ? idx : idx + 1
                          setLineupOver({ side, index: insertIndex })
                        }}
                        onDrop={() => {
                          if (!lineupDrag || !lineupOver || lineupDrag.side !== side) return
                          onReorderMatchLineup(match.id, side, lineupDrag.memberId, lineupOver.index)
                          setLineupDrag(null)
                          setLineupOver(null)
                        }}
                        onDragEnd={() => { setLineupDrag(null); setLineupOver(null) }}
                      >
                        <span className="drag-handle" aria-hidden="true">⠿</span>
                        <span className="lineup-pos">{getKendoPosition(idx, boutsTotal)}</span>
                        <span className="lineup-member-name">{member.name.trim() || 'Open slot'}</span>
                      </div>
                      {lineupOver?.side === side && lineupOver.index === idx + 1 && <div className="drop-line" />}
                    </Fragment>
                  ))}
                </>
              )}
            </div>
          )
        })}
        {lineupLocked ? (
          <p className="lineup-lock-note">Lineup locked — reset scorecard to reorder</p>
        ) : (
          <p className="lineup-hint">Drag to set the match order for each team</p>
        )}
      </div>

      {/* 1. Individual bout scores */}
      <div className="team-scorecard">
        {Array.from({ length: boutsTotal }, (_, boutIndex) => {
          const leftMember = leftMembers[boutIndex]
          const rightMember = rightMembers[boutIndex]
          const boutKey = getBoutKey(match.id, boutIndex)
          const boutScore = scores[boutKey] ?? { left: 0, right: 0 }
          const leftWonBout = boutScore.left >= 2 && boutScore.left > boutScore.right
          const rightWonBout = boutScore.right >= 2 && boutScore.right > boutScore.left
          const boutDone = boutScore.left >= 2 || boutScore.right >= 2
          const boutTimer = timers[boutKey]
          const boutTimeExpired = isTimerExpired(boutTimer, durationSeconds)
          const boutLocked = boutDone || boutTimeExpired
          const boutTimerStarted = !!boutTimer

          return (
            <div key={boutIndex} className={`bout-row${boutTimeExpired && !boutDone ? ' is-time-draw' : ''}`}>
              <span className="bout-pos">{getKendoPosition(boutIndex, boutsTotal)}</span>

              {/* Timer first, matching the singles card order */}
              <MatchTimer
                timer={boutTimer}
                durationSeconds={durationSeconds}
                locked={boutDone}
                disableStart={activeTimerKey != null && activeTimerKey !== boutKey}
                onStart={() => onTimerStart(boutKey)}
                onPause={() => onTimerPause(boutKey)}
                onReset={() => onTimerReset(boutKey)}
                onExpire={() => onTimerExpire(boutKey)}
              />

              <div className="bout-names-row match-scoring-row">
                <div className={`bout-score-slot score-slot score-slot-left${leftWonBout ? ' is-winner' : ''}`}>
                  <span className="score-slot-name">{leftMember?.name.trim() || 'Open slot'}</span>
                  <ScorePlate
                    score={boutScore.left}
                    side="left"
                    canScore={boutTimerStarted && !boutLocked}
                    onScore={(amount) => onAddBoutScore(match.id, boutIndex, 'left', amount)}
                    onUndo={() => onUndoBoutScore(match.id, boutIndex, 'left')}
                  />
                </div>

                <span className="match-vs-kanji" aria-hidden="true">対</span>

                <div className={`bout-score-slot score-slot score-slot-right${rightWonBout ? ' is-winner' : ''}`}>
                  <span className="score-slot-name">{rightMember?.name.trim() || 'Open slot'}</span>
                  <ScorePlate
                    score={boutScore.right}
                    side="right"
                    canScore={boutTimerStarted && !boutLocked}
                    onScore={(amount) => onAddBoutScore(match.id, boutIndex, 'right', amount)}
                    onUndo={() => onUndoBoutScore(match.id, boutIndex, 'right')}
                  />
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* 2 & 3. Team score and total individual score */}
      <div className="team-stats-bar">
        <div className="team-stat-row">
          <span className={`team-stat-val${stats.teamWinner === 'left' ? ' is-winner' : ''}`}>
            {stats.leftWins}
          </span>
          <span className="team-stat-label">Team score</span>
          <span className={`team-stat-val${stats.teamWinner === 'right' ? ' is-winner' : ''}`}>
            {stats.rightWins}
          </span>
        </div>
        <div className="team-stat-row">
          <span className={`team-stat-sub${isTiebreaker && stats.teamWinner === 'left' ? ' is-tiebreak-winner' : ''}`}>
            {fmtScore(stats.leftTotal)}
          </span>
          <span className="team-stat-label">
            {isTiebreaker ? 'Tiebreaker ippons' : 'Total ippons'}
          </span>
          <span className={`team-stat-sub${isTiebreaker && stats.teamWinner === 'right' ? ' is-tiebreak-winner' : ''}`}>
            {fmtScore(stats.rightTotal)}
          </span>
        </div>
      </div>

      {/* Manual winner override when no auto-winner yet */}
      {showManualSelect ? (
        <div className="team-tie-notice">
          <p>Declare the match winner:</p>
          <div className="team-tie-select-row">
            {[match.left, match.right].map((slot) =>
              slot.entrant ? (
                <button
                  key={slot.entrant.id}
                  type="button"
                  className="ghost-button"
                  onClick={() => onSelectWinner(match.id, slot.entrant!.id)}
                >
                  {slot.label}
                </button>
              ) : null,
            )}
          </div>
        </div>
      ) : null}

    </article>
  )
}

function getTournamentInsight(tournament: TournamentRecord) {
  const entrants = toTournamentEntrants(
    tournament.kind,
    tournament.singles,
    tournament.teams,
  )

  if (entrants.length < 2) {
    return {
      entrants: entrants.length,
      progress: 0,
      champion: null as string | null,
      nextMatch: null as string | null,
      nextMatchPairing: null as string | null,
      isComplete: false,
    }
  }

  const bracket = buildTournamentBracket(entrants, tournament.format, tournament.results)
  const nextPendingMatch = getNextPendingMatch([
    ...bracket.winnersRounds,
    ...bracket.losersRounds,
    ...bracket.finalRounds,
  ])

  return {
    entrants: entrants.length,
    progress:
      bracket.totalMatches > 0
        ? Math.round((bracket.completedMatches / bracket.totalMatches) * 100)
        : 0,
    champion: bracket.champion?.label ?? null,
    nextMatch: nextPendingMatch?.code ?? null,
    nextMatchPairing: nextPendingMatch ? getTournamentMatchPairing(tournament, nextPendingMatch) : null,
    isComplete: bracket.champion !== null,
  }
}

function sortByUpdatedDesc<T extends { updatedAt: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
}

function formatUpdatedAt(dateString: string) {
  const date = new Date(dateString)
  if (Number.isNaN(date.getTime())) return 'Unknown'

  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  if (diffMs >= 0 && diffMs < 60_000) return 'Just now'
  if (diffMs >= 0 && diffMs < 60 * 60_000) {
    const minutes = Math.max(1, Math.floor(diffMs / 60_000))
    return `${minutes} min ago`
  }
  if (diffMs >= 0 && diffMs < 24 * 60 * 60_000) {
    const hours = Math.max(1, Math.floor(diffMs / (60 * 60_000)))
    return `${hours} hr ago`
  }

  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
}

type TournamentStatus = 'active' | 'upcoming' | 'past'

function hasTournamentStarted(tournament: TournamentRecord): boolean {
  return (
    Object.keys(tournament.results).length > 0 ||
    Object.keys(tournament.scores).length > 0 ||
    Object.keys(tournament.timers ?? {}).length > 0
  )
}

function getTournamentStatus(tournament: TournamentRecord): TournamentStatus {
  if (getTournamentInsight(tournament).isComplete) return 'past'
  return hasTournamentStarted(tournament) ? 'active' : 'upcoming'
}

function reorderByIndex<T extends { id: string }>(
  items: T[],
  fromMemberId: string,
  toIndex: number,
): T[] {
  const fromIndex = items.findIndex((item) => item.id === fromMemberId)
  if (fromIndex < 0) return items
  const nextItems = [...items]
  const [item] = nextItems.splice(fromIndex, 1)
  const adjustedIndex = toIndex > fromIndex ? toIndex - 1 : toIndex
  nextItems.splice(adjustedIndex, 0, item)
  return nextItems
}

function isLegacySeedData(records: TournamentRecord[]): boolean {
  if (records.length !== 2) {
    return false
  }

  const legacySeeds = [
    ['Spring Kendo Taikai', '2026-04-18T09:00:00.000Z'],
    ['Winter Team Cup', '2026-02-14T11:00:00.000Z'],
  ] as const

  return legacySeeds.every(([name, createdAt]) =>
    records.some((record) => record.name === name && record.createdAt === createdAt),
  )
}

function AppFrame({
  children,
  action,
}: {
  children: React.ReactNode
  action?: React.ReactNode
}) {
  return (
    <div className="page-shell">
      <header className="topbar">
        <Link to="/" className="brand-block">
          <span className="brand-block-text">
            <span>Kendo Tournament</span>
            <strong>Shiai Desk</strong>
          </span>
        </Link>
        <div className="topbar-actions">{action}</div>
      </header>
      {children}
    </div>
  )
}

function TournamentCard({
  tournament,
  onDelete,
}: {
  tournament: TournamentRecord
  onDelete?: (id: string) => void
}) {
  const insight = getTournamentInsight(tournament)
  const status = getTournamentStatus(tournament)
  const statusChip = status === 'past' ? 'Past' : status === 'active' ? 'Active' : 'Upcoming'
  const statusClass = status === 'past' ? 'is-complete' : status === 'active' ? 'is-live' : 'is-upcoming'
  const focusLabel = insight.isComplete ? 'Champion' : status === 'active' ? 'Next bout' : 'First bout'
  const focusValue = insight.isComplete ? insight.champion ?? 'Undecided' : insight.nextMatchPairing ?? 'TBD'
  const focusCode = !insight.isComplete ? insight.nextMatch : null
  const actionLabel = status === 'active' ? 'Continue' : status === 'past' ? 'Review' : 'Open'

  return (
    <article className={`tournament-card tournament-card--${tournament.kind} tournament-card-status-${status}`}>
      <div className="tournament-card-header">
        <div>
          <span className="tournament-type-badge">
            {tournament.kind === 'single' ? 'Individual' : 'Team'}
          </span>
          <h3>{tournament.name}</h3>
        </div>
        <span className={`status-chip ${statusClass}`}>
          {statusChip}
        </span>
      </div>

      <div className="tournament-card-focus">
        <span>{focusLabel}</span>
        {focusCode ? <em className="tournament-card-focus-code">{focusCode}</em> : null}
        <strong>{focusValue}</strong>
      </div>

      <div className="tournament-card-ledger" aria-label="Tournament details">
        <span>{tournament.format === 'single' ? 'Single knockout' : 'Double knockout'}</span>
        <span>{insight.entrants} entrants</span>
        <span>{insight.progress}% complete</span>
      </div>

      <footer className="tournament-card-footer">
        <span>Updated {formatUpdatedAt(tournament.updatedAt)}</span>
        <div className="tournament-card-actions">
          {onDelete && (
            <button
              type="button"
              className="tournament-card-delete"
              title="Delete tournament"
              aria-label={`Delete ${tournament.name}`}
              onClick={(event) => {
                event.preventDefault()
                if (window.confirm(`Delete "${tournament.name}" from local storage?`)) {
                  onDelete(tournament.id)
                }
              }}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <path
                  d="M3.2 4.4h9.6M6.4 4.4V3.2h3.2v1.2M5 6.4l.45 6.2h5.1L11 6.4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.45"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          )}
          <Link to={`/tournaments/${tournament.id}`} className={`tournament-card-primary is-${status}`}>
            {actionLabel}
          </Link>
        </div>
      </footer>
    </article>
  )
}

function TournamentGraphModal({
  tournament,
  onClose,
  onSelectMatch,
}: {
  tournament: TournamentRecord
  onClose: () => void
  onSelectMatch?: (matchId: string) => void
}) {
  const entrants = toTournamentEntrants(tournament.kind, tournament.singles, tournament.teams)
  const bracket = entrants.length >= 2
    ? buildTournamentBracket(entrants, tournament.format, tournament.results)
    : null
  const nextPendingMatch = bracket
    ? getNextPendingMatch([
        ...bracket.winnersRounds,
        ...bracket.losersRounds,
        ...bracket.finalRounds,
      ])
    : null
  const insight = getTournamentInsight(tournament)
  const sections = bracket
    ? [
        { id: 'winners', title: 'Winners bracket', rounds: bracket.winnersRounds },
        { id: 'losers', title: 'Losers bracket', rounds: bracket.losersRounds },
        { id: 'finals', title: 'Finals', rounds: bracket.finalRounds },
      ].filter((section) => section.rounds.length > 0)
    : []

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div className="graph-modal-overlay" onClick={onClose}>
      <section
        className="graph-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="graph-modal-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="graph-modal-header">
          <div>
            <p className="eyebrow">
              <span className="kanji-kicker">{getTournamentKindKanji(tournament.kind)}</span>
              Bracket graph
            </p>
            <h2 id="graph-modal-title">{tournament.name}</h2>
          </div>
          <button
            type="button"
            className="settings-close-btn"
            onClick={onClose}
            aria-label="Close bracket graph"
          >
            ✕
          </button>
        </header>

        <div className="graph-modal-summary" aria-label="Tournament summary">
          <div>
            <span>Format</span>
            <strong>{tournament.format === 'single' ? 'Single knockout' : 'Double knockout'}</strong>
          </div>
          <div>
            <span>Entrants</span>
            <strong>{insight.entrants}</strong>
          </div>
          <div>
            <span>{insight.isComplete ? 'Champion' : 'Next'}</span>
            <strong>{insight.isComplete ? insight.champion ?? 'Undecided' : insight.nextMatch ?? 'TBD'}</strong>
          </div>
        </div>

        <div className="graph-modal-body">
          {!bracket ? (
            <div className="graph-empty">
              <strong>Bracket not ready</strong>
              <span>Add at least two entrants to generate the graph.</span>
            </div>
          ) : (
            sections.map((section) => (
              <section key={section.id} className="bracket-graph-section">
                <div className="section-heading">
                  <p>{section.title}</p>
                </div>
                <div className="bracket-graph-scroll">
                  <div className="bracket-graph-grid">
                    {section.rounds.map((round, roundIndex) => (
                      <div key={round.id} className="bracket-graph-round">
                        <header className="bracket-graph-round-header">
                          <strong>{round.title}</strong>
                          <span>{round.subtitle}</span>
                        </header>
                        <div className="bracket-graph-matches">
                          {round.matches.map((match) => {
                            const matchStatus = match.isAutoAdvance
                              ? 'bye'
                              : match.isComplete
                                ? 'complete'
                                : match.id === nextPendingMatch?.id
                                  ? 'next'
                                  : 'pending'
                            return (
                              <button
                                key={match.id}
                                type="button"
                                className={`bracket-graph-match is-${matchStatus}`}
                                data-stage-kanji={getMatchStageKanji(match.stage)}
                                data-has-connector={roundIndex < section.rounds.length - 1 ? 'true' : 'false'}
                                onClick={() => onSelectMatch?.(match.id)}
                                disabled={!onSelectMatch}
                                title={`Jump to ${match.code}`}
                                aria-label={`Jump to ${match.code}`}
                              >
                                <span className="bracket-graph-code">{match.code}</span>
                                <div className="bracket-graph-slot">
                                  <span className={match.selectedWinnerId === match.left.entrant?.id ? 'is-winner' : ''}>
                                    {match.left.label}
                                  </span>
                                </div>
                                <div className="bracket-graph-slot">
                                  <span className={match.selectedWinnerId === match.right.entrant?.id ? 'is-winner' : ''}>
                                    {match.right.label}
                                  </span>
                                </div>
                              </button>
                            )
                          })}
                        </div>
                      </div>
                    ))}
                    {bracket.champion && section.id === 'finals' ? (
                      <div className="bracket-graph-champion">
                        <span aria-hidden="true">優勝</span>
                        <strong>{bracket.champion.label}</strong>
                      </div>
                    ) : null}
                  </div>
                </div>
              </section>
            ))
          )}
        </div>
      </section>
    </div>
  )
}

function HomePage({
  tournaments,
  onDeleteTournament,
}: {
  tournaments: TournamentRecord[]
  onDeleteTournament: (id: string) => void
}) {
  const activeTournaments = sortByUpdatedDesc(tournaments.filter((t) => getTournamentStatus(t) === 'active'))
  const upcomingTournaments = tournaments.filter((t) => getTournamentStatus(t) === 'upcoming')
  const pastTournaments = sortByUpdatedDesc(tournaments.filter((t) => getTournamentStatus(t) === 'past'))

  const [tab, setTab] = useState<TournamentStatus>(() => {
    if (activeTournaments.length) return 'active'
    if (upcomingTournaments.length) return 'upcoming'
    if (pastTournaments.length) return 'past'
    return 'active'
  })

  const tabs: { key: TournamentStatus; label: string; count: number }[] = [
    { key: 'active', label: 'Active', count: activeTournaments.length },
    { key: 'upcoming', label: 'Queued', count: upcomingTournaments.length },
    { key: 'past', label: 'Archived', count: pastTournaments.length },
  ]

  const currentList =
    tab === 'active' ? activeTournaments : tab === 'upcoming' ? upcomingTournaments : pastTournaments
  const emptyCopy =
    tab === 'active'
      ? { h: 'No active tournaments', p: 'Tournaments appear here once the first bout is scored.' }
      : tab === 'upcoming'
      ? { h: 'No upcoming tournaments', p: 'Create a new bracket to queue up an event.' }
      : { h: 'No completed tournaments yet', p: 'Finished events will appear here once a champion has been decided.' }

  return (
    <AppFrame
      action={
        <>
          <Link to="/docs" className="inline-link">
            Docs
          </Link>
          <Link to="/tournaments/new" className="primary-link">
            Create new tournament
          </Link>
        </>
      }
    >
      <section className="home-header">
        <div>
          <p className="eyebrow">Tournament register</p>
          <h1>Tournament desk</h1>
        </div>
        <span className="home-header-count">{tournaments.length} saved</span>
      </section>

      <section className="home-status-nav" role="tablist" aria-label="Tournament status">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            className={`home-status-tile${tab === t.key ? ' is-active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            <span>{t.label}</span>
            <strong>{t.count}</strong>
            <em>
              {t.key === 'active' ? 'In progress' : t.key === 'upcoming' ? 'Ready to begin' : 'Finished'}
            </em>
          </button>
        ))}
      </section>

      <section className="list-section">
        {currentList.length > 0 ? (
          <div className="tournament-grid">
            {currentList.map((tournament) => (
              <TournamentCard
                key={tournament.id}
                tournament={tournament}
                onDelete={onDeleteTournament}
              />
            ))}
          </div>
        ) : (
          <div className="empty-card">
            <h3>{emptyCopy.h}</h3>
            <p>{emptyCopy.p}</p>
          </div>
        )}
      </section>
    </AppFrame>
  )
}

function DocsPage() {
  return (
    <AppFrame
      action={
        <>
          <Link to="/" className="inline-link">
            Tournament desk
          </Link>
          <Link to="/tournaments/new" className="primary-link">
            Create new tournament
          </Link>
        </>
      }
    >
      <section className="docs-hero">
        <div>
          <p className="eyebrow">Website documentation</p>
          <h1>How to use Shiai Desk</h1>
        </div>
        <div className="docs-hero-note">
          <span>Public route</span>
          <strong>/docs</strong>
          <p>
            On GitHub Pages, this guide is available at
            {' '}
            <a href="https://xianyangwong.github.io/kendo-tournament/docs">
              xianyangwong.github.io/kendo-tournament/docs
            </a>
            .
          </p>
        </div>
      </section>

      <nav className="docs-jump-list" aria-label="Guide steps">
        {DOC_STEPS.map((step, index) => (
          <a key={step.id} href={`#${step.id}`}>
            <span>{String(index + 1).padStart(2, '0')}</span>
            {step.title}
          </a>
        ))}
      </nav>

      <section className="docs-step-list">
        {DOC_STEPS.map((step, index) => (
          <article key={step.id} id={step.id} className="docs-step">
            <div className="docs-step-copy">
              <span className="docs-step-number">{String(index + 1).padStart(2, '0')}</span>
              <h2>{step.title}</h2>
              <p>{step.body}</p>
              <ul>
                {step.bullets.map((bullet) => (
                  <li key={bullet}>{bullet}</li>
                ))}
              </ul>
            </div>
            <figure className="docs-step-figure">
              <img
                src={step.image}
                alt={step.alt}
                loading={index === 0 ? 'eager' : 'lazy'}
                decoding="async"
              />
            </figure>
          </article>
        ))}
      </section>

      <section className="docs-deploy-note">
        <div>
          <p className="eyebrow">Deployment</p>
          <h2>GitHub Pages</h2>
        </div>
        <p>
          Pushes to <code>main</code> run the Pages workflow, build the Vite app, and publish the
          generated <code>dist</code> folder. In GitHub, keep <code>Settings &gt; Pages &gt; Source</code>
          {' '}
          set to <code>GitHub Actions</code>.
        </p>
      </section>
    </AppFrame>
  )
}

function SinglesEditor({
  singles,
  locked = false,
  onUpdate,
  onAdd,
  onRemove,
}: {
  singles: SoloEntry[]
  locked?: boolean
  onUpdate: (id: string, name: string) => void
  onAdd: () => void
  onRemove: (id: string) => void
}) {
  return (
    <div className="panel-card roster-panel">
      <div className="panel-heading">
        <p>Entries</p>
        <h2>Solo competitors</h2>
      </div>

      <div className="entry-stack">
        {singles.map((entry, index) => (
          <div key={entry.id} className="entry-card compact-entry">
            <div className="entry-header">
              <span>Kendoka {index + 1}</span>
              {!locked && (
                <button type="button" onClick={() => onRemove(entry.id)}>
                  Remove
                </button>
              )}
            </div>
            <input
              value={entry.name}
              onChange={(event) => onUpdate(entry.id, event.target.value)}
              placeholder="Competitor name"
              readOnly={locked}
            />
          </div>
        ))}
      </div>

      {!locked && (
        <button type="button" className="primary-button" onClick={onAdd}>
          Add competitor
        </button>
      )}
    </div>
  )
}

function TeamsEditor({
  teams,
  locked = false,
  onUpdateTeam,
  onRemoveTeam,
  onAddTeam,
  onUpdateMember,
  onRemoveMember,
  onAddMember,
}: {
  teams: TeamEntry[]
  locked?: boolean
  onUpdateTeam: (teamId: string, name: string) => void
  onRemoveTeam: (teamId: string) => void
  onAddTeam: () => void
  onUpdateMember: (teamId: string, memberId: string, name: string) => void
  onRemoveMember: (teamId: string, memberId: string) => void
  onAddMember: (teamId: string) => void
}) {
  return (
    <div className="panel-card roster-panel">
      <div className="panel-heading">
        <p>Entries</p>
        <h2>Team rosters</h2>
      </div>

      <div className="entry-stack">
        {teams.map((team, index) => (
          <div key={team.id} className="entry-card team-entry-card">
            <div className="entry-header">
              <span>Team {index + 1}</span>
              {!locked && (
                <button type="button" onClick={() => onRemoveTeam(team.id)}>
                  Remove team
                </button>
              )}
            </div>
            <input
              value={team.name}
              onChange={(event) => onUpdateTeam(team.id, event.target.value)}
              placeholder="Team name"
              readOnly={locked}
            />
            <div className="member-list">
              {team.members.map((member, memberIndex) => (
                <div key={member.id} className="member-row">
                  <span className="member-order">#{memberIndex + 1}</span>
                  <input
                    value={member.name}
                    onChange={(event) => onUpdateMember(team.id, member.id, event.target.value)}
                    placeholder="Member name"
                    readOnly={locked}
                  />
                  {!locked && (
                    <button
                      type="button"
                      className="remove-member-btn"
                      onClick={() => onRemoveMember(team.id, member.id)}
                      aria-label={`Remove member ${memberIndex + 1}`}
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
            </div>
            {!locked ? (
              <button type="button" className="ghost-button" onClick={() => onAddMember(team.id)}>
                Add team member
              </button>
            ) : null}
          </div>
        ))}
      </div>

      {!locked ? (
        <button type="button" className="primary-button" onClick={onAddTeam}>
          Add team
        </button>
      ) : null}
    </div>
  )
}

function TournamentWizard({
  onCreateTournament,
}: {
  onCreateTournament: (draft: TournamentDraft) => string
}) {
  const navigate = useNavigate()
  const [step, setStep] = useState(0)
  const [draft, setDraft] = useState<TournamentDraft>(createEmptyTournamentDraft())

  const entrantCount = draft.kind === 'single' ? draft.singles.length : draft.teams.length

  function updateSingles(nextSingles: SoloEntry[]) {
    setDraft((current) => ({ ...current, singles: nextSingles }))
  }

  function updateTeams(nextTeams: TeamEntry[]) {
    setDraft((current) => ({ ...current, teams: nextTeams }))
  }

  function createTournament() {
    const tournamentId = onCreateTournament(draft)
    navigate(`/tournaments/${tournamentId}`)
  }

  return (
    <AppFrame
      action={
        <Link to="/" className="inline-link">
          Back to tournaments
        </Link>
      }
    >
      <section className="wizard-layout">
        <div className="wizard-main">
          <div className="wizard-header">
            <p className="eyebrow">New tournament</p>
            <h1 className="wizard-title">Guided setup</h1>
            <nav className="wizard-dots" aria-label="Setup progress">
              {(['Basics', 'Entrants', 'Review'] as const).map((label, i) => (
                <Fragment key={i}>
                  <div className={`wizard-dot-step${i === step ? ' is-active' : i < step ? ' is-done' : ''}`}>
                    <span className="wizard-dot-circle">{i < step ? '✓' : null}</span>
                    <span className="wizard-dot-label">{label}</span>
                  </div>
                  {i < 2 ? <div className="wizard-dot-connector" aria-hidden="true" /> : null}
                </Fragment>
              ))}
            </nav>
          </div>
          {step === 0 ? (
            <div className="panel-card wizard-panel">
              <div className="panel-heading">
                <h2>Tournament basics</h2>
              </div>

              <label className="field-block">
                <span>Tournament name</span>
                <input
                  value={draft.name}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, name: event.target.value }))
                  }
                  placeholder="Autumn Kendo Cup"
                />
              </label>

              <div className="toggle-group">
                <span>Event type</span>
                <div className="pill-row">
                  <button
                    type="button"
                    className={draft.kind === 'single' ? 'is-active' : ''}
                    onClick={() => setDraft((current) => ({ ...current, kind: 'single' }))}
                  >
                    Single tournament
                  </button>
                  <button
                    type="button"
                    className={draft.kind === 'team' ? 'is-active' : ''}
                    onClick={() => setDraft((current) => ({ ...current, kind: 'team' }))}
                  >
                    Team tournament
                  </button>
                </div>
              </div>

              <div className="toggle-group">
                <span>Knockout format</span>
                <div className="pill-row">
                  <button
                    type="button"
                    className={draft.format === 'single' ? 'is-active' : ''}
                    onClick={() => setDraft((current) => ({ ...current, format: 'single' }))}
                  >
                    Single knockout
                  </button>
                  <button
                    type="button"
                    className={draft.format === 'double' ? 'is-active' : ''}
                    onClick={() => setDraft((current) => ({ ...current, format: 'double' }))}
                  >
                    Double knockout
                  </button>
                </div>
              </div>

              <DurationField
                seconds={draft.matchDurationSeconds}
                onChange={(seconds) => setDraft((current) => ({ ...current, matchDurationSeconds: seconds }))}
              />
            </div>
          ) : null}

          {step === 1 ? (
            draft.kind === 'single' ? (
              <SinglesEditor
                singles={draft.singles}
                onUpdate={(id, name) =>
                  updateSingles(
                    draft.singles.map((entry) => (entry.id === id ? { ...entry, name } : entry)),
                  )
                }
                onAdd={() => updateSingles([...draft.singles, createSoloEntry()])}
                onRemove={(id) =>
                  updateSingles(draft.singles.filter((entry) => entry.id !== id))
                }
              />
            ) : (
              <TeamsEditor
                teams={draft.teams}
                onUpdateTeam={(teamId, name) =>
                  updateTeams(
                    draft.teams.map((team) => (team.id === teamId ? { ...team, name } : team)),
                  )
                }
                onRemoveTeam={(teamId) =>
                  updateTeams(draft.teams.filter((team) => team.id !== teamId))
                }
                onAddTeam={() => updateTeams([...draft.teams, createTeamEntry()])}
                onUpdateMember={(teamId, memberId, name) =>
                  updateTeams(
                    draft.teams.map((team) =>
                      team.id === teamId
                        ? {
                            ...team,
                            members: team.members.map((member) =>
                              member.id === memberId ? { ...member, name } : member,
                            ),
                          }
                        : team,
                    ),
                  )
                }
                onRemoveMember={(teamId, memberId) =>
                  updateTeams(
                    draft.teams.map((team) =>
                      team.id === teamId
                        ? {
                            ...team,
                            members: team.members.filter((member) => member.id !== memberId),
                          }
                        : team,
                    ),
                  )
                }
                onAddMember={(teamId) =>
                  updateTeams(
                    draft.teams.map((team) =>
                      team.id === teamId
                        ? { ...team, members: [...team.members, createTeamMember()] }
                        : team,
                    ),
                  )
                }
              />
            )
          ) : null}

          {step === 2 ? (
            <div className="panel-card wizard-panel">
              <div className="panel-heading">
                <h2>Review tournament</h2>
              </div>

              <div className="review-grid">
                <div className="review-card">
                  <span>Name</span>
                  <strong>{draft.name}</strong>
                </div>
                <div className="review-card">
                  <span>Type</span>
                  <strong>{draft.kind === 'single' ? 'Single' : 'Team'}</strong>
                </div>
                <div className="review-card">
                  <span>Format</span>
                  <strong>{draft.format === 'single' ? 'Single knockout' : 'Double knockout'}</strong>
                </div>
                <div className="review-card">
                  <span>Entrants</span>
                  <strong>{entrantCount}</strong>
                </div>
              </div>

              <div className="review-list">
                {draft.kind === 'single'
                  ? draft.singles.map((entry) => (
                      <div key={entry.id} className="review-list-item">
                        <strong>{entry.name || 'Unnamed kendoka'}</strong>
                      </div>
                    ))
                  : draft.teams.map((entry) => (
                      <div key={entry.id} className="review-list-item">
                        <strong>{entry.name || 'Untitled team'}</strong>
                        <span>
                          {entry.members
                            .map(
                              (member, index) =>
                                `${index + 1}. ${member.name || 'Open slot'}`,
                            )
                            .join(' | ')}
                        </span>
                      </div>
                    ))}
              </div>

              {entrantCount < 2 ? (
                <p className="validation-note">
                  Add at least two entrants before creating the tournament.
                </p>
              ) : null}
            </div>
          ) : null}

          <div className="wizard-footer">
            <button type="button" className="ghost-button" onClick={() => setStep((current) => Math.max(0, current - 1))} disabled={step === 0}>
              Back
            </button>
            {step < 2 ? (
              <button type="button" className="primary-button" onClick={() => setStep((current) => Math.min(2, current + 1))}>
                Next step
              </button>
            ) : (
              <button type="button" className="primary-button" onClick={createTournament} disabled={entrantCount < 2}>
                Create tournament
              </button>
            )}
          </div>
        </div>
      </section>
    </AppFrame>
  )
}

function TournamentWorkbench({
  tournament,
  onChange,
  onDelete,
}: {
  tournament: TournamentRecord
  onChange: (updater: (current: TournamentRecord) => TournamentRecord) => void
  onDelete?: () => void
}) {
  const entrants = toTournamentEntrants(tournament.kind, tournament.singles, tournament.teams)
  const bracket = entrants.length >= 2
    ? buildTournamentBracket(entrants, tournament.format, tournament.results)
    : null
  const nextPendingMatch = bracket
    ? getNextPendingMatch([
        ...bracket.winnersRounds,
        ...bracket.losersRounds,
        ...bracket.finalRounds,
      ])
    : null

  const scores = tournament.scores ?? {}
  const showScoring = tournament.kind === 'single'
  const teamScoringTeams = tournament.kind === 'team' ? tournament.teams : undefined
  const teamLineups = tournament.kind === 'team' ? (tournament.lineups ?? {}) : undefined
  const hasStarted = hasTournamentStarted(tournament)
  const previousNextMatchIdRef = useRef<string | null | undefined>(undefined)

  function handleAddScore(matchId: string, side: ScoreSide, amount: ScoreAwardAmount) {
    onChange((current) => {
      // Recompute bracket from `current` (the latest committed state) rather than
      // the stale `bracket` closure captured at render time. Without this, a score
      // update that fires before a re-render would look up match entrants from an
      // outdated bracket, potentially writing the wrong winner — or writing a result
      // to L1M1 when the user was scoring a winners bracket match.
      const currentEntrants = toTournamentEntrants(current.kind, current.singles, current.teams)
      const currentBracket = currentEntrants.length >= 2
        ? buildTournamentBracket(currentEntrants, current.format, current.results)
        : null

      const allMatches = currentBracket
        ? [...currentBracket.winnersRounds, ...currentBracket.losersRounds, ...currentBracket.finalRounds]
            .flatMap((r) => r.matches)
        : []
      const match = allMatches.find((m) => m.id === matchId)

      // Guard: do not score a match that has only one entrant.
      if (!match || match.isAutoAdvance) {
        return current
      }
      if (match.isComplete) {
        return current
      }

      const existing = (current.scores ?? {})[matchId] ?? { left: 0, right: 0 }
      const nextSideScore = Math.max(0, existing[side] + amount)
      const nextScore = { ...existing, [side]: nextSideScore }

      let nextResults = current.results
      let nextTimers = current.timers ?? {}
      const isEnchoScore = isEnchoTimer(current.timers?.[matchId])
      if (isEnchoScore || nextScore.left >= 2 || nextScore.right >= 2) {
        const winner = isEnchoScore
          ? (side === 'left' ? match.left.entrant : match.right.entrant)
          : (nextScore.left >= 2 ? match.left.entrant : match.right.entrant)
        if (winner) {
          nextResults = { ...current.results, [matchId]: winner.id }
          nextTimers = stopTimerInMap(current.timers, matchId)
        }
      } else if (current.results[matchId]) {
        // If a manually selected result exists, scoring has not decided this match yet.
        nextResults = { ...current.results }
        delete nextResults[matchId]
      }

      return {
        ...current,
        scores: { ...(current.scores ?? {}), [matchId]: nextScore },
        scoreEvents: appendScoreEvent(current.scoreEvents, matchId, { side, amount }),
        results: nextResults,
        timers: nextTimers,
        updatedAt: new Date().toISOString(),
      }
    })
  }

  function handleUndoScore(matchId: string, side: ScoreSide) {
    onChange((current) => {
      const currentEntrants = toTournamentEntrants(current.kind, current.singles, current.teams)
      const currentBracket = currentEntrants.length >= 2
        ? buildTournamentBracket(currentEntrants, current.format, current.results)
        : null

      const allMatches = currentBracket
        ? [...currentBracket.winnersRounds, ...currentBracket.losersRounds, ...currentBracket.finalRounds]
            .flatMap((r) => r.matches)
        : []
      const match = allMatches.find((m) => m.id === matchId)
      if (!match || match.isAutoAdvance) return current

      const existing = (current.scores ?? {})[matchId] ?? { left: 0, right: 0 }
      const undoAmount = getUndoAmount(current.scoreEvents, matchId, side, existing[side])
      if (!undoAmount) return current

      const nextSideScore = Math.max(0, existing[side] - undoAmount)
      const nextScore = { ...existing, [side]: nextSideScore }

      let nextResults = current.results
      if (nextScore.left >= 2 || nextScore.right >= 2) {
        const winner = nextScore.left >= 2 ? match.left.entrant : match.right.entrant
        if (winner) {
          nextResults = { ...current.results, [matchId]: winner.id }
        }
      } else if (current.results[matchId]) {
        nextResults = { ...current.results }
        delete nextResults[matchId]
      }

      return {
        ...current,
        scores: { ...(current.scores ?? {}), [matchId]: nextScore },
        scoreEvents: removeLastScoreEvent(current.scoreEvents, matchId, side),
        results: nextResults,
        updatedAt: new Date().toISOString(),
      }
    })
  }

  function handleResetScore(matchId: string) {
    onChange((current) => {
      const remainingScores = { ...(current.scores ?? {}) }
      const remainingResults = { ...current.results }
      const remainingTimers = { ...(current.timers ?? {}) }
      delete remainingScores[matchId]
      delete remainingResults[matchId]
      delete remainingTimers[matchId]
      return {
        ...current,
        scores: remainingScores,
        scoreEvents: removeScoreEventKey(current.scoreEvents, matchId),
        results: remainingResults,
        timers: remainingTimers,
        updatedAt: new Date().toISOString(),
      }
    })
  }

  function handleAddBoutScore(matchId: string, boutIndex: number, side: ScoreSide, amount: ScoreAwardAmount) {
    onChange((current) => {
      // Always recompute from current state to avoid stale closures
      const currentEntrants = toTournamentEntrants(current.kind, current.singles, current.teams)
      const currentBracket = currentEntrants.length >= 2
        ? buildTournamentBracket(currentEntrants, current.format, current.results)
        : null
      const allMatches = currentBracket
        ? [...currentBracket.winnersRounds, ...currentBracket.losersRounds, ...currentBracket.finalRounds]
            .flatMap((r) => r.matches)
        : []
      const match = allMatches.find((m) => m.id === matchId)
      if (!match || match.isAutoAdvance) return current

      const boutKey = getBoutKey(matchId, boutIndex)
      const existing = (current.scores ?? {})[boutKey] ?? { left: 0, right: 0 }
      if (existing.left >= 2 || existing.right >= 2) return current

      const nextSideScore = Math.max(0, existing[side] + amount)
      const nextBoutScore = { ...existing, [side]: nextSideScore }
      const nextScores = { ...(current.scores ?? {}), [boutKey]: nextBoutScore }
      const nextScoreEvents = appendScoreEvent(current.scoreEvents, boutKey, { side, amount })
      let nextTimers = current.timers ?? {}

      if (nextBoutScore.left >= 2 || nextBoutScore.right >= 2) {
        nextTimers = stopTimerInMap(nextTimers, boutKey)
      }

      // Determine team match winner from all bout scores (with updated score)
      const leftTeam = current.teams.find((t) => t.id === match.left.entrant?.id)
      const rightTeam = current.teams.find((t) => t.id === match.right.entrant?.id)
      const boutsTotal = Math.min(leftTeam?.members.length ?? 0, rightTeam?.members.length ?? 0)
      const boutScoresList = Array.from({ length: boutsTotal }, (_, i) => nextScores[getBoutKey(matchId, i)])
      const matchDurationSeconds = current.matchDurationSeconds ?? DEFAULT_MATCH_DURATION_SECONDS
      const boutCompletionList = Array.from({ length: boutsTotal }, (_, i) =>
        isTeamBoutComplete(boutScoresList[i], nextTimers[getBoutKey(matchId, i)], matchDurationSeconds),
      )
      const stats = computeTeamStats(boutScoresList, boutsTotal, boutCompletionList)

      let nextResults = current.results
      if (stats.teamWinner !== null) {
        const winnerEntrant = stats.teamWinner === 'left' ? match.left.entrant : match.right.entrant
        if (winnerEntrant) {
          nextResults = { ...current.results, [matchId]: winnerEntrant.id }
          nextTimers = stopMatchTimers(nextTimers, matchId)
        }
      } else if (current.results[matchId]) {
        // Match no longer has a determined winner — clear so bracket re-opens it.
        nextResults = { ...current.results }
        delete nextResults[matchId]
      }

      return {
        ...current,
        scores: nextScores,
        scoreEvents: nextScoreEvents,
        results: nextResults,
        timers: nextTimers,
        updatedAt: new Date().toISOString(),
      }
    })
  }

  function handleUndoBoutScore(matchId: string, boutIndex: number, side: ScoreSide) {
    onChange((current) => {
      const currentEntrants = toTournamentEntrants(current.kind, current.singles, current.teams)
      const currentBracket = currentEntrants.length >= 2
        ? buildTournamentBracket(currentEntrants, current.format, current.results)
        : null
      const allMatches = currentBracket
        ? [...currentBracket.winnersRounds, ...currentBracket.losersRounds, ...currentBracket.finalRounds]
            .flatMap((r) => r.matches)
        : []
      const match = allMatches.find((m) => m.id === matchId)
      if (!match || match.isAutoAdvance) return current

      const boutKey = getBoutKey(matchId, boutIndex)
      const existing = (current.scores ?? {})[boutKey] ?? { left: 0, right: 0 }
      const undoAmount = getUndoAmount(current.scoreEvents, boutKey, side, existing[side])
      if (!undoAmount) return current

      const nextSideScore = Math.max(0, existing[side] - undoAmount)
      const nextBoutScore = { ...existing, [side]: nextSideScore }
      const nextScores = { ...(current.scores ?? {}), [boutKey]: nextBoutScore }
      const nextScoreEvents = removeLastScoreEvent(current.scoreEvents, boutKey, side)
      let nextTimers = current.timers ?? {}

      const leftTeam = current.teams.find((t) => t.id === match.left.entrant?.id)
      const rightTeam = current.teams.find((t) => t.id === match.right.entrant?.id)
      const boutsTotal = Math.min(leftTeam?.members.length ?? 0, rightTeam?.members.length ?? 0)
      const boutScoresList = Array.from({ length: boutsTotal }, (_, i) => nextScores[getBoutKey(matchId, i)])
      const matchDurationSeconds = current.matchDurationSeconds ?? DEFAULT_MATCH_DURATION_SECONDS
      const boutCompletionList = Array.from({ length: boutsTotal }, (_, i) =>
        isTeamBoutComplete(boutScoresList[i], nextTimers[getBoutKey(matchId, i)], matchDurationSeconds),
      )
      const stats = computeTeamStats(boutScoresList, boutsTotal, boutCompletionList)

      let nextResults = current.results
      if (stats.teamWinner !== null) {
        const winnerEntrant = stats.teamWinner === 'left' ? match.left.entrant : match.right.entrant
        if (winnerEntrant) {
          nextResults = { ...current.results, [matchId]: winnerEntrant.id }
          nextTimers = stopMatchTimers(nextTimers, matchId)
        }
      } else if (current.results[matchId]) {
        nextResults = { ...current.results }
        delete nextResults[matchId]
      }

      return {
        ...current,
        scores: nextScores,
        scoreEvents: nextScoreEvents,
        results: nextResults,
        timers: nextTimers,
        updatedAt: new Date().toISOString(),
      }
    })
  }

  function handleResetTeamScore(matchId: string) {
    onChange((current) => {
      // Remove all bout score keys for this match
      const nextScores = Object.fromEntries(
        Object.entries(current.scores ?? {}).filter(([key]) => !key.startsWith(`${matchId}:bout:`)),
      )
      const nextTimers = Object.fromEntries(
        Object.entries(current.timers ?? {}).filter(([key]) => key !== matchId && !key.startsWith(`${matchId}:bout:`)),
      )
      const remainingResults = { ...current.results }
      delete remainingResults[matchId]
      return {
        ...current,
        scores: nextScores,
        scoreEvents: removeScoreEventKeysByPrefix(current.scoreEvents, `${matchId}:bout:`),
        results: remainingResults,
        timers: nextTimers,
        updatedAt: new Date().toISOString(),
      }
    })
  }

  function handleReorderMatchLineup(matchId: string, side: 'left' | 'right', memberId: string, toIndex: number) {
    onChange((current) => {
      const currentEntrants = toTournamentEntrants(current.kind, current.singles, current.teams)
      const currentBracket = currentEntrants.length >= 2
        ? buildTournamentBracket(currentEntrants, current.format, current.results)
        : null
      const allMatches = currentBracket
        ? [...currentBracket.winnersRounds, ...currentBracket.losersRounds, ...currentBracket.finalRounds]
            .flatMap((r) => r.matches)
        : []
      const match = allMatches.find((m) => m.id === matchId)
      if (!match) return current

      const teamId = side === 'left' ? match.left.entrant?.id : match.right.entrant?.id
      if (!teamId) return current

      const team = current.teams.find((t) => t.id === teamId)
      if (!team) return current

      const currentOrder = current.lineups?.[matchId]?.[side] ?? team.members.map((m) => m.id)
      const nextOrder = reorderByIndex(currentOrder.map((id) => ({ id })), memberId, toIndex).map((item) => item.id)

      return {
        ...current,
        lineups: {
          ...(current.lineups ?? {}),
          [matchId]: {
            ...(current.lineups?.[matchId] ?? { left: team.members.map((m) => m.id), right: team.members.map((m) => m.id) }),
            [side]: nextOrder,
          },
        },
        updatedAt: new Date().toISOString(),
      }
    })
  }

  function handleTimerStart(key: string) {
    onChange((current) => {
      const durationMs = (current.matchDurationSeconds ?? DEFAULT_MATCH_DURATION_SECONDS) * 1000
      const existing = current.timers?.[key]
      const remainingMs = existing
        ? (existing.runningSince != null
          ? Math.max(0, existing.remainingMs - (Date.now() - existing.runningSince))
          : existing.remainingMs)
        : durationMs
      if (remainingMs <= 0) return current
      return {
        ...current,
        timers: {
          ...(current.timers ?? {}),
          [key]: { ...existing, remainingMs, runningSince: Date.now() },
        },
        updatedAt: new Date().toISOString(),
      }
    })
  }

  function handleTimerPause(key: string) {
    onChange((current) => {
      const existing = current.timers?.[key]
      if (!existing || existing.runningSince == null) return current
      const remainingMs = Math.max(0, existing.remainingMs - (Date.now() - existing.runningSince))
      return {
        ...current,
        timers: {
          ...(current.timers ?? {}),
          [key]: { ...existing, remainingMs, runningSince: null },
        },
        updatedAt: new Date().toISOString(),
      }
    })
  }

  function handleTimerReset(key: string) {
    onChange((current) => {
      const existing = current.timers?.[key]
      if (isEnchoTimer(existing)) {
        const durationMs = (current.matchDurationSeconds ?? DEFAULT_MATCH_DURATION_SECONDS) * 1000
        return {
          ...current,
          timers: {
            ...(current.timers ?? {}),
            [key]: { ...existing, remainingMs: durationMs, runningSince: null },
          },
          updatedAt: new Date().toISOString(),
        }
      }

      const rest = { ...(current.timers ?? {}) }
      delete rest[key]
      return {
        ...current,
        timers: rest,
        updatedAt: new Date().toISOString(),
      }
    })
  }

  function handleTimerExpire(key: string) {
    onChange((current) => {
      const existing = current.timers?.[key]
      const boutMatchInfo = getBoutMatchInfo(key)
      if (existing && existing.runningSince == null && existing.remainingMs <= 0 && !(current.kind === 'single' && !boutMatchInfo)) {
        return current
      }

      let nextTimers = {
        ...(current.timers ?? {}),
        [key]: { remainingMs: 0, runningSince: null },
      }
      let nextResults = current.results

      if (current.kind === 'single' && !boutMatchInfo) {
        const currentEntrants = toTournamentEntrants(current.kind, current.singles, current.teams)
        const currentBracket = currentEntrants.length >= 2
          ? buildTournamentBracket(currentEntrants, current.format, current.results)
          : null
        const allMatches = currentBracket
          ? [...currentBracket.winnersRounds, ...currentBracket.losersRounds, ...currentBracket.finalRounds]
              .flatMap((r) => r.matches)
          : []
        const match = allMatches.find((m) => m.id === key)

        if (match && !match.isAutoAdvance && !match.isComplete) {
          const scoreLeader = getScoreLeader((current.scores ?? {})[key])
          const winnerEntrant =
            scoreLeader === 'left'
              ? match.left.entrant
              : scoreLeader === 'right'
                ? match.right.entrant
                : null

          if (winnerEntrant) {
            nextResults = { ...current.results, [key]: winnerEntrant.id }
          } else {
            if (current.results[key]) {
              nextResults = { ...current.results }
              delete nextResults[key]
            }
            const durationMs = (current.matchDurationSeconds ?? DEFAULT_MATCH_DURATION_SECONDS) * 1000
            nextTimers = {
              ...nextTimers,
              [key]: { remainingMs: durationMs, runningSince: null, phase: 'encho' },
            }
          }
        }
      } else if (current.kind === 'team' && boutMatchInfo) {
        const { matchId } = boutMatchInfo
        const currentEntrants = toTournamentEntrants(current.kind, current.singles, current.teams)
        const currentBracket = currentEntrants.length >= 2
          ? buildTournamentBracket(currentEntrants, current.format, current.results)
          : null
        const allMatches = currentBracket
          ? [...currentBracket.winnersRounds, ...currentBracket.losersRounds, ...currentBracket.finalRounds]
              .flatMap((r) => r.matches)
          : []
        const match = allMatches.find((m) => m.id === matchId)

        if (match && !match.isAutoAdvance) {
          const leftTeam = current.teams.find((t) => t.id === match.left.entrant?.id)
          const rightTeam = current.teams.find((t) => t.id === match.right.entrant?.id)
          const boutsTotal = Math.min(leftTeam?.members.length ?? 0, rightTeam?.members.length ?? 0)
          const boutScoresList = Array.from({ length: boutsTotal }, (_, i) => (current.scores ?? {})[getBoutKey(matchId, i)])
          const matchDurationSeconds = current.matchDurationSeconds ?? DEFAULT_MATCH_DURATION_SECONDS
          const boutCompletionList = Array.from({ length: boutsTotal }, (_, i) =>
            isTeamBoutComplete(boutScoresList[i], nextTimers[getBoutKey(matchId, i)], matchDurationSeconds),
          )
          const stats = computeTeamStats(boutScoresList, boutsTotal, boutCompletionList)

          if (stats.teamWinner !== null) {
            const winnerEntrant = stats.teamWinner === 'left' ? match.left.entrant : match.right.entrant
            if (winnerEntrant) {
              nextResults = { ...current.results, [matchId]: winnerEntrant.id }
              nextTimers = stopMatchTimers(nextTimers, matchId)
            }
          } else if (current.results[matchId]) {
            nextResults = { ...current.results }
            delete nextResults[matchId]
          }
        }
      }

      return {
        ...current,
        results: nextResults,
        timers: nextTimers,
        updatedAt: new Date().toISOString(),
      }
    })
  }

  function handleSetMatchDuration(seconds: number) {
    onChange((current) => ({
      ...current,
      matchDurationSeconds: Math.max(1, Math.round(seconds)),
      updatedAt: new Date().toISOString(),
    }))
  }

  function handleResetBracket() {
    if (!window.confirm('Reset bracket results, scores, and timers for this tournament?')) return
    onChange((current) => ({
      ...current,
      results: {},
      scores: {},
      scoreEvents: {},
      timers: {},
      updatedAt: new Date().toISOString(),
    }))
  }

  function handleSelectWinner(matchId: string, entrantId: string) {
    onChange((current) => {
      const isClearingWinner = current.results[matchId] === entrantId
      return {
        ...current,
        results: {
          ...current.results,
          [matchId]: isClearingWinner ? '' : entrantId,
        },
        timers: isClearingWinner ? current.timers : stopMatchTimers(current.timers, matchId),
        updatedAt: new Date().toISOString(),
      }
    })
  }

  // Find the currently running timer (if any). Used to disable Start on every
  // other timer so only one match can be running at a time.
  const activeTimerKey = (() => {
    const timers = tournament.timers ?? {}
    const dSec = tournament.matchDurationSeconds ?? DEFAULT_MATCH_DURATION_SECONDS
    for (const [key, t] of Object.entries(timers)) {
      if (t.runningSince != null && getTimerRemainingMs(t, dSec) > 0) return key
    }
    return null
  })()

  const [settingsOpen, setSettingsOpen] = useState(false)
  const [graphOpen, setGraphOpen] = useState(false)
  const nextBoutScoreboardHref =
    nextPendingMatch?.left.entrant && nextPendingMatch.right.entrant
      ? `${import.meta.env.BASE_URL}tournaments/${tournament.id}/match/${nextPendingMatch.id}/scoreboard`
      : null
  const nextBoutScoreboardReady = nextPendingMatch
    ? hasMatchTimerStarted(nextPendingMatch.id, tournament.timers, tournament.kind)
    : false
  const nextBoutStripInfo = nextPendingMatch ? getNextBoutStripInfo(tournament, nextPendingMatch) : null

  useEffect(() => {
    if (!settingsOpen) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setSettingsOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [settingsOpen])

  useEffect(() => {
    const nextMatchId = nextPendingMatch?.id ?? null
    const previousNextMatchId = previousNextMatchIdRef.current
    previousNextMatchIdRef.current = nextMatchId

    if (previousNextMatchId === undefined || previousNextMatchId === nextMatchId || !nextMatchId || !hasStarted) {
      return
    }

    window.requestAnimationFrame(() => {
      scrollToNextBoutCard()
    })
  }, [hasStarted, nextPendingMatch?.id])

  return (
    <>
      <div className="workbench-sticky-stack">
        <header className="workbench-header">
          <Link
            to="/"
            className="workbench-back-btn"
            title="Back to tournaments"
            aria-label="Back to tournaments"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <path
                d="M9.8 3.2 5 8l4.8 4.8"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </Link>
          <div className="workbench-title-block">
            <p className="workbench-eyebrow">
              <span className="kanji-kicker">{getTournamentKindKanji(tournament.kind)}</span>
              {tournament.kind === 'single' ? 'Individual bracket' : 'Team shiai'}
              {' · '}
              <span className="kanji-kicker">{getTournamentFormatKanji(tournament.format)}</span>
              {tournament.format === 'single' ? 'Single knockout' : 'Double knockout'}
            </p>
            <h1>{tournament.name}</h1>
          </div>
          <div className="workbench-header-right">
            <div
              className="workbench-status"
              data-status-kanji={bracket?.champion ? '優勝' : '次戦'}
              hidden={!!nextPendingMatch && !bracket?.champion}
            >
              <span className="status-label">{bracket?.champion ? 'Champion' : 'Next bout'}</span>
              <strong className="status-value">
                {bracket?.champion?.label ?? nextPendingMatch?.code ?? '—'}
              </strong>
            </div>
            <div className="workbench-controls">
              <button
                type="button"
                className="reset-bracket-btn"
                onClick={handleResetBracket}
                disabled={!hasStarted}
                title="Reset bracket"
                aria-label="Reset bracket"
              >
                <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                  <path
                    d="M3.2 8a4.8 4.8 0 1 0 1.45-3.43"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                  />
                  <path d="M2 2.6v3.6h3.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              {onDelete ? (
                <button
                  type="button"
                  className="delete-tournament-btn"
                  onClick={onDelete}
                  title="Delete tournament"
                  aria-label="Delete tournament"
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                    <path
                      d="M3.2 4.4h9.6M6.4 4.4V3.2h3.2v1.2M5 6.4l.45 6.2h5.1L11 6.4"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.45"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              ) : null}
              <button
                type="button"
                className="bracket-graph-btn"
                onClick={() => setGraphOpen(true)}
                title="View bracket graph"
                aria-label="View bracket graph"
              >
                <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                  <path
                    d="M2.4 3.2h3.2v2.4H2.4zM2.4 10.4h3.2v2.4H2.4zM10.4 6.8h3.2v2.4h-3.2z"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.2"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M5.6 4.4h1.6v3.6h3.2M5.6 11.6h1.6V8h3.2"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
              <button
                type="button"
                className="settings-icon-btn"
                onClick={() => setSettingsOpen(true)}
                title="Tournament settings"
                aria-label="Open tournament settings"
              >
                ⚙
              </button>
            </div>
          </div>
        </header>

        {nextPendingMatch && nextBoutStripInfo && !bracket?.champion ? (
          <section className="next-bout-strip" aria-label="Next bout">
            <div className="next-bout-strip-kanji" aria-hidden="true">次戦</div>
            <div className="next-bout-strip-main">
              <strong>{nextPendingMatch.code}</strong>
              <span className="next-bout-strip-names">
                {nextBoutStripInfo.position ? (
                  <em className="next-bout-strip-position">{nextBoutStripInfo.position}</em>
                ) : null}
                {nextBoutStripInfo.left}
                <span className="next-bout-strip-divider" aria-hidden="true">対</span>
                {nextBoutStripInfo.right}
              </span>
              {nextBoutStripInfo.detail ? (
                <span className="next-bout-strip-detail">{nextBoutStripInfo.detail}</span>
              ) : null}
            </div>
            <div className="next-bout-strip-actions">
              <button
                type="button"
                className="next-bout-strip-btn"
                onClick={scrollToNextBoutCard}
                title="Jump to next bout"
                aria-label="Jump to next bout"
              >
                <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                  <path d="M8 3.2v8.9" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
                  <path d="M4.7 8.9 8 12.2l3.3-3.3" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              {nextBoutScoreboardHref && nextBoutScoreboardReady ? (
                <a
                  className="next-bout-strip-btn"
                  href={nextBoutScoreboardHref}
                  target="_blank"
                  rel="noreferrer"
                  title="Open scoreboard"
                  aria-label="Open scoreboard"
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                    <path d="M5.2 4.2H3.4v8.4h8.4v-1.8" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M8.1 3.4h4.5v4.5" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="m7.4 8.6 5-5" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" />
                  </svg>
                </a>
              ) : nextBoutScoreboardHref ? (
                <span
                  className="next-bout-strip-btn is-disabled"
                  aria-disabled="true"
                  title="Start the timer to open scoreboard"
                  aria-label="Scoreboard unavailable until timer starts"
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                    <path d="M5.2 4.2H3.4v8.4h8.4v-1.8" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M8.1 3.4h4.5v4.5" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="m7.4 8.6 5-5" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" />
                  </svg>
                </span>
              ) : null}
            </div>
          </section>
        ) : null}
      </div>

      {graphOpen ? (
        <TournamentGraphModal
          tournament={tournament}
          onClose={() => setGraphOpen(false)}
          onSelectMatch={(matchId) => {
            setGraphOpen(false)
            window.requestAnimationFrame(() => scrollToMatchCard(matchId))
          }}
        />
      ) : null}

      {/* Settings drawer */}
      {settingsOpen ? (
        <div className="settings-overlay" onClick={() => setSettingsOpen(false)}>
          <aside className="settings-drawer" onClick={(e) => e.stopPropagation()}>
            <div className="settings-drawer-header">
              <h2>Tournament settings</h2>
              <button
                type="button"
                className="settings-close-btn"
                onClick={() => setSettingsOpen(false)}
                aria-label="Close settings"
              >✕</button>
            </div>

            <div className="settings-drawer-body">
              <label className="field-block">
                <span>Tournament name</span>
                <input
                  value={tournament.name}
                  readOnly={hasStarted}
                  onChange={(event) =>
                    !hasStarted && onChange((current) => ({ ...current, name: event.target.value }))
                  }
                  placeholder="Autumn Kendo Cup"
                />
              </label>

              <div className="toggle-group">
                <span>Event type</span>
                <div className="pill-row">
                  <button
                    type="button"
                    className={tournament.kind === 'single' ? 'is-active' : ''}
                    disabled
                  >
                    Single
                  </button>
                  <button
                    type="button"
                    className={tournament.kind === 'team' ? 'is-active' : ''}
                    disabled
                  >
                    Team
                  </button>
                </div>
              </div>

              <div className="toggle-group">
                <span>Knockout format</span>
                <div className="pill-row">
                  <button
                    type="button"
                    className={tournament.format === 'single' ? 'is-active' : ''}
                    disabled={hasStarted}
                    onClick={() => onChange((current) => ({ ...current, format: 'single' }))}
                  >
                    Single knockout
                  </button>
                  <button
                    type="button"
                    className={tournament.format === 'double' ? 'is-active' : ''}
                    disabled={hasStarted}
                    onClick={() => onChange((current) => ({ ...current, format: 'double' }))}
                  >
                    Double knockout
                  </button>
                </div>
              </div>

              <DurationField
                seconds={tournament.matchDurationSeconds ?? DEFAULT_MATCH_DURATION_SECONDS}
                onChange={handleSetMatchDuration}
                disabled={hasStarted}
              />

              {tournament.kind === 'single' ? (
                <SinglesEditor
                  singles={tournament.singles}
                  locked={hasStarted}
                  onUpdate={(id, name) =>
                    onChange((current) => ({
                      ...current,
                      singles: current.singles.map((entry) =>
                        entry.id === id ? { ...entry, name } : entry,
                      ),
                    }))
                  }
                  onAdd={() =>
                    onChange((current) => ({
                      ...current,
                      singles: [...current.singles, createSoloEntry()],
                    }))
                  }
                  onRemove={(id) =>
                    onChange((current) => ({
                      ...current,
                      singles: current.singles.filter((entry) => entry.id !== id),
                    }))
                  }
                />
              ) : (
                <TeamsEditor
                  teams={tournament.teams}
                  locked={hasStarted}
                  onUpdateTeam={(teamId, name) =>
                    onChange((current) => ({
                      ...current,
                      teams: current.teams.map((team) =>
                        team.id === teamId ? { ...team, name } : team,
                      ),
                    }))
                  }
                  onRemoveTeam={(teamId) =>
                    onChange((current) => ({
                      ...current,
                      teams: current.teams.filter((team) => team.id !== teamId),
                    }))
                  }
                  onAddTeam={() =>
                    onChange((current) => ({
                      ...current,
                      teams: [...current.teams, createTeamEntry()],
                    }))
                  }
                  onUpdateMember={(teamId, memberId, name) =>
                    onChange((current) => ({
                      ...current,
                      teams: current.teams.map((team) =>
                        team.id === teamId
                          ? {
                              ...team,
                              members: team.members.map((member) =>
                                member.id === memberId ? { ...member, name } : member,
                              ),
                            }
                          : team,
                      ),
                    }))
                  }
                  onRemoveMember={(teamId, memberId) =>
                    onChange((current) => ({
                      ...current,
                      teams: current.teams.map((team) =>
                        team.id === teamId
                          ? {
                              ...team,
                              members: team.members.filter((member) => member.id !== memberId),
                            }
                          : team,
                      ),
                    }))
                  }
                  onAddMember={(teamId) =>
                    onChange((current) => ({
                      ...current,
                      teams: current.teams.map((team) =>
                        team.id === teamId
                          ? { ...team, members: [...team.members, createTeamMember()] }
                          : team,
                      ),
                    }))
                  }
                />
              )}
            </div>
          </aside>
        </div>
      ) : null}

      <section className="workspace-grid">
        <section className="diagram-panel">
          {entrants.length < 2 ? (
            <p className="validation-note">
              Add at least two entrants in settings to generate the bracket.
            </p>
          ) : null}

          {bracket ? (
            <div className="panel-card bracket-panel">
              <div className="panel-heading bracket-heading">
                <div className="bracket-heading-meta">
                  <h2>Live bracket</h2>
                  <span className="bracket-meta-pills">
                    <span className="meta-pill">{entrants.length} entrants</span>
                    {nextPendingMatch && !bracket.champion
                      ? <span className="meta-pill">Next: {nextPendingMatch.code}</span>
                      : null}
                    {bracket.champion
                      ? <span className="meta-pill meta-pill-champion">Champion: {bracket.champion.label}</span>
                      : null}
                  </span>
                </div>
              </div>

              <RoundColumns
                title="Winners bracket"
                rounds={bracket.winnersRounds}
                nextMatchId={nextPendingMatch?.id}
                scores={scores}
                showScoring={showScoring}
                teams={teamScoringTeams}
                lineups={teamLineups}
                tournamentId={tournament.id}
                onSelectWinner={handleSelectWinner}
                onAddScore={handleAddScore}
                onUndoScore={handleUndoScore}
                onResetScore={handleResetScore}
                onAddBoutScore={handleAddBoutScore}
                onUndoBoutScore={handleUndoBoutScore}
                onResetTeamScore={handleResetTeamScore}
                onReorderMatchLineup={handleReorderMatchLineup}
                timers={tournament.timers ?? {}}
                durationSeconds={tournament.matchDurationSeconds ?? DEFAULT_MATCH_DURATION_SECONDS}
                activeTimerKey={activeTimerKey}
                onTimerStart={handleTimerStart}
                onTimerPause={handleTimerPause}
                onTimerReset={handleTimerReset}
                onTimerExpire={handleTimerExpire}
              />
              <RoundColumns
                title="Losers bracket"
                rounds={bracket.losersRounds}
                nextMatchId={nextPendingMatch?.id}
                scores={scores}
                showScoring={showScoring}
                teams={teamScoringTeams}
                lineups={teamLineups}
                tournamentId={tournament.id}
                onSelectWinner={handleSelectWinner}
                onAddScore={handleAddScore}
                onUndoScore={handleUndoScore}
                onResetScore={handleResetScore}
                onAddBoutScore={handleAddBoutScore}
                onUndoBoutScore={handleUndoBoutScore}
                onResetTeamScore={handleResetTeamScore}
                onReorderMatchLineup={handleReorderMatchLineup}
                timers={tournament.timers ?? {}}
                durationSeconds={tournament.matchDurationSeconds ?? DEFAULT_MATCH_DURATION_SECONDS}
                activeTimerKey={activeTimerKey}
                onTimerStart={handleTimerStart}
                onTimerPause={handleTimerPause}
                onTimerReset={handleTimerReset}
                onTimerExpire={handleTimerExpire}
              />
              <RoundColumns
                title="Finals"
                rounds={bracket.finalRounds}
                nextMatchId={nextPendingMatch?.id}
                scores={scores}
                showScoring={showScoring}
                teams={teamScoringTeams}
                lineups={teamLineups}
                tournamentId={tournament.id}
                onSelectWinner={handleSelectWinner}
                onAddScore={handleAddScore}
                onUndoScore={handleUndoScore}
                onResetScore={handleResetScore}
                onAddBoutScore={handleAddBoutScore}
                onUndoBoutScore={handleUndoBoutScore}
                onResetTeamScore={handleResetTeamScore}
                onReorderMatchLineup={handleReorderMatchLineup}
                timers={tournament.timers ?? {}}
                durationSeconds={tournament.matchDurationSeconds ?? DEFAULT_MATCH_DURATION_SECONDS}
                activeTimerKey={activeTimerKey}
                onTimerStart={handleTimerStart}
                onTimerPause={handleTimerPause}
                onTimerReset={handleTimerReset}
                onTimerExpire={handleTimerExpire}
              />
            </div>
          ) : null}
        </section>
      </section>
    </>
  )
}

function TournamentDetailPage({
  tournaments,
  onUpdateTournament,
  onDeleteTournament,
}: {
  tournaments: TournamentRecord[]
  onUpdateTournament: (
    tournamentId: string,
    updater: (current: TournamentRecord) => TournamentRecord,
  ) => void
  onDeleteTournament: (tournamentId: string) => void
}) {
  const navigate = useNavigate()
  const { tournamentId } = useParams()
  const tournament = tournaments.find((entry) => entry.id === tournamentId)

  if (!tournament || !tournamentId) {
    return (
      <AppFrame
        action={
          <Link to="/" className="inline-link">
            Back to tournaments
          </Link>
        }
      >
        <div className="empty-card not-found-card">
          <h2>Tournament not found</h2>
          <p>The requested tournament no longer exists in local storage.</p>
        </div>
      </AppFrame>
    )
  }

  const handleDeleteTournament = () => {
    if (window.confirm('Delete this tournament from local storage?')) {
      onDeleteTournament(tournament.id)
      navigate('/')
    }
  }

  return (
    <AppFrame>
      <TournamentWorkbench
        tournament={tournament}
        onChange={(updater) => onUpdateTournament(tournament.id, updater)}
        onDelete={handleDeleteTournament}
      />
    </AppFrame>
  )
}

function MatchScoreboardPage({ tournaments }: { tournaments: TournamentRecord[] }) {
  const { tournamentId, matchId } = useParams<{ tournamentId: string; matchId: string }>()
  const tournament = tournaments.find((t) => t.id === tournamentId)

  useEffect(() => {
    document.body.classList.add('scoreboard-body')
    return () => { document.body.classList.remove('scoreboard-body') }
  }, [])

  if (!tournament || !matchId) {
    return (
      <main className="scoreboard scoreboard-empty">
        <p className="scoreboard-eyebrow">Scoreboard</p>
        <h1>Match not found</h1>
        <p className="scoreboard-hint">This tournament or match no longer exists.</p>
      </main>
    )
  }

  const entrants = toTournamentEntrants(tournament.kind, tournament.singles, tournament.teams)
  if (entrants.length < 2) {
    return (
      <main className="scoreboard scoreboard-empty">
        <p className="scoreboard-eyebrow">Scoreboard</p>
        <h1>Bracket not ready</h1>
      </main>
    )
  }

  const bracket = buildTournamentBracket(entrants, tournament.format, tournament.results)
  const allMatches = [
    ...bracket.winnersRounds,
    ...bracket.losersRounds,
    ...bracket.finalRounds,
  ].flatMap((r) => r.matches)
  const match = allMatches.find((m) => m.id === matchId)

  if (!match || !match.left.entrant || !match.right.entrant) {
    return (
      <main className="scoreboard scoreboard-empty">
        <p className="scoreboard-eyebrow">Scoreboard</p>
        <h1>Match not available</h1>
        <p className="scoreboard-hint">{tournament.name}</p>
      </main>
    )
  }

  const isTeam = tournament.kind === 'team'

  if (!isTeam) {
    const score = tournament.scores[match.id] ?? { left: 0, right: 0 }
    const winnerId = tournament.results[match.id]
    const singlesDuration = tournament.matchDurationSeconds ?? DEFAULT_MATCH_DURATION_SECONDS
    const singlesTimer = tournament.timers?.[match.id]
    return (
      <main className="scoreboard scoreboard-singles">
        <header className="scoreboard-top">
          <p className="scoreboard-eyebrow"><span className="kanji-kicker">試合</span>{tournament.name}</p>
          <h1>{match.title}</h1>
          <p className="scoreboard-code">
            {match.code}
            {' \u00b7 '}
            <ScoreboardClock timer={singlesTimer} durationSeconds={singlesDuration} />
          </p>
        </header>
        <section className="scoreboard-duel">
          <div className={`scoreboard-side${winnerId === match.left.entrant.id ? ' is-winner' : ''}`}>
            <span className="scoreboard-score">{score.left % 1 === 0 ? score.left : score.left.toFixed(1)}</span>
            <span className="scoreboard-name">{match.left.label}</span>
          </div>
          <div className="scoreboard-divider" aria-hidden="true">対</div>
          <div className={`scoreboard-side${winnerId === match.right.entrant.id ? ' is-winner' : ''}`}>
            <span className="scoreboard-score">{score.right % 1 === 0 ? score.right : score.right.toFixed(1)}</span>
            <span className="scoreboard-name">{match.right.label}</span>
          </div>
        </section>
        {winnerId ? (
          <p className="scoreboard-victor">
            勝者 — {winnerId === match.left.entrant.id ? match.left.label : match.right.label}
          </p>
        ) : (
          <p className="scoreboard-victor scoreboard-victor-pending">試合中</p>
        )}
      </main>
    )
  }

  // Team match
  const leftTeam = tournament.teams.find((t) => t.id === match.left.entrant!.id)
  const rightTeam = tournament.teams.find((t) => t.id === match.right.entrant!.id)
  const lineup = tournament.lineups?.[match.id]
  const leftMembers = resolveMatchLineup(leftTeam, lineup?.left)
  const rightMembers = resolveMatchLineup(rightTeam, lineup?.right)
  const boutsTotal = Math.min(leftMembers.length, rightMembers.length)
  const boutScores = Array.from({ length: boutsTotal }, (_, i) => tournament.scores?.[getBoutKey(match.id, i)])
  const durationSeconds = tournament.matchDurationSeconds ?? DEFAULT_MATCH_DURATION_SECONDS
  const boutTimers = Array.from({ length: boutsTotal }, (_, i) => tournament.timers?.[getBoutKey(match.id, i)])
  const boutCompletionList = Array.from({ length: boutsTotal }, (_, i) =>
    isTeamBoutComplete(boutScores[i], boutTimers[i], durationSeconds),
  )
  const stats = computeTeamStats(boutScores, boutsTotal, boutCompletionList)
  const winnerId = tournament.results?.[match.id]
  const fmt = (n: number) => (n % 1 === 0 ? String(n) : n.toFixed(1))
  // A bout is "done" if a winner is decided OR the timer has expired (drawn).
  const currentBoutIndex = boutScores.findIndex((s, i) => {
    const decided = s && (s.left >= 2 || s.right >= 2)
    const expired = isTimerExpired(boutTimers[i], durationSeconds)
    return !decided && !expired
  })

  // Default to the current bout, but fall back to the last bout once everything is done.
  const focusBoutIndex = currentBoutIndex >= 0 && currentBoutIndex < boutsTotal
    ? currentBoutIndex
    : boutsTotal - 1
  const focusBout = focusBoutIndex >= 0 ? (boutScores[focusBoutIndex] ?? { left: 0, right: 0 }) : null
  const focusLeftPlayer = focusBoutIndex >= 0 ? leftMembers[focusBoutIndex] : undefined
  const focusRightPlayer = focusBoutIndex >= 0 ? rightMembers[focusBoutIndex] : undefined
  const focusLeftWon = focusBout ? focusBout.left >= 2 && focusBout.left > focusBout.right : false
  const focusRightWon = focusBout ? focusBout.right >= 2 && focusBout.right > focusBout.left : false
  const isLive = currentBoutIndex >= 0 && currentBoutIndex < boutsTotal
  const focusLabel = focusBoutIndex >= 0
    ? `${isLive ? '進行中' : '最終戦'} \u00b7 ${getKendoPosition(focusBoutIndex, boutsTotal)}`
    : ''

  return (
    <main className="scoreboard scoreboard-team">
      <header className="scoreboard-top">
        <p className="scoreboard-eyebrow"><span className="kanji-kicker">団体戦</span>{tournament.name} &middot; {match.title}</p>
        <h1>
          <span className="scoreboard-team-name">{match.left.label}</span>
          <span className="scoreboard-team-vs"> 対 </span>
          <span className="scoreboard-team-name">{match.right.label}</span>
        </h1>
        <p className="scoreboard-code">
          {match.code}{focusLabel ? ` \u2014 ${focusLabel}` : ''}
          {focusBoutIndex >= 0 ? (
            <>
              {' \u00b7 '}
              <ScoreboardClock timer={boutTimers[focusBoutIndex]} durationSeconds={durationSeconds} />
            </>
          ) : null}
        </p>
      </header>

      {focusBout ? (
        <section className="scoreboard-duel">
          <div className={`scoreboard-side${focusLeftWon ? ' is-winner' : ''}`}>
            <span className="scoreboard-score">{fmt(focusBout.left)}</span>
            <span className="scoreboard-name">{focusLeftPlayer?.name.trim() || 'Open slot'}</span>
            <span className="scoreboard-subscore">{match.left.label}</span>
          </div>
          <div className="scoreboard-divider" aria-hidden="true">対</div>
          <div className={`scoreboard-side${focusRightWon ? ' is-winner' : ''}`}>
            <span className="scoreboard-score">{fmt(focusBout.right)}</span>
            <span className="scoreboard-name">{focusRightPlayer?.name.trim() || 'Open slot'}</span>
            <span className="scoreboard-subscore">{match.right.label}</span>
          </div>
        </section>
      ) : null}

      <section className="scoreboard-bottom-strip">
        <section className="scoreboard-team-tally">
          <div className={`scoreboard-team-tally-side${winnerId === match.left.entrant.id || stats.teamWinner === 'left' ? ' is-winner' : ''}`}>
            <span className="scoreboard-team-tally-wins">{stats.leftWins}</span>
            <span className="scoreboard-team-tally-label">{match.left.label}</span>
            <span className="scoreboard-team-tally-sub">{fmt(stats.leftTotal)} ippons</span>
          </div>
          <span className="scoreboard-team-tally-mid">団体</span>
          <div className={`scoreboard-team-tally-side${winnerId === match.right.entrant.id || stats.teamWinner === 'right' ? ' is-winner' : ''}`}>
            <span className="scoreboard-team-tally-wins">{stats.rightWins}</span>
            <span className="scoreboard-team-tally-label">{match.right.label}</span>
            <span className="scoreboard-team-tally-sub">{fmt(stats.rightTotal)} ippons</span>
          </div>
        </section>

        <section className="scoreboard-bouts">
          {Array.from({ length: boutsTotal }, (_, i) => {
            const s = boutScores[i] ?? { left: 0, right: 0 }
            const leftWon = s.left >= 2 && s.left > s.right
            const rightWon = s.right >= 2 && s.right > s.left
            const done = isTeamBoutComplete(s, boutTimers[i], durationSeconds)
            return (
              <div key={i} className={`scoreboard-bout-row${i === currentBoutIndex ? ' is-current' : ''}${done ? ' is-done' : ''}`}>
                <span className="scoreboard-bout-pos">{getKendoPosition(i, boutsTotal)}</span>
                <span className={`scoreboard-bout-cell${leftWon ? ' is-winner' : ''}`}>
                  {leftMembers[i]?.name.trim() || 'Open slot'}
                </span>
                <span className="scoreboard-bout-cell-score">{fmt(s.left)} &ndash; {fmt(s.right)}</span>
                <span className={`scoreboard-bout-cell scoreboard-bout-cell-right${rightWon ? ' is-winner' : ''}`}>
                  {rightMembers[i]?.name.trim() || 'Open slot'}
                </span>
              </div>
            )
          })}
        </section>
      </section>

      {winnerId ? (
        <p className="scoreboard-victor">
          勝者 &mdash; {winnerId === match.left.entrant.id ? match.left.label : match.right.label}
        </p>
      ) : null}
    </main>
  )
}

function App() {
  const [pwaUpdate, setPwaUpdate] = useState<(() => void) | null>(null)
  const [tournaments, setTournaments] = useState<TournamentRecord[]>(() => {
    if (typeof window === 'undefined') {
      return []
    }

    try {
      const stored = window.localStorage.getItem(TOURNAMENT_STORAGE_KEY)
      if (!stored) {
        return []
      }

      const parsed = JSON.parse(stored)
      if (!Array.isArray(parsed)) {
        return []
      }

      const records = parsed as TournamentRecord[]
      if (isLegacySeedData(records)) {
        window.localStorage.removeItem(TOURNAMENT_STORAGE_KEY)
        return []
      }

      return records
    } catch {
      return []
    }
  })

  useEffect(() => {
    window.localStorage.setItem(TOURNAMENT_STORAGE_KEY, JSON.stringify(tournaments))
  }, [tournaments])

  useEffect(() => subscribeToPwaUpdates((applyUpdate) => {
    setPwaUpdate(() => applyUpdate)
  }), [])

  // Cross-tab sync: when another tab (e.g. the scoreboard tab) writes to
  // localStorage, refresh local state so the scoreboard updates live.
  useEffect(() => {
    function handleStorage(event: StorageEvent) {
      if (event.key !== TOURNAMENT_STORAGE_KEY || !event.newValue) return
      try {
        const parsed = JSON.parse(event.newValue)
        if (Array.isArray(parsed)) {
          setTournaments(parsed as TournamentRecord[])
        }
      } catch {
        // ignore
      }
    }
    window.addEventListener('storage', handleStorage)
    return () => window.removeEventListener('storage', handleStorage)
  }, [])

  function createTournament(draft: TournamentDraft) {
    const record = createTournamentRecord({
      ...draft,
      singles: cloneSingles(draft.singles),
      teams: cloneTeams(draft.teams),
    })

    setTournaments((current) => [record, ...current])
    return record.id
  }

  function updateTournament(
    tournamentId: string,
    updater: (current: TournamentRecord) => TournamentRecord,
  ) {
    setTournaments((current) =>
      current.map((tournament) =>
        tournament.id === tournamentId
          ? {
              ...updater(tournament),
              updatedAt: new Date().toISOString(),
            }
          : tournament,
      ),
    )
  }

  function deleteTournament(tournamentId: string) {
    setTournaments((current) => current.filter((tournament) => tournament.id !== tournamentId))
  }

  return (
    <>
      <BrowserRouter basename={import.meta.env.BASE_URL}>
        <Routes>
          <Route path="/" element={<HomePage tournaments={tournaments} onDeleteTournament={deleteTournament} />} />
          <Route path="/docs" element={<DocsPage />} />
          <Route
            path="/tournaments/new"
            element={<TournamentWizard onCreateTournament={createTournament} />}
          />
          <Route
            path="/tournaments/:tournamentId"
            element={
              <TournamentDetailPage
                tournaments={tournaments}
                onUpdateTournament={updateTournament}
                onDeleteTournament={deleteTournament}
              />
            }
          />
          <Route
            path="/tournaments/:tournamentId/match/:matchId/scoreboard"
            element={<MatchScoreboardPage tournaments={tournaments} />}
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
      {pwaUpdate ? (
        <div className="pwa-update-toast" role="status" aria-live="polite">
          <div>
            <span>Update ready</span>
            <strong>Refresh to use the latest shiai desk.</strong>
          </div>
          <div className="pwa-update-actions">
            <button type="button" onClick={pwaUpdate}>Refresh</button>
            <button type="button" onClick={() => setPwaUpdate(null)} aria-label="Dismiss update">Dismiss</button>
          </div>
        </div>
      ) : null}
    </>
  )
}

export default App
