# gemini_email_enricher_bounceban

Gemini-powered email enrichment and verification app with BounceBan integration.

## Features

- Upload CSV or spreadsheet files from the web UI
- Process rows through a Gemini-driven browser workflow
- Verify email addresses with BounceBan
- Download processed output files
- Recover stale jobs on server restart

## Requirements

- Node.js 18+
- Google Chrome installed locally
- Access to a logged-in Gemini browser profile
- BounceBan API key

## Environment Variables

Create a `.env` file in the project root and set the values you need:

```env
PORT=3000
BOUNCEBAN_API_KEY=your_bounceban_api_key_here
CDP_PORT=9226
CHROME_PATH=
CHROME_USER_DATA_DIR=./chrome-data
GEMINI_PARALLEL_WINDOWS=5
GEMINI_SEARCH_DELAY_MS=2000
GEMINI_RESPONSE_TIMEOUT_MS=30000
BOUNCEBAN_MAX_PARALLEL=100
```

## Install

```bash
npm install
```

## Run

```bash
npm start
```

For development:

```bash
npm run dev
```

The app serves the UI at `http://localhost:3000` by default.

## Project Structure

- `server.js` - Express server entry point
- `public/` - Frontend assets
- `src/` - Browser automation, parsing, processing, and API routes
- `data/` - Generated exports and job state files

## Notes

- Do not commit `.env`, generated CSV files, or job output files.
- The repository does not include a license file yet.