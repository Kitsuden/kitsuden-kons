# kon-academy-lms

A learning management system for Kitsuden: courses with modules, topics and quizzes, course
assignment to people and groups, progress, learning paths, satisfaction surveys, certificates with
public verification, and Excel exports. For organisations that train their own staff or members.

| Maturity | Category | Version | Mounted at | Requires |
| --- | --- | --- | --- | --- |
| beta | business | 1.1.1 | `/api/academy` | kon-media |

## Install

Inside a Kitsuden project:

```bash
kitsuden kon add academy-lms --enable
```

Kitsuden leaves a specialized kon off until you switch it on, so pass `--enable` (or switch it on
in the admin panel, **Kons**). Restart the API afterwards. `kon.json` lists `kon-media` as a
required kon; it ships with the Kitsuden core, so nothing else is installed.

No environment variables are read. PDF certificates
(`GET /api/academy/certificates/:courseId/pdf`) use `pdfkit` and Excel exports (the three
`/api/academy/export/*` routes) use `exceljs`; both are regular dependencies in `package.json`
and install with the kon. `pdf-lib` stays optional: only the template mode of
`services/pdf.service.ts` imports it.

After installing, a global admin creates the first academy profiles
(`POST /api/academy/profiles`). Setup steps: [SETUP.md](SETUP.md).

## What it adds

| Table | What it holds |
| --- | --- |
| `training_user_profiles` | The academy role of a user (`administrator`, `supervisor`, `student`), department, job title, active flag |
| `courses`, `course_modules`, `topics`, `additional_files` | Course content; topics hold text, video (local, YouTube, external), image and document references to kon-media |
| `quizzes`, `questions`, `question_options` | A quiz per module, its questions and options |
| `assignment_groups`, `group_users`, `group_supervisors` | Groups of learners with a main supervisor and extra supervisors |
| `assignments` | A course assigned to a user or a group |
| `course_progress`, `module_progress`, `topic_progress` | Each learner's progress |
| `user_answers`, `quiz_results` | Quiz attempts and results |
| `learning_paths`, `learning_path_courses`, `learning_path_progress`, `learning_path_assignments` | Ordered sequences of courses and who follows them |
| `feedback` | Ratings of topics |
| `satisfaction_surveys` | The survey a learner sends after finishing a course |
| `certificates` | Certificates with an unpredictable verification code |
| `academy_activity_log` | Activity log |

A learner sees a course only when it is assigned to them, directly or through a group. A quiz
allows 5 attempts and cannot be retaken once passed; the correct options never reach a learner. A
certificate needs the course completed and its survey sent. Field values and enums are listed in
[API.md](API.md).

## HTTP API

All routes need a session except `GET /api/academy/certificates/verify/:code`. "Signed in" =
any account; "manager" = global admin, academy administrator or academy supervisor;
"administrator" = global admin or academy administrator. Bodies are validated with the old
`zValidator` behaviour: an invalid body is a 400 with the zod result, unknown fields are dropped.

### Learning (any signed-in account)

| Route | Who | What it does |
| --- | --- | --- |
| `GET /api/academy/courses` | signed in | Active courses assigned to me, with progress; filter `status` |
| `GET /api/academy/courses/:id` | signed in | A course with modules, topics, files and quiz, and my progress (404 if not assigned) |
| `GET /api/academy/courses/:id/modules` | signed in | Modules of a course |
| `GET /api/academy/modules/:id` | signed in | A module with topics and quiz |
| `GET /api/academy/topics/:id` | signed in | A topic with my progress |
| `POST /api/academy/topics/:id/complete` | signed in | Mark a topic completed; recalculates course progress |
| `GET /api/academy/quizzes/:id` | signed in | A quiz with questions (correct options only for managers) |
| `POST /api/academy/quizzes/:id/answer` | signed in | Answer a quiz; returns score and attempts left (429 after 5, 409 if passed) |
| `POST /api/academy/feedback` | signed in | Rate a topic of an assigned course |
| `POST /api/academy/surveys` | signed in | Send the satisfaction survey of a completed course |
| `GET /api/academy/certificates/:courseId` | signed in | Issue or return my certificate (403 until course and survey are done) |
| `GET /api/academy/certificates/:courseId/pdf` | signed in | My certificate as a PDF |
| `GET /api/academy/certificates/verify/:code` | public | Verify a certificate code (400 invalid, 404 unknown) |
| `GET /api/academy/dashboard/my-progress` | signed in | My progress |
| `GET /api/academy/learning-paths` | signed in | Active learning paths; filter `category` |
| `GET /api/academy/learning-paths/mine` | signed in | Learning paths assigned to me |
| `GET /api/academy/learning-paths/:id` | signed in | A learning path with its courses and my progress |
| `GET /api/academy/groups` | signed in | Managers: all groups with members; others: their groups without members |
| `GET /api/academy/groups/:id` | signed in | Managers: with members and supervisors; a member: without them; others: 404 |
| `POST /api/academy/media/validate` | signed in | Check a file's size and MIME type; uploads nothing |
| `POST /api/academy/media/youtube-info` | signed in | Parse a YouTube URL (id, embed and thumbnail URLs) |
| `POST /api/academy/media/normalize-video` | signed in | Normalize a YouTube, Vimeo or direct video URL |

