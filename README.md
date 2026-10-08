# PDF Auto-Grader

A small self-hosted web app that grades handwritten student work against a teacher's answer key.

1. The teacher uploads an **answer key** (PDF, photos, Word or text file). Claude turns it into a structured list of items, which the teacher reviews and edits.
2. The teacher uploads the **homework or quiz**: one file per student, or **one scan of the whole stack** that Claude grades in one pass (or splits into papers for the teacher to check first). Students can also hand in work themselves through a share link, once a teacher turns that on.
3. Claude **reads every page**, in any handwriting, and judges each item against the key.
4. The grade is **computed in code** from those judgments: by completion (the default), accuracy, or a blend of both.
5. The teacher sees papers **organized by section and name**, with anything doubtful flagged for review and a CSV export. Optionally (per assignment), each student also gets **notes on what they did** and feedback per question.

> **AI grades can be wrong.** Review the flagged papers, spot-check the others, and only then release feedback to students.

## What's new

- **Notes for students are optional, and off by default** (new and existing assignments). Tick **Write notes for students** when creating an assignment or on its **Settings** tab to have the AI explain what each student did and give feedback on every question. Notes are most of what the AI writes, so turning them on makes each paper cost roughly **1.5×** as much (more for assignments with many questions). With notes off the AI still reads and judges every answer, scores are the same, and you can still write your own feedback on the review page; receipts and the CSV simply leave the notes out. Changing the setting applies to papers graded from then on and doesn't mark graded papers for regrading.
- **Quizzes:** each assignment is now **Homework** or a **Quiz** (choose when creating it, or change it on its **Settings** tab). Both are graded exactly the same way; quizzes get a "Quiz" badge, "Upload quizzes" wording, and the dashboard can be filtered to **All**, **Homework** or **Quizzes**. Existing assignments become Homework.
- **Any file format:** every upload (answer key, per-student papers, whole-stack scans and student uploads) accepts **PDFs, photos, Word (.docx) and text files (.txt, .md, .csv)**, and several files are joined into one paper in the order picked. Everything is turned into a PDF on the server before grading. JPEG and PNG become pages as they are; other images (iPhone HEIC, WebP, GIF, TIFF, AVIF…) are converted to JPEG in the browser first, so a browser that can't open a format says so. Word and text files become plain text pages (formatting and pictures in a Word file are dropped, so upload a PDF when layout or drawings matter). Old `.doc`, `.pages` and other formats are refused with "Save it as PDF or .docx first".
- **Choose the AI model** under **Settings → AI model**: **Claude Sonnet 5.5** (the default, about half the cost, good for most homework) or **Claude Opus 5.5** (the most capable, for messy handwriting or tricky answers). Servers upgraded from an earlier version start on Sonnet 5.5 too. `ANTHROPIC_MODEL` is no longer used: if your `.env.local` still sets it, the server ignores it and logs a warning at startup, so delete the line.
- **Grading with an Anthropic-hosted agent (optional, off by default):** Claude reads each paper in its own workspace on Anthropic's servers and can zoom in on hard-to-read handwriting. It's slower and more expensive than the direct API, which is the default (also on upgraded servers, unless a teacher chose the hosted agent); switch under **Settings → Grader**.
- **Upload the homework yourself:** one PDF per student, or one scan of the whole class's stack. By default a scan is **graded in one pass** (the cheapest way): the AI reads each page once, finds whose paper it is and grades it in the same step, and papers whose start or end it isn't sure about are flagged ("Check the paper's pages") for your review. You can instead have the AI **split first, then grade** (or split it every N pages yourself) and check the split before anything is graded — unless the AI's split looks clean (every paper has one name, the usual number of pages, and every page was read confidently): then grading starts on its own and the scan's page says so. The hosted agent can't grade in one pass, so with it a scan is always split first.
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

Sign in and paste your Anthropic API key under **Settings → Anthropic API key**. It is checked with Anthropic (against the model chosen under **Settings → AI model**), stored encrypted, and used from the next paper on; replacing or removing it takes effect without a restart. Alternatively set `ANTHROPIC_API_KEY` in the environment: a key saved in Settings takes precedence over it. Without either, papers wait in the queue.

All settings are listed, with defaults, in [`.env.example`](.env.example). The most useful ones:

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Optional. Used when no key is saved in Settings; a key saved there takes precedence. With neither, the grading worker stays paused. |
| `APP_SECRET` | — | 32+ random characters (`openssl rand -base64 32`) that encrypt the API key saved in Settings. Empty: `DATA_DIR/secret.key` is generated and used instead (see Backups). Changing it makes the saved key unreadable; Settings then asks for it again. |
| `APP_URL` | — | Public origin, e.g. `https://grader.school.org`. Used for share and receipt links, the origin check and secure cookies. |
| `DATA_DIR` | `./data` | SQLite database and uploaded PDFs. |
| `ANTHROPIC_EFFORT` | `high` | `low` … `max`. `medium` is cheaper and faster. |
| `ANTHROPIC_MODEL` | — | **No longer used.** Choose the model under Settings → AI model. If it is still set, it is ignored and the server logs "ANTHROPIC_MODEL is no longer used — choose the model on the Settings page." at startup. |
| `TEACHER_SIGNUP_CODE` | — | Required to sign up, when set (see below). At least 12 characters. |
| `MAX_UPLOAD_MB` / `MAX_PAGES` | `20` / `40` | Per-upload limits for students, teacher uploads and keys; also the limit for each paper cut from a scan. |
| `MAX_SCAN_MB` / `MAX_SCAN_PAGES` | `100` / `200` | Limits for one scan of a whole class's stack (at most 200 MB / 500 pages). The reverse proxy must allow uploads this large. |
| `GRADING_CONCURRENCY` | `10` | How many papers (and other AI jobs) run at once, 1–32. When Anthropic answers "rate limited" or "overloaded", the paper is retried without using up one of its attempts, the server starts nothing new until the time Anthropic asks for (or a short pause), and it runs half as many at once, climbing back by one after each paper that finishes. Lower it if your Anthropic account's rate limits are low and you'd rather not see these pauses. |
| `SCAN_SPLIT_PARALLEL` | `4` | How many batches of up to 20 pages of one whole-class scan the AI reads at once, 1–8. |
| `ONE_PASS_CHUNK_PAGES` | `18` | Grading a whole-class scan in one pass: the most scanned pages per AI call, 1–40. Calls hold whole papers when the key tells their length (16 pages for 4-page papers). |
| `AGENT_BUDGET_GRADE_USD` | `2.00` | Hosted agent: spending cap per paper, in US dollars at list prices. |
| `AGENT_KEEP_SESSIONS` | `0` | `1` keeps hosted-agent sessions and uploads for debugging. Never with real student work. |

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

## Choosing the AI model

**Settings → AI model** applies to every teacher on the server, with either engine:

- **Claude Sonnet 5.5** (recommended, the default): about half the cost of Opus. Good for most homework.
- **Claude Opus 5.5**: the most capable model, best for messy handwriting or tricky answers. About twice the cost of Sonnet.

The model reads the answer keys and grades the papers. Splitting a whole-class scan into papers always uses Sonnet 5.5. A change applies from the next answer key or paper (one already being graded finishes on the model it started with); papers already graded keep their grades and aren't marked for regrading. A key saved after the change is checked against the chosen model. With the hosted agent, its answer-key reader and paper grader are updated to the new model in your Anthropic workspace (new versions of the same agents).

## Grading with the Anthropic-hosted agent

The **Anthropic-hosted agent** (Claude Managed Agents) is optional and off by default: servers grade with the **direct API**, which sends each paper to Claude in a single request, unless a teacher chooses the hosted agent under **Settings → Grader**. The hosted agent is best for very hard-to-read papers. Instead of sending each paper to Claude in one request, the app gives Claude a private, temporary workspace on Anthropic's servers for each paper, answer key or batch of scanned pages. Claude reads the PDF there and, where handwriting is hard to read, can render a page larger, crop it or rotate it before deciding. It hands its result back through a strict form the app checks; if anything is missing or malformed, the agent is told what to fix and tries again.

