/**
 * Academy Kon - Admin Configuration
 *
 * LMS-style admin with courses, lessons, and enrollment management
 */

// Local type definition to avoid importing from packages/admin
interface AdminViewColumn {
  name: string;
  type: string;
  label?: string;
  hidden?: boolean;
  sortable?: boolean;
  filterable?: boolean;
  displayField?: string;
  badge?: boolean;
  badgeColor?: Record<string, string>;
  width?: string;
}

interface AdminView {
  id: string;
  type: string;
  title: string;
  table: string;
  columns?: AdminViewColumn[];
  defaultSort?: { column: string; direction: "asc" | "desc" };
  filters?: Array<{
    field: string;
    type: string;
    label: string;
    options?: Array<{ value: string; label: string }>;
  }>;
  actions?: string[];
  groupBy?: string;
  cardFields?: string[];
  draggable?: boolean;
}

interface AdminConfig {
  name: string;
  singularName: string;
  icon: string;
  category: string;
  order: number;
  views: AdminView[];
  forms?: Record<string, unknown>;
  apiEndpoint: string;
}

export const adminConfig: AdminConfig = {
  name: "Academy",
  singularName: "Course",
  icon: "GraduationCap",
  category: "content",
  order: 20,

  views: [
    {
      id: "courses",
      type: "grid",
      title: "Courses",
      table: "courses",
      columns: [
        { name: "id", type: "text", hidden: true },
        { name: "thumbnail", type: "image", label: "Thumbnail", width: "60px" },
        { name: "title", type: "text", label: "Title", sortable: true, filterable: true },
        { name: "instructor", type: "relation", label: "Instructor", displayField: "name" },
        { name: "category", type: "text", label: "Category", sortable: true, filterable: true },
        {
          name: "level",
          type: "text",
          label: "Level",
          badge: true,
          badgeColor: {
            beginner: "green",
            intermediate: "yellow",
            advanced: "red",
          },
        },
        { name: "duration", type: "number", label: "Duration (min)" },
        { name: "enrolled_count", type: "number", label: "Students" },
        { name: "published", type: "boolean", label: "Published", badge: true },
        { name: "created_at", type: "datetime", label: "Created" },
      ],
      defaultSort: { column: "created_at", direction: "desc" },
      filters: [
        { field: "category", type: "select", label: "Category" },
        {
          field: "level",
          type: "select",
          label: "Level",
          options: [
            { value: "beginner", label: "Beginner" },
            { value: "intermediate", label: "Intermediate" },
            { value: "advanced", label: "Advanced" },
          ],
        },
        { field: "published", type: "boolean", label: "Published" },
      ],
      actions: ["view", "edit", "delete", "clone"],
    },
    {
      id: "lessons",
      type: "grid",
      title: "Lessons",
      table: "lessons",
      columns: [
        { name: "id", type: "text", hidden: true },
        { name: "title", type: "text", label: "Title", sortable: true },
        { name: "course", type: "relation", label: "Course", displayField: "title" },
        { name: "order", type: "number", label: "Order", sortable: true },
        { name: "duration", type: "number", label: "Duration" },
        { name: "type", type: "text", label: "Type", badge: true },
        { name: "published", type: "boolean", label: "Published", badge: true },
      ],
      defaultSort: { column: "order", direction: "asc" },
      actions: ["view", "edit", "delete"],
    },
    {
      id: "enrollments",
      type: "grid",
      title: "Enrollments",
      table: "enrollments",
      columns: [
        { name: "id", type: "text", hidden: true },
        { name: "student", type: "relation", label: "Student", displayField: "name" },
        { name: "course", type: "relation", label: "Course", displayField: "title" },
        { name: "progress", type: "number", label: "Progress %" },
        {
          name: "status",
          type: "text",
          label: "Status",
          badge: true,
          badgeColor: {
            active: "green",
            completed: "blue",
            dropped: "red",
          },
        },
        { name: "enrolled_at", type: "datetime", label: "Enrolled" },
        { name: "completed_at", type: "datetime", label: "Completed" },
      ],
      filters: [
        {
          field: "status",
          type: "select",
          label: "Status",
          options: [
            { value: "active", label: "Active" },
            { value: "completed", label: "Completed" },
            { value: "dropped", label: "Dropped" },
          ],
        },
      ],
      actions: ["view", "edit"],
    },
    {
      id: "kanban",
      type: "kanban",
      title: "Course Pipeline",
      table: "courses",
      groupBy: "status",
      cardFields: ["title", "instructor", "enrolled_count"],
      draggable: true,
    },
  ],

  forms: {
    course: {
      layout: "tabs",
      groups: [
        {
          id: "basic",
          label: "Basic Info",
          fields: ["title", "slug", "description", "category", "level"],
        },
        {
          id: "content",
          label: "Content",
          fields: ["thumbnail", "trailer_url", "syllabus"],
        },
        {
          id: "settings",
          label: "Settings",
          fields: ["instructor_id", "duration", "price", "published"],
        },
      ],
    },
  },

  apiEndpoint: "/api/explorer/courses",
};

export default adminConfig;
