/**
 * Academy LMS - Admin Configuration
 *
 * Optional: if present, the admin uses these custom views.
 * If absent, it uses the auto-generated Data Explorer.
 */

interface AdminConfig {
  name: string;
  icon: string;
  views: Array<Record<string, unknown>>;
  forms?: Record<string, unknown>;
}

export const adminConfig: AdminConfig = {
  // Name in the sidebar
  name: "Academy",

  // Icon (Lucide icon name)
  icon: "GraduationCap",

  // Main views
  views: [
    {
      id: "dashboard",
      type: "dashboard",
      title: "Dashboard",
      // Dashboard widgets
      widgets: [
        { type: "stat", table: "courses", label: "Active Courses" },
        { type: "stat", table: "group_users", label: "Students" },
        { type: "chart", table: "course_progress", chartType: "completion" },
      ],
    },
    {
      id: "courses",
      type: "grid",
      title: "Courses",
      table: "courses",
      // Grid configuration
      columns: ["title", "courseType", "active", "createdAt"],
      actions: ["edit", "delete", "clone"],
      // Default filters
      filters: [
        { field: "courseType", type: "select", options: ["ONBOARDING", "MANAGEMENT", "TECHNICAL"] },
        { field: "active", type: "boolean" },
      ],
    },
    {
      id: "course-builder",
      type: "custom",
      title: "Course Builder",
      // Custom Svelte component (optional)
      component: "CourseBuilder",
      // Only shown in edit mode
      context: "edit",
    },
    {
      id: "groups",
      type: "grid",
      title: "Student Groups",
      table: "assignment_groups",
      columns: ["name", "supervisorPrincipalId", "members.count"],
    },
    {
      id: "learning-paths",
      type: "pipeline", // Kanban-style view
      title: "Learning Paths",
      table: "learning_paths",
      groupBy: "category",
      columns: ["name", "totalCourses", "active"],
    },
  ],

  // Form configuration
  forms: {
    courses: {
      layout: "tabs",
      tabs: [
        { id: "general", label: "General", fields: ["title", "description", "courseType"] },
        { id: "media", label: "Media", fields: ["cover", "coverColor"] },
        { id: "schedule", label: "Schedule", fields: ["startDate", "endDate", "durationHours"] },
      ],
    },
  },
};

// Export custom components (optional)
// export { default as CourseBuilder } from "./admin/CourseBuilder.svelte";
// export { default as QuizEditor } from "./admin/QuizEditor.svelte";
