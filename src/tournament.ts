export type TournamentKind = 'single' | 'team'
export type EliminationFormat = 'single' | 'double'

export interface TournamentEntrant {
  id: string
  label: string
  details: string[]
}

export interface MatchSlot {
  entrant: TournamentEntrant | null
  label: string
  details: string[]
  isBye: boolean
}

export interface BracketMatch {
  id: string
  code: string
  title: string
  stage: 'winners' | 'losers' | 'final' | 'reset'
  left: MatchSlot
  right: MatchSlot
  winnerSlot: MatchSlot
  loserSlot: MatchSlot
  options: TournamentEntrant[]
  selectedWinnerId: string | null
  isComplete: boolean
  isAutoAdvance: boolean
}

export interface BracketRound {
  id: string
  title: string
  subtitle: string
  matches: BracketMatch[]
}

export interface BracketView {
  winnersRounds: BracketRound[]
  losersRounds: BracketRound[]
  finalRounds: BracketRound[]
  champion: TournamentEntrant | null
  totalMatches: number
  completedMatches: number
}

type ResultMap = Record<string, string>

interface InternalRound {
  id: string
  title: string
  subtitle: string
  matches: BracketMatch[]
}

const EMPTY_SLOT: MatchSlot = {
  entrant: null,
  label: 'Awaiting opponent',
  details: [],
  isBye: false,
}

function createEntrantSlot(entrant: TournamentEntrant): MatchSlot {
  return {
    entrant,
    label: entrant.label,
    details: entrant.details,
    isBye: false,
  }
}

function createPlaceholderSlot(label: string): MatchSlot {
  return {
    entrant: null,
    label,
    details: [],
    isBye: false,
  }
}

function createByeSlot(): MatchSlot {
  return {
    entrant: null,
    label: 'BYE',
    details: ['Automatic advance'],
    isBye: true,
  }
}

function pairSequentially(slots: MatchSlot[]): Array<[MatchSlot, MatchSlot]> {
  const pairs: Array<[MatchSlot, MatchSlot]> = []

  for (let index = 0; index < slots.length; index += 2) {
    pairs.push([slots[index] ?? EMPTY_SLOT, slots[index + 1] ?? EMPTY_SLOT])
  }

  return pairs
}

function getStandardRoundTitle(roundIndex: number, totalRounds: number): string {
  if (totalRounds === 1) {
    return 'Final'
  }

  if (roundIndex === totalRounds - 1) {
    return 'Final'
  }

  if (roundIndex === totalRounds - 2) {
    return 'Semifinal'
  }

  if (roundIndex === totalRounds - 3) {
    return 'Quarterfinal'
  }

  return `Round ${roundIndex + 1}`
}

function buildMatch(
  id: string,
  code: string,
  title: string,
  stage: BracketMatch['stage'],
  left: MatchSlot,
  right: MatchSlot,
  results: ResultMap,
): BracketMatch {
  const options = [left.entrant, right.entrant].filter(
    (entrant): entrant is TournamentEntrant => entrant !== null,
  )
  const selectedWinnerId = results[id] ?? null
  const leftEntrant = left.entrant
  const rightEntrant = right.entrant
  const onlyEntrant = leftEntrant ?? rightEntrant

  let winnerSlot = createPlaceholderSlot(`Winner ${code}`)
  let loserSlot = createPlaceholderSlot(`Loser ${code}`)
  let isComplete = false
  let isAutoAdvance = false

  // Only auto-advance when the opposing slot is an actual BYE, not a pending placeholder.
  if (left.isBye && rightEntrant) {
    winnerSlot = createEntrantSlot(rightEntrant)
    loserSlot = createByeSlot()
    isComplete = true
    isAutoAdvance = true
  } else if (right.isBye && leftEntrant) {
    winnerSlot = createEntrantSlot(leftEntrant)
    loserSlot = createByeSlot()
    isComplete = true
    isAutoAdvance = true
  } else if (leftEntrant && rightEntrant) {
    const selectedEntrant = options.find((entrant) => entrant.id === selectedWinnerId)

    if (selectedEntrant) {
      const loserEntrant =
        selectedEntrant.id === leftEntrant.id ? rightEntrant : leftEntrant

      winnerSlot = createEntrantSlot(selectedEntrant)
      loserSlot = createEntrantSlot(loserEntrant)
      isComplete = true
    }
  } else if (left.isBye && right.isBye && onlyEntrant) {
    // Both sides are BYEs but somehow one entrant exists — edge case, auto-advance.
    winnerSlot = createEntrantSlot(onlyEntrant)
    loserSlot = createByeSlot()
    isComplete = true
    isAutoAdvance = true
  }

  return {
    id,
    code,
    title,
    stage,
    left,
    right,
    winnerSlot,
    loserSlot,
    options,
    selectedWinnerId,
    isComplete,
    isAutoAdvance,
  }
}

