# WhatsApp Checker

## Overview

A full-stack web app to verify whether phone numbers are registered on WhatsApp. Uses a linked WhatsApp account via one-time QR scan (session persists permanently). Provides a React frontend and a Node.js/Baileys API backend.

## Architecture

- **Frontend**: React + Vite (`artifacts/whatsapp-checker/src`)
- **Backend**: Node.js + Express + Baileys (`artifacts/whatsapp-checker/wa-server.mjs`)
- **Database**: SQLite via `better-sqlite3` (`.wa-data/checker.db`) — check history and per-number results survive restarts
- **Auth storage**: Baileys session files in `.wa-auth/`

## Stack

- **Monorepo tool**: pnpm workspaces
- **Frontend**: React 19, Vite, Tailwind CSS, TanStack Query, Sonner toasts, shadcn/ui
- **Backend**: Node.js (ESM), Express 5, `@whiskeysockets/baileys`, `better-sqlite3`

## Services

- `artifacts/whatsapp-checker: web` — Vite dev server on port 23059 (dev only)
- `artifacts/whatsapp-checker: api` — Node.js API on port 5000 (dev); in production, this unified server also serves the built React frontend static files

## Production Deployment

Single unified process: `pnpm --filter @workspace/whatsapp-checker run start` (`node wa-server.mjs`).
- Build step: `pnpm --filter @workspace/whatsapp-checker run build` → outputs to `dist/public/`
- Server reads `PORT` from the environment (injected by the deployment platform)
- Serves `dist/public` as static files; falls back to `index.html` for SPA routing
- All `/api/*` routes handled by Express
- Requires **VM deployment** (always-running) since WhatsApp session is stateful

## Key Features

- One-time QR scan to link a WhatsApp account; session persists permanently
- Bulk-check up to 100 phone numbers at once
- Single-number REST endpoint: `GET /api/check/:number`
- Real-time status updates via SSE (`/api/sse`)
- Persistent check history with per-session detail view
- Overall statistics (total checks, success rate)
- CSV export of results

## API Endpoints

- `GET /api/status` — connection status + QR code (base64 PNG)
- `POST /api/check` — bulk check `{ numbers: string[] }`
- `GET /api/check/:number` — single-number check (not saved to DB)
- `GET /api/history` — all past sessions
- `GET /api/history/:id` — results for a session
- `GET /api/stats` — overall stats
- `GET /api/sse` — Server-Sent Events stream
- `GET /api/docs` — API metadata

## Running

Both dev services start automatically via workflows. The API proxy runs at `/api` and the Vite dev server at `/`.

For production, only the unified Node server runs (handles both API + static serving on `PORT`).
