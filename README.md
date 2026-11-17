# Naukri Khojo

A job-application worker that runs on your own Mac. It finds jobs that fit your profile on Naukri and on company career pages, fills in and submits the applications, and tracks recruiter replies from Gmail. You use it from a dashboard in your browser.

Your profile, saved answers, logins, resume and application history are stored only on your Mac, in `.automation/`. Git ignores that folder and nothing in it is uploaded anywhere.

## How it works

1. **Find.** It searches Naukri for your keywords in your cities, and checks about 1,000 company career sites (Greenhouse, Lever, SmartRecruiters, Workday and others) for new openings.
2. **Match.** Each job is checked against your profile:
   - role and seniority
   - your cities, or remote roles open to India
   - published salary against your range
   - experience required
   - required skills
   - posting age: at most 7 days
   - at most **2 applications per company**, and no reposts of a role you already applied to
3. **Apply.** It opens the application form in a hidden browser and fills it from your profile and resume. It answers screening questions and the Naukri chatbot, then submits. A job counts as applied only after the site confirms it.
4. **Ask.** If a form asks something it can't answer, the job waits under **Needs your answers**. Your answer is saved and reused for every later job that asks the same thing.
5. **Track.** It reads Gmail every 30 minutes and groups interview invites, assessments and recruiter messages under **Employer replies**.

### Schedule (India time)

| When | What |
|---|---|
| 9 PM – 3 AM | Naukri search and applications, several runs through the night |
| 8 AM | Daily run: company career sites, then applying to what was found |
| Every 30 min | Gmail check for recruiter replies |

Naukri blocks hidden browsers, so Naukri runs in a window placed off screen. It runs only at night so it doesn't get in your way.

## Setup

**Needs:** a Mac, [Node.js](https://nodejs.org) 18 or newer, and your own Naukri account.

```bash
npm install
npx playwright install chromium
```

### Create your profile

Start the local worker with `npm run automation`, open **http://127.0.0.1:4129**, and choose **Profile & rules**. Upload a PDF or DOCX resume and click **Extract resume details**. Review and edit the suggestions, then save the profile. You can also edit an existing profile from this screen. Salary, notice period, preferred cities, employment history, and skill-specific years need your confirmation; the resume parser does not guess them. Saving a profile keeps the worker paused and automatic submission disabled until you explicitly change those settings.

The profile is stored at `.automation/profile.json`; the uploaded resume is stored beside it. The example schema remains available in `profile.example.json` for manual setup.

### Open automation from your portal account

Start the local worker with `npm run automation`, sign in to the Naukri Khojo portal, and open **Daily Auto Hunt** from its dashboard. The portal issues a short-lived, one-use sign-in handoff to the local worker; opening the worker URL directly does not expose its jobs or controls. The account name, candidate email, skills, experience, and job-role keywords are merged into the local candidate profile when you open it. Preferences, platform sessions, and automation jobs remain on this computer. With `MONGODB_URI`, resumes, PNG application screenshots, and report exports also have private GridFS copies.

The local automation data directory is bound to the first linked portal account. Use a separate `AUTOMATION_DATA_DIR` for another account. Hosted deployments require a stable `JWT_SECRET` of at least 32 characters, shared by all portal instances and the local worker `.env`; the app fails at startup if it is missing. For local-only use, a stable private key is generated in `.automation` automatically. Vercel trusts one proxy hop for client IP rate limiting; set `TRUST_PROXY_HOPS` only when deploying behind a different trusted proxy chain.

| Field | What it is for |
|---|---|
| `name`, `email`, `phone`, `currentCompany`, `currentTitle`, `experienceYears` | Filled into application forms |
| `currentCtcLpa`, `noticeDays`, `holdingOffer` | Answers to the usual Naukri questions |
| `minimumCtcLpa`, `maximumCtcLpa` | Jobs with a published salary below your minimum are skipped |
| `expectedCtcLpa` | The number given when a form asks for one figure |
| `cities` | Where you will work; other locations are skipped |
| `excludedCompanies` | Never applied to. Always include your current employer. |
| `searchKeywords` | What is typed into the Naukri search |
| `skills`, `years` | Years per skill, used for "How many years of X?" questions |
| `education`, `employment` | Filled into forms that ask for them |
| `standingAnswers` | Yes/no answers to legal questions (relatives at the company, non-compete, background check…). All are `false` in the template; set each one truthfully. |
| `coverLetter` | Your letter. `{title}`, `{company}` and `{name}` are filled in for each job. |
| `resumeText` | Plain text of your resume, used to answer questions |
| `resumeFile` | File name of your resume (PDF or DOCX) placed in `.automation/` |

Only put true information in the profile. The worker submits exactly what is written there.

### Start

```bash
npm run automation
```

Open **http://127.0.0.1:4129**, then go to **Accounts & import**:

1. **Sign in to Naukri.** A browser window opens; log in to your own account. The session is kept on your Mac.
2. **Gmail** (optional, for reply tracking and the Cold email tab): enter your Gmail address and a Gmail app password (Google Account → Security → 2-Step Verification → App passwords), then **Connect and verify**.
3. Click **Find jobs**, or wait for the schedule.

Keep the Terminal window running and the Mac **plugged in with the lid open**. On battery with the lid closed the Mac sleeps and nothing runs.

## Using the dashboard

| Section | What you do there |
|---|---|
| **Applications** | Every job found, with status and the reason it was skipped or held |
| **Needs your answers** | Answer questions the worker couldn't, then it retries |
| **Applied jobs** | What was submitted, with the confirmation; record recruiter calls and outcomes |
| **Employer replies** | Recruiter emails, one row per employer (latest email) |
| **Cold email** | Extract email addresses from `.xlsx` or `.csv`, review recipients, compose a subject/body, optionally attach a file, and send individual messages through the connected Gmail account |
| **Relevant jobs** | Matches that need you to apply by hand (unsupported sites) |
| **Profile & rules** | Your profile as the worker reads it |
| **Saved daily reports** | Per-day CSV of applications |

Buttons:
- **Run today:** a full run right now.
- **Find jobs:** search only.
- **Apply queued jobs:** apply to what has already been found.
- **Test one form:** fills one application without submitting it.
- **Pause:** stops after the current application.

Naukri applying works only inside the 9 PM – 3 AM window.

## Rules worth knowing

- **One Naukri account per person.** Never sign in to someone else's account.
- **LinkedIn is not automated.** It is turned off by default because LinkedIn restricts accounts it detects as automated. Apply there yourself.
- **Workday** sites need an account per company. Put `WORKDAY_EMAIL` and `WORKDAY_PASSWORD` in a `.env` file if you want those attempted.
- Some forms always need you: custom company portals, CAPTCHAs, email verification codes. These are listed for you rather than guessed.

## Troubleshooting

| Problem | Fix |
|---|---|
| Nothing applied overnight | The Mac slept. Keep it plugged in with the lid open, or run `sudo pmset -a disablesleep 1` (undo with `0`). |
| "Naukri: login required" | Sign in again from **Accounts & import**. |
| "A run is already active" | Wait for it to finish; the dashboard shows progress. |
| Dashboard does not open | Check that `npm run automation` is still running in Terminal. |
| Many jobs "Needs your answers" | Answer them once; the same question is then answered automatically. |

## For developers

```bash
npm test                      # unit and browser tests
npm run automation:dry-run    # fill one form without submitting
```

| Path | Contents |
|---|---|
| `src/automation/server.js` | Dashboard API and schedule |
| `src/automation/runner.js` | A run: find, match, apply, check inbox |
| `src/automation/naukri.js` | Naukri search and chatbot applications |
| `src/automation/discovery.js` | Company career-site search |
| `src/automation/matching.js` | Eligibility rules and ranking |
| `src/automation/answers.js` | Answers to form questions from the profile |
| `src/automation/browser.js` | Form filling and submission checks |
| `src/automation/inbox.js` | Gmail reply classification |
| `public/automation.html` | Dashboard |
| `.automation/` | Your local data (never committed) |
# Durable automation queue (optional)

The default local behavior is unchanged. Set `AUTOMATION_QUEUE_ENABLED=true` and run `npm run start:all` to enqueue portal job hunts and browser automation runs in MongoDB. The MongoDB deployment must support transactions (a replica set, such as MongoDB Atlas). The automation service processes queued browser runs in the same process as its interactive browser sessions, with one active run per portal account and one queue consumer per service instance. In queued mode, MongoDB supplies per-user automation jobs/settings at worker start and receives API mutations, per-job checkpoints, and the post-run snapshot; scoped JSON is the worker's local cache. Both apps must use the same `MONGODB_URI` and `AUTOMATION_DATA_DIR`. For a Vercel portal deployment, run `npm run automation:worker` as a separate long-lived process for portal job-hunt tasks; it does not claim browser automation tasks. Browser automation remains bound to the local, loopback-only service and its persistent data directory.

Each authenticated portal account uses an isolated automation data directory and browser profile. This is single-instance account isolation; it is not horizontal scale evidence and does not make the loopback-only browser worker accessible to remote users. See [MULTI_USER_AUTOMATION_ARCHITECTURE.md](MULTI_USER_AUTOMATION_ARCHITECTURE.md) for deployment and migration limits.

For durable queued automation, set `AUTOMATION_CREDENTIAL_KEY` to a random secret of at least 32 bytes (generate one with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`). Keep the same key across automation service instances, store it in the deployment secret manager, and back it up securely: losing or changing it makes encrypted Gmail credentials unreadable. With this key set, Gmail app passwords are encrypted at rest in MongoDB and the account-scoped local cache. `AUTOMATION_QUEUE_ENABLED=true` requires this key. With `MONGODB_URI`, resumes, PNG application screenshots, report exports, and job descriptions are stored in the private `automationFiles` GridFS bucket with per-user metadata; local copies support Playwright and local-mode fallback. Platform cookies and browser sessions remain local. Queue-mode state writes use a revision check, and jobs are checkpointed before application work so crash recovery can flag uncertain submissions. This is not horizontal browser execution: the automation service and browser profiles remain local and loopback-only.

Interactive platform sign-in and manual browser tasks reserve the account's automation lock while the candidate is using the persistent browser. Check the platform sign-in after login to release that reservation. If abandoned, it expires after 30 minutes by default (`AUTOMATION_INTERACTIVE_LEASE_MS`); queued runs are rejected during the reservation so they cannot close or reuse the candidate's active sign-in window.

Browser queue runs are pinned to the automation host that accepted them so another host cannot run them with a different local Playwright profile. Keep `AUTOMATION_INSTANCE_ID` stable across restarts of one host and unique across hosts. The default combines the hostname with a hash of `AUTOMATION_DATA_DIR`. This affinity does not make the loopback browser service remotely reachable or share job state across hosts.

Queue workers share a Mongo-backed global run-slot limit (`AUTOMATION_GLOBAL_MAX_RUNS`, default `1`). Configure the same limit on every consumer. Slots expire with the run lease after a worker crash; expired runs are marked interrupted for review rather than automatically replayed.

To preview importing the currently SSO-linked local automation profile, deduplicated contacts, automation settings/history, jobs, resume, PNG evidence, and report exports into their owning MongoDB user, run `npm run automation:migrate-local`. The command is dry-run by default; use `npm run automation:migrate-local -- --apply` to write. Stop the automation service before applying so profile and local files cannot change during the migration; apply mode also refuses an active local worker or Mongo-backed run/browser/contact lease. For an account in the scoped `users/` directory, provide its 24-character portal MongoDB ID with `--user-id <id>`. It verifies the stored owner ID, profile binding, and account email. Existing Mongo profile/contact/state/job records are preserved; jobs are inserted in batches and their descriptions are stored separately in GridFS. Account history is capped at 8 MB per state document. Gmail credentials are migrated on authenticated sign-in when `AUTOMATION_CREDENTIAL_KEY` is set; browser sessions are not migrated. Queue mode now reads and writes the Mongo state repository, with per-account JSON used as the working cache. This does not enable remote browser access or shared browser sessions.