/**
 * Compact single-elimination bracket. Each round pairs as many entrants as
 * possible; if the count is odd, the bottom remaining seed gets a BYE that round
 * and advances directly. By default this keeps the bracket dense — no empty
 * cards, at most one BYE per round — instead of inflating to the next power of
 * two. Double knockout can opt into showing those BYE advances as match cards
 * so every winners-bracket feed is visible to officials.
 *
 * Total rounds = ceil(log2(n)). For 5 entrants:
 *   R1: 2 matches + 1 bye  (4 play, 1 advances free)  -> 3 advance
 *   R2: 1 match  + 1 bye                              -> 2 advance
 *   R3: 1 match (final)
 */
function buildCompactWinnersBracket(
  entrants: TournamentEntrant[],
  results: ResultMap,
  showAutoAdvanceMatches = false,
): { rounds: InternalRound[]; championSlot: MatchSlot } {
  if (entrants.length === 0) {
    return { rounds: [], championSlot: EMPTY_SLOT }
  }

  if (entrants.length === 1) {
    return { rounds: [], championSlot: createEntrantSlot(entrants[0]) }
  }

  const totalRounds = Math.ceil(Math.log2(entrants.length))
  const rounds: InternalRound[] = []
  let currentSlots: MatchSlot[] = entrants.map(createEntrantSlot)

  for (let roundIndex = 0; roundIndex < totalRounds; roundIndex += 1) {
    const slotsForRound: MatchSlot[] = []
    let byeSlot: MatchSlot | null = null

    // If odd, carry the bottom slot as the BYE so adjacent winners feed forward
    // visually: W1M1 + W1M2 -> W2M1, with the leftover as the visible BYE card.
    if (currentSlots.length % 2 === 1) {
      byeSlot = currentSlots[currentSlots.length - 1]
      slotsForRound.push(...currentSlots.slice(0, -1))
    } else {
      slotsForRound.push(...currentSlots)
    }

    const pairs = pairSequentially(slotsForRound)

    const matches = pairs.map(([left, right], matchIndex) => {
      const id = `w-${roundIndex + 1}-${matchIndex + 1}`
      const code = `W${roundIndex + 1}M${matchIndex + 1}`

      return buildMatch(
        id,
        code,
        `Match ${matchIndex + 1}`,
        'winners',
        left,
        right,
        results,
      )
    })
    const byeMatch = byeSlot && showAutoAdvanceMatches
      ? buildMatch(
          `w-${roundIndex + 1}-${matches.length + 1}`,
          `W${roundIndex + 1}M${matches.length + 1}`,
          `Match ${matches.length + 1}`,
          'winners',
          byeSlot,
          createByeSlot(),
          results,
        )
      : null
    const visibleMatches = byeMatch ? [...matches, byeMatch] : matches

    rounds.push({
      id: `winners-${roundIndex + 1}`,
      title: getStandardRoundTitle(roundIndex, totalRounds),
      subtitle: roundIndex === totalRounds - 1 ? 'Final bout' : 'Advance on one loss',
      matches: visibleMatches,
    })

    const winners = matches.map((match) => match.winnerSlot)
    currentSlots = byeMatch
      ? [...winners, byeMatch.winnerSlot]
      : (byeSlot ? [...winners, byeSlot] : winners)
  }

  return {
    rounds,
    championSlot: currentSlots[0] ?? EMPTY_SLOT,
  }
}


