IMDb Ønskeliste — Setup

Local setup

- Copy `.env.example` to `.env` and set your OMDb API key:

  OMDB_API_KEY=your_real_key_here

- Start the app:

  node server.js

- Or from project root (matches `package.json` start):

  npm start

Production (Render)

- On Render, create a new Web Service pointing to this repository.
- Build command: `npm install`
- Start command: `npm start`
- Add environment variables in the Render dashboard or using a `render.yaml`:
  - `OMDB_API_KEY` — your OMDb API key (required for richer titles)
  - `DATABASE_URL` — (optional) PostgreSQL connection string if you want persistent storage

Notes

- If `OMDB_API_KEY` is unset, the server will attempt to scrape the IMDb page to extract a title, but OMDb is recommended for reliability.
- Do NOT commit secrets; keep real values in Render dashboard or a local `.env` excluded from VCS.
