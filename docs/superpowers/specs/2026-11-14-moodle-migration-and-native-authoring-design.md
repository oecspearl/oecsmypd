# MyPD — Moodle Migration & Native Interactive Authoring — Design

**Status:** Draft for approval
**Date:** 2026-11-14
**Owner:** Clendon Biscette
**Author:** Claude (investigative design)

---

## 1. Intent & Why

MyPD (OECS MyPD) is the OECS's new proprietary LMS, built after the previous
Moodle platform became unmaintainable (bugs, security issues, a crash). Before
Moodle was lost, there was no backend/DB access, so the courses were rescued
from the **front end** via a custom scraper (`MOODLESCRAPER/`), producing **98
`.mbz` Moodle backup files** plus an offline viewer.

Those backups are the **only surviving copy** of years of OECS professional-
development content. The goal is to bring **everything** in them into MyPD so
these PD courses can **continue to be offered** — not archived, but live and
runnable: teachers enroll, work through the material, complete, and earn
certificates.

Investigation (see §4) established that the raw material is rich and complete,
but the existing MyPD Moodle importer is a **text-only skeleton** that loses
assignments, files, interactives, forums, and structure. And MyPD has **no
interactive-content (H5P) capability at all**. So "complete transfer" requires
both a far better importer **and** new native capability in MyPD.

