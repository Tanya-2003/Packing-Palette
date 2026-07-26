# Packing Palette

A lightweight React + Vite app for planning travel packing lists with destination weather, activity-aware recommendations, and destination palette inspiration.

## Live demo

- Primary public link: `https://packing-palette-eight.vercel.app`
- Production deployment: `https://packing-palette-3ttijkxat-tanya-2003s-projects.vercel.app`

## Features

- Search destination cities with Open-Meteo geocoding
- Generate a trip-ready packing list based on trip length, weather, and activities
- Show weather summary with temperature, rain chance, and estimated UV index
- Extract destination color palettes from iconic travel imagery
- Clean editorial field guide UI with responsive layout and packing checklist

## Local setup

1. Install dependencies

```bash
npm install
```

2. Start the dev server

```bash
npm run dev
```

3. Open the local preview URL shown by Vite

## Build for production

```bash
npm run build
```

## Preview production build locally

```bash
npm run preview
```

## Environment variables

The app can optionally use Google Custom Search for destination images. Add these variables in a `.env` file or your deployment settings if you want image search support:

```env
VITE_GOOGLE_API_KEY=your_google_api_key
VITE_GOOGLE_CX=your_custom_search_engine_id
VITE_GOOGLE_IMAGE_SEARCH=true
```

If Google image search is unavailable, the app falls back to Wikimedia image sources for destination imagery.

## Project structure

- `src/App.jsx` — main React app
- `src/styles.css` — app styling
- `vite.config.js` — Vite configuration
- `package.json` — dependencies and scripts

## Deployment

This repository is deployed on Vercel. The public alias is the best URL to share.

## Notes

- The app is designed to use client-side APIs only.
- Weather data is powered by Open-Meteo and may be forecast or historical averages depending on trip timing.
- The packing recommendations are intended as general guidance and should be reviewed before travel.

