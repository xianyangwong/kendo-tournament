import type { EliminationFormat, TournamentKind, TournamentEntrant } from './tournament'

export interface SoloEntry {
  id: string
  name: string
}

export interface TeamMember {
  id: string
  name: string
}

export interface TeamEntry {
  id: string
  name: string
  members: TeamMember[]
}

export interface TournamentDraft {
  name: string
  kind: TournamentKind
  format: EliminationFormat
  singles: SoloEntry[]
  teams: TeamEntry[]
}

export interface MatchScore {
  left: number
  right: number
}

export interface TournamentRecord extends TournamentDraft {
  id: string
  createdAt: string
  updatedAt: string
  results: Record<string, string>
  scores: Record<string, MatchScore>
  lineups: Record<string, { left: string[]; right: string[] }>
}

export const TOURNAMENT_STORAGE_KEY = 'kendo-tournament:v1'

export function makeId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`
}

export function createSoloEntry(name = ''): SoloEntry {
  return {
    id: makeId('solo'),
    name,
  }
}

export function createTeamMember(name = ''): TeamMember {
  return {
    id: makeId('member'),
    name,
  }
}

export function createTeamEntry(name = '', members: string[] = ['', '', '']): TeamEntry {
  return {
    id: makeId('team'),
    name,
    members: members.map((member) => createTeamMember(member)),
  }
}

export function createEmptyTournamentDraft(): TournamentDraft {
  return {
    name: 'New Kendo Tournament',
    kind: 'single',
    format: 'single',
    singles: [createSoloEntry(), createSoloEntry()],
    teams: [createTeamEntry(), createTeamEntry()],
  }
}

function shuffled<T>(items: T[]): T[] {
  const arr = [...items]
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

export function cloneSingles(entries: SoloEntry[]): SoloEntry[] {
  return entries.map((entry) => ({ ...entry }))
}

export function cloneTeams(entries: TeamEntry[]): TeamEntry[] {
  return entries.map((team) => ({
    ...team,
    members: team.members.map((member) => ({ ...member })),
  }))
}

export function createTournamentRecord(
  draft: TournamentDraft,
  options?: Partial<Pick<TournamentRecord, 'id' | 'createdAt' | 'updatedAt' | 'results' | 'scores' | 'lineups'>>,
): TournamentRecord {
  const timestamp = new Date().toISOString()

  return {
    id: options?.id ?? makeId('tournament'),
    createdAt: options?.createdAt ?? timestamp,
    updatedAt: options?.updatedAt ?? timestamp,
    results: options?.results ?? {},
    name: draft.name,
    kind: draft.kind,
    format: draft.format,
    singles: shuffled(cloneSingles(draft.singles)),
    teams: shuffled(cloneTeams(draft.teams)),
    scores: options?.scores ?? {},
    lineups: options?.lineups ?? {},
  }
}

export function toTournamentEntrants(
  kind: TournamentKind,
  singles: SoloEntry[],
  teams: TeamEntry[],
): TournamentEntrant[] {
  if (kind === 'single') {
    return singles.map((entry) => ({
      id: entry.id,
      label: entry.name.trim() || 'Unnamed kendoka',
      details: ['Solo bracket entry'],
    }))
  }

  return teams.map((team) => ({
    id: team.id,
    label: team.name.trim() || 'Untitled team',
    details:
      team.members.length > 0
        ? team.members.map((member, index) => `${index + 1}. ${member.name.trim() || 'Open slot'}`)
        : ['No team members yet'],
  }))
}