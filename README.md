# DragonGrader

A small self-hosted web app **for teachers** that grades handwritten student work against the teacher's answer key. Students never log in or use it: the teacher scans or photographs the papers and uploads them.

Every homework or quiz follows three steps, shown as the cards of its live **Workspace** (start one by dropping its answer key on the dashboard):

1. **Add the answer key** (PDF, photos, Word or text file). Claude turns it into a structured list of questions, asks the teacher about anything the key leaves open, and the teacher checks, edits and approves it.
2. **Upload students' work**: one file per student, or **one scan of the whole stack** that Claude grades in one pass (or splits into papers for the teacher to check first). Claude **reads every page**, in any handwriting, and judges each question against the key; the grade is **computed in code** from those judgments: by completion (the default), accuracy, or a blend of both.
3. **Review results**: papers **organized by class section and name**, with anything doubtful flagged "Needs your check", a per-question breakdown, and a CSV export. Optionally (per assignment), the AI also writes **feedback notes** on what each student did.

The dashboard's **Where students are struggling** lists every question that most of a class got wrong, across all of the teacher's homework and quizzes, so it's clear what to teach again.

> **AI grades can be wrong.** Check the flagged papers and spot-check the others before you record any grade.

## What's new

- **Mark detection with a blank worksheet (free, offline, every engine):** upload the worksheet as it was handed out, before anyone wrote on it, on the **Answer key** tab. Circles, ticks, crosses and filled bubbles are then read by measuring the ink each student added next to every printed option — not by the AI, which on choice questions sometimes "sees" a circle that isn't there. Blank answers are found the same way, and only written answers go to the AI, as small crops with no question and no answer key. See [Mark detection with a blank worksheet](#mark-detection-with-a-blank-worksheet).
- **Fast lane for class scans (and a class list):** when the assignment has a blank worksheet with saved answer spots, a whole-class scan is split by matching every page to the blank — no AI reads a full page — and only names and written answers go to the AI, as small crops batched across the whole class. For a 26-page packet that took about 7 minutes on a local model, an emulation at the same model speed estimates about 1¼ minutes (40 s two papers at a time). Paste a **class list** in the assignment's **Settings** and misread names are matched to it. See [Fast lane](#fast-lane-class-scans-with-a-blank-worksheet).
- **Grade on your own computer, without an API key:** choose **On this computer (Ollama)** under **Settings → Grader** and a free vision model runs on the computer through [Ollama](https://ollama.com): nothing is sent to Anthropic and nothing costs anything per paper. It is slower and less accurate on messy handwriting than Claude; switching back is one click. On Windows, **double-click `Start Grader.bat`** to install, build, start and open the app. See [Run it on your own Windows PC (no API)](#run-it-on-your-own-windows-pc-no-api).
- **Faster grading on your own computer:** the local model now answers in a compact form, page images are sized for the model (1280 px for Qwen, 896 for Gemma), class scans are graded in one pass instead of being read twice, and **Papers at a time** in Settings lets a big GPU grade two papers at once. Each paper shows where its time went ("Read: 48 s · Checked: 12 s · Model: gemma3:27b"). See [Make local grading faster](#make-local-grading-faster).
- **A live workspace, drag and drop everywhere.** Drop an answer key on the dashboard (**Homework** or **Quiz**) and a new assignment starts at once ("Untitled …" until the AI names it from the key; rename it any time with **Rename** next to the title). Its **Workspace** tab (formerly *Results*) is one vertical flow that updates by itself: **1. Answer key** — "Reading your answer key… 0:12", then **A few questions before grading**: when the key leaves something open (a missing answer, no point values, an unclear item, whether to accept equivalent forms), the AI asks at most about six short questions in the same reading (no extra AI call). Answer them (suggestions are filled in; choices are one tap) or skip them, **Save answers and continue**, check the summary and **Approve key**. Answers are applied in code: a missing answer becomes yours, "2 each" or "Q1-5: 1, Q6: 3" sets the points, everything else goes to your notes for grading. **2. Students' work** — one drop zone: several files are one paper per student; a single PDF more than 1.5× the key's length is taken for the whole class and graded in one pass (you see which, and can switch with one click, before it uploads). **3. Grading** — the progress bar and a feed of papers as each one is graded (name, section, score, "Needs your check"), then the results board and "Questions most students got wrong". Every upload button and zone (key, papers, scans) also takes dropped files.
- **Live updates without reloading.** The workspace and the dashboard keep a Server-Sent Events connection (`/api/teacher/assignments/<id>/live`, `/api/teacher/live`; teacher-only, owner-only) over which the server pushes a small snapshot whenever something changed. The server only polls its own database (about once a second, nothing sent when nothing changed, a heartbeat every 15 s); it makes no AI calls. If the connection can't be kept, the pages fall back to refreshing every few seconds while work is in progress, as before.
- **Teachers only.** The app no longer has anything for students: the start page sends you to your assignments (or to log in), and the student pages — the class-code box, `/s/CODE` upload pages, receipt links (`/r/…`) and their PDFs — are gone (old links now show "not found"). With them went the "Students can upload their own work" switch, share codes and links, opening and closing assignments, "release feedback", "Copy student link" and the CSV's "Receipt link" column. Teachers upload every paper, exactly as before (an approved answer key is all an upload needs). Nothing is deleted from the database: papers students handed in earlier, and their grades, stay on the Results tab.
- **Simpler pages.** Each assignment shows its three steps — 1. Add the answer key → 2. Upload students' work → 3. Review results — with ticks and a link to the right tab. The tabs are **Results**, **Answer key**, **Upload work**, **Questions**, **Lessons** and **Settings**; a paper the AI isn't sure about "Needs your check"; every dashboard card says the next step in one line; and empty pages say what to do next.
- **Where students are struggling** (dashboard): every question most of a class missed, across all your homework and quizzes, most missed first: the assignment, the question and its prompt, "{pct}% missed ({n} of {total} students)", a bar, and **See who missed it**, which opens that assignment's results filtered to the papers that missed it. The top 10 show, with **Show all**. Nothing is sent to the AI for it.
- **"Questions most students got wrong"** (Results and Questions tabs): a question is highlighted once at least 5 papers are graded and **more than half** of the class missed it (it was 40% before). Partly right answers count by the credit they lost, as before.
- **Feedback notes are optional, and off by default** (new and existing assignments). Tick **Write feedback notes** when creating an assignment or on its **Settings** tab to have the AI explain what each student did and give feedback on every question. Notes are most of what the AI writes, so turning them on makes each paper cost roughly **1.5×** as much (more for assignments with many questions). With notes off the AI still reads and judges every answer, scores are the same, and you can still write your own feedback on the review page; the CSV simply leaves the notes out. Changing the setting applies to papers graded from then on and doesn't mark graded papers for regrading.
- **Quizzes:** each assignment is now **Homework** or a **Quiz** (choose when creating it, or change it on its **Settings** tab). Both are graded exactly the same way; quizzes get a "Quiz" badge, "Upload quizzes" wording, and the dashboard can be filtered to **All**, **Homework** or **Quizzes**. Existing assignments become Homework.
- **Any file format:** every upload (answer key, per-student papers and whole-stack scans) accepts **PDFs, photos, Word (.docx) and text files (.txt, .md, .csv)**, and several files are joined into one paper in the order picked. Everything is turned into a PDF on the server before grading. JPEG and PNG become pages as they are; other images (iPhone HEIC, WebP, GIF, TIFF, AVIF…) are converted to JPEG in the browser first, so a browser that can't open a format says so. Word and text files become plain text pages (formatting and pictures in a Word file are dropped, so upload a PDF when layout or drawings matter). Old `.doc`, `.pages` and other formats are refused with "Save it as PDF or .docx first".
- **Choose the AI model** under **Settings → AI model**: **Claude Sonnet 5.5** (the default, about half the cost, good for most homework) or **Claude Opus 5.5** (the most capable, for messy handwriting or tricky answers). Servers upgraded from an earlier version start on Sonnet 5.5 too. `ANTHROPIC_MODEL` is no longer used: if your `.env.local` still sets it, the server ignores it and logs a warning at startup, so delete the line.
- **Grading with an Anthropic-hosted agent (optional, off by default):** Claude reads each paper in its own workspace on Anthropic's servers and can zoom in on hard-to-read handwriting. It's slower and more expensive than the direct API, which is the default (also on upgraded servers, unless a teacher chose the hosted agent); switch under **Settings → Grader**.
- **Upload the homework yourself:** one PDF per student, or one scan of the whole class's stack. By default a scan is **graded in one pass** (the cheapest way): the AI reads each page once, finds whose paper it is and grades it in the same step, and papers whose start or end it isn't sure about are flagged ("Check the paper's pages") for your review. You can instead have the AI **split first, then grade** (or split it every N pages yourself) and check the split before anything is graded — unless the AI's split looks clean (every paper has one name, the usual number of pages, and every page was read confidently): then grading starts on its own and the scan's page says so. The hosted agent can't grade in one pass, so with it a scan is always split first; Ollama on this computer grades in one pass too.
- **The grader learns from your corrections:** each correction (with your reason) becomes a lesson that later gradings of the assignment follow, together with your grading preferences.
- **The Anthropic API key can be set in the app** (Settings), stored encrypted; `ANTHROPIC_API_KEY` is now optional.
- **One-click regrade** of the papers graded before your latest corrections.

## Quick start

Requires Node 22.13 or newer. The database is Node's built-in SQLite (`node:sqlite`), so `npm install` compiles nothing; Node prints "ExperimentalWarning: SQLite is an experimental feature" once at startup, which is harmless.

```bash
npm install
cp .env.example .env.local
AI_MODE=fake npm run dev
```

Open <http://localhost:3000/signup> and create the first teacher account. `AI_MODE=fake` replaces Claude with a deterministic stand-in, so the whole flow (key, uploads, scans, grading, review, lessons, question stats, CSV) works without an API key. Every teacher page then shows "FAKE AI MODE — grades are not real".

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
| `APP_URL` | — | Public origin, e.g. `https://grader.school.org`. Used for the origin check and secure cookies. |
| `DATA_DIR` | `./data` | SQLite database and uploaded PDFs. |
| `ANTHROPIC_EFFORT` | `low` | `low` … `max`. How long the AI thinks before marking. `low` is the cheapest and fastest; try `medium` or `high` for hard or messy work. |
| `ANTHROPIC_MODEL` | — | **No longer used.** Choose the model under Settings → AI model. If it is still set, it is ignored and the server logs "ANTHROPIC_MODEL is no longer used — choose the model on the Settings page." at startup. |
| `TEACHER_SIGNUP_CODE` | — | Required to sign up, when set (see below). At least 12 characters. |
| `MAX_UPLOAD_MB` / `MAX_PAGES` | `20` / `40` | Per-upload limits for papers and answer keys; also the limit for each paper cut from a scan. |
| `MAX_SCAN_MB` / `MAX_SCAN_PAGES` | `100` / `200` | Limits for one scan of a whole class's stack (at most 200 MB / 500 pages). The reverse proxy must allow uploads this large. |
| `GRADING_CONCURRENCY` | `10` | How many papers (and other AI jobs) run at once, 1–32. When Anthropic answers "rate limited" or "overloaded", the paper is retried without using up one of its attempts, the server starts nothing new until the time Anthropic asks for (or a short pause), and it runs half as many at once, climbing back by one after each paper that finishes. Lower it if your Anthropic account's rate limits are low and you'd rather not see these pauses. |
| `SCAN_SPLIT_PARALLEL` | `4` | How many batches of up to 20 pages of one whole-class scan the AI reads at once, 1–8. |
| `ONE_PASS_CHUNK_PAGES` | `18` | Grading a whole-class scan in one pass: the most scanned pages per AI call, 1–40. Calls hold whole papers when the key tells their length (16 pages for 4-page papers). |
| `AGENT_BUDGET_GRADE_USD` | `2.00` | Hosted agent: spending cap per paper, in US dollars at list prices. |
| `AGENT_KEEP_SESSIONS` | `0` | `1` keeps hosted-agent sessions and uploads for debugging. Never with real student work. |
| `OLLAMA_CONCURRENCY` | `1` | Ollama on this computer: papers (and other AI jobs) run at once while it grades, 1–8, unless **Papers at a time** is set in Settings → Grader. `GRADING_CONCURRENCY` applies to the Claude engines. |
| `OLLAMA_IMAGE_MAX_EDGE` | by model | Ollama: pixels of each page image's longer side, 512–4096, unless **Page image size** is set in Settings → Grader. Unset: 1280 for Qwen models, 896 for Gemma models (never more than 1024 for Gemma), 1600 for others. |
| `OLLAMA_PAGES_PER_CALL` | `4` | Ollama: most page images per call, 1–8; longer papers, keys and scan batches are read in batches of pages. |
| `OLLAMA_CROPS_PER_CALL` | `8` | Ollama: crops (names, written answers) read per call, 1–16; a class scan's fast lane sends them in batches of this many. |
| `CROPS_PER_CALL` | `30` | Claude engines: crops read per call by a class scan's fast lane, 1–60. |
| `OLLAMA_TIMEOUT_MS` | `1200000` | Ollama: time limit of one call (20 minutes); a call that takes longer is retried later. |

The server checks the settings, the data directory and the database when it starts; if anything is wrong it logs the problem and exits with code 1 instead of serving errors.

## Teacher accounts

- If `TEACHER_SIGNUP_CODE` is set, **every** sign-up needs it, the first one included. Use a random code of at least 12 characters (for example the output of `openssl rand -base64 12`), not a word, and share it only with colleagues who should get an account. Wrong codes are limited to 20 per hour server-wide.
- If `TEACHER_SIGNUP_CODE` is unset, the **first** account can be created by anyone who reaches `/signup` (so create it right after deploying), and sign-up is closed once it exists.

## Email when grading is done

Grading runs on the server, not in the browser: upload the papers (or drop a whole-class scan), then close the tab or log out, and DragonGrader keeps going. With email set up, each teacher gets:

- **"Graded: Unit 4 Quiz (3 to check)"** a minute after the last paper of a batch is graded: how many were graded, the class average, how many need a check (with a link straight to them) and any that couldn't be graded. A class uploaded in parts gets one email per batch, not one per paper.
- **"Answer key ready to check: Unit 4 Quiz"** when the AI has read a key that isn't approved yet (papers are graded once it is). Not sent when you approve it within the minute.

**Set it up once** (Settings → **Email when grading is done**). One outgoing mail account serves every teacher on the server; each teacher's emails go to the address they log in with.

1. Easiest: make a free Gmail account for DragonGrader, turn on **2-Step Verification**, then create an **app password** at <https://myaccount.google.com/apppasswords>.
2. In Settings click **Gmail** (fills in `smtp.gmail.com`, port 465, SSL/TLS), enter the Gmail address as the username and the 16-letter app password, and **Save**. Microsoft 365 / Outlook: click **Outlook / Microsoft 365** (`smtp.office365.com`, 587, STARTTLS); many schools turn this off for staff accounts, so a separate Gmail account is often simpler.
3. Fill in **DragonGrader's address** (for the links in emails): the address you open it at from other computers, e.g. `http://192.168.1.25:3000` on your network or your tunnel's `https://` address (see "Use DragonGrader from anywhere").
4. Click **Send a test email**. If it fails, the reason shows in Settings ("refused the username or password", "couldn't reach the mail server").

Each teacher can turn their own emails off with **Email me when grading is done**. The password is stored encrypted like the API key. Failed sends aren't retried; the last error shows in Settings. The computer running DragonGrader has to stay on (and awake) until grading finishes: in Windows, **Settings → System → Power → Screen and sleep → "When plugged in, put my device to sleep after": Never**.

## Use DragonGrader from anywhere

DragonGrader is a website served by the computer it runs on, with its own teacher logins (see "Teacher accounts"). To open it from other computers or from home, that computer stays on and you choose how others reach it:

- **Same building / network:** open `http://<that PC's address>:3000` (find the address with `ipconfig`, "IPv4 Address"), after allowing port 3000 in Windows Firewall for Private networks: `New-NetFirewallRule -DisplayName "DragonGrader" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow -Profile Private` (in a Terminal run as administrator).
- **From home, just for you (recommended): Tailscale.** Free; install it on the grading PC and on your laptop or phone, sign in with the same account, and open `http://<the PC's Tailscale name>:3000`. Nothing is exposed to the internet and no router settings change.
- **A public web address for several teachers: Cloudflare Tunnel.** Free (you need a domain name, about $10 a year): it gives an `https://grader.yourdomain.com` address that reaches the PC without opening ports. Set `APP_URL=https://grader.yourdomain.com` in `.env.local` and require a sign-up code (`TEACHER_SIGNUP_CODE`) so only your colleagues can make accounts.
- **A cloud server instead of your PC:** works with the Claude engines (no graphics card needed there); local grading with Ollama needs the GPU PC.

To have DragonGrader start by itself when the PC starts: press **Win + R**, type `shell:startup`, press Enter, and put a shortcut to **Start Grader.bat** in the folder that opens.

## Several teachers: grading capacity

One grader can serve a department; what limits it is how many papers the graphics card(s) get through when everyone uploads at once.

- **Teachers take turns** automatically: answer keys and scan splits go first, then the next paper is from the teacher with the fewest papers grading now (ties: the teacher served longest ago). One teacher's 200-page scan doesn't hold up another's 25-paper quiz.
- **Other computers running Ollama** (Settings → More grading capacity): list their addresses, one per line (e.g. `http://192.168.1.31:11434`), and papers are spread over this computer and them, so two GPUs grade about twice as many. On each: install Ollama, download the same model, run `setx OLLAMA_HOST 0.0.0.0` and restart Ollama, and allow port 11434 in Windows Firewall (Private networks). **Test these computers** checks each one. One that is off or lacks the model is skipped for two minutes and its papers go to the others.
- **Claude overflow for busy days** (same card): while Ollama grades and more than N papers wait (20 by default), extra papers go to Claude with the saved API key instead of waiting, until the monthly cap you set is spent (counted per calendar month, estimated at list prices; the card shows this month's spend). Off by default. If Claude fails (no credit, a bad key), those papers are graded locally and the overflow rests for 10 minutes.

## Teachers only

Only teachers use the app; students never need an account, a code or a link. Sign in, create a homework or quiz, and follow its three steps. Everything students wrote reaches the app through your uploads.

Servers upgraded from a version where students could hand in work themselves keep all of that data — the papers, their grades and your corrections show on each assignment's Workspace tab as before — but the student pages and links no longer exist, and the old setting is ignored.

## Where students are struggling

The dashboard's first section lists every question that **most of a class got wrong**, across all of your homework and quizzes, most missed first. A question counts once at least **5 papers** are graded (each student's latest paper; papers waiting for your check count too) and its miss rate is **above 50%**. An answer is missed when it isn't fully right — wrong, blank or unreadable, or partly right by the credit it lost — whatever the grading mode, and your point changes count. Each row shows the assignment, "Question 3", the question's prompt, "{pct}% missed ({n} of {total} students)" and **See who missed it**, which opens that assignment's results showing only the papers that missed it and what those students wrote most often. The 10 most missed show first; **Show all** lists the rest.

The same rule highlights "Questions most students got wrong" on each assignment's Workspace and Questions tabs, and fills the "Most students got it wrong" column of the question-stats CSV. It is worked out from the stored grades, with no AI calls.

## Matching answers (quizzes only)

On a **quiz**, the Workspace tab ends with **Matching answers**: pairs of students who gave the **same wrong answers that few others in the class chose**, the usual sign of copied answers. Getting the same questions right never counts (good students agree), and neither does a wrong answer most of the class fell for. A pair shows up when the two answered at least 4 of the same questions, gave the same answer on at least 80% of them, and share at least two wrong answers, one of them rare (chosen by at most a quarter of the papers, or by only these two). Two or more rare wrong answers in common make a **Strong match**; one makes a **Possible match**. Each pair lists the questions and answers they share ("Q4: C (only these two)") and links to both papers. It starts once 4 papers are graded, and the dashboard's **Needs your attention** box links to every quiz that has any. Homework isn't checked: students may work on it together, and most answers match anyway. A match is a reason to look at the papers, not proof; it is worked out from the stored grades, with no AI calls.

## How a paper is graded: read first without the answer key, then marked

The AI used to see the answer key while it read a paper, and on a faint or ambiguous mark it could "read" the expected answer instead of the one the student chose (a wrong B marked right as C). Now every engine (direct API, hosted agent, Ollama, practice mode) and one-pass scans grade in three steps:

1. **Read, without the key.** The AI transcribes what the student marked for each question (for multiple choice the letter(s) actually circled or filled in, both when two are marked) and notes the marks it saw ("B circled, A crossed out") and how sure it is. It is given the questions (and their option letters) but never the expected or accepted answers, your notes, your lessons or the key PDF.
2. **Marked by the program** where the answer is objective: multiple-choice letters, true/false, numbers (0.5 = 1/2, units checked) and exact short answers (ignoring case, spaces and punctuation). Blank answers are "no answer"; unreadable ones go to you.
3. **Judged by the AI** from the transcription alone (text only, no pages) for everything else, with the key, your notes and lessons, plus the student notes when they're on. When nothing is left to judge and notes are off, this step is skipped.

Each question on a paper's page shows **What the AI read** and whether it was **Marked by the program (exact match)** or **Judged by the AI**; your point changes still win. The reading carries the page images as before; the judging step is a small text-only request, so a paper costs about the same (a little more when many questions need judging, less when the program marks them all).

## Mark detection with a blank worksheet

Vision models are good at reading names and handwriting, but on printed choice questions they sometimes report a circle where there is none, or the wrong letter. Mark detection reads those marks with plain image processing instead, so it costs nothing, works offline and gives the same answer every time.

**Set it up once per worksheet** (optional; approving the key doesn't need it):

1. Export the worksheet as PDF from Word or Google Docs (**File → Save as / Download → PDF**), **before anyone writes on it**, and drop it on **Blank worksheet** on the assignment's **Answer key** tab. A clean scan of an unanswered copy works too. It must have the same number of pages as each student's paper.
2. The app finds the **answer spots**: for a digital PDF from its text (question numbers like `1.`, `2)`, `Q3`, `3a)`; options `A)`–`D)`, `(a)`, `1)`–`4)`, True/False, T/F, Yes/No, "is / are", check boxes and bubbles; blanks `_____`), linked to the key's questions by label. For a scan the selected AI looks at each blank page once and proposes them; with no AI set up you draw them yourself.
3. **Check them**: each page shows the spots in color — blue boxes on the options of choice questions ("Q3: A B C D"), green areas where answers are written ("Q5: write-in"). Drag a box to move it, drag a corner to resize it, **Draw a new answer spot**, link a question to another key item, change how it is answered, remove spots, or untick **Use mark detection** for a question the AI should keep reading. **Save answer spots** — papers are only read from the spots once they are saved. (On a phone the spots are shown but not edited.)
4. Papers graded before you saved the spots (or with an earlier save), reviewed ones included, keep their old readings until regraded: **Regrade N papers with mark detection** (under the spots, and above the Results board) regrades them all in one click, keeping your own point changes.

**What happens to each paper** (single uploads and whole-class scans graded in one pass alike):

- Each page is rendered at 150 dpi and **lined up with the blank** (shift, scale and rotation up to ±5°, even upside down), then the **added ink** in each spot is measured: dark on the paper and not printed on the blank.
- **Choice questions:** an option counts as marked when its spot has clearly more ink than the others. Nothing marked → "no answer". One → that option, compared with the key in code. Two (or a crossed-out choice next to a new one) → both are reported, marked wrong unless the key expects both, and sent to you ("Multiple answers"). A faint or borderline mark → low confidence, for you to check. A faint stray dot is ignored.
- **Written answers, matching and drawings:** an empty spot is "no answer" without any AI call. Otherwise the spot is cropped (at 200 dpi) and the AI is asked only to transcribe the crop — several crops in one call — then the transcription is marked or judged as before. Drawings are always sent to you to check.
- **Names and sections** are read from crops too: of where the name and class go on the blank (found from labels such as "Name:", "Period", "Section", "Class", "Date"; shown in the spot editor as **Student's name** and **Class / period / section**, which you can move, add or remove), or of the top fifth of page 1 when the blank has no such line. When every question is covered by a spot, no page goes to the AI at all; only when nothing is written where the name goes does the AI read page 1 for it.
- A paper that **can't be lined up** with the blank (another worksheet, a different number of pages, a very skewed photo) is read entirely by the AI as before and flagged **"Couldn't line up with the blank worksheet"**.

On the paper's review page, each question read this way shows **the crop of its answer spot** (with the option read as marked outlined in green), "Marked by mark detection (matches the key)" or similar, and the ink found ("B: strong mark (5.1%); others clean"). Your point changes still win.

**Limits:** it needs a blank with the same layout and page count as the papers, upright pages (a sideways photo won't line up), and marks made on or right next to the options: an answer written somewhere else, such as the margin, is not seen. Handwritten worksheets, slanted phone photos and heavily shaded scans line up less reliably; those papers fall back to the AI and are flagged. "Circle the correct word" questions with several word groups use the first group only. Changing the spots doesn't regrade papers already graded; regrade them from their page.

## How the grader learns

It is not retrained. When you correct the AI on a paper — the points, the feedback or "What you did" — and optionally say why ("Lowercase co2 is fine."), the correction becomes a **lesson** for that assignment. Every later grading of the assignment sends the active lessons along with your **grading preferences** (Settings → Grading preferences: standing notes for all of your assignments), and the grader follows your rulings on the same or similar answers to the same question.

- Each assignment's **Lessons** tab lists its lessons, says which ones the grader is sent (and why others aren't), and lets you edit the reason, turn a lesson off, or copy its reason into your grading preferences. A lesson stays with your correction on its paper, so turning it off is how you stop the grader using it (it stays off when you edit that correction later).
- Deleting a paper keeps the lessons from your corrections on it, with that student's answer and your notes: the Lessons tab marks them "Its paper was deleted", and you can delete them there.
- A lesson shows the answer as the AI read it, so say in the reason when you corrected a misreading ("The student wrote x = -3; the minus is faint."). A correction of an answer the AI saw as blank or couldn't read is sent only once it has a reason, and a ruling without a reason that contradicts the answer key sends the paper to you instead of overriding the key. Points that no judgment gives exactly (3 of 5 on an all-or-nothing question) are passed on too, and matching answers on later papers come to you to set the points.
- Papers graded before your latest lessons or preferences can be regraded in one click: **"Regrade N papers with your latest corrections"** on the Workspace tab or the Lessons tab. Papers you already corrected or checked are left alone (you can still regrade one from its page); your overrides and edits are always kept.

## Choosing the AI model

**Settings → AI model** applies to every teacher on the server, with either engine:

- **Claude Sonnet 5.5** (recommended, the default): about half the cost of Opus. Good for most homework.
- **Claude Opus 5.5**: the most capable model, best for messy handwriting or tricky answers. About twice the cost of Sonnet.

The model reads the answer keys and grades the papers. Splitting a whole-class scan into papers always uses Sonnet 5.5. A change applies from the next answer key or paper (one already being graded finishes on the model it started with); papers already graded keep their grades and aren't marked for regrading. A key saved after the change is checked against the chosen model. With the hosted agent, its answer-key reader and paper reader are updated to the new model in your Anthropic workspace (new versions of the same agents).

## Grading with the Anthropic-hosted agent

The **Anthropic-hosted agent** (Claude Managed Agents) is optional and off by default: servers grade with the **direct API**, which sends each paper to Claude in a single request, unless a teacher chooses the hosted agent under **Settings → Grader**. The hosted agent is best for very hard-to-read papers. Instead of sending each paper to Claude in one request, the app gives Claude a private, temporary workspace on Anthropic's servers for each paper, answer key or batch of scanned pages. Claude reads the PDF there and, where handwriting is hard to read, can render a page larger, crop it or rotate it before deciding. It hands its result back through a strict form the app checks; if anything is missing or malformed, the agent is told what to fix and tries again. The paper agent only reads (it is never given the answer key); the app marks what it read and judges the rest with a short text-only request to the direct API, on the same key and model.

- **Same API key, same account, same model.** The agent uses the key under **Settings → Anthropic API key** (or `ANTHROPIC_API_KEY`), the model chosen under **Settings → AI model** (the scan splitter always uses Sonnet 5.5), and is billed to the same Anthropic account. A Claude Pro or Max subscription can't be used by the app.
- **Set up once you choose it.** Nothing is created in your Anthropic workspace while the direct API is chosen. When you choose the hosted agent, the app creates one environment and three agents (answer-key reader, paper reader, scan splitter) in the key's Anthropic workspace, named "PDF Auto-Grader: …", and checks them again before each paper and whenever the key or the model changes. **Settings → Grader** shows "Ready", or the problem and a **Set up again** button. Don't edit or archive them in the Console; if you did, press Set up again. A key from another workspace gets its own set.
- **Cost.** Tokens at the chosen model's prices plus **$0.08 per hour** of agent time. The agent reads in several steps (more AI turns per paper), so a paper costs more than with the direct API; each assignment's Settings tab shows the actual cost. Every session has a spending cap — by default $2.00 per paper (`AGENT_BUDGET_GRADE_USD`), $3.00 per answer key (`AGENT_BUDGET_EXTRACT_USD`) and $1.50 per batch of up to 20 scanned pages (`AGENT_BUDGET_SCAN_USD`). A session that reaches its cap is retried once with double the cap; after that the paper waits for you to grade it.
- **Speed.** Expect a few minutes per paper, slower than the direct API. Several papers are graded at once (`GRADING_CONCURRENCY`); each session stops after `AGENT_SESSION_TIMEOUT_MS` (20 minutes by default) and is retried later.
- **Privacy.** Papers and answer keys are processed on Anthropic's servers. Each upload and each agent session is deleted from Anthropic as soon as its task finishes, successful or not; uploads also expire on their own after an hour, and sessions left behind by a crash are removed automatically by a later grading run. The workspace has no internet access and no web tools. **Claude Managed Agents is not eligible for Zero Data Retention (ZDR) or HIPAA BAA coverage**; if your school requires ZDR, use the direct API under a ZDR agreement. `AGENT_KEEP_SESSIONS=1` keeps sessions and uploads so you can inspect them in the Anthropic Console (the server log prints each session's Console path); never use it with real student work.
- **Switching engines.** **Settings → Grader** switches between the two. The switch applies from the next paper; papers already being graded finish as they started. Stay on the direct API if Managed Agents isn't available to your organization (it's in beta) or you need ZDR; anything already set up for the hosted agent stays in your workspace, unused.

## Run it on your own Windows PC (no API)

The whole app can run on one Windows PC, like Ollama: double-click to start it, it opens in your browser at `http://localhost:3000`, and the papers are read on that computer by a free AI model. No Anthropic account or API key is needed, and student work never leaves the computer.

1. **Install Node.js LTS** from <https://nodejs.org> (version 22.13 or newer; the big green button). Accept the defaults. Nothing else is needed for the app's packages: no Python, Visual Studio or other build tools (the database is built into Node, and the one native package comes ready-made for Windows).
2. **Install Ollama for Windows** from <https://ollama.com/download>. It runs in the background (look for the llama icon by the clock).
3. **Download a vision model** once. Open *Command Prompt* or *PowerShell* and run:

   ```
   ollama pull qwen2.5vl:7b
   ```

   That is about 6 GB and suits a graphics card (GPU) with about **8 GB** of memory. Alternatives, by GPU memory:

   | GPU memory | Model | Notes |
   |---|---|---|
   | ~8 GB | `qwen2.5vl:7b` | Recommended starting point. |
   | ~12 GB | `gemma3:12b` | Another good reader of page images. |
   | ~24 GB | `qwen2.5vl:32b` | Most accurate of these, much slower without a big GPU. |
   | ~24 GB | `qwen3.6:27b` | Newest Qwen (about 18 GB download; needs a recent Ollama). Its "thinking" is turned off automatically so it answers directly. |

   **Without a GPU** (CPU only) it works, but expect **several minutes per page** and keep the class small; a laptop may get hot and slow.
4. **Double-click `Start Grader.bat`** (in the app's folder). The first time it installs the app's packages and builds it (a few minutes, needs internet); later starts take seconds. It creates `.env.local` with `AI_MODE=claude` and no API key, starts the app, waits until it answers and opens <http://localhost:3000>. Keep the window open while you grade; **Ctrl+C** (or closing the window) stops it. On a Mac, double-click `start-grader.command`; on Linux, run `./start-grader.sh`.
5. **Sign up** the first teacher account, then open **Settings → Grader** and choose **On this computer (Ollama)**. The address is normally `http://localhost:11434`; pick the model you downloaded from the list (models that can read images come first) and press **Test connection**. It says whether Ollama answers, which models are downloaded, and what to do if something is missing ("Run: ollama pull …"). Press **Save** after changing the address, model or context size.

That's it: add an answer key and upload papers as usual. The "No API key" warning doesn't show while Ollama grades.

**Honest notes**

- **Speed:** by default a local model reads one paper at a time (**Papers at a time** in Settings, else `OLLAMA_CONCURRENCY`, default 1, because one GPU does the work anyway). With a recent GPU expect **tens of seconds per page** (it depends on the model, the GPU and the handwriting); on a CPU, minutes. Claude is much faster and grades many papers at once. See [Make local grading faster](#make-local-grading-faster).
- **Accuracy:** small local models misread messy handwriting more often, follow the answer key less carefully and flag less reliably than Claude. Check more papers by hand, especially the first few of each assignment. Typed or neat work does best.
- **What is different from Claude:** each PDF page is turned into an image on the server (**Page image size**: 1280 px on the longer side for Qwen models, 896 for Gemma, 1600 for others) and sent with the same instructions the Claude engines use; the original key PDF is not sent with each paper (the approved key is, to the text-only check). The model answers in a compact form (very short keys, no explanations), which the app turns back into the usual reading, so a paper takes fewer output tokens; each answer is also capped at a size that fits it, so a model that starts repeating itself stops. A paper is read at most `OLLAMA_PAGES_PER_CALL` pages (default 4) per call; longer papers are graded in batches of pages and the answers merged (for each question, the batch where the student answered it). A whole-class scan is **graded in one pass** as with Claude: it is read in batches of whole papers, each page once, and never split first. If the model's answer isn't valid, it is told what is wrong and asked once more.
- **When something is wrong**, grading pauses with the fix on every page: "Ollama isn't running at … — start Ollama", or "The model … isn't downloaded in Ollama. Run: ollama pull …", or a model too big for the computer's memory. Fix it and press **Test connection**; grading continues at once (otherwise within 5 minutes).
- **Context size** (Settings, default 16384 tokens) is how much the model reads at once. Raise it (and use more GPU memory) if long papers fail with "ran out of room"; or lower `OLLAMA_PAGES_PER_CALL`.
- **Cost:** $0. Each assignment's Settings tab still counts the tokens, at $0.
- **Switching back to Claude is one click:** choose **Direct API** under Settings → Grader and add an API key. Papers already graded keep their grades; regrade any you want Claude to read again.

### Fast lane: class scans with a blank worksheet

When the assignment has a blank worksheet with **saved** answer spots, a whole-class scan uploaded to be graded in one pass takes the fast lane automatically, with every engine (the biggest gain is on Ollama):

1. **Matching pages to the blank** (no AI): each scan page is rendered at 150 dpi and lined up with the page of the blank the sequence predicts (then the others at half size), scored both ways (the blank's print found on the page, and the page's print explained by the blank, handwriting areas left out). A paper starts at every page that matches page 1 of the blank — two page 1s are never one paper — and pages that match page 2, 3… join it. Blank backs and cover pages are left out and listed. A missing page, pages out of order, a repeated page, a paper starting without page 1, or a page 1 with nothing written where the name goes flags the paper **Check the paper's pages**, with the reason in its notes.
2. **Reading names and written answers**: the crops of every paper (names, classes and written answers; never a question or an answer) go to the AI together, in batches (`OLLAMA_CROPS_PER_CALL`, default 8, for Ollama; `CROPS_PER_CALL`, default 30, for Claude), as many at once as **Papers at a time** allows on Ollama.
3. **Marking**: choices from their ink, written answers from their transcriptions, marked in code and checked by the AI (text only) only where needed — as for a paper on its own. A paper with something no spot could read (a page that didn't line up well) is read by the AI from its own pages only.

The scan page shows **Matching pages to the blank… 12/26**, then **Reading names and written answers… 40/62 crops**, then **Marking…**; each paper's time line starts with **Fast lane: matched pages to the blank worksheet**. When fewer than half of the pages match the blank (another worksheet, upside-down photos), the AI reads every page instead, as before. On a synthetic 26-page packet (9 students, a 3-page worksheet), matching takes about 0.25 s a page and the AI gets 9 calls with 62 crops instead of 26 full pages.

**Class list:** paste one student per line in the assignment's **Settings → Class list** ("Maria Lopez | Period 3"; or reuse your previous assignment's list). A name read on a paper is matched to it — misspelt, reversed ("Lopez, Maria"), with initials, or a first name only one student has — and the list's spelling and section are used; the review page shows the reading next to the match. A name that matches no one, or could be two students, keeps the reading and is flagged. The list's names are sent to the AI only with name crops, never with answers.

### Make local grading faster

Each paper's review page shows where its time went, for example **Read: 48 s · Checked: 12 s · Model: gemma3:27b**, and Settings → Grader → On this computer shows the median time per paper of the last 10 papers graded on this computer. Use them to compare the settings below on your own papers.

- **Choose the model for your GPU.** On a 24 GB card (RTX 3090 / 4090), `gemma3:27b` is usually the faster of the large models and reads handwriting well; `qwen2.5vl:32b` is often the more accurate reader but slower, and it needs most of the card for one paper. On 8–12 GB, `qwen2.5vl:7b` or `gemma3:12b`. A model that doesn't fit in GPU memory runs partly on the CPU and is many times slower.
- **Check that the model runs on the GPU.** While a paper is being graded, run `ollama ps`: the PROCESSOR column must say **100% GPU**. Anything like `30%/70% CPU/GPU` means the model (plus its context) doesn't fit: choose a smaller model, lower the **Context size** in Settings (16384 is plenty for a few pages; each Qwen page at 1280 px is about 1,600 tokens), or close other programs using the GPU.
- **Page image size** (Settings → Grader). Automatic is 1280 px for Qwen models (it turns every 28×28 pixels into a token, so 1280 instead of 1600 reads pages about a third faster with handwriting still clear) and 896 for Gemma models (Gemma shrinks every image to 896×896 itself, so larger images are wasted work; at most 1024 is ever sent to Gemma). Raise it only if tiny handwriting is misread.
- **Papers at a time** (Settings → Grader, 1–4). `2` works well with `gemma3:27b` on a 24 GB card: the GPU reads one paper while it writes the other's answer. Ollama must be told too: set `OLLAMA_NUM_PARALLEL` to the same number and restart Ollama (Windows: `setx OLLAMA_NUM_PARALLEL 2`, then quit Ollama from the llama icon and start it again). Use `1` for `qwen2.5vl:32b`, which needs the whole card for one paper. Each parallel paper needs its own context memory, so check `ollama ps` again afterwards.
- **Make Ollama itself faster** (set once, then restart Ollama): `setx OLLAMA_FLASH_ATTENTION 1` (less memory and faster reading of long prompts) and `setx OLLAMA_KV_CACHE_TYPE q8_0` (halves the context memory, so a larger model or two papers at a time fit; needs flash attention). On macOS/Linux, set them in the environment of `ollama serve`.
- **Keep the model loaded.** The app asks Ollama to keep it in memory for 30 minutes after each call, so only the first paper waits for it to load.
- **Turn off "Write notes for students"** (each assignment's Settings) when you only need scores: then the model writes no notes, and a paper whose answers the program could mark by itself (multiple choice, true/false, numbers, exact words) needs no second "check" step at all.
- **One PDF per student or one class scan:** both are fast now. One PDF per student needs no finding of papers, so start with that when you can; a class scan is graded in one pass (each page read once), in batches of whole papers when the answer key tells the paper's length.

## Run exactly one instance

The grading queue lives in SQLite and the worker runs inside the Next.js server process; upload rate limits are kept in memory. **Run a single `next start` process** — no clustering, no second replica, no serverless platform. Jobs left running when the process stops are picked up again at the next start.

## Behind a reverse proxy

Terminate TLS in a reverse proxy and let it pass the client's address and the original host. Raise the body limit above `MAX_SCAN_MB` (a whole-class scan is the largest upload; 110 MB for the default 100 MB). Set `APP_URL` to the public origin.

Make the Node server reachable **only through the proxy**: start it on the loopback interface with `npm start -- -H 127.0.0.1` (or firewall port 3000). The per-address rate limits (login and sign-up) read the client's address from `X-Forwarded-For`, which only the proxy can be trusted to set. A client that reaches `next start` directly can put any address there, and those limits then mean nothing; only the limits that don't depend on the address (wrong signup codes, API-key checks per teacher) still hold.

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

The live pages use Server-Sent Events: responses are sent with `X-Accel-Buffering: no` and `Cache-Control: no-transform`, so nginx and compression don't hold them back, and a heartbeat every 15 s keeps them under `proxy_read_timeout`. Each stream ends after 10 minutes and the browser reconnects by itself.

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

Student work — the PDFs and photos, including names written on them — and the answer key are sent to the Anthropic API for grading (with the Claude engines; with **On this computer (Ollama)** they stay on the computer running Ollama). Make sure that is acceptable under your school's policies before using real student work. With the hosted agent, see [Grading with the Anthropic-hosted agent](#grading-with-the-anthropic-hosted-agent): each paper's upload and session are deleted after grading, and Managed Agents isn't eligible for Zero Data Retention. Nothing is shared with other services, and pages are marked `noindex`.

## Cost

With the direct API, roughly **$0.05–0.15 per paper** with **Claude Sonnet 5.5**, the default ($2 / $10 per million input / output tokens; cached input $0.20), and roughly **$0.10–0.30 per paper** with **Claude Opus 5.5** ($4 / $20; cached input $0.20). These estimates are with notes for students turned on; with notes off (the default) a paper costs roughly a third less, because the AI writes only its judgments and a short transcription of each answer. Output and thinking tokens dominate; the model, the notes setting and the effort are the main levers. These figures assume the default `ANTHROPIC_EFFORT=low`; `medium` or `high` makes the AI think longer and costs noticeably more. The answer key, your lessons and your grading preferences are cached between papers, so their cost is small (writing them to the cache costs 2× the input price with the default `AI_CACHE_TTL=1h`, 1.25× with `5m`). Splitting a whole-class scan with the AI always uses Sonnet 5.5 and costs about **half a cent per scanned page** on top (splitting every N pages is free). Grading a scan **in one pass** reads each page once, on the chosen model: there is no split and the answer key and context are sent once per batch of pages instead of once per paper, so it costs less than splitting first and then grading each paper (most for short papers; the output — the AI's judgments — is the same either way).

Each assignment's Settings tab shows its token usage and estimated cost, added up over every AI call (regrades, retries, reading the key and splitting scans included), each priced at the rate of the model that answered it, so an assignment graded partly with each model is priced correctly. A request that a model declines can be answered by a fallback model (Claude Sonnet 5 for Sonnet 5.5; Claude Opus 5 or Opus 4.8 for Opus 5.5, both $5 / $25), which is priced at its own rate. With the hosted agent, add $0.08 per hour of agent time and expect more tokens per paper, because the agent reads in several steps; each assignment's Settings tab shows the actual cost.

## Development

```bash
npm run dev        # development server
npm test           # unit tests (vitest, no network)
npm run typecheck  # next typegen && tsc --noEmit
npm run lint
```
