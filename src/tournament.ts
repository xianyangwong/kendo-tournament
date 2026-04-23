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

function nextPowerOfTwo(value: number): number {
  let size = 2

  while (size < value) {
    size *= 2
  }

  return size
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

  if (leftEntrant && !rightEntrant) {
    winnerSlot = createEntrantSlot(leftEntrant)
    loserSlot = EMPTY_SLOT
    isComplete = true
    isAutoAdvance = true
  } else if (rightEntrant && !leftEntrant) {
    winnerSlot = createEntrantSlot(rightEntrant)
    loserSlot = EMPTY_SLOT
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
  } else if (onlyEntrant) {
    winnerSlot = createEntrantSlot(onlyEntrant)
    loserSlot = EMPTY_SLOT
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

function buildWinnersBracket(
  entrants: TournamentEntrant[],
  results: ResultMap,
): { rounds: InternalRound[]; championSlot: MatchSlot } {
  const bracketSize = nextPowerOfTwo(entrants.length)
  const initialSlots = Array.from({ length: bracketSize }, (_, index) => {
    const entrant = entrants[index]
    return entrant ? createEntrantSlot(entrant) : createByeSlot()
  })

  const totalRounds = Math.log2(bracketSize)
  const rounds: InternalRound[] = []
  let currentSlots = initialSlots

  for (let roundIndex = 0; roundIndex < totalRounds; roundIndex += 1) {
    const matches = pairSequentially(currentSlots).map(([left, right], matchIndex) => {
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

    rounds.push({
      id: `winners-${roundIndex + 1}`,
      title: getStandardRoundTitle(roundIndex, totalRounds),
      subtitle: roundIndex === totalRounds - 1 ? 'Winners bracket decider' : 'Advance on one loss',
      matches,
    })

    currentSlots = matches.map((match) => match.winnerSlot)
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

  const rounds: InternalRound[] = []
  let previousRound: BracketMatch[] = []

  for (let roundNumber = 1; roundNumber <= 2 * (totalWinnerRounds - 1); roundNumber += 1) {
    const isOddRound = roundNumber % 2 === 1
    let pairs: Array<[MatchSlot, MatchSlot]> = []

    if (roundNumber === 1) {
      pairs = pairSequentially(winnersRounds[0].matches.map((match) => match.loserSlot))
    } else if (isOddRound) {
      pairs = pairSequentially(previousRound.map((match) => match.winnerSlot))
    } else {
      const previousWinners = previousRound.map((match) => match.winnerSlot)
      const winnerRoundIndex = roundNumber / 2
      const incomingLosers = winnersRounds[winnerRoundIndex].matches.map(
        (match) => match.loserSlot,
      )

      pairs = previousWinners.map((slot, index) => [slot, incomingLosers[index] ?? EMPTY_SLOT])
    }

    const matches = pairs.map(([left, right], matchIndex) => {
      const id = `l-${roundNumber}-${matchIndex + 1}`
      const code = `L${roundNumber}M${matchIndex + 1}`

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
      id: `losers-${roundNumber}`,
      title: `Elimination Round ${roundNumber}`,
      subtitle: isOddRound ? 'Losers stay alive' : 'Drops from winners bracket join',
      matches,
    })

    previousRound = matches
  }

  return rounds
}

export function buildTournamentBracket(
  entrants: TournamentEntrant[],
  format: EliminationFormat,
  results: ResultMap,
): BracketView {
  const { rounds: winnersRounds, championSlot: winnersChampionSlot } =
    buildWinnersBracket(entrants, results)
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