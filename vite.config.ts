import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const legacyBrowserTargets = ['chrome80', 'edge80', 'firefox78', 'safari13', 'ios13']

// https://vite.dev/config/
export default defineConfig({
  // GitHub Pages serves the site from /<repo>/; override with VITE_BASE for custom domains or local dev.
  base: process.env.VITE_BASE ?? '/kendo-tournament/',
  plugins: [react()],
  build: {
    target: legacyBrowserTargets,
    cssTarget: legacyBrowserTargets,
  },
})
