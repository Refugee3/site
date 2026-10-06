# PDF Auto-Grader

A small self-hosted web app that grades handwritten student work against a teacher's answer key.

1. The teacher uploads an **answer key** (PDF). Claude turns it into a structured list of items, which the teacher reviews and edits.
2. Students open a share link (`/s/K7M4QX`, no account needed) and hand in a **PDF or phone photos** of their work.
3. Claude **reads every page**, in any handwriting, and judges each item against the key.
4. The grade is **computed in code** from those judgments: by completion (the default), accuracy, or a blend of both.
5. Each student gets **notes on what they did** and feedback per question, and the teacher sees papers **organized by section and name**, with anything doubtful flagged for review and a CSV export.

> **AI grades can be wrong.** Review the flagged papers, spot-check the others, and only then release feedback to students.

## Quick start

Requires Node 22 or newer.

```bash
npm install
cp .env.example .env.local
AI_MODE=fake npm run dev
```

Open <http://localhost:3000/signup> and create the first teacher account. `AI_MODE=fake` replaces Claude with a deterministic stand-in, so the whole flow (key, uploads, grading, review, release, CSV) works without an API key. Every teacher page then shows "FAKE AI MODE — grades are not real".

For real grading in production, set `ANTHROPIC_API_KEY` (and `APP_URL`) in the environment or `.env.local`, then:

```bash
npm run build
npm start
```

All settings are listed, with defaults, in [`.env.example`](.env.example). The most useful ones:

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Required when `AI_MODE=claude` (the default). Without it the grading worker stays paused. |
| `APP_URL` | — | Public origin, e.g. `https://grader.school.org`. Used for share and receipt links, the origin check and secure cookies. |
| `DATA_DIR` | `./data` | SQLite database and uploaded PDFs. |
| `ANTHROPIC_EFFORT` | `high` | `low` … `max`. `medium` is cheaper and faster. |
| `TEACHER_SIGNUP_CODE` | — | Lets additional teachers sign up (see below). |
| `MAX_UPLOAD_MB` / `MAX_PAGES` | `20` / `40` | Per-upload limits for students, teacher uploads and keys. |

## Teacher accounts

- The **first** account can be created by anyone who reaches `/signup`, so create it right after deploying.
- After that, sign-up requires `TEACHER_SIGNUP_CODE`. Share the code only with colleagues who should get an account.
- If `TEACHER_SIGNUP_CODE` is unset, sign-up is closed once the first teacher exists.

## Run exactly one instance

The grading queue lives in SQLite and the worker runs inside the Next.js server process; upload rate limits are kept in memory. **Run a single `next start` process** — no clustering, no second replica, no serverless platform. Jobs left running when the process stops are picked up again at the next start.

## Behind a reverse proxy

Terminate TLS in a reverse proxy and let it pass the client's address and the original host. Raise the body limit above `MAX_UPLOAD_MB`. Set `APP_URL` to the public origin.

Caddy:

```caddy
grader.school.org {
	request_body {
		max_size 25MB
	}
	reverse_proxy 127.0.0.1:3000
}
```

Caddy sets `X-Forwarded-For`, `X-Forwarded-Host` and `X-Forwarded-Proto` itself.

nginx:

```nginx
server {
    listen 443 ssl;
    server_name grader.school.org;
    # ssl_certificate / ssl_certificate_key ...

    client_max_body_size 25m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
    }
}
```

Only set `ALLOWED_ORIGINS` if your proxy rewrites the `Host` header.

## Backups

Everything lives in `DATA_DIR`. Back up the database with SQLite's online backup (safe while the app runs) and copy the uploaded files:

```bash
sqlite3 data/app.db ".backup backup.db"
cp -r data/files backup-files
```

## Privacy

Student work — the PDFs and photos, including names written on them — and the answer key are sent to the Anthropic API for grading. Make sure that is acceptable under your school's policies before using real student work. Nothing is shared with other services, and pages are marked `noindex`.

## Cost

Roughly **$0.10–0.30 per paper** with the default model (`claude-opus-5-5`, $4 / $20 per million input / output tokens). Output and thinking tokens dominate; `ANTHROPIC_EFFORT=medium` is the main lever for lowering cost. The answer key is cached between papers, so its cost is negligible. Each assignment's Settings tab shows its token usage and estimated cost.

## Development

```bash
npm run dev        # development server
npm test           # unit tests (vitest, no network)
npm run typecheck  # next typegen && tsc --noEmit
npm run lint
```
