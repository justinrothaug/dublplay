---
title: NBA Edge
emoji: 🏀
colorFrom: green
colorTo: blue
sdk: docker
pinned: false
app_port: 7860
---

# 🏀 NBA Edge — AI Betting Analyst

A full-stack NBA betting analysis app powered by Google Gemini AI.

## Features
- 🔴 **Live Scores** with real-time win probabilities
- 📅 **Tonight's Games** — spreads, moneylines, O/U
- ⚡ **Gemini AI Analysis** — one click per game
- 🎯 **Player Prop Picks** with confidence ratings
- 📊 **Standings** with win streaks
- 💬 **AI Chat** — ask anything about the NBA slate

## Setup

### Option 1 — Set a server-side API key (Hugging Face Secrets)
Add `GEMINI_API_KEY` as a Space secret. Users won't need to enter a key.

### Option 2 — Users enter their own key
Leave `GEMINI_API_KEY` unset. A key prompt will appear on load.
Get a free key at [Google AI Studio](https://aistudio.google.com/app/apikey).

## Local Development

```bash
# Backend only
cd backend
pip install -r requirements.txt
uvicorn main:app --reload

# Frontend only (in another terminal)
cd frontend
npm install
npm run dev

# Full stack with Docker
docker compose up --build
```

## Disclaimer
For entertainment purposes only. Not financial advice. Please gamble responsibly.