Separately, OECS already has a standalone React app (the "OECS/EduContent
Content Creator") that authors 10 interactive content types with per-type
players. Its guts are reusable; its identity is not (see constraint C1).

## 2. Goals / Non-Goals / Anti-Goals

### Goals
- **G1.** Bring the full content of the Moodle backups into MyPD at high
  fidelity: pages/books, assignments **and student submissions**, quizzes +
  questions, forums, all embedded files (PDFs/images/audio/video), and the
  12 H5P interactives.
- **G2.** Give MyPD a **native interactive-content capability** — both
  authoring (create/edit) and playback — for the interactive types, harvested
  from the existing OECS Content Creator but presented as MyPD's own.
- **G3.** Preserve course **structure**: one MyPD course per topic, with a
  class/group per facilitator (the currently-unused `classes` layer), sections
  → subjects/lessons in order.
- **G4.** Bring **people & history** across: learner accounts, enrollments into
  the right facilitator group, and completion state.
- **G5.** Prove the entire pipeline on **one pilot course end-to-end** before
  scaling to the remaining courses and bulk accounts.

### Non-Goals (not now, not never)
- **NG1.** Importing fine-grained Moodle activity logs / per-page view history
  (not present in the backups).
- **NG2.** Running the **official H5P runtime**. The 12 interactives are only 2
  common types, both already covered by harvested players; faithful `.h5p`
  replay is unnecessary (see §4, §6C).
- **NG3.** Rebuilding the OECS Content Creator as a separate app or sub-brand
  inside MyPD (see C1).

### Anti-Goals (would make this a failure even if it "works")
- **AG1.** Degrading or disrupting the **live diplomacy programme** (~43
  commission staff, ~310 active enrollments across ~6 modules). Migration work
  must not touch or endanger live data.
- **AG2.** The authoring tool looking/feeling like a foreign product bolted onto
  MyPD. It must read as native MyPD.
- **AG3.** A lossy "skeleton" import that leaves courses non-runnable (the
  current importer's failure mode).
- **AG4.** Mishandling the real PII in the backups (names, emails, and student
  submissions for ~2,257 people).

## 3. Constraints

- **C1 — MyPD identity (hard).** The harvested content creator is absorbed as a
  **native MyPD capability**: MyPD branding, naming, design system, routes, and
  navigation. No "OECS/EduContent Content Creator" product name, branding, or
  separate app surface. It runs on MyPD's Supabase auth/users, MyPD's data
  model, and MyPD's Next.js API routes — **not** the creator's Express /
  express-session / Passport OAuth / Drizzle layer. We harvest the guts (React
  players, editors, content JSON schemas, AI generation), re-dressed as MyPD.
- **C2 — Stack.** MyPD is Next.js 15 (App Router) + React 19 + Supabase
  (Postgres/Auth/Storage) on Vercel. All new work conforms to this. The creator
  is React 19 + Vite + Express + Drizzle; only its **client/React** parts and
  **schemas** port directly; its server/DB layer is re-implemented on
  Supabase + Next API routes.
- **C3 — Live safety.** Migration/import runs execute against a **separate
  staging Supabase project**, never directly against live production. Verified
  output is promoted to production as **unpublished** rows for final review
  before going live. The live diplomacy courses and the 67 existing users are
  never touched by migration code.
- **C4 — Investigation is read-only until approved.** No schema changes, no
  bulk inserts, no account creation, and no emails sent until explicitly
  approved per phase.
- **C5 — PII.** Learner accounts and submissions are real PII. Account creation,
  storage of submissions, and any invite/welcome emails are deliberate,
  reviewable steps — never a side effect of an import.

## 4. Current State (evidence)

- **Source is rich/complete.** One backup (SSEZL) = 18.8 MB, 1,971 files: a full
  H5P interactive, 47 PNG/37 SVG images, audio, 14 Word docs + 5 PDFs including
  **student submissions**, plus assignment briefs and page HTML.
- **Existing importer is text-only.** The two leftover `ssezl` test imports in
  the live DB show: pages imported as flat `rich_text`; assignments reduced to
  empty 129-byte lessons; H5P/forum dropped; GoogleMeet an empty placeholder;
  0 of ~1,947 files imported; sections flattened; imported twice (duplicate);
  ordering bug; left unpublished.
- **Everything maps to a MyPD home _except_ H5P** (which has none): content
  renderer supports text/label/embed/file/image/pdf/video/audio/
  interactive_video/slideshow/code_sandbox/quiz/assignment/survey.
- **H5P footprint is small & clean:** 12 interactives across 12 of 98 backups
  (~6 distinct after de-dup), only **2 types** — `H5P.ImageHotspots` (11) and
  `H5P.InteractiveVideo` (1) — both with existing creator players. Content is
  recoverable as **inline JSON** in each `hvp.xml` (`<json_content>` +
  `<machine_name>`); the official runtime is not needed.
- **Live LMS is lightly populated:** 12 courses, 67 users (49 student / 14
  instructor / 4 admin, mostly @oecs.int), `classes` table empty, 0
  certificates. Real activity = the diplomacy programme.
- **People scale:** ~2,257 distinct people and ~6,200 memberships in the
  backups; only **11 already have MyPD accounts** → onboarding history is
  **bulk account creation**, not matching.

Schema note: the real DB schema (~193 tables) lives in live Supabase, not the
repo (only 2 migrations). The builder must read live schema via PostgREST using
`.env.local` (service role, read-only) when implementing.

## 5. Content Mapping (Moodle → MyPD)

| Moodle | MyPD destination | Notes |
|---|---|---|
| page, book, label | `lessons` content blocks (`text`/`label`) | HTML preserved; `@@PLUGINFILE@@` rewired to stored files |
| resource/file, embedded media | Supabase Storage (`course-materials`) + `file`/`pdf`/`image`/`audio`/`video` blocks + `files` | all files uploaded, links rewired |
| assign | `assignments` (+ brief) | real assignment record, not a text stub |
| assign submissions | `assignment_submissions` + stored files | the student work in the backups |
| quiz + questions | `quizzes` + `questions` | real quiz records; map Moodle question types |
| forum | `course_discussions` (+ replies) | |
| googlemeet | `video_conferences` / embed | |
| H5P ImageHotspots/InteractiveVideo | MyPD interactive content (harvested players) via converter | §6C |
| sections | `subjects`/lesson ordering | preserve order; one course/topic |
| facilitator copy | a **class/group** under one course | first use of `classes` |
| users, roles, enrollment | `users` + `enrollments` (+ class) | bulk account creation |
| completion | `enrollments.status`/progress, certificates | grades mostly empty in source |

## 6. Build Components

### A. High-fidelity Moodle importer (replaces the text-only one)
A rewrite/replacement of `app/api/courses/import/moodle/route.ts` that walks the
full backup (reusing the richer parsing already proven in `viewer.py`): real
assignment/quiz/forum records, file upload with link rewiring, section →
subject/lesson structure and ordering, idempotent (no duplicate courses),
lands unpublished. Handles the per-facilitator → class mapping.

### B. Native MyPD interactive content (authoring + playback)
Harvest from the OECS Content Creator, re-dressed per C1:
- **Players** (`QuizPlayer`, `DragDropPlayer`, `FillBlanksPlayer`,
  `FlashcardPlayer`, `ImageHotspotPlayer`, `InteractiveBookPlayer`,
  `MemoryGamePlayer`, `PresentationPlayer`, `VideoFinderPlayer`, `VideoPlayer`)
  ported as MyPD lesson content blocks / a new `interactive` block type.
- **Authoring** (per-type editors + AI generation) integrated into MyPD's
  lesson/course authoring, in MyPD's design system.
- **Storage** re-homed from the creator's `h5p_content` (Drizzle/Postgres) to a
  MyPD Supabase table (type + JSONB payload), on MyPD auth/users.
- MyPD naming/branding throughout; creator identity removed.

### C. H5P converters (just 2)
`H5P.ImageHotspots` → MyPD `image-hotspot`, `H5P.InteractiveVideo` → MyPD
`interactive-video`. Read inline `json_content` from `hvp.xml`, map fields,
store as MyPD interactive content; existing players render it. ~6 distinct
interactives to verify.

### D. People & history
Create learner accounts (Supabase Auth + `users`), enroll into the correct
facilitator **class**, set completion. Deliberate, reviewable, with a defined
policy for invite/welcome emails. Scope (all vs active cohorts) is an open
decision (§8).

## 7. Phasing

1. **Phase 0 — Pilot (one course, end-to-end), on staging.** Prove A+B+C on
   **SSEZL** against a **separate staging Supabase project**: high-fidelity
   import, interactive(s) converted and playing via native MyPD players, files
   intact, assignments + submissions present, structure/order correct. A small
   number of sample learners may be created **on staging only** to prove the
   class/enrollment/completion mapping — not the real bulk accounts. SSEZL
   exercises every hard part (ImageHotspots H5P, assignments, submissions,
   files). Verified output is then promoted to production unpublished.
2. **Phase 1 — Interactive foundation hardened.** Finish porting authoring +
   all needed players as native MyPD features.
3. **Phase 2 — Content scale-out.** Import the remaining ~14 courses, collapsing
   per-facilitator copies into courses + classes.
4. **Phase 3 — People & history at scale.** Bulk accounts + enrollments +
   completion, per the §8 scope decision, with the agreed email policy.
5. **Phase 4 — Go-live.** Publish reviewed courses; verify against live-safety
   constraints.

## 8. Decisions (locked 2026-11-14) & remaining

### Locked
- **D1 — Account scope → Content first, people later.** Migrate course content
  and structure first; defer bulk account creation until content is verified.
  No thousands of PII records created in the early phases.
- **D2 — Pilot course → SSEZL.**
- **D5 — Pilot/migration environment → separate staging Supabase** (per C3),
  not live production.
- **D6 — Past completions → mark completion only.** No retroactive MyPD
  certificates generated from imported data (revisitable later).
- **D4 — Submissions → bring them across** (builder default; grades are largely
  empty in source, so carry completion/whatever grade data exists, don't block
  on grades).

### Settled by author (builder-review calls, revisit if wrong)
- Interactive content is a **new MyPD lesson content-block type** (`interactive`
  or similar), with authoring integrated into MyPD's lesson editor.
- Person identity key for future account creation = **email**.
- The OECS Content Creator source (`EduContent-Creator-main.zip`) is extracted
  into a **reference-only** location for harvesting; it is not run as an app.
- **Phase-0 verification task:** confirm Moodle **quiz question data** is
  actually present/recoverable in the backups (SSEZL had no quiz; other courses
  may) before promising full quiz fidelity.

### Remaining (decide before Phase 3)
- **D3 — Invite/welcome email policy** for bulk account creation (send logins
  vs dormant-then-invite). Deferred with the "people later" decision.

## 9. Left to the Builder

- Read the live Supabase schema (PostgREST, read-only) for exact columns/
  constraints of `courses`, `classes`, `enrollments`, `lessons`, `assignments`,
  `assignment_submissions`, `quizzes`, `questions`, `course_discussions`,
  `files`, `certificates`, `users`, and define the new interactive-content
  table.
- Detailed field-level mapping for each content/question type and the H5P
  converters.
- Importer idempotency/dedup strategy and the facilitator→class model specifics.
- The account-provisioning mechanism (Supabase Auth admin API + `users`) and
  email policy implementation.
- Test strategy (the repo currently has no tests).
- A written implementation plan via superpowers:writing-plans, per phase.
```
```
