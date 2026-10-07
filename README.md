# PDF Auto-Grader

A small self-hosted web app that grades handwritten student work against a teacher's answer key.

1. The teacher uploads an **answer key** (PDF). Claude turns it into a structured list of items, which the teacher reviews and edits.
2. The teacher uploads the **homework**: one PDF per student, or **one scan of the whole stack** that Claude splits into papers for the teacher to check. Students can also hand in work themselves through a share link, once a teacher turns that on.
3. Claude **reads every page**, in any handwriting, and judges each item against the key.
4. The grade is **computed in code** from those judgments: by completion (the default), accuracy, or a blend of both.
5. Each student gets **notes on what they did** and feedback per question, and the teacher sees papers **organized by section and name**, with anything doubtful flagged for review and a CSV export.

> **AI grades can be wrong.** Review the flagged papers, spot-check the others, and only then release feedback to students.

## What's new

- **Upload the homework yourself:** one PDF per student, or one scan of the whole class's stack. The AI finds where each paper starts (or you split it every N pages), and you check the split before anything is graded.
- **Student uploads are off by default**, on new and upgraded servers alike. Turn them on in Settings when you want students to hand in work through a code or link.
- **The grader learns from your corrections:** each correction (with your reason) becomes a lesson that later gradings of the assignment follow, together with your grading preferences.
- **The Anthropic API key can be set in the app** (Settings), stored encrypted; `ANTHROPIC_API_KEY` is now optional.
- **One-click regrade** of the papers graded before your latest corrections.

## Quick start

Requires Node 22 or newer.

```bash
npm install
cp .env.example .env.local
AI_MODE=fake npm run dev
```

Open <http://localhost:3000/signup> and create the first teacher account. `AI_MODE=fake` replaces Claude with a deterministic stand-in, so the whole flow (key, uploads, scans, grading, review, lessons, release, CSV) works without an API key. Every teacher page then shows "FAKE AI MODE — grades are not real".

For real grading in production, set `APP_URL` in the environment or `.env.local`, then:

```bash
npm run build
npm start
```

Sign in and paste your Anthropic API key under **Settings → Anthropic API key**. It is checked with Anthropic, stored encrypted, and used from the next paper on; replacing or removing it takes effect without a restart. Alternatively set `ANTHROPIC_API_KEY` in the environment: a key saved in Settings takes precedence over it. Without either, papers wait in the queue.

All settings are listed, with defaults, in [`.env.example`](.env.example). The most useful ones:

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Optional. Used when no key is saved in Settings; a key saved there takes precedence. With neither, the grading worker stays paused. |
| `APP_SECRET` | — | 32+ random characters (`openssl rand -base64 32`) that encrypt the API key saved in Settings. Empty: `DATA_DIR/secret.key` is generated and used instead (see Backups). Changing it makes the saved key unreadable; Settings then asks for it again. |
| `APP_URL` | — | Public origin, e.g. `https://grader.school.org`. Used for share and receipt links, the origin check and secure cookies. |
| `DATA_DIR` | `./data` | SQLite database and uploaded PDFs. |
| `ANTHROPIC_EFFORT` | `high` | `low` … `max`. `medium` is cheaper and faster. |
| `TEACHER_SIGNUP_CODE` | — | Required to sign up, when set (see below). At least 12 characters. |
| `MAX_UPLOAD_MB` / `MAX_PAGES` | `20` / `40` | Per-upload limits for students, teacher uploads and keys; also the limit for each paper cut from a scan. |
| `MAX_SCAN_MB` / `MAX_SCAN_PAGES` | `100` / `200` | Limits for one scan of a whole class's stack (at most 200 MB / 500 pages). The reverse proxy must allow uploads this large. |

The server checks the settings, the data directory and the database when it starts; if anything is wrong it logs the problem and exits with code 1 instead of serving errors.

## Teacher accounts

- If `TEACHER_SIGNUP_CODE` is set, **every** sign-up needs it, the first one included. Use a random code of at least 12 characters (for example the output of `openssl rand -base64 12`), not a word, and share it only with colleagues who should get an account. Wrong codes are limited to 20 per hour server-wide.
- If `TEACHER_SIGNUP_CODE` is unset, the **first** account can be created by anyone who reaches `/signup` (so create it right after deploying), and sign-up is closed once it exists.

## Students can upload their own work

The switch **Settings → Student submissions → "Students can upload their own work"** applies to every teacher on the server. It is **off by default, also on existing installs after the upgrade**: assignments that were open stop taking student uploads until a teacher turns the switch on (they keep their status and take uploads again once it is on).

While it is off:

