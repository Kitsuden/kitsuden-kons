# kon-directory

An employee directory: organizations, departments, positions, employee profiles with documents,
org charts and reporting chains. For a company that wants its people to find each other while
keeping HR data (birth date, salary band, emergency contact, documents) visible to HR only.

| Maturity | Category | Version | Mounted at | Requires |
| --- | --- | --- | --- | --- |
| beta | business | 1.0.0 | `/api/directory` | kon-media (core `auth`) |

## Install

```bash
kitsuden kon add directory --enable
```

`package.json` has `defaultEnabled: false`, so pass `--enable` (or switch the kon on in the admin
panel, **Kons**). Restart the API afterwards. `kon.json` lists `kon-media` as a required kon:
employee documents point at media files (`mediaId`), and photo and logo URLs are built as
`/api/media/preset/<id>/thumbnail` and `/api/media/preset/<id>/small`. No environment variables.

## What it adds

- **Organizations**: companies or entities, with contact data, logo and an employee count.
- **Departments**: belong to an organization, can nest (`parentDepartmentId`), have a head, a cost
  center (HR only) and a headcount that the kon recounts when employees join, move or leave.
- **Positions**: job titles in an organization, with level, grade, department, the position they
  report to and an `isManagement` flag.
- **Employees**: profiles linked optionally to a CMS account (`userId`), with manager, status
  (`active`, `on_leave`, `remote`, `terminated`, `contractor`, `intern`), employment type
  (`full_time`, `part_time`, `contract`, `intern`, `freelance`), skills, languages, links,
  emergency contact, custom fields and a `visibleInDirectory` switch.
- **Employee documents**: contracts, IDs, certificates pointing at an uploaded media file, with
  dates, a document number and an `isConfidential` flag.

Tables (from `kon.json`): `directory_organizations`, `directory_departments`,
`directory_positions`, `directory_employees`, `directory_employee_documents`,
`directory_org_chart_cache`. The last one is created by the migrations but no route reads or
writes it; the org chart is computed on each request.

## HTTP API

