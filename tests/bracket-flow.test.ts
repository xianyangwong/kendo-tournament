import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildTournamentBracket,
  type BracketMatch,
  type EliminationFormat,
  type TournamentEntrant,
} from '../src/tournament.js'

function entrants(names: string[]): TournamentEntrant[] {
  return names.map((name) => ({
    id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    label: name,
    details: [],
  }))
}

function bracket(names: string[], format: EliminationFormat, results: Record<string, string> = {}) {
  return buildTournamentBracket(entrants(names), format, results)
}

function matchShape(match: BracketMatch) {
  return {
    code: match.code,
    left: match.left.label,
    right: match.right.label,
    winner: match.winnerSlot.label,
    auto: match.isAutoAdvance,
  }
}

test('double knockout with 3 entrants shows the bottom seed as W1M2 bye', () => {
  const view = bracket(['A', 'B', 'C'], 'double')

  assert.deepEqual(view.winnersRounds[0].matches.map(matchShape), [
    { code: 'W1M1', left: 'A', right: 'B', winner: 'Winner W1M1', auto: false },
    { code: 'W1M2', left: 'C', right: 'BYE', winner: 'C', auto: true },
  ])
  assert.deepEqual(matchShape(view.winnersRounds[1].matches[0]), {
    code: 'W2M1',
    left: 'Winner W1M1',
    right: 'C',
    winner: 'Winner W2M1',
    auto: false,
  })
})

test('double knockout with 6 entrants feeds W1M1 and W1M2 winners into W2M1', () => {
  const view = bracket(
    ['Raymond', 'Mark', 'Mike', 'Matt', 'Yang', 'Nick'],
    'double',
    {
      'w-1-1': 'raymond',
      'w-1-2': 'matt',
      'w-1-3': 'nick',
    },
  )

  assert.deepEqual(view.winnersRounds[1].matches.map(matchShape), [
    { code: 'W2M1', left: 'Raymond', right: 'Matt', winner: 'Winner W2M1', auto: false },
    { code: 'W2M2', left: 'Nick', right: 'BYE', winner: 'Nick', auto: true },
  ])
})

test('double knockout with 7 entrants keeps adjacent winners paired before the bye carry', () => {
  const view = bracket(['A', 'B', 'C', 'D', 'E', 'F', 'G'], 'double')

  assert.deepEqual(view.winnersRounds[0].matches.map(matchShape), [
    { code: 'W1M1', left: 'A', right: 'B', winner: 'Winner W1M1', auto: false },
    { code: 'W1M2', left: 'C', right: 'D', winner: 'Winner W1M2', auto: false },
    { code: 'W1M3', left: 'E', right: 'F', winner: 'Winner W1M3', auto: false },
    { code: 'W1M4', left: 'G', right: 'BYE', winner: 'G', auto: true },
  ])
  assert.deepEqual(view.winnersRounds[1].matches.map(matchShape), [
    { code: 'W2M1', left: 'Winner W1M1', right: 'Winner W1M2', winner: 'Winner W2M1', auto: false },
    { code: 'W2M2', left: 'Winner W1M3', right: 'G', winner: 'Winner W2M2', auto: false },
  ])
})

test('single knockout with 3 entrants keeps the bye hidden but feeds the final correctly', () => {
  const view = bracket(['A', 'B', 'C'], 'single')

  assert.deepEqual(view.winnersRounds[0].matches.map(matchShape), [
    { code: 'W1M1', left: 'A', right: 'B', winner: 'Winner W1M1', auto: false },
  ])
  assert.deepEqual(matchShape(view.winnersRounds[1].matches[0]), {
    code: 'W2M1',
    left: 'Winner W1M1',
    right: 'C',
    winner: 'Winner W2M1',
    auto: false,
  })
})

test('single knockout with 5 entrants pairs W1M1 and W1M2 winners before the bye carry', () => {
  const view = bracket(
    ['A', 'B', 'C', 'D', 'E'],
    'single',
    {
      'w-1-1': 'a',
      'w-1-2': 'c',
    },
  )

  assert.deepEqual(matchShape(view.winnersRounds[1].matches[0]), {
    code: 'W2M1',
    left: 'A',
    right: 'C',
    winner: 'Winner W2M1',
    auto: false,
  })
  assert.deepEqual(matchShape(view.winnersRounds[2].matches[0]), {
    code: 'W3M1',
    left: 'Winner W2M1',
    right: 'E',
    winner: 'Winner W3M1',
    auto: false,
  })
})