- **Same API key, same account, same model.** The agent uses the key under **Settings → Anthropic API key** (or `ANTHROPIC_API_KEY`), the model chosen under **Settings → AI model** (the scan splitter always uses Sonnet 5.5), and is billed to the same Anthropic account. A Claude Pro or Max subscription can't be used by the app.
- **Set up once you choose it.** Nothing is created in your Anthropic workspace while the direct API is chosen. When you choose the hosted agent, the app creates one environment and three agents (answer-key reader, paper grader, scan splitter) in the key's Anthropic workspace, named "PDF Auto-Grader: …", and checks them again before each paper and whenever the key or the model changes. **Settings → Grader** shows "Ready", or the problem and a **Set up again** button. Don't edit or archive them in the Console; if you did, press Set up again. A key from another workspace gets its own set.
- **Cost.** Tokens at the chosen model's prices plus **$0.08 per hour** of agent time. The agent reads in several steps (more AI turns per paper), so a paper costs more than with the direct API; each assignment's Settings tab shows the actual cost. Every session has a spending cap — by default $2.00 per paper (`AGENT_BUDGET_GRADE_USD`), $3.00 per answer key (`AGENT_BUDGET_EXTRACT_USD`) and $1.50 per batch of up to 20 scanned pages (`AGENT_BUDGET_SCAN_USD`). A session that reaches its cap is retried once with double the cap; after that the paper waits for you to grade it.
- **Speed.** Expect a few minutes per paper, slower than the direct API. Several papers are graded at once (`GRADING_CONCURRENCY`); each session stops after `AGENT_SESSION_TIMEOUT_MS` (20 minutes by default) and is retried later.
- **Privacy.** Papers and answer keys are processed on Anthropic's servers. Each upload and each agent session is deleted from Anthropic as soon as its task finishes, successful or not; uploads also expire on their own after an hour, and sessions left behind by a crash are removed automatically by a later grading run. The workspace has no internet access and no web tools. **Claude Managed Agents is not eligible for Zero Data Retention (ZDR) or HIPAA BAA coverage**; if your school requires ZDR, use the direct API under a ZDR agreement. `AGENT_KEEP_SESSIONS=1` keeps sessions and uploads so you can inspect them in the Anthropic Console (the server log prints each session's Console path); never use it with real student work.
- **Switching engines.** **Settings → Grader** switches between the two. The switch applies from the next paper; papers already being graded finish as they started. Stay on the direct API if Managed Agents isn't available to your organization (it's in beta) or you need ZDR; anything already set up for the hosted agent stays in your workspace, unused.

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

Student work — the PDFs and photos, including names written on them — and the answer key are sent to the Anthropic API for grading. Make sure that is acceptable under your school's policies before using real student work. With the hosted agent, see [Grading with the Anthropic-hosted agent](#grading-with-the-anthropic-hosted-agent): each paper's upload and session are deleted after grading, and Managed Agents isn't eligible for Zero Data Retention. Nothing is shared with other services, and pages are marked `noindex`.

## Cost

With the direct API, roughly **$0.05–0.15 per paper** with **Claude Sonnet 5.5**, the default ($2 / $10 per million input / output tokens; cached input $0.20), and roughly **$0.10–0.30 per paper** with **Claude Opus 5.5** ($4 / $20; cached input $0.20). These estimates are with notes for students turned on; with notes off (the default) a paper costs roughly a third less, because the AI writes only its judgments and a short transcription of each answer. Output and thinking tokens dominate; the model and the notes setting are the main levers, and `ANTHROPIC_EFFORT=medium` lowers cost further. The answer key, your lessons and your grading preferences are cached between papers, so their cost is small (writing them to the cache costs 2× the input price with the default `AI_CACHE_TTL=1h`, 1.25× with `5m`). Splitting a whole-class scan with the AI always uses Sonnet 5.5 and costs about **half a cent per scanned page** on top (splitting every N pages is free). Grading a scan **in one pass** reads each page once, on the chosen model: there is no split and the answer key and context are sent once per batch of pages instead of once per paper, so it costs less than splitting first and then grading each paper (most for short papers; the output — the AI's judgments — is the same either way).

Each assignment's Settings tab shows its token usage and estimated cost, added up over every AI call (regrades, retries, reading the key and splitting scans included), each priced at the rate of the model that answered it, so an assignment graded partly with each model is priced correctly. A request that a model declines can be answered by a fallback model (Claude Sonnet 5 for Sonnet 5.5; Claude Opus 5 or Opus 4.8 for Opus 5.5, both $5 / $25), which is priced at its own rate. With the hosted agent, add $0.08 per hour of agent time and expect more tokens per paper, because the agent reads in several steps; each assignment's Settings tab shows the actual cost.

## Development

```bash
npm run dev        # development server
npm test           # unit tests (vitest, no network)
npm run typecheck  # next typegen && tsc --noEmit
npm run lint
```
