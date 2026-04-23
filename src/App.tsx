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
  type MatchScore,
  type MatchTimerState,
  toTournamentEntrants,
} from './app-model'

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

function getBoutKey(matchId: string, boutIndex: number): string {
  return `${matchId}:bout:${boutIndex}`
}

function getTimerRemainingMs(timer: MatchTimerState | undefined, durationSeconds: number): number {
  if (!timer) return durationSeconds * 1000
  if (timer.runningSince == null) return Math.max(0, timer.remainingMs)
  return Math.max(0, timer.remainingMs - (Date.now() - timer.runningSince))
}

function isTimerExpired(timer: MatchTimerState | undefined, durationSeconds: number): boolean {
  if (!timer) return false
  return getTimerRemainingMs(timer, durationSeconds) <= 0
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

function computeTeamStats(boutScores: Array<MatchScore | undefined>, boutsTotal: number) {
  let leftWins = 0
  let rightWins = 0
  let leftTotal = 0
  let rightTotal = 0
  let finishedBouts = 0

  for (const score of boutScores) {
    if (!score) continue
    leftTotal += score.left
    rightTotal += score.right
    if (score.left >= 2 || score.right >= 2) {
      finishedBouts++
      if (score.left > score.right) leftWins++
      else if (score.right > score.left) rightWins++
    }
  }

  const pendingBouts = Math.max(0, boutsTotal - finishedBouts)
  let teamWinner: 'left' | 'right' | null = null

  if (leftWins > rightWins + pendingBouts) {
    teamWinner = 'left'
  } else if (rightWins > leftWins + pendingBouts) {
    teamWinner = 'right'
  } else if (pendingBouts === 0 && leftWins === rightWins) {
    // All bouts finished and team score is tied — use ippon tally as tiebreaker
    if (leftTotal > rightTotal) teamWinner = 'left'
    else if (rightTotal > leftTotal) teamWinner = 'right'
    // else perfect tie — no auto-winner
  }

  return { leftWins, rightWins, leftTotal, rightTotal, finishedBouts, pendingBouts, teamWinner }
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
  return (
    <span className={`scoreboard-clock${isRunning ? ' is-running' : ''}${expired ? ' is-expired' : ''}`}>
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
  const [text, setText] = useState(formatTimerMs(seconds * 1000))
  useEffect(() => {
    setText(formatTimerMs(seconds * 1000))
  }, [seconds])
  return (
    <label className={`field-block duration-field${disabled ? ' is-disabled' : ''}`}>
      <span>{label}</span>
      <input
        type="text"
        inputMode="numeric"
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const next = parseDurationInput(text)
          if (next == null || next < 1) {
            setText(formatTimerMs(seconds * 1000))
          } else {
            onChange(next)
            setText(formatTimerMs(next * 1000))
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

function ScorePlate({
  score,
  side,
  disabled,
  canScore,
  onScore,
}: {
  score: number
  side: 'left' | 'right'
  disabled?: boolean
  canScore: boolean
  onScore: (amount: 0.5 | 1 | -0.5 | -1) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent) {
      if (!ref.current) return
      if (!ref.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const canUndoHalf = score > 0
  const canUndoFull = score >= 1

  function act(amount: 0.5 | 1 | -0.5 | -1) {
    onScore(amount)
    setOpen(false)
  }

  return (
    <div className={`score-plate score-plate-${side}`} ref={ref}>
      {/* Inline 4-button cluster — only visible inside the fullscreen bracket */}
      <div className={`score-plate-inline score-plate-inline-${side}`}>
        {side === 'left' ? <span className="score-plate-inline-value">{fmtScore(score)}</span> : null}
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
        <button
          type="button"
          className="score-plate-inline-btn is-undo"
          disabled={!canUndoHalf}
          onClick={() => onScore(-0.5)}
          title="Undo ½"
        >
          −½
        </button>
        <button
          type="button"
          className="score-plate-inline-btn is-undo"
          disabled={!canUndoFull}
          onClick={() => onScore(-1)}
          title="Undo 1"
        >
          −1
        </button>
        {side === 'right' ? <span className="score-plate-inline-value">{fmtScore(score)}</span> : null}
      </div>

      {/* Default popover trigger — hidden in fullscreen */}
      <div className="score-plate-popover">
        <button
          type="button"
          className={`score-plate-trigger${open ? ' is-open' : ''}`}
          disabled={disabled && !canUndoHalf}
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={open}
          title="Adjust score"
        >
          <span className="score-plate-value">{fmtScore(score)}</span>
          <span className="score-plate-caret" aria-hidden="true">▾</span>
        </button>
        {open ? (
          <div className={`score-plate-menu score-plate-menu-${side}`} role="menu">
            <p className="score-plate-menu-label">Award point</p>
            <div className="score-plate-row">
              <button
                type="button"
                className="score-plate-action is-primary"
                disabled={!canScore}
                onClick={() => act(1)}
              >
                <span className="score-plate-action-label">Ippon</span>
                <span className="score-plate-action-amt">+1</span>
              </button>
              <button
                type="button"
                className="score-plate-action"
                disabled={!canScore}
                onClick={() => act(0.5)}
              >
                <span className="score-plate-action-label">Half</span>
                <span className="score-plate-action-amt">+½</span>
              </button>
            </div>
            <p className="score-plate-menu-label is-undo">Undo</p>
            <div className="score-plate-row">
              <button
                type="button"
                className="score-plate-action is-undo"
                disabled={!canUndoFull}
                onClick={() => act(-1)}
              >
                <span className="score-plate-action-label">Ippon</span>
                <span className="score-plate-action-amt">−1</span>
              </button>
              <button
                type="button"
                className="score-plate-action is-undo"
                disabled={!canUndoHalf}
                onClick={() => act(-0.5)}
              >
                <span className="score-plate-action-label">Half</span>
                <span className="score-plate-action-amt">−½</span>
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function MatchTimer({
  timer,
  durationSeconds,
  locked,
  disableStart,
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
  onStart: () => void
  onPause: () => void
  onReset: () => void
  onExpire: () => void
  compact?: boolean
}) {
  const [, setTick] = useState(0)
  const isRunning = timer?.runningSince != null
  const remaining = getTimerRemainingMs(timer, durationSeconds)
  const expired = remaining <= 0 && timer != null

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
    <div className={`match-timer${expired ? ' is-expired' : ''}${isRunning ? ' is-running' : ''}${compact ? ' is-compact' : ''}`}>
      <span className="match-timer-display">{formatTimerMs(remaining)}</span>
      {!locked ? (
        <div className="match-timer-controls">
          {!expired && !isRunning ? (
            <button
              type="button"
              className="timer-btn timer-btn-icon"
              onClick={onStart}
              disabled={disableStart}
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
              className="timer-btn timer-btn-icon"
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
              disabled={disableStart}
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
  tournamentId,
  timer,
  durationSeconds,
  disableStartIfOtherActive,
  onSelectWinner,
  onAddScore,
  onResetScore,
  onTimerStart,
  onTimerPause,
  onTimerReset,
  onTimerExpire,
}: {
  match: BracketMatch
  matchScore?: MatchScore
  showScoring?: boolean
  tournamentId?: string
  timer?: MatchTimerState
  durationSeconds: number
  disableStartIfOtherActive?: boolean
  onSelectWinner: (matchId: string, entrantId: string) => void
  onAddScore?: (matchId: string, side: 'left' | 'right', amount: 0.5 | 1 | -0.5 | -1) => void
  onResetScore?: (matchId: string) => void
  onTimerStart?: (matchId: string) => void
  onTimerPause?: (matchId: string) => void
  onTimerReset?: (matchId: string) => void
  onTimerExpire?: (matchId: string) => void
}) {
  const canScore = showScoring && !match.isAutoAdvance
  const hasScore = matchScore && (matchScore.left > 0 || matchScore.right > 0)
  const timeExpired = isTimerExpired(timer, durationSeconds)
  const scoringLocked = match.isComplete || timeExpired

  return (
    <article className={`match-card stage-${match.stage}`}>
      <header className="match-header">
        <div>
          <p className="match-code">{match.code}</p>
          <h4>{match.title}</h4>
        </div>
        <div className="match-header-actions">
          <span className={`match-state ${match.isComplete ? 'is-complete' : 'is-pending'}`}>
            {match.isComplete ? (match.isAutoAdvance ? 'Auto-advanced' : 'Locked in') : 'Pending'}
          </span>
          {tournamentId && !match.isAutoAdvance && match.left.entrant && match.right.entrant ? (
            <a
              className="scoreboard-link"
              href={`/tournaments/${tournamentId}/match/${match.id}/scoreboard`}
              target="_blank"
              rel="noreferrer"
              title="Open public scoreboard"
            >
              ↗ Scoreboard
            </a>
          ) : null}
        </div>
      </header>

      {canScore ? (
        <>
          <MatchTimer
            timer={timer}
            durationSeconds={durationSeconds}
            locked={match.isComplete}
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
                  <>
                    {idx === 1 && (
                      <span className="match-vs-kanji" aria-hidden="true">対</span>
                    )}
                    <div
                      key={side}
                      className={`score-slot score-slot-${side}${isWinner ? ' is-winner' : ''}${slot.isBye ? ' is-bye' : ''}`}
                    >
                      <span className="score-slot-name">{slot.label}</span>
                      <ScorePlate
                        score={score}
                        side={side}
                        disabled={!entrant || scoringLocked}
                        canScore={!!entrant && !scoringLocked}
                        onScore={(amount) => entrant && onAddScore?.(match.id, side, amount)}
                      />
                    </div>
                  </>
                )
              },
            )}
          </div>
          {timeExpired && !match.isComplete ? (
            <div className="timer-expired-block">
              <p className="timer-expired-note">Time — bout drawn. Pick a winner to advance the bracket.</p>
              <div className="timer-expired-actions">
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
          {(hasScore || match.isComplete) ? (
            <button
              type="button"
              className="score-reset-btn ghost-button"
              onClick={() => onResetScore?.(match.id)}
            >
              Reset score
            </button>
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
  onResetTeamScore,
  onReorderMatchLineup,
  onTimerStart,
  onTimerPause,
  onTimerReset,
  onTimerExpire,
}: {
  title: string
  rounds: BracketRound[]
  scores: Record<string, MatchScore>
  showScoring?: boolean
  teams?: TeamEntry[]
  lineups?: Record<string, { left: string[]; right: string[] }>
  tournamentId?: string
  timers: Record<string, MatchTimerState>
  durationSeconds: number
  activeTimerKey: string | null
  onSelectWinner: (matchId: string, entrantId: string) => void
  onAddScore?: (matchId: string, side: 'left' | 'right', amount: 0.5 | 1 | -0.5 | -1) => void
  onResetScore?: (matchId: string) => void
  onAddBoutScore?: (matchId: string, boutIndex: number, side: 'left' | 'right', amount: 0.5 | 1 | -0.5 | -1) => void
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
                    matchScore={scores[match.id]}
                    showScoring={showScoring}
                    tournamentId={tournamentId}
                    timer={timers[match.id]}
                    durationSeconds={durationSeconds}
                    disableStartIfOtherActive={activeTimerKey != null && activeTimerKey !== match.id}
                    onSelectWinner={onSelectWinner}
                    onAddScore={onAddScore}
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
  onResetTeamScore,
  onReorderMatchLineup,
  onTimerStart,
  onTimerPause,
  onTimerReset,
  onTimerExpire,
}: {
  match: BracketMatch
  leftTeam?: TeamEntry
  rightTeam?: TeamEntry
  scores: Record<string, MatchScore>
  lineups: Record<string, { left: string[]; right: string[] }>
  tournamentId?: string
  timers: Record<string, MatchTimerState>
  durationSeconds: number
  activeTimerKey: string | null
  onSelectWinner: (matchId: string, entrantId: string) => void
  onAddBoutScore: (matchId: string, boutIndex: number, side: 'left' | 'right', amount: 0.5 | 1 | -0.5 | -1) => void
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
  const stats = computeTeamStats(boutScoresList, boutsTotal)
  const hasAnyScore = boutScoresList.some((s) => s && (s.left > 0 || s.right > 0))
  const lineupLocked = hasAnyScore || match.isComplete
  const isTiebreaker = stats.leftWins === stats.rightWins && (stats.leftTotal > 0 || stats.rightTotal > 0)
  const showManualSelect = hasAnyScore && !match.isComplete && match.options.length > 1

  // No members or auto-advance: fall back to click-to-select slot buttons
  if (match.isAutoAdvance || boutsTotal === 0) {
    return (
      <article className={`match-card stage-${match.stage}`}>
        <header className="match-header">
          <div>
            <p className="match-code">{match.code}</p>
            <h4>{match.title}</h4>
          </div>
          <span className={`match-state ${match.isComplete ? 'is-complete' : 'is-pending'}`}>
            {match.isComplete ? (match.isAutoAdvance ? 'Auto-advanced' : 'Locked in') : 'Pending'}
          </span>
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
    <article className={`match-card team-match-card stage-${match.stage}`}>
      <header className="match-header">
        <div>
          <p className="match-code">{match.code}</p>
          <h4>{match.title}</h4>
        </div>
        <div className="match-header-actions">
          <span className={`match-state ${match.isComplete ? 'is-complete' : 'is-pending'}`}>
            {match.isComplete ? 'Locked in' : 'Pending'}
          </span>
          {tournamentId && match.left.entrant && match.right.entrant ? (
            <a
              className="scoreboard-link"
              href={`/tournaments/${tournamentId}/match/${match.id}/scoreboard`}
              target="_blank"
              rel="noreferrer"
              title="Open public scoreboard"
            >
              ↗ Scoreboard
            </a>
          ) : null}
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

          return (
            <div key={boutIndex} className={`bout-row${boutTimeExpired && !boutDone ? ' is-time-draw' : ''}`}>
              <span className="bout-pos">{getKendoPosition(boutIndex, boutsTotal)}</span>

              {/* Names + scores row. display:contents in normal so left/right enter the parent grid */}
              <div className="bout-names-row">
                <div className={`bout-left${leftWonBout ? ' bout-won' : ''}`}>
                  <span className="bout-name">{leftMember?.name.trim() || 'Open slot'}</span>
                  <ScorePlate
                    score={boutScore.left}
                    side="left"
                    disabled={boutLocked}
                    canScore={!boutLocked}
                    onScore={(amount) => onAddBoutScore(match.id, boutIndex, 'left', amount)}
                  />
                </div>

                {/* Kanji VS divider — only visible in fullscreen */}
                <span className="bout-vs-kanji" aria-hidden="true">対</span>

                <div className={`bout-right${rightWonBout ? ' bout-won' : ''}`}>
                  <ScorePlate
                    score={boutScore.right}
                    side="right"
                    disabled={boutLocked}
                    canScore={!boutLocked}
                    onScore={(amount) => onAddBoutScore(match.id, boutIndex, 'right', amount)}
                  />
                  <span className="bout-name">{rightMember?.name.trim() || 'Open slot'}</span>
                </div>
              </div>

              {/* Timer — compact center column in normal mode, full-width row in fullscreen */}
              <MatchTimer
                compact
                timer={boutTimer}
                durationSeconds={durationSeconds}
                locked={boutDone}
                disableStart={activeTimerKey != null && activeTimerKey !== boutKey}
                onStart={() => onTimerStart(boutKey)}
                onPause={() => onTimerPause(boutKey)}
                onReset={() => onTimerReset(boutKey)}
                onExpire={() => onTimerExpire(boutKey)}
              />
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

      {(hasAnyScore || match.isComplete) ? (
        <button
          type="button"
          className="score-reset-btn ghost-button"
          onClick={() => onResetTeamScore(match.id)}
        >
          Reset scorecard
        </button>
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
    isComplete: bracket.champion !== null,
  }
}

function formatDate(dateString: string) {
  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(dateString))
}

type TournamentStatus = 'active' | 'upcoming' | 'past'

function getTournamentStatus(tournament: TournamentRecord): TournamentStatus {
  if (getTournamentInsight(tournament).isComplete) return 'past'
  const hasStarted =
    Object.keys(tournament.results).length > 0 || Object.keys(tournament.scores).length > 0
  return hasStarted ? 'active' : 'upcoming'
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
            <strong>Championship Desk</strong>
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

  return (
    <article className="tournament-card">
      <div className="tournament-card-header">
        <div>
          <p>{tournament.kind === 'single' ? 'Individual event' : 'Team event'}</p>
          <h3>{tournament.name}</h3>
        </div>
        <span className={`status-chip ${statusClass}`}>
          {statusChip}
        </span>
      </div>

      <div className="tournament-meta-grid">
        <div>
          <span>Format</span>
          <strong>
            {tournament.format === 'single' ? 'Single knockout' : 'Double knockout'}
          </strong>
        </div>
        <div>
          <span>Entrants</span>
          <strong>{insight.entrants}</strong>
        </div>
        <div>
          <span>Progress</span>
          <strong>{insight.progress}%</strong>
        </div>
        <div>
          <span>{insight.isComplete ? 'Champion' : 'Next bout'}</span>
          <strong>{insight.isComplete ? insight.champion : insight.nextMatch ?? 'TBD'}</strong>
        </div>
      </div>

      <footer className="tournament-card-footer">
        <span>Updated {formatDate(tournament.updatedAt)}</span>
        <div className="tournament-card-actions">
          {onDelete && (
            <button
              type="button"
              className="tournament-card-delete"
              onClick={(event) => {
                event.preventDefault()
                if (window.confirm(`Delete "${tournament.name}" from local storage?`)) {
                  onDelete(tournament.id)
                }
              }}
            >
              Delete
            </button>
          )}
          <Link to={`/tournaments/${tournament.id}`} className="inline-link">
            Open tournament
          </Link>
        </div>
      </footer>
    </article>
  )
}

function HomePage({
  tournaments,
  onDeleteTournament,
}: {
  tournaments: TournamentRecord[]
  onDeleteTournament: (id: string) => void
}) {
  const activeTournaments = tournaments.filter((t) => getTournamentStatus(t) === 'active')
  const upcomingTournaments = tournaments.filter((t) => getTournamentStatus(t) === 'upcoming')
  const pastTournaments = tournaments.filter((t) => getTournamentStatus(t) === 'past')

  const [tab, setTab] = useState<TournamentStatus>(() => {
    if (activeTournaments.length) return 'active'
    if (upcomingTournaments.length) return 'upcoming'
    if (pastTournaments.length) return 'past'
    return 'active'
  })

  const tabs: { key: TournamentStatus; label: string; count: number }[] = [
    { key: 'active', label: 'Active', count: activeTournaments.length },
    { key: 'upcoming', label: 'Upcoming', count: upcomingTournaments.length },
    { key: 'past', label: 'Past', count: pastTournaments.length },
  ]

  const currentList =
    tab === 'active' ? activeTournaments : tab === 'upcoming' ? upcomingTournaments : pastTournaments
  const canDelete = tab !== 'active'
  const emptyCopy =
    tab === 'active'
      ? { h: 'No active tournaments', p: 'Tournaments appear here once the first bout is scored.' }
      : tab === 'upcoming'
      ? { h: 'No upcoming tournaments', p: 'Create a new bracket to queue up an event.' }
      : { h: 'No completed tournaments yet', p: 'Finished events will appear here once a champion has been decided.' }

  return (
    <AppFrame
      action={
        <Link to="/tournaments/new" className="primary-link">
          Create new tournament
        </Link>
      }
    >
      <section className="home-hero">
        <div>
          <p className="eyebrow">Local archive</p>
          <h1>Track every kendo tournament from one desk.</h1>
        </div>
        <p className="home-hero-copy">
          Current and finished tournaments are saved in local storage, so you can return to the same event board without setting up brackets from scratch.
        </p>
      </section>

      <section className="list-section">
        <div className="tournament-tabs" role="tablist">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              className={`tournament-tab${tab === t.key ? ' is-active' : ''}`}
              onClick={() => setTab(t.key)}
            >
              <span>{t.label}</span>
              <em>{t.count}</em>
            </button>
          ))}
        </div>

        {currentList.length > 0 ? (
          <div className="tournament-grid">
            {currentList.map((tournament) => (
              <TournamentCard
                key={tournament.id}
                tournament={tournament}
                onDelete={canDelete ? onDeleteTournament : undefined}
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
            />
            <div className="member-list">
              {team.members.map((member, memberIndex) => (
                <div key={member.id} className="member-row">
                  <span className="member-order">#{memberIndex + 1}</span>
                  <input
                    value={member.name}
                    onChange={(event) => onUpdateMember(team.id, member.id, event.target.value)}
                    placeholder="Member name"
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
        <aside className="wizard-sidebar panel-card">
          <p className="eyebrow">Create tournament</p>
          <h1>Guided setup</h1>
          <ol className="wizard-steps">
            <li className={step === 0 ? 'is-active' : step > 0 ? 'is-complete' : ''}>Basics</li>
            <li className={step === 1 ? 'is-active' : step > 1 ? 'is-complete' : ''}>Entrants</li>
            <li className={step === 2 ? 'is-active' : ''}>Review</li>
          </ol>
        </aside>

        <div className="wizard-main">
          {step === 0 ? (
            <div className="panel-card wizard-panel">
              <div className="panel-heading">
                <p>Step 1</p>
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
                <p>Step 3</p>
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
}: {
  tournament: TournamentRecord
  onChange: (updater: (current: TournamentRecord) => TournamentRecord) => void
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
  const progress =
    bracket && bracket.totalMatches > 0
      ? Math.round((bracket.completedMatches / bracket.totalMatches) * 100)
      : 0

  const scores = tournament.scores ?? {}
  const showScoring = tournament.kind === 'single'
  const teamScoringTeams = tournament.kind === 'team' ? tournament.teams : undefined
  const teamLineups = tournament.kind === 'team' ? (tournament.lineups ?? {}) : undefined

  function handleAddScore(matchId: string, side: 'left' | 'right', amount: 0.5 | 1 | -0.5 | -1) {
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

      // Guard: do not score a match that has only one entrant. Allow undo on
      // completed matches so a mistake can be corrected.
      if (!match || match.isAutoAdvance) {
        return current
      }
      if (match.isComplete && amount > 0) {
        return current
      }

      const existing = (current.scores ?? {})[matchId] ?? { left: 0, right: 0 }
      const nextSideScore = Math.max(0, existing[side] + amount)
      const nextScore = { ...existing, [side]: nextSideScore }

      let nextResults = current.results
      if (nextScore.left >= 2 || nextScore.right >= 2) {
        const winner = nextScore.left >= 2 ? match.left.entrant : match.right.entrant
        if (winner) {
          nextResults = { ...current.results, [matchId]: winner.id }
        }
      } else if (current.results[matchId]) {
        // Score dropped below winning threshold via undo — clear stored result so
        // the bracket re-opens this match.
        const { [matchId]: _r, ...rest } = current.results
        nextResults = rest
      }

      return {
        ...current,
        scores: { ...(current.scores ?? {}), [matchId]: nextScore },
        results: nextResults,
        updatedAt: new Date().toISOString(),
      }
    })
  }

  function handleResetScore(matchId: string) {
    onChange((current) => {
      const { [matchId]: _s, ...remainingScores } = current.scores ?? {}
      const { [matchId]: _r, ...remainingResults } = current.results
      return {
        ...current,
        scores: remainingScores,
        results: remainingResults,
        updatedAt: new Date().toISOString(),
      }
    })
  }

  function handleAddBoutScore(matchId: string, boutIndex: number, side: 'left' | 'right', amount: 0.5 | 1 | -0.5 | -1) {
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
      // Bout already finished — only allow undo (negative amount).
      if ((existing.left >= 2 || existing.right >= 2) && amount > 0) return current

      const nextSideScore = Math.max(0, existing[side] + amount)
      const nextBoutScore = { ...existing, [side]: nextSideScore }
      const nextScores = { ...(current.scores ?? {}), [boutKey]: nextBoutScore }

      // Determine team match winner from all bout scores (with updated score)
      const leftTeam = current.teams.find((t) => t.id === match.left.entrant?.id)
      const rightTeam = current.teams.find((t) => t.id === match.right.entrant?.id)
      const boutsTotal = Math.min(leftTeam?.members.length ?? 0, rightTeam?.members.length ?? 0)
      const boutScoresList = Array.from({ length: boutsTotal }, (_, i) => nextScores[getBoutKey(matchId, i)])
      const stats = computeTeamStats(boutScoresList, boutsTotal)

      let nextResults = current.results
      if (stats.teamWinner !== null) {
        const winnerEntrant = stats.teamWinner === 'left' ? match.left.entrant : match.right.entrant
        if (winnerEntrant) {
          nextResults = { ...current.results, [matchId]: winnerEntrant.id }
        }
      } else if (current.results[matchId]) {
        // Match no longer has a determined winner — clear so bracket re-opens it.
        const { [matchId]: _r, ...rest } = current.results
        nextResults = rest
      }

      return {
        ...current,
        scores: nextScores,
        results: nextResults,
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
      const { [matchId]: _r, ...remainingResults } = current.results
      return {
        ...current,
        scores: nextScores,
        results: remainingResults,
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
          [key]: { remainingMs, runningSince: Date.now() },
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
          [key]: { remainingMs, runningSince: null },
        },
        updatedAt: new Date().toISOString(),
      }
    })
  }

  function handleTimerReset(key: string) {
    onChange((current) => {
      const { [key]: _removed, ...rest } = current.timers ?? {}
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
      if (existing && existing.runningSince == null && existing.remainingMs <= 0) return current
      return {
        ...current,
        timers: {
          ...(current.timers ?? {}),
          [key]: { remainingMs: 0, runningSince: null },
        },
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

  const [bracketFullscreen, setBracketFullscreen] = useState(false)
  useEffect(() => {
    if (!bracketFullscreen) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setBracketFullscreen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prev
      document.removeEventListener('keydown', onKey)
    }
  }, [bracketFullscreen])

  return (
    <>
      <section className="hero-panel">
        <div className="hero-copy">
          <p className="eyebrow">Tournament desk</p>
          <div className="hero-meta-row">
            <span className="meta-pill">
              {tournament.kind === 'single' ? 'Individual draw' : 'Team roster draw'}
            </span>
            <span className="meta-pill">
              {tournament.format === 'single' ? 'Single elimination' : 'Double elimination'}
            </span>
          </div>
          <h1>{tournament.name}</h1>
          <p className="hero-text">
            Use the setup panel to refine the event, then click bracket winners to keep the live board synchronized with the tournament floor.
          </p>
          <div className="hero-note">
            <span className="hero-note-label">Floor call</span>
            <strong>{nextPendingMatch?.code ?? 'Ready to set the first bout'}</strong>
            <p>
              {nextPendingMatch
                ? 'Select the winner inside the bracket board to keep the event moving.'
                : 'Once two entrants exist, the board turns into a live tournament sheet.'}
            </p>
          </div>
        </div>
        <div className="hero-metrics">
          <div className="metric-card accent-card">
            <span>Progress</span>
            <strong>{progress}%</strong>
            <p>
              {bracket
                ? `${bracket.completedMatches} of ${bracket.totalMatches} matches settled`
                : 'Waiting for entrants'}
            </p>
          </div>
          <div className="metric-card">
            <span>Champion</span>
            <strong>{bracket?.champion?.label ?? 'TBD'}</strong>
            <p>
              {bracket?.champion
                ? 'Bracket complete'
                : nextPendingMatch
                  ? `Next call: ${nextPendingMatch.code}`
                  : 'Bracket will appear after at least two entrants'}
            </p>
          </div>
        </div>
      </section>

      <section className="workspace-grid">
        <aside className="control-panel">
          <div className="panel-card form-panel">
            <div className="panel-heading">
              <p>Setup</p>
              <h2>Tournament settings</h2>
            </div>

            <label className="field-block">
              <span>Tournament name</span>
              <input
                value={tournament.name}
                onChange={(event) =>
                  onChange((current) => ({ ...current, name: event.target.value }))
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
                  onClick={() => onChange((current) => ({ ...current, format: 'single' }))}
                >
                  Single knockout
                </button>
                <button
                  type="button"
                  className={tournament.format === 'double' ? 'is-active' : ''}
                  onClick={() => onChange((current) => ({ ...current, format: 'double' }))}
                >
                  Double knockout
                </button>
              </div>
            </div>

            <DurationField
              seconds={tournament.matchDurationSeconds ?? DEFAULT_MATCH_DURATION_SECONDS}
              onChange={handleSetMatchDuration}
              disabled={Object.keys(tournament.results).length > 0 || Object.keys(tournament.scores).length > 0}
            />

            <div className="utility-row">
              <button
                type="button"
                className="ghost-button"
                onClick={() => onChange((current) => ({ ...current, results: {}, scores: {}, timers: {} }))}
              >
                Clear bracket results
              </button>
            </div>
          </div>

          {tournament.kind === 'single' ? (
            <SinglesEditor
              singles={tournament.singles}
              locked={Object.keys(tournament.results).length > 0 || Object.keys(tournament.scores).length > 0}
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
              locked={Object.keys(tournament.results).length > 0 || Object.keys(tournament.scores).length > 0}
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
        </aside>

        <section className="diagram-panel">
          <div className="panel-card summary-panel">
            <div className="panel-heading">
              <p>Status</p>
              <h2>{tournament.name}</h2>
            </div>

            <p className="summary-intro">
              A live event board for tracking the current draw, next bout, and eventual champion.
            </p>

            <div className="summary-grid">
              <div className="summary-tile summary-tile-wide">
                <span>Bracket type</span>
                <strong>
                  {tournament.kind === 'single' ? 'Single event' : 'Team event'} /{' '}
                  {tournament.format === 'single' ? 'Single knockout' : 'Double knockout'}
                </strong>
              </div>
              <div className="summary-tile">
                <span>Entrants</span>
                <strong>{entrants.length}</strong>
              </div>
              <div className="summary-tile">
                <span>Next up</span>
                <strong>{nextPendingMatch?.code ?? 'Bracket complete'}</strong>
              </div>
              <div className="summary-tile summary-tile-wide">
                <span>Champion</span>
                <strong>{bracket?.champion?.label ?? 'No winner yet'}</strong>
              </div>
            </div>

            {entrants.length < 2 ? (
              <p className="validation-note">
                Add at least two entrants to generate the tournament graph.
              </p>
            ) : null}
          </div>

          {bracket ? (
            <div className={`panel-card bracket-panel${bracketFullscreen ? ' is-fullscreen' : ''}`}>
              <div className="panel-heading bracket-heading">
                <div>
                  <p>Diagram</p>
                  <h2>Live tournament bracket</h2>
                </div>
                <button
                  type="button"
                  className="ghost-button bracket-fullscreen-toggle"
                  onClick={() => setBracketFullscreen((v) => !v)}
                  aria-pressed={bracketFullscreen}
                  title={bracketFullscreen ? 'Exit fullscreen (Esc)' : 'Open in fullscreen for projection'}
                >
                  {bracketFullscreen ? '✕  Exit fullscreen' : '⛶  Fullscreen'}
                </button>
              </div>

              <RoundColumns
                title="Winners bracket"
                rounds={bracket.winnersRounds}
                scores={scores}
                showScoring={showScoring}
                teams={teamScoringTeams}
                lineups={teamLineups}
                tournamentId={tournament.id}
                onSelectWinner={(matchId, entrantId) =>
                  onChange((current) => ({
                    ...current,
                    results: {
                      ...current.results,
                      [matchId]: current.results[matchId] === entrantId ? '' : entrantId,
                    },
                  }))
                }
                onAddScore={handleAddScore}
                onResetScore={handleResetScore}
                onAddBoutScore={handleAddBoutScore}
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
                scores={scores}
                showScoring={showScoring}
                teams={teamScoringTeams}
                lineups={teamLineups}
                tournamentId={tournament.id}
                onSelectWinner={(matchId, entrantId) =>
                  onChange((current) => ({
                    ...current,
                    results: {
                      ...current.results,
                      [matchId]: current.results[matchId] === entrantId ? '' : entrantId,
                    },
                  }))
                }
                onAddScore={handleAddScore}
                onResetScore={handleResetScore}
                onAddBoutScore={handleAddBoutScore}
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
                scores={scores}
                showScoring={showScoring}
                teams={teamScoringTeams}
                lineups={teamLineups}
                tournamentId={tournament.id}
                onSelectWinner={(matchId, entrantId) =>
                  onChange((current) => ({
                    ...current,
                    results: {
                      ...current.results,
                      [matchId]: current.results[matchId] === entrantId ? '' : entrantId,
                    },
                  }))
                }
                onAddScore={handleAddScore}
                onResetScore={handleResetScore}
                onAddBoutScore={handleAddBoutScore}
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

  const hasStarted =
    Object.keys(tournament.results).length > 0 || Object.keys(tournament.scores).length > 0

  return (
    <AppFrame
      action={
        <div className="topbar-action-row">
          <Link to="/" className="inline-link">
            Back to tournaments
          </Link>
          {!hasStarted && (
            <button
              type="button"
              className="ghost-button"
              onClick={() => {
                if (window.confirm('Delete this tournament from local storage?')) {
                  onDeleteTournament(tournament.id)
                  navigate('/')
                }
              }}
            >
              Delete tournament
            </button>
          )}
        </div>
      }
    >
      <TournamentWorkbench
        tournament={tournament}
        onChange={(updater) => onUpdateTournament(tournament.id, updater)}
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
          <p className="scoreboard-eyebrow">{tournament.name}</p>
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
          <div className="scoreboard-divider" aria-hidden="true">VS</div>
          <div className={`scoreboard-side${winnerId === match.right.entrant.id ? ' is-winner' : ''}`}>
            <span className="scoreboard-score">{score.right % 1 === 0 ? score.right : score.right.toFixed(1)}</span>
            <span className="scoreboard-name">{match.right.label}</span>
          </div>
        </section>
        {winnerId ? (
          <p className="scoreboard-victor">
            Victor — {winnerId === match.left.entrant.id ? match.left.label : match.right.label}
          </p>
        ) : (
          <p className="scoreboard-victor scoreboard-victor-pending">In progress</p>
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
  const stats = computeTeamStats(boutScores, boutsTotal)
  const winnerId = tournament.results?.[match.id]
  const fmt = (n: number) => (n % 1 === 0 ? String(n) : n.toFixed(1))
  const durationSeconds = tournament.matchDurationSeconds ?? DEFAULT_MATCH_DURATION_SECONDS
  const boutTimers = Array.from({ length: boutsTotal }, (_, i) => tournament.timers?.[getBoutKey(match.id, i)])
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
    ? `${isLive ? 'Now playing' : 'Final bout'} \u00b7 ${getKendoPosition(focusBoutIndex, boutsTotal)}`
    : ''

  return (
    <main className="scoreboard scoreboard-team">
      <header className="scoreboard-top">
        <p className="scoreboard-eyebrow">{tournament.name} &middot; {match.title}</p>
        <h1>
          <span className="scoreboard-team-name">{match.left.label}</span>
          <span className="scoreboard-team-vs"> vs </span>
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
          <div className="scoreboard-divider" aria-hidden="true">VS</div>
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
          <span className="scoreboard-team-tally-mid">Team</span>
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
            const done = s.left >= 2 || s.right >= 2
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
          Victor &mdash; {winnerId === match.left.entrant.id ? match.left.label : match.right.label}
        </p>
      ) : null}
    </main>
  )
}

function App() {
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
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <Routes>
        <Route path="/" element={<HomePage tournaments={tournaments} onDeleteTournament={deleteTournament} />} />
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
  )
}

export default App
