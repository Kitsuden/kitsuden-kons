# kon-academy-lms: setup

Steps to go from an installed kon to a first course a learner can take. Route details and roles:
[README.md](README.md).

## 1. Install and restart

```bash
kitsuden kon add academy-lms --enable   # runs the migrations and switches the kon on
```

Without `--enable` the kon is installed but off: switch it on in the admin panel (**Kons**).
`kon-media`, which it needs, ships with the Kitsuden core. Restart the API. At startup the kon checks that `courses`, `course_modules` and `quizzes` exist
and logs a warning if they do not; it never creates tables itself (the migrations in
`migrations/` do).

PDF certificates and Excel exports use `pdfkit` and `exceljs`, which install with the kon. Template
certificates also need `pdf-lib`, an optional dependency.

## 2. Give the first academy roles

Only a global admin account (or an academy administrator) creates profiles. Nobody can give
themselves one.

```bash
POST /api/academy/profiles
{ "userId": "<account id>", "trainingRole": "administrator" }
```

Use `supervisor` for people who assign courses and read reports for their groups, and `student`
(or no profile) for learners. A profile set inactive loses its role.

## 3. Build a course

As an academy administrator: create the course (`POST /api/academy/courses`), its modules
(`POST /api/academy/modules`), topics (`POST /api/academy/topics`), a quiz
(`POST /api/academy/quizzes`) with questions (`POST /api/academy/quizzes/:id/questions`) and
options (`POST /api/academy/questions/:id/options`).

## 4. Group and assign

Create a group (`POST /api/academy/groups`, optional `supervisorPrincipalId` as main supervisor), add members
(`POST /api/academy/groups/:id/members`), then assign the course to the group or to one user
(`POST /api/academy/assignments`). A supervisor can assign only within the groups it supervises.

## 5. Check

A learner now sees the course in `GET /api/academy/courses`. After completing its topics, passing
the quiz and sending the survey (`POST /api/academy/surveys`), the learner gets a certificate
(`GET /api/academy/certificates/:courseId`), which anyone can verify with
`GET /api/academy/certificates/verify/:code`.

## Admin panel

`kon.json` declares grid views for courses, modules, topics, quizzes, groups, assignments,
learning paths, surveys, progress and certificates, plus a dashboard view. They appear in the
Kitsuden admin panel when the kon is active.