- Teachers upload all the homework on each assignment's **Upload homework** tab. Codes, share links, the open/close buttons and "Save & open" are hidden.
- The start page and every `/s/CODE` page tell students their teacher isn't accepting online submissions and to hand in their paper instead; the upload endpoint refuses before looking up the code.
- **Receipt links keep working**: copy a paper's student link from its page or from the upload list, and the student sees their feedback there once you release it.

## How the grader learns

It is not retrained. When you correct the AI on a paper — the points, the feedback or "What you did" — and optionally say why ("Lowercase co2 is fine."), the correction becomes a **lesson** for that assignment. Every later grading of the assignment sends the active lessons along with your **grading preferences** (Settings → Grading preferences: standing notes for all of your assignments), and the grader follows your rulings on the same or similar answers to the same question.

- Each assignment's **Lessons** tab lists its lessons, says which ones the grader is sent (and why others aren't), and lets you edit the reason, turn a lesson off, or copy its reason into your grading preferences. A lesson stays with your correction on its paper, so turning it off is how you stop the grader using it (it stays off when you edit that correction later).
- Deleting a paper keeps the lessons from your corrections on it, with that student's answer and your notes: the Lessons tab marks them "Its paper was deleted", and you can delete them there.
- A lesson shows the answer as the AI read it, so say in the reason when you corrected a misreading ("The student wrote x = -3; the minus is faint."). A correction of an answer the AI saw as blank or couldn't read is sent only once it has a reason, and a ruling without a reason that contradicts the answer key sends the paper to you instead of overriding the key. Points that no judgment gives exactly (3 of 5 on an all-or-nothing question) are passed on too, and matching answers on later papers come to you to set the points.
- Papers graded before your latest lessons or preferences can be regraded in one click: **"Regrade N papers with your latest corrections"** on the board or the Lessons tab. Papers you already corrected or marked reviewed are left alone (you can still regrade one from its page); your overrides and edits are always kept.

## Run exactly one instance

The grading queue lives in SQLite and the worker runs inside the Next.js server process; upload rate limits are kept in memory. **Run a single `next start` process** — no clustering, no second replica, no serverless platform. Jobs left running when the process stops are picked up again at the next start.

## Behind a reverse proxy

Terminate TLS in a reverse proxy and let it pass the client's address and the original host. Raise the body limit above `MAX_SCAN_MB` (a whole-class scan is the largest upload; 110 MB for the default 100 MB). Set `APP_URL` to the public origin.

Make the Node server reachable **only through the proxy**: start it on the loopback interface with `npm start -- -H 127.0.0.1` (or firewall port 3000). The per-address rate limits (login, uploads, code lookups) read the client's address from `X-Forwarded-For`, which only the proxy can be trusted to set. A client that reaches `next start` directly can put any address there, and those limits then mean nothing; only the limits that don't depend on the address (uploads per assignment and in all, wrong signup codes) still hold.

Caddy:

```caddy
grader.school.org {
	request_body {
		max_size 110MB
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

    client_max_body_size 110m;

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
cp data/secret.key backup-secret.key   # only when APP_SECRET is not set
```

The API key saved in Settings is encrypted with `APP_SECRET`, or, when that is not set, with `DATA_DIR/secret.key`. Back up `secret.key` together with the database (without it a restored server can't read the saved key, and Settings asks for it again). Anyone holding the database alone can't read the key, but anyone holding all of `DATA_DIR` without `APP_SECRET` can: setting `APP_SECRET` keeps the secret out of the data directory.

## Memory

An upload is held in memory while it is checked: plan for about **3× the largest scan** (about 300 MB for a 100 MB scan) on top of the app's usual needs.

## Privacy

Student work — the PDFs and photos, including names written on them — and the answer key are sent to the Anthropic API for grading. Make sure that is acceptable under your school's policies before using real student work. Nothing is shared with other services, and pages are marked `noindex`.

## Cost

Roughly **$0.10–0.30 per paper** with the default model (`claude-opus-5-5`, $4 / $20 per million input / output tokens). Output and thinking tokens dominate; `ANTHROPIC_EFFORT=medium` is the main lever for lowering cost. The answer key, your lessons and your grading preferences are cached between papers, so their cost is small. Splitting a whole-class scan with the AI costs about **$0.01 per scanned page** on top (splitting every N pages is free). Each assignment's Settings tab shows its token usage and estimated cost, added up over every AI call (regrades, retries, reading the key and splitting scans included).

## Development

```bash
npm run dev        # development server
npm test           # unit tests (vitest, no network)
npm run typecheck  # next typegen && tsc --noEmit
npm run lint
```
