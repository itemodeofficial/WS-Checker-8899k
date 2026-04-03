# WhatsApp Checker

## Overview

A web app to check which phone numbers have WhatsApp accounts. Paste up to 100 phone numbers with country codes and see which ones are active on WhatsApp, with history and stats.

## Architecture

- **Frontend**: React + Vite (artifacts/whatsapp-checker)
- **Backend**: Python Flask (Whatsappchecker.py, also copied to artifacts/whatsapp-checker/)
- **Checking method**: wa.me link verification via HTTP requests

## Stack

- **Monorepo tool**: pnpm workspaces
- **Frontend**: React 19, Vite, Tailwind CSS, TanStack Query, Sonner toasts
- **Backend**: Python 3.11, Flask, Flask-CORS, requests, phonenumbers

## Services

- `artifacts/whatsapp-checker: web` — React frontend on port 23059
- `artifacts/whatsapp-checker: api` — Python Flask backend on port 5000, serving `/api`

## Key Features

- Paste phone numbers (one per line), check up to 100 at once
- Auto-normalizes international number formats using the `phonenumbers` library
- Shows which numbers have WhatsApp (green) vs not (red) vs unknown (amber)
- Check history with per-session detail view
- Overall statistics (total checks, success rate)
- CSV export of results

## Running

Both services start automatically via workflows. The API is at `/api` and the frontend is at `/`.
