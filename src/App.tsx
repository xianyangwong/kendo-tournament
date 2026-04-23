import { Fragment, useEffect, useState } from 'react'
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
  3: ['Senpo', 'Chuken', 'Taisho'],
  5: ['Senpo', 'Jiho', 'Chuken', 'Fukusho', 'Taisho'],
  7: ['Senpo', 'Jiho', 'Chuken', 'Fukusho', 'Gojo', 'Rokuban', 'Taisho'],
}

function getKendoPosition(index: number, total: number): string {
  return KENDO_POSITIONS[total]?.[index] ?? `#${index + 1}`
}

function getBoutKey(matchId: string, boutIndex: number): string {
  return `${matchId}:bout:${boutIndex}`
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

function MatchCard({
  match,
  matchScore,
  showScoring,
  onSelectWinner,
  onAddScore,
  onResetScore,
}: {
  match: BracketMatch
  matchScore?: MatchScore
  showScoring?: boolean
  onSelectWinner: (matchId: string, entrantId: string) => void
  onAddScore?: (matchId: string, side: 'left' | 'right', amount: 0.5 | 1) => void
  onResetScore?: (matchId: string) => void
}) {
  const canScore = showScoring && !match.isAutoAdvance
  const hasScore = matchScore && (matchScore.left > 0 || matchScore.right > 0)

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

      {canScore ? (
        <>
          {([{ slot: match.left, side: 'left' as const }, { slot: match.right, side: 'right' as const }]).map(
            ({ slot, side }) => {
              const entrant = slot.entrant
              const score = side === 'left' ? (matchScore?.left ?? 0) : (matchScore?.right ?? 0)
              const isWinner = entrant?.id === match.selectedWinnerId
              return (
                <div
                  key={side}
                  className={`score-slot${isWinner ? ' is-winner' : ''}${slot.isBye ? ' is-bye' : ''}`}
                >
                  <span className="score-slot-name">{slot.label}</span>
                  <div className="score-controls">
                    <span className="score-value">
                      {score % 1 === 0 ? score : score.toFixed(1)}
                    </span>
                    <button
                      type="button"
                      className="score-btn"
                      disabled={!entrant || match.isComplete}
                      onClick={() => entrant && onAddScore?.(match.id, side, 1)}
                    >
                      +1
                    </button>
                    <button
                      type="button"
                      className="score-btn"
                      disabled={!entrant || match.isComplete}
                      onClick={() => entrant && onAddScore?.(match.id, side, 0.5)}
                    >
                      +½
                    </button>
                  </div>
                </div>
              )
            },
          )}
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
  onSelectWinner,
  onAddScore,
  onResetScore,
  onAddBoutScore,
  onResetTeamScore,
  onReorderMatchLineup,
}: {
  title: string
  rounds: BracketRound[]
  scores: Record<string, MatchScore>
  showScoring?: boolean
  teams?: TeamEntry[]
  lineups?: Record<string, { left: string[]; right: string[] }>
  onSelectWinner: (matchId: string, entrantId: string) => void
  onAddScore?: (matchId: string, side: 'left' | 'right', amount: 0.5 | 1) => void
  onResetScore?: (matchId: string) => void
  onAddBoutScore?: (matchId: string, boutIndex: number, side: 'left' | 'right', amount: 0.5 | 1) => void
  onResetTeamScore?: (matchId: string) => void
  onReorderMatchLineup?: (matchId: string, side: 'left' | 'right', memberId: string, toIndex: number) => void
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
                    onSelectWinner={onSelectWinner}
                    onAddBoutScore={onAddBoutScore!}
                    onResetTeamScore={onResetTeamScore!}
                    onReorderMatchLineup={onReorderMatchLineup!}
                  />
                ) : (
                  <MatchCard
                    key={match.id}
                    match={match}
                    matchScore={scores[match.id]}
                    showScoring={showScoring}
                    onSelectWinner={onSelectWinner}
                    onAddScore={onAddScore}
                    onResetScore={onResetScore}
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
  onSelectWinner,
  onAddBoutScore,
  onResetTeamScore,
  onReorderMatchLineup,
}: {
  match: BracketMatch
  leftTeam?: TeamEntry
  rightTeam?: TeamEntry
  scores: Record<string, MatchScore>
  lineups: Record<string, { left: string[]; right: string[] }>
  onSelectWinner: (matchId: string, entrantId: string) => void
  onAddBoutScore: (matchId: string, boutIndex: number, side: 'left' | 'right', amount: 0.5 | 1) => void
  onResetTeamScore: (matchId: string) => void
  onReorderMatchLineup: (matchId: string, side: 'left' | 'right', memberId: string, toIndex: number) => void
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
        <span className={`match-state ${match.isComplete ? 'is-complete' : 'is-pending'}`}>
          {match.isComplete ? 'Locked in' : 'Pending'}
        </span>
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
          const boutScore = scores[getBoutKey(match.id, boutIndex)] ?? { left: 0, right: 0 }
          const leftWonBout = boutScore.left >= 2 && boutScore.left > boutScore.right
          const rightWonBout = boutScore.right >= 2 && boutScore.right > boutScore.left
          const boutDone = boutScore.left >= 2 || boutScore.right >= 2

          return (
            <div key={boutIndex} className="bout-row">
              <span className="bout-pos">{getKendoPosition(boutIndex, boutsTotal)}</span>

              {/* Left side: name then score + buttons */}
              <div className={`bout-left${leftWonBout ? ' bout-won' : ''}`}>
                <span className="bout-name">{leftMember?.name.trim() || 'Open slot'}</span>
                <div className="bout-controls">
                  <span className="score-value">{fmtScore(boutScore.left)}</span>
                  <button
                    type="button"
                    className="score-btn"
                    disabled={boutDone || match.isComplete}
                    onClick={() => onAddBoutScore(match.id, boutIndex, 'left', 1)}
                  >
                    +1
                  </button>
                  <button
                    type="button"
                    className="score-btn"
                    disabled={boutDone || match.isComplete}
                    onClick={() => onAddBoutScore(match.id, boutIndex, 'left', 0.5)}
                  >
                    +½
                  </button>
                </div>
              </div>

              <span className="bout-divider">vs</span>

              {/* Right side: buttons + score then name (mirrored) */}
              <div className={`bout-right${rightWonBout ? ' bout-won' : ''}`}>
                <div className="bout-controls">
                  <button
                    type="button"
                    className="score-btn"
                    disabled={boutDone || match.isComplete}
                    onClick={() => onAddBoutScore(match.id, boutIndex, 'right', 0.5)}
                  >
                    +½
                  </button>
                  <button
                    type="button"
                    className="score-btn"
                    disabled={boutDone || match.isComplete}
                    onClick={() => onAddBoutScore(match.id, boutIndex, 'right', 1)}
                  >
                    +1
                  </button>
                  <span className="score-value">{fmtScore(boutScore.right)}</span>
                </div>
                <span className="bout-name">{rightMember?.name.trim() || 'Open slot'}</span>
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
          <span>Kendo Tournament</span>
          <strong>Championship Desk</strong>
        </Link>
        <div className="topbar-actions">{action}</div>
      </header>
      {children}
    </div>
  )
}

function TournamentCard({ tournament }: { tournament: TournamentRecord }) {
  const insight = getTournamentInsight(tournament)

  return (
    <article className="tournament-card">
      <div className="tournament-card-header">
        <div>
          <p>{tournament.kind === 'single' ? 'Individual event' : 'Team event'}</p>
          <h3>{tournament.name}</h3>
        </div>
        <span className={`status-chip ${insight.isComplete ? 'is-complete' : 'is-live'}`}>
          {insight.isComplete ? 'Past' : 'Current'}
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
        <Link to={`/tournaments/${tournament.id}`} className="inline-link">
          Open tournament
        </Link>
      </footer>
    </article>
  )
}

function HomePage({ tournaments }: { tournaments: TournamentRecord[] }) {
  const currentTournaments = tournaments.filter((tournament) => !getTournamentInsight(tournament).isComplete)
  const pastTournaments = tournaments.filter((tournament) => getTournamentInsight(tournament).isComplete)

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
        <div className="section-header-row">
          <div>
            <p className="eyebrow">Current</p>
            <h2>Active tournaments</h2>
          </div>
          <span>{currentTournaments.length} live</span>
        </div>

        {currentTournaments.length > 0 ? (
          <div className="tournament-grid">
            {currentTournaments.map((tournament) => (
              <TournamentCard key={tournament.id} tournament={tournament} />
            ))}
          </div>
        ) : (
          <div className="empty-card">
            <h3>No active tournaments</h3>
            <p>Create a new bracket to start tracking a live event.</p>
          </div>
        )}
      </section>

      <section className="list-section">
        <div className="section-header-row">
          <div>
            <p className="eyebrow">Archive</p>
            <h2>Past tournaments</h2>
          </div>
          <span>{pastTournaments.length} completed</span>
        </div>

        {pastTournaments.length > 0 ? (
          <div className="tournament-grid">
            {pastTournaments.map((tournament) => (
              <TournamentCard key={tournament.id} tournament={tournament} />
            ))}
          </div>
        ) : (
          <div className="empty-card">
            <h3>No completed tournaments yet</h3>
            <p>Finished events will appear here once a champion has been decided.</p>
          </div>
        )}
      </section>
    </AppFrame>
  )
}

function SinglesEditor({
  singles,
  onUpdate,
  onAdd,
  onRemove,
}: {
  singles: SoloEntry[]
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
              <button type="button" onClick={() => onRemove(entry.id)}>
                Remove
              </button>
            </div>
            <input
              value={entry.name}
              onChange={(event) => onUpdate(entry.id, event.target.value)}
              placeholder="Competitor name"
            />
          </div>
        ))}
      </div>

      <button type="button" className="primary-button" onClick={onAdd}>
        Add competitor
      </button>
    </div>
  )
}

function TeamsEditor({
  teams,
  onUpdateTeam,
  onRemoveTeam,
  onAddTeam,
  onUpdateMember,
  onRemoveMember,
  onAddMember,
}: {
  teams: TeamEntry[]
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
              <button type="button" onClick={() => onRemoveTeam(team.id)}>
                Remove team
              </button>
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
                  <button
                    type="button"
                    className="remove-member-btn"
                    onClick={() => onRemoveMember(team.id, member.id)}
                    aria-label={`Remove member ${memberIndex + 1}`}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            <button type="button" className="ghost-button" onClick={() => onAddMember(team.id)}>
              Add team member
            </button>
          </div>
        ))}
      </div>

      <button type="button" className="primary-button" onClick={onAddTeam}>
        Add team
      </button>
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

  function handleAddScore(matchId: string, side: 'left' | 'right', amount: 0.5 | 1) {
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

      // Guard: do not score a match that is already decided or has only one entrant.
      if (!match || match.isComplete || match.isAutoAdvance) {
        return current
      }

      const existing = (current.scores ?? {})[matchId] ?? { left: 0, right: 0 }
      const nextScore = { ...existing, [side]: existing[side] + amount }

      let nextResults = current.results
      if (nextScore.left >= 2 || nextScore.right >= 2) {
        const winner = nextScore.left >= 2 ? match.left.entrant : match.right.entrant
        if (winner) {
          nextResults = { ...current.results, [matchId]: winner.id }
        }
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

  function handleAddBoutScore(matchId: string, boutIndex: number, side: 'left' | 'right', amount: 0.5 | 1) {
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
      if (!match || match.isComplete || match.isAutoAdvance) return current

      const boutKey = getBoutKey(matchId, boutIndex)
      const existing = (current.scores ?? {})[boutKey] ?? { left: 0, right: 0 }
      // Bout already finished — ignore
      if (existing.left >= 2 || existing.right >= 2) return current

      const nextBoutScore = { ...existing, [side]: existing[side] + amount }
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
                  onClick={() => onChange((current) => ({ ...current, kind: 'single' }))}
                >
                  Single
                </button>
                <button
                  type="button"
                  className={tournament.kind === 'team' ? 'is-active' : ''}
                  onClick={() => onChange((current) => ({ ...current, kind: 'team' }))}
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

            <div className="utility-row">
              <button
                type="button"
                className="ghost-button"
                onClick={() => onChange((current) => ({ ...current, results: {}, scores: {} }))}
              >
                Clear bracket results
              </button>
            </div>
          </div>

          {tournament.kind === 'single' ? (
            <SinglesEditor
              singles={tournament.singles}
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
            <div className="panel-card bracket-panel">
              <div className="panel-heading">
                <p>Diagram</p>
                <h2>Live tournament bracket</h2>
              </div>

              <RoundColumns
                title="Winners bracket"
                rounds={bracket.winnersRounds}
                scores={scores}
                showScoring={showScoring}
                teams={teamScoringTeams}
                lineups={teamLineups}
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
              />
              <RoundColumns
                title="Losers bracket"
                rounds={bracket.losersRounds}
                scores={scores}
                showScoring={showScoring}
                teams={teamScoringTeams}
                lineups={teamLineups}
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
              />
              <RoundColumns
                title="Finals"
                rounds={bracket.finalRounds}
                scores={scores}
                showScoring={showScoring}
                teams={teamScoringTeams}
                lineups={teamLineups}
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
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage tournaments={tournaments} />} />
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
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App
