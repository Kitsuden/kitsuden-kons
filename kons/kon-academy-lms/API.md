# kon-academy-lms: data reference

Values, formats and responses the API uses. The full list of routes, with who may call each one,
is in [README.md](README.md#http-api).

## Enums

| Enum | Values |
| --- | --- |
| `training_role` | `administrator`, `supervisor`, `student` |
| `course_type` | `ONBOARDING`, `MANAGEMENT`, `TECHNICAL`, `TOOLS`, `DEVELOPMENT` |
| `assignment_method` | `manual`, `group`, `automatic` |
| `department` | `ACCOUNTING`, `FINANCE`, `EXECUTIVE`, `LEGAL`, `BUSINESS`, `OPERATIONS`, `HUMAN_RESOURCES`, `TECHNOLOGY`, `OTHER` |
| `job_title` | `Assistant`, `Analyst`, `Professional`, `Coordinator`, `Supervisor`, `Head`, `Manager` |
| `place` | `OFFICE`, `HOME`, `TRANSIT` |
| `survey_role` | `Participant`, `Speaker`, `Organizer`, `Other` |

## Tables

| Table | Holds |
| --- | --- |
| `training_user_profiles` | Academy role and data of a user |
| `courses` | Courses |
| `course_modules` | Modules of a course |
| `topics` | Topics of a module |
| `additional_files` | Files attached to a topic |
| `quizzes` | Quiz of a module |
| `questions` | Quiz questions |
| `question_options` | Options of a question |
| `assignment_groups` | Groups of learners |
| `group_users` | Group members |
| `group_supervisors` | Extra supervisors of a group |
| `assignments` | Course assignments to a user or group |
| `course_progress`, `module_progress`, `topic_progress` | Progress |
| `user_answers`, `quiz_results` | Quiz answers and results |
| `learning_paths`, `learning_path_courses` | Learning paths and their courses |
| `learning_path_progress`, `learning_path_assignments` | Path progress and assignments |
| `feedback` | Topic ratings |
| `satisfaction_surveys` | Course surveys (`presenter` rating 1-5, `recommendation` text) |
| `certificates` | Issued certificates |
| `academy_activity_log` | Activity log |

## Topic body

`POST /api/academy/topics` takes `moduleId`, `title`, `content`, `position` (default 1) and
optionally `videoLocal`, `imageId`, `documentId` (kon-media references), `videoYoutube` and
`externalVideo`. Examples with YouTube: [tests/youtube-examples.md](tests/youtube-examples.md).

## Quizzes

`POST /api/academy/quizzes/:id/answer` takes `{ "answers": { "<questionId>": "<optionId>" } }` and
returns the score, whether it passed and the attempts left. At most 5 attempts (429 after); a
passed quiz cannot be retaken (409). An option of another question does not score.

## Certificates

Codes have the form `CERT-XXXXXXXX-XXXXXXXX-XXXXXXXXXXXX` and are not predictable.
`GET /api/academy/certificates/verify/:code` needs no session: 400 for a malformed code, 404 for
an unknown one. The PDF is generated with `pdfkit`, colored with the course's `coverColor`.

## Excel exports

`GET /api/academy/export/assignments` and `GET /api/academy/export/progress` filter by `courseId`
and `groupId`; `GET /api/academy/export/surveys` by `courseId`. They return an `.xlsx` attachment
built with `exceljs`.

## User sync

`POST /api/academy/sync/users` takes
`{ "users": [{ "externalId", "userId"?, "email", "name", "role"?, "active"?, ... }], "config"? }`;
`POST /api/academy/sync/users/csv` takes a raw CSV body with a header row:

```csv
externalId,userId,email,name,lastName,department,jobTitle,role
EMP001,<account id>,jane@example.com,Jane,Doe,TECHNOLOGY,Analyst,supervisor
```

Both create or update the academy profile (role, active flag, notes) of each row's account. A kon
cannot create accounts or look them up by email, so each row names an existing account by
`userId` (or by `externalId` when the external system already uses the account id); a row whose
account does not exist is counted in `result.failed` with its reason in `result.errors`. The role
is the row's `role` when it is an academy role (`administrator`, `supervisor`, `student`), else
`config.roleMapping` maps it, else `student`. `config.createNewUsers: false` skips accounts
without a profile and `config.updateExisting: false` skips those with one. The JSON route answers
400 and writes nothing if any row is invalid; the CSV route skips invalid rows and reports them.
The response carries `result: { successful, failed, created, updated, errors }`.
`GET /api/academy/sync/role-mapping` returns the example mapping (`exampleRoleMapping` in
`services/user-sync.service.ts`) and the academy roles.

## Media helpers

`POST /api/academy/media/youtube-info` with `{ "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }`:

```json
{
  "valid": true,
  "videoId": "dQw4w9WgXcQ",
  "embedUrl": "https://www.youtube.com/embed/dQw4w9WgXcQ",
  "thumbnailUrl": "https://img.youtube.com/vi/dQw4w9WgXcQ/maxresdefault.jpg"
}
```

`POST /api/academy/media/normalize-video` turns YouTube and Vimeo links into embed URLs.
`POST /api/academy/media/validate` checks a file's size and MIME type for its kind (image, video,
document, audio, any) and uploads nothing.
