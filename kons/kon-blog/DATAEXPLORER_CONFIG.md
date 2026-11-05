# DataExplorer Configuration - Kon Blog

## Using the Generic DataExplorer

The DataExplorer is a component of the Kitsuden admin panel (core), not of this kon:
`packages/admin/src/lib/components/DataExplorer.svelte` and
`packages/admin/src/lib/data-explorer/fieldRegistry.ts` in the Kitsuden repository. This page shows
how to point it at the blog's list route, `GET /api/blog`, which answers
`{ docs, totalDocs, totalPages, page, limit, hasNextPage, hasPrevPage }`.

## Usage example in a Svelte component

```svelte
<script>
  import DataExplorer from "$lib/components/DataExplorer.svelte";
  import { fieldPresets } from "$lib/data-explorer/fieldRegistry";

  const config = {
    table: "blog_posts",
    label: "Blog Posts",
    columns: [
      {
        field: "title",
        label: "Title",
        fieldConfig: { type: "text", options: { maxLength: 200 } },
      },
      {
        field: "status",
        label: "Status",
        fieldConfig: {
          type: "status-badge",
          options: {
            colors: {
              draft: "bg-yellow-500/10 text-yellow-500",
              published: "bg-green-500/10 text-green-500",
              scheduled: "bg-blue-500/10 text-blue-500",
              archived: "bg-gray-500/10 text-gray-400",
            },
          },
        },
      },
      {
        field: "readingTime",
        label: "Reading Time",
        fieldConfig: { type: "number" },
      },
      {
        field: "publishedAt",
        label: "Published",
        fieldConfig: {
          type: "calculated",
          options: {
            calculate: (row) => (row.publishedAt ? timeAgo(row.publishedAt) : "—"),
            format: "text",
          },
        },
      },
      {
        field: "commentCount",
        label: "Comments",
        fieldConfig: {
          type: "calculated",
          options: {
            // `comments.count` is null when kon-comments is not installed
            calculate: (row) => row.comments?.count ?? "—",
          },
        },
      },
    ],
    searchableFields: ["title", "excerpt"],
    filterableFields: ["status", "authorId"],
    rowActions: [
      { id: "edit", label: "Edit", icon: Edit2 },
      { id: "view", label: "View", icon: Eye },
    ],
  };
</script>

<DataExplorer table="blog_posts" {config} apiEndpoint="/api/blog" />
```

## Available Calculated Fields

### 1. Backend (in the API)

The list route (`list-posts` in `src/routes.ts`) adds these fields to each post it returns, on top
of the `blog_posts` columns:

| Field | What it is |
| --- | --- |
| `categories` | `[{ id, name, slug }]` of the post's categories. |
| `gameIds`, `tagIds` | Uuids of the linked games and tags. |
| `comments` | `{ subjectType: "blog_post", subjectId, endpoint, enabled, count }`; `count` is the number of published comments, or `null` without kon-comments. |

`readingTime` is a stored column (`reading_time`), set by the editor; the API does not compute it.
The list does not include the author: `GET /api/blog/slug/:slug` does (`author`), the list only
has `authorId`. The API searches `title` and `excerpt` only (`?search=`).

### 2. Frontend (in the DataExplorer)

Fields calculated in the frontend are evaluated dynamically:

```typescript
{
  field: "isOverdue",
  label: "Status",
  fieldConfig: {
    type: "calculated",
    options: {
      calculate: (row) => {
        if (row.status !== "scheduled") return null;
        return new Date(row.publishedAt) < new Date() ? "Overdue" : "On Track";
      },
      format: "badge"
    }
  }
}
```

## Calculation Helpers

```typescript
import { calculatedHelpers } from "$lib/data-explorer/fieldRegistry";

// Count
calculatedHelpers.count(array);

// Sum
calculatedHelpers.sum(array, "fieldName");

// Average
calculatedHelpers.avg(array, "fieldName");

// Format date
calculatedHelpers.dateFormat(date, "YYYY-MM-DD");

// Relative time
calculatedHelpers.timeAgo(date);

// Currency
calculatedHelpers.currency(value, "USD");

// Get nested value
calculatedHelpers.get(obj, "path.nested.field", "default");

// Conditional
calculatedHelpers.if(condition, trueValue, falseValue);
```

## Registered Field Types

| Type           | Component        | Use                |
| -------------- | ---------------- | ------------------ |
| `text`         | TextField        | Simple text        |
| `textarea`     | TextField        | Long text          |
| `email`, `url`, `slug` | TextField | Text with a format |
| `number`       | NumberField      | Numbers            |
| `boolean`      | BooleanField     | Yes/No             |
| `date`         | DateField        | Dates              |
| `datetime`     | DateField        | Date and time      |
| `status-badge` | StatusBadgeField | Colored statuses   |
| `select`       | StatusBadgeField | Simple select      |
| `calculated`   | CalculatedField  | Calculated values  |
| `relation`     | (pending)        | FK to other tables |
| `media`        | (pending)        | Images/files       |
| `richtext`     | (pending)        | Rich editor        |

## Extending with Custom Types

A component of the admin panel can register its own field types (`fieldRegistry` lives in the
admin, so this applies to admin code, not to a kon's server code):

```typescript
// In an admin component
import { fieldRegistry } from "$lib/data-explorer/fieldRegistry";
import MyCustomField from "./MyCustomField.svelte";

fieldRegistry.register("my-custom-type", MyCustomField);
```