What each employee field shows depends on who asks (see [Who can do what](#who-can-do-what)).
Lists return `{ docs }`; `GET /api/directory/employees` also returns `totalDocs`.

Structure:

| Route | Who may call it | What it does |
| --- | --- | --- |
| `GET /api/directory/organizations` | Signed in | Active organizations by name (up to 500), with logo URL and employee count. |
| `POST /api/directory/organizations` | HR | Creates an organization; slug from the name unless given; 409 if taken. |
| `GET /api/directory/organizations/:id` | Signed in | One organization by id or slug, with its active top-level departments. Inactive: 404 except for HR. |
| `GET /api/directory/departments` | Signed in | Active departments (up to 1000). Filters `organizationId`, `parentId` (`null` = top level). |
| `POST /api/directory/departments` | HR | Creates a department; slug unique in the organization (409); a parent from another organization is 422. |
| `GET /api/directory/departments/:id` | Signed in | A department with head, sub-departments and active employees as the caller may see them. Inactive: 404 except for HR. |
| `GET /api/directory/positions` | Signed in | Active positions (up to 1000). Filters `organizationId`, `departmentId`. |
| `POST /api/directory/positions` | HR | Creates a position. |

Employees:

| Route | Who may call it | What it does |
| --- | --- | --- |
| `GET /api/directory/employees` | Signed in | Active, visible employees by surname. Filters `organizationId`, `departmentId`, `positionId`, `managerId`, `remote=true`, `location`, `search` (name; HR also e-mail), `status` (HR only), `limit` (1-100, default 50). |
| `POST /api/directory/employees` | HR | Creates a profile. Required: `organizationId`, `employeeId`, `firstName`, `lastName`, `email`. Employee number unique per organization and e-mail unique overall (409). |
| `GET /api/directory/employees/:id` | Signed in | A profile with organization, department, position, manager and direct reports. Hidden or inactive: 404 except for its owner and HR. |
| `PATCH /api/directory/employees/:id` | HR, or the employee | HR changes any field. The employee changes only personal fields of their own profile; any other field is 403. |
| `DELETE /api/directory/employees/:id` | HR | Soft delete: sets the profile inactive and `terminated`, recounts headcount. |
| `GET /api/directory/employees/:id/reporting-chain` | Signed in | `{ chain }` from the top manager down to the employee; at most 50 steps, a cycle stops. Hidden profile: 404. |
| `GET /api/directory/employees/:id/documents` | HR, or the employee | HR sees all documents; the employee sees their own non-confidential ones; anyone else gets 404. |
| `POST /api/directory/employees/:id/documents` | HR | Records a document for an uploaded media file (`mediaId`); the uploader is the caller. |

Views:

| Route | Who may call it | What it does |
| --- | --- | --- |
| `GET /api/directory/org-chart` | Signed in | `{ organizationId, roots, totalEmployees }`: tree of active, visible employees by manager. `organizationId` is required (400). |
| `GET /api/directory/search` | Signed in | Up to 20 employees and 10 departments matching `q` (at least 2 characters, else 400); `organizationId` narrows it. |
| `GET /api/directory/stats` | HR, or employees of that organization | `{ totalEmployees, byStatus, byDepartment, remoteEmployees, onSiteEmployees }` for `organizationId` (required). 403 for others. |

Ids are uuids; a malformed id gives 404 (path) or 400 (query), not a database error.

## Who can do what

The host lets only signed-in callers into `/api/directory` (its gate answers 401 to anonymous
requests). Inside, the policies in `directory.policy.ts` decide:

| Who | Sees | Changes |
| --- | --- | --- |
| Signed-in user without a profile | The public card of active, visible employees: name, photo, department, position, manager, location, remote, bio, skills, languages, links. No e-mails or phones. | Nothing. |
| Colleague (active profile in the same organization) | The public card plus `workEmail`, `phone`, `timezone` of people in their organizations; that organization's stats. | Nothing of others. |
| The employee | Their whole profile (even if hidden) and their non-confidential documents. | Personal fields of their own active profile: `displayName`, `phone`, `mobile`, `photoId`, `timezone`, `bio`, `skills`, `languages`, `linkedin`, `github`, `twitter`, `website`, `emergencyContact`, `visibleInDirectory`. |
| Editor | The same as any user: an editor is not HR here. | Nothing. |
| HR: admin, or an agent with `directory:*`, `kon:directory:*` or `admin` | Everything, including confidential documents and the HR-only columns. | Everything. |

Row security (`migrations/0006_english_rls.sql`, tables `directory_employees` and
`directory_employee_documents`):

- Employees: read by the system, HR, the profile's owner, and anyone for active, visible profiles;
  updated by the system, HR or the owner; inserted and deleted by the system or HR.
- A trigger (`directory_protect_hr_fields`) refuses changes to HR fields (organization, employee
  number, names, e-mails, department, position, manager, status, dates, salary band, custom
  fields, `isActive`, …) by anyone but the system or HR, even through direct SQL.
- Documents: read by the system, HR, and the owner for non-confidential ones; written by the
  system or HR.

Hidden profiles and other people's documents answer 404, not 403. Organizations, departments and
positions have no row security: the structure is visible to every signed-in caller.

## Configuration

None. The kon reads no environment variables or settings.

## Agents and MCP

Every operation is an MCP tool `directory__<op>` with the fine scope `kon:directory:<op>`.

| Operation | Route | Writes |
| --- | --- | --- |
| `list-organizations` | `GET /api/directory/organizations` | no |
| `create-organization` | `POST /api/directory/organizations` | yes |
| `get-organization` | `GET /api/directory/organizations/:id` | no |
| `list-departments` | `GET /api/directory/departments` | no |
| `create-department` | `POST /api/directory/departments` | yes |
| `get-department` | `GET /api/directory/departments/:id` | no |
| `list-positions` | `GET /api/directory/positions` | no |
| `create-position` | `POST /api/directory/positions` | yes |
| `list-employees` | `GET /api/directory/employees` | no |
| `create-employee` | `POST /api/directory/employees` | yes |
| `get-employee` | `GET /api/directory/employees/:id` | no |
| `update-employee` | `PATCH /api/directory/employees/:id` | yes |
| `offboard-employee` | `DELETE /api/directory/employees/:id` | yes, sensitive |
| `get-org-chart` | `GET /api/directory/org-chart` | no |
| `get-reporting-chain` | `GET /api/directory/employees/:id/reporting-chain` | no |
| `list-employee-documents` | `GET /api/directory/employees/:id/documents` | no |
| `add-employee-document` | `POST /api/directory/employees/:id/documents` | yes |
| `search-directory` | `GET /api/directory/search` | no |
| `get-directory-stats` | `GET /api/directory/stats` | no |

`offboard-employee` is a `DELETE`, sensitive by default: with human approval on, an agent's call
returns `202 KITSUDEN_E_APPROVAL_REQUIRED`. Details for agents: [AGENTS.md](AGENTS.md).

## Tests

`tests/unit/kon-directory-security.test.ts` covers the projections for anonymous callers,
colleagues, the employee and HR; personal versus HR fields; documents; statistics; a manager
cycle; malformed ids; the uploader taken from the session; and row security plus the HR-fields
trigger in the database.

```bash
pnpm vitest run tests/unit/kon-directory-security.test.ts
```

## License

MIT