### Content (administrator)

| Route | Who | What it does |
| --- | --- | --- |
| `POST /api/academy/courses` | administrator | Create a course |
| `PUT /api/academy/courses/:id` | administrator | Update a course |
| `DELETE /api/academy/courses/:id` | administrator | Deactivate a course |
| `POST /api/academy/modules` | administrator | Create a module |
| `PUT /api/academy/modules/:id` | administrator | Update a module |
| `DELETE /api/academy/modules/:id` | administrator | Delete a module |
| `POST /api/academy/modules/reorder` | administrator | Reorder modules |
| `POST /api/academy/topics` | administrator | Create a topic |
| `PUT /api/academy/topics/:id` | administrator | Update a topic |
| `DELETE /api/academy/topics/:id` | administrator | Delete a topic |
| `POST /api/academy/topics/reorder` | administrator | Reorder topics |
| `POST /api/academy/topics/:id/files` | administrator | Attach a file to a topic |
| `DELETE /api/academy/files/:id` | administrator | Remove a topic file |
| `POST /api/academy/quizzes` | administrator | Create a quiz |
| `PUT /api/academy/quizzes/:id` | administrator | Update a quiz |
| `DELETE /api/academy/quizzes/:id` | administrator | Delete a quiz |
| `POST /api/academy/quizzes/:id/questions` | administrator | Add a question |
| `PUT /api/academy/questions/:id` | administrator | Update a question |
| `DELETE /api/academy/questions/:id` | administrator | Delete a question |
| `POST /api/academy/questions/:id/options` | administrator | Add an option |
| `PUT /api/academy/options/:id` | administrator | Update an option |
| `DELETE /api/academy/options/:id` | administrator | Delete an option |
| `POST /api/academy/learning-paths` | administrator | Create a learning path |
| `PUT /api/academy/learning-paths/:id` | administrator | Update a learning path |
| `DELETE /api/academy/learning-paths/:id` | administrator | Deactivate a learning path |
| `POST /api/academy/learning-paths/:id/courses` | administrator | Add a course to a path |
| `PUT /api/academy/learning-paths/:id/courses/:courseId` | administrator | Update a course in a path |
| `DELETE /api/academy/learning-paths/:id/courses/:courseId` | administrator | Remove a course from a path |

### People, assignments and reports

| Route | Who | What it does |
| --- | --- | --- |
| `GET /api/academy/profiles` | manager | Academy profiles; filter by role |
| `POST /api/academy/profiles` | administrator | Create a profile or update its role and notes |
| `PUT /api/academy/profiles/:id/role` | administrator | Change a user's academy role |
| `POST /api/academy/groups` | administrator | Create a group |
| `PUT /api/academy/groups/:id` | administrator | Update a group |
| `DELETE /api/academy/groups/:id` | administrator | Delete a group |
| `POST /api/academy/groups/:id/members` | administrator | Add members |
| `DELETE /api/academy/groups/:id/members/:userId` | administrator | Remove a member |
| `POST /api/academy/groups/:id/supervisors` | administrator | Add an extra supervisor |
| `DELETE /api/academy/groups/:id/supervisors/:supervisorId` | administrator | Remove an extra supervisor |
| `GET /api/academy/assignments` | manager | List assignments |
| `GET /api/academy/assignments/:id` | manager | Assignment detail |
| `POST /api/academy/assignments` | manager | Assign a course to a user or group (a supervisor only within their groups) |
| `POST /api/academy/assignments/multiple` | manager | Assign several courses in bulk |
| `PUT /api/academy/assignments/:id` | manager | Update an assignment |
| `DELETE /api/academy/assignments/:id` | administrator | Delete an assignment |
| `POST /api/academy/learning-paths/:id/assign` | manager | Assign a learning path |
| `GET /api/academy/learning-paths/:id/stats` | manager | Learning path statistics |
| `GET /api/academy/courses/:id/stats` | manager | Course statistics |
| `GET /api/academy/surveys` | manager | List surveys |
| `GET /api/academy/surveys/stats` | manager | Survey statistics |
| `GET /api/academy/surveys/:id` | manager | Survey detail |
| `GET /api/academy/dashboard` | manager | Totals, hours, completion rate, alerts |
| `GET /api/academy/reports/courses` | manager | Course report |
| `GET /api/academy/reports/users/:id` | manager | Report of one learner |
| `GET /api/academy/reports/progress` | manager | Progress report |
| `GET /api/academy/export/assignments` | manager | Assignments as .xlsx (`courseId`, `groupId`) |
| `GET /api/academy/export/progress` | manager | Progress as .xlsx (`courseId`, `groupId`) |
| `GET /api/academy/export/surveys` | manager | Surveys as .xlsx (`courseId`) |
| `POST /api/academy/sync/users` | administrator | Create or update the academy profiles of a JSON list of existing accounts |
| `POST /api/academy/sync/users/csv` | administrator | The same with a raw CSV body |
| `GET /api/academy/sync/role-mapping` | administrator | Example mapping from external roles to academy roles |

