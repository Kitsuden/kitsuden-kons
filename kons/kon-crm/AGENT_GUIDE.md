# Working in the CRM as an agent

Read this before your first call. `get-agent-guide` also returns, live, this installation's words (its entities,
fields and activity kinds), what you can see, and the tool groups.

## Start every task the same way

1. `get-my-access`: whether you see all records or only assigned ones, amounts, sensitive fields and notes.
   A field or amount you do not see is hidden from you, not empty. Never conclude "zero" or "none" from it.
2. Learn the business's words: a deal may be called a "matter", a "project" or an "order" here. The entity's
   custom fields (`customFields`) and the activity kinds (`list-activity-kinds`) are this business's vocabulary.

## Reading

- Count with `count-deals` (`groupBy=stageId`, `status`, `assignedTo` or `cf.<field>`), not by listing everything.
- Filter by the business's own fields with `cf.<field>=value` on deals, contacts and companies. A 403 means you
  cannot read that field, so you cannot filter by it either.
- Search deals by title, contact name or company name with `search`.
- For someone's work: `list-work` with `include=deal`, and `get-work-summary` for the counts.
- A deal's story: `get-deal-history`; its people and their roles: `list-deal-contacts`.

## Writing

- **Nothing is guessed.** When you learn something about a contact or company, record it with
  `record-observation`: the field, the value, where you saw it (`source`) and the kind of evidence (from
  `get-evidence-policy`). Never send a confidence: you are asked what you saw, not how sure you are. The CRM
  decides whether it is written to the record or waits for a person.
- Do not overwrite what a person typed. If the record says something else, record the observation and let a
  person decide.
- Before moving a deal, `validate-move`: a stage may require fields or documents. Say why in `moveReason`.
- Two contacts that look like the same person: `merge-contacts` only asks; a person decides.
- Log work on a deal with `log-deal-work` (a quantity of a unit, at your resource's rate). A 409 means the ledger
  (kon-conta) is not installed here.

## What only a person does

Accepting or rejecting a suggested value, deciding a merge, opening a client's portal link, granting access and
configuring the CRM. You will get a 403: do not retry and do not look for another way.

## Approval

A `202` with `KITSUDEN_E_APPROVAL_REQUIRED` means a person must approve that action. Report what you proposed and
stop; do not retry it.

## Emails

Emails copied to the CRM are activities of type `email` (`metadata.direction`: `sent` or `received`). A signature
in a received email is evidence: record what it says with `record-observation`, evidence `own-email-signature`,
source `email:<messageId>`.

## Being woken up

An admin can make a core action run you when the CRM announces something: `crm:deal:created`,
`crm:deal:stage-changed`, `crm:deal:status-changed`, `crm:contact:created`, `crm:email:received`,
`crm:observation:suggested` or `crm:observation:applied`. The event carries ids, never values: read the record
with your own access before acting.

## Tool groups

Ask for only the group your task needs (`kon:crm/<group>`): a smaller list of tools is easier to choose from.
`get-agent-guide` lists them with their operations.
