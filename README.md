# Kendo Tournament Builder

Web application for creating, tracking, and revisiting kendo tournaments with persistent local storage and live bracket visuals.

## Features

- Home page with current and past tournament lists
- Local storage persistence for saved tournaments
- Wizard flow for creating a new tournament
- Single tournaments and team tournaments
- Single knockout and double knockout formats
- Team member name entry with explicit roster order
- Live tournament status by clicking winners directly in the bracket
- Automatic byes when the entrant count is not a power of two

## App Flow

1. Open the home page to review active and completed tournaments.
2. Create a new tournament from the wizard at `/tournaments/new`.
3. Choose `Single` or `Team`, then choose `Single knockout` or `Double knockout`.
4. Add competitors or teams.
5. For teams, add members and use the ordering controls to define the lineup.
6. Save the tournament and continue on the tournament detail page.
7. Click winners in the bracket diagram to advance the tournament and update status.

## Development

```bash
npm install
npm run dev
```

The Vite dev server usually starts at `http://localhost:5173`.

## Production Build

```bash
npm run build
```

## Stack

- React 19
- React Router
- TypeScript
- Vite
- Browser localStorage

## Validation

The current project build passes with `npm run build`.