## Who can do what

The policy is `academy.policy.ts` (resources `academy` and `academy-course`). The role that counts
is the academy role in `training_user_profiles`, and only while the profile is active; a site
`editor` has no academy rights by being one. Nobody gives themselves a profile: an administrator
creates it.

| Actor | What it may do |
| --- | --- |
| Anonymous | Verify a certificate code only (401 elsewhere) |
| Account without a profile, or `student` | Its assigned courses, progress, quizzes, surveys, certificates; groups it belongs to |
| `supervisor` | Manager routes: assignments, reports, exports, profiles list; only the learners and groups it supervises |
| `administrator`, or global `admin` account | Everything, including content, groups, profiles and deletes |
| Agent | Signed-in routes with `user:act`, `admin` or an `academy-lms:` / `kon:academy-lms:` scope; manager routes with `academy:manage`, administrator routes with `academy:administer` (`academy:*`, `academy-lms:*`, `kon:academy-lms:*` or `admin` open both). A managing agent manages every learner, not a set of groups |

Row security (migrations `0003` to `0009`, plus the core's owner policies) isolates the personal
tables by `user_id`; an academy administrator sees all rows, a supervisor the rows of learners in
the groups it supervises. Agents are recognised through the core's `kitsuden_agent_can_in_kon`
(migration `0009`): `academy:manage` reads and writes the personal tables of every learner (and
reads the profiles), `academy:administer` also writes the profiles; a denial (`!academy:*`,
`!academy-lms:*`) wins. A fine operation scope alone (`kon:academy-lms:<operation>`) passes the
route but row security still limits the agent to its own rows.

**404 instead of 403.** A course, topic or group a learner is not assigned to or not a member of
answers 404.

## Configuration

None: no environment variables or settings. The certificate color comes from the course's
`coverColor` (default `#009c3c`).

## Agents and MCP

Every route is a kon SDK operation with the fine scope `kon:academy-lms:<operation>` and an MCP
tool `academy-lms__<operation>` (ids in `academy-lms.routes.ts`), except five that are REST only:
`download-certificate-pdf` (PDF bytes), `export-assignments`, `export-progress`,
`export-surveys` (Excel files) and `sync-users-csv` (raw CSV body).

Writes marked sensitive, which an admin can hold for human approval
(`202 KITSUDEN_E_APPROVAL_REQUIRED`): `assign-courses-in-bulk`, `assign-learning-path`,
`reorder-modules`, `reorder-topics`, `create-profile`, `change-profile-role`, and every DELETE.
Details for agents: [AGENTS.md](AGENTS.md).

## Tests

| File | Covers |
| --- | --- |
| `tests/unit/security-academy.test.ts` | Course access by assignment, hidden answers, quiz limits, own progress, groups, academy roles, certificates |
| `tests/unit/kon-academy-lms-agents-and-sync.test.ts` | Agent scopes in row security (forced RLS, non-superuser role) and user sync writing profiles |
| `tests/unit/academy-without-relational-api.test.ts` | A course end to end: build, study, quiz, survey, certificate, learning path, management views |
| `kons/kon-academy-lms/tests/academy-lms.test.ts` | Services (PDF, Excel, media, user sync); runs on Bun |
| `kons/kon-academy-lms/tests/run-tests.sh` | Manual smoke test against a running API with a session cookie |

```bash
pnpm vitest run tests/unit/security-academy.test.ts
pnpm vitest run tests/unit/academy-without-relational-api.test.ts
pnpm test:bun   # bun suites, academy-lms included (sets a placeholder DATABASE_URL)
```

## License

MIT