function buildLosersBracket(
  winnersRounds: InternalRound[],
  results: ResultMap,
): InternalRound[] {
  const totalWinnerRounds = winnersRounds.length

  if (totalWinnerRounds <= 1) {
    return []
  }

  // Helper: filter out BYE loser slots (auto-advances produce BYE losers
  // that shouldn't enter the losers bracket).
  const realLosersFromWinnersRound = (roundIndex: number): MatchSlot[] =>
    winnersRounds[roundIndex].matches
      .map((match) => match.loserSlot)
      .filter((slot) => !slot.isBye)

  const rounds: InternalRound[] = []
  // Pool of slots currently in the losers bracket (waiting to be paired).
  let pool: MatchSlot[] = []
  let losersRoundNumber = 0

  // Helper: build a round from a pool of slots. If odd, the top slot gets a
  // bye and carries forward. Returns the new pool (winners of this round
  // plus any bye carry).
  const playRound = (
    inputPool: MatchSlot[],
    subtitle: string,
  ): MatchSlot[] => {
    if (inputPool.length < 2) {
      return inputPool
    }

    let byeCarry: MatchSlot | null = null
    let toPair = inputPool
    if (toPair.length % 2 === 1) {
      byeCarry = toPair[0]
      toPair = toPair.slice(1)
    }

    losersRoundNumber += 1
    const pairs = pairSequentially(toPair)
    const matches = pairs.map(([left, right], matchIndex) => {
      const id = `l-${losersRoundNumber}-${matchIndex + 1}`
      const code = `L${losersRoundNumber}M${matchIndex + 1}`
      return buildMatch(
        id,
        code,
        `Elimination ${matchIndex + 1}`,
        'losers',
        left,
        right,
        results,
      )
    })

    rounds.push({
      id: `losers-${losersRoundNumber}`,
      title: `Elimination Round ${losersRoundNumber}`,
      subtitle,
      matches,
    })

    const winners = matches.map((match) => match.winnerSlot)
    return byeCarry ? [byeCarry, ...winners] : winners
  }

  // Seed losers pool with R1 losers
  pool = realLosersFromWinnersRound(0)

  // For each subsequent winners round, run a pairing-down round on the pool,
  // then merge in the new W-round losers and run another round.
  for (let wRound = 1; wRound < totalWinnerRounds; wRound += 1) {
    // First reduce the existing pool (if we have more than the incoming losers)
    if (pool.length > 1) {
      pool = playRound(pool, 'Losers stay alive')
    }
    // Merge in incoming losers from this winners round
    const incoming = realLosersFromWinnersRound(wRound)
    pool = [...pool, ...incoming]
    // Then play a round combining survivors with new drops
    if (pool.length > 1) {
      pool = playRound(pool, 'Drops from winners bracket join')
    }
  }

  // Drain remaining pool down to a single losers champion
  while (pool.length > 1) {
    pool = playRound(pool, 'Losers stay alive')
  }

  return rounds
}

export function buildTournamentBracket(
  entrants: TournamentEntrant[],
  format: EliminationFormat,
  results: ResultMap,
): BracketView {
  const { rounds: winnersRounds, championSlot: winnersChampionSlot } =
    buildCompactWinnersBracket(entrants, results, format === 'double')
  const losersRounds =
    format === 'double' ? buildLosersBracket(winnersRounds, results) : []

  const finalRounds: InternalRound[] = []
  let champion = winnersChampionSlot.entrant

  if (format === 'double') {
    const winnersFinal = winnersRounds[winnersRounds.length - 1]?.matches[0]
    const losersChampionSource =
      losersRounds.length > 0
        ? losersRounds[losersRounds.length - 1].matches[0]?.winnerSlot ?? EMPTY_SLOT
        : winnersFinal?.loserSlot ?? EMPTY_SLOT

    const grandFinal = buildMatch(
      'f-1',
      'GF1',
      'Grand Final',
      'final',
      winnersChampionSlot,
      losersChampionSource,
      results,
    )

    finalRounds.push({
      id: 'grand-final',
      title: 'Grand Final',
      subtitle: 'Winners bracket champion meets the survivor',
      matches: [grandFinal],
    })

    champion =
      grandFinal.winnerSlot.entrant &&
      grandFinal.winnerSlot.entrant.id !== winnersChampionSlot.entrant?.id
        ? null
        : grandFinal.winnerSlot.entrant

    if (
      grandFinal.winnerSlot.entrant &&
      losersChampionSource.entrant &&
      grandFinal.winnerSlot.entrant.id === losersChampionSource.entrant.id
    ) {
      const resetFinal = buildMatch(
        'f-2',
        'GF2',
        'Championship Reset',
        'reset',
        winnersChampionSlot,
        losersChampionSource,
        results,
      )

      finalRounds.push({
        id: 'reset-final',
        title: 'Reset Final',
        subtitle: 'Both finalists now have one loss',
        matches: [resetFinal],
      })

      champion = resetFinal.winnerSlot.entrant
    }
  }

  const allRounds = [...winnersRounds, ...losersRounds, ...finalRounds]
  const allMatches = allRounds.flatMap((round) => round.matches)

  return {
    winnersRounds,
    losersRounds,
    finalRounds,
    champion,
    totalMatches: allMatches.length,
    completedMatches: allMatches.filter((match) => match.isComplete).length,
  }
}
