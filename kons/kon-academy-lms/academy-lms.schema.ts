/**
 * Academy LMS - Schema
 *
 * Models a complete learning management system with:
 * - Courses, modules and topics
 * - Quiz and assessment system
 * - Progress tracking
 * - Assignment groups
 * - Learning Paths
 * - Satisfaction surveys
 */

import { createId } from "@paralleldrive/cuid2";
import {
  pgTable,
  text,
  timestamp,
  decimal,
  integer,
  boolean,
  jsonb,
  pgEnum,
} from "drizzle-orm/pg-core";

// ============================================
// ENUMS
// ============================================

export const trainingRoleEnum = pgEnum("training_role", [
  "administrator",
  "supervisor",
  "student",
]);

export const courseTypeEnum = pgEnum("course_type", [
  "ONBOARDING",
  "MANAGEMENT",
  "TECHNICAL",
  "TOOLS",
  "DEVELOPMENT",
]);

export const assignmentMethodEnum = pgEnum("assignment_method", ["manual", "group", "automatic"]);

export const departmentEnum = pgEnum("department", [
  "ACCOUNTING",
  "FINANCE",
  "EXECUTIVE",
  "LEGAL",
  "BUSINESS",
  "OPERATIONS",
  "HUMAN_RESOURCES",
  "TECHNOLOGY",
  "OTHER",
]);

export const jobTitleEnum = pgEnum("job_title", [
  "Assistant",
  "Analyst",
  "Professional",
  "Coordinator",
  "Supervisor",
  "Head",
  "Manager",
]);

export const placeEnum = pgEnum("place", ["OFFICE", "HOME", "TRANSIT"]);

export const surveyRoleEnum = pgEnum("survey_role", [
  "Participant",
  "Speaker",
  "Organizer",
  "Other",
]);

// ============================================
// MAIN TABLES
// ============================================

/**
 * User profile specific to the training system
 * Extends the base Kitsuden user with specific roles
 */
export const userProfileTable = pgTable("training_user_profiles", {
  id: text("id").primaryKey().$defaultFn(createId),
  userId: text("user_id").notNull().unique(), // Reference to kitsuden-core-users
  trainingRole: trainingRoleEnum("training_role").notNull().default("student"),
  active: boolean("active").notNull().default(true),
  roleAssignedAt: timestamp("role_assigned_at").defaultNow(),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

/**
 * Courses available in the system
 */
export const courseTable = pgTable("courses", {
  id: text("id").primaryKey().$defaultFn(createId),
  title: text("title").notNull(),
  description: text("description").notNull(),
  startDate: timestamp("start_date"),
  endDate: timestamp("end_date"),
  durationHours: decimal("duration_hours", { precision: 5, scale: 1 }),
  mediaId: text("media_id"), // Reference to kon-media (for the course cover)
  coverColor: text("cover_color").notNull().default("#009c3c"),
  courseType: courseTypeEnum("course_type"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

/**
 * Assignment groups to organize students
 */
export const assignmentGroupTable = pgTable("assignment_groups", {
  id: text("id").primaryKey().$defaultFn(createId),
  name: text("name").notNull(),
  supervisorPrincipalId: text("supervisor_principal_id"), // Reference to userProfileTable
  description: text("description"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

/**
 * Many-to-many relation: Groups - Users
 */
export const groupUserTable = pgTable("group_users", {
  id: text("id").primaryKey().$defaultFn(createId),
  groupId: text("group_id")
    .notNull()
    .references(() => assignmentGroupTable.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(), // Reference to kitsuden-core-users
  assignedAt: timestamp("assigned_at").defaultNow(),
});

/**
 * Many-to-many relation: Groups - Additional supervisors
 */
export const groupSupervisorTable = pgTable("group_supervisors", {
  id: text("id").primaryKey().$defaultFn(createId),
  groupId: text("group_id")
    .notNull()
    .references(() => assignmentGroupTable.id, { onDelete: "cascade" }),
  supervisorId: text("supervisor_id").notNull(), // Reference to userProfileTable
  assignedAt: timestamp("assigned_at").defaultNow(),
});

/**
 * Modules within a course
 */
export const moduleTable = pgTable("course_modules", {
  id: text("id").primaryKey().$defaultFn(createId),
  courseId: text("course_id")
    .notNull()
    .references(() => courseTable.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description"),
  position: integer("position").notNull().default(1),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

/**
 * Topics within a module
 */
export const topicTable = pgTable("topics", {
  id: text("id").primaryKey().$defaultFn(createId),
  moduleId: text("module_id")
    .notNull()
    .references(() => moduleTable.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  content: text("content").notNull(),
  position: integer("position").notNull().default(1),
  // Multimedia
  videoLocal: text("video_local"), // Reference to kon-media
  videoYoutube: text("video_youtube"), // YouTube embed URL
  externalVideo: text("external_video"), // iframe or external link
  imageId: text("image_id"), // Reference to kon-media
  documentId: text("document_id"), // Reference to kon-media
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

/**
 * Additional files attached to topics
 */
export const additionalFileTable = pgTable("additional_files", {
  id: text("id").primaryKey().$defaultFn(createId),
  topicId: text("topic_id")
    .notNull()
    .references(() => topicTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  file: text("file").notNull(), // Reference to kon-media
  position: integer("position").notNull().default(1),
  createdAt: timestamp("created_at").defaultNow(),
});

// ============================================
// QUIZ SYSTEM
// ============================================

/**
 * Quiz associated with a module
 */
export const quizTable = pgTable("quizzes", {
  id: text("id").primaryKey().$defaultFn(createId),
  moduleId: text("module_id")
    .notNull()
    .unique()
    .references(() => moduleTable.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  instructions: text("instructions"),
  mediaId: text("media_id"), // Reference to kon-media (for the quiz cover)
  minPassingScore: integer("min_passing_score").notNull().default(70), // Percentage
  timeLimitMinutes: integer("time_limit_minutes"), // Optional
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

/**
 * Questions of a quiz
 */
export const questionTable = pgTable("questions", {
  id: text("id").primaryKey().$defaultFn(createId),
  quizId: text("quiz_id")
    .notNull()
    .references(() => quizTable.id, { onDelete: "cascade" }),
  text: text("text").notNull(),
  score: integer("score").notNull().default(10),
  position: integer("position").notNull().default(1),
  fileId: text("file_id"), // Reference to kon-media (image/audio)
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow(),
});

/**
 * Answer options for questions
 */
export const optionTable = pgTable("question_options", {
  id: text("id").primaryKey().$defaultFn(createId),
  questionId: text("question_id")
    .notNull()
    .references(() => questionTable.id, { onDelete: "cascade" }),
  text: text("text").notNull(),
  isCorrect: boolean("is_correct").notNull().default(false),
  position: integer("position").notNull().default(1),
  createdAt: timestamp("created_at").defaultNow(),
});

// ============================================
// PROGRESS TRACKING
// ============================================

/**
 * A user's progress in a course
 */
export const courseProgressTable = pgTable("course_progress", {
  id: text("id").primaryKey().$defaultFn(createId),
  userId: text("user_id").notNull(), // Reference to kitsuden-core-users
  courseId: text("course_id")
    .notNull()
    .references(() => courseTable.id, { onDelete: "cascade" }),
  completed: boolean("completed").notNull().default(false),
  completedAt: timestamp("completed_at"),
  surveyCompleted: boolean("survey_completed").notNull().default(false),
  certificateDownloaded: boolean("certificate_downloaded").notNull().default(false),
  certificateDownloadedAt: timestamp("certificate_downloaded_at"),
  progressPercent: integer("progress_percent").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

/**
 * Relation: Modules completed by user in a course
 */
export const moduleProgressTable = pgTable("module_progress", {
  id: text("id").primaryKey().$defaultFn(createId),
  courseProgressId: text("course_progress_id")
    .notNull()
    .references(() => courseProgressTable.id, { onDelete: "cascade" }),
  moduleId: text("module_id")
    .notNull()
    .references(() => moduleTable.id, { onDelete: "cascade" }),
  completedAt: timestamp("completed_at").defaultNow(),
});

/**
 * A user's progress in a specific topic
 */
export const topicProgressTable = pgTable("topic_progress", {
  id: text("id").primaryKey().$defaultFn(createId),
  userId: text("user_id").notNull(), // Reference to kitsuden-core-users
  topicId: text("topic_id")
    .notNull()
    .references(() => topicTable.id, { onDelete: "cascade" }),
  completed: boolean("completed").notNull().default(false),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

/**
 * Users' answers to quiz questions
 */
export const userAnswerTable = pgTable("user_answers", {
  id: text("id").primaryKey().$defaultFn(createId),
  userId: text("user_id").notNull(), // Reference to kitsuden-core-users
  questionId: text("question_id")
    .notNull()
    .references(() => questionTable.id, { onDelete: "cascade" }),
  selectedOptionId: text("selected_option_id")
    .notNull()
    .references(() => optionTable.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").defaultNow(),
});

/**
 * Final quiz results per user
 */
export const quizResultTable = pgTable("quiz_results", {
  id: text("id").primaryKey().$defaultFn(createId),
  userId: text("user_id").notNull(), // Reference to kitsuden-core-users
  quizId: text("quiz_id")
    .notNull()
    .references(() => quizTable.id, { onDelete: "cascade" }),
  score: integer("score").notNull(),
  scorePercent: integer("score_percent").notNull(),
  passed: boolean("passed").notNull().default(false),
  answersJson: jsonb("answers_json"), // { questionId: optionId, ... }
  takenAt: timestamp("taken_at").defaultNow(),
  timeSpentSeconds: integer("time_spent_seconds"),
});

// ============================================
// LEARNING PATHS
// ============================================

/**
 * Learning Paths - Predefined learning routes
 * They group multiple courses into an ordered sequence
 */
export const learningPathTable = pgTable("learning_paths", {
  id: text("id").primaryKey().$defaultFn(createId),
  name: text("name").notNull(),
  description: text("description"),
  category: text("category"), // e.g. "Onboarding", "Development", "Technical"
  estimatedHours: decimal("estimated_hours", { precision: 6, scale: 1 }),
  mediaId: text("media_id"), // Reference to kon-media (for the learning path image)
  active: boolean("active").notNull().default(true),
  requiresSequentialApproval: boolean("requires_sequential_approval").notNull().default(false), // true = must complete course N to access N+1
  createdById: text("created_by_id"), // User who created the path
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

/**
 * Relation: Courses within a Learning Path
 * Defines the sequential order of the courses
 */
export const learningPathCourseTable = pgTable("learning_path_courses", {
  id: text("id").primaryKey().$defaultFn(createId),
  learningPathId: text("learning_path_id")
    .notNull()
    .references(() => learningPathTable.id, { onDelete: "cascade" }),
  courseId: text("course_id")
    .notNull()
    .references(() => courseTable.id, { onDelete: "cascade" }),
  position: integer("position").notNull().default(1),
  required: boolean("required").notNull().default(true), // true = must be completed to finish the path
  estimatedDays: integer("estimated_days"), // Suggested days to complete
  createdAt: timestamp("created_at").defaultNow(),
});

/**
 * A user's progress in a whole Learning Path
 */
export const learningPathProgressTable = pgTable("learning_path_progress", {
  id: text("id").primaryKey().$defaultFn(createId),
  userId: text("user_id").notNull(), // Reference to kitsuden-core-users
  learningPathId: text("learning_path_id")
    .notNull()
    .references(() => learningPathTable.id, { onDelete: "cascade" }),
  completionPercent: integer("completion_percent").notNull().default(0),
  completedCourses: integer("completed_courses").notNull().default(0),
  totalCourses: integer("total_courses").notNull().default(0),
  completed: boolean("completed").notNull().default(false),
  completedAt: timestamp("completed_at"),
  startDate: timestamp("start_date").defaultNow(),
  dueDate: timestamp("due_date"), // Deadline to complete the whole path
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

/**
 * Learning Path assignments
 * Records who assigned the whole path
 */
export const learningPathAssignmentTable = pgTable("learning_path_assignments", {
  id: text("id").primaryKey().$defaultFn(createId),
  learningPathId: text("learning_path_id")
    .notNull()
    .references(() => learningPathTable.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(), // Reference to kitsuden-core-users
  assignedById: text("assigned_by_id"), // Who made the assignment
  dueDate: timestamp("due_date"), // Custom deadline
  priority: text("priority").default("normal"), // low, normal, high, urgent
  notes: text("notes"),
  date: timestamp("date").defaultNow(),
});

// ============================================
// ASSIGNMENTS
// ============================================

/**
 * History of course assignments to users/groups
 */
export const assignmentTable = pgTable("assignments", {
  id: text("id").primaryKey().$defaultFn(createId),
  courseId: text("course_id")
    .notNull()
    .references(() => courseTable.id, { onDelete: "cascade" }),
  userId: text("user_id"), // Reference to kitsuden-core-users (nullable if it is a group assignment)
  groupId: text("group_id").references(() => assignmentGroupTable.id, { onDelete: "cascade" }),
  method: assignmentMethodEnum("method").notNull().default("manual"),
  assignedById: text("assigned_by_id"), // Reference to kitsuden-core-users
  date: timestamp("date").defaultNow(),
  notes: text("notes"),
});

// ============================================
// FEEDBACK AND SURVEYS
// ============================================

/**
 * User feedback about topics
 */
export const feedbackTable = pgTable("feedback", {
  id: text("id").primaryKey().$defaultFn(createId),
  userId: text("user_id").notNull(), // Reference to kitsuden-core-users
  topicId: text("topic_id")
    .notNull()
    .references(() => topicTable.id, { onDelete: "cascade" }),
  rating: integer("rating").notNull(), // 1-5 stars
  comment: text("comment"),
  createdAt: timestamp("created_at").defaultNow(),
});

/**
 * Post-course satisfaction surveys
 */
export const satisfactionSurveyTable = pgTable("satisfaction_surveys", {
  id: text("id").primaryKey().$defaultFn(createId),
  userId: text("user_id"), // Reference to kitsuden-core-users
  courseId: text("course_id").references(() => courseTable.id, { onDelete: "set null" }),

  // Demographic information
  department: departmentEnum("department").notNull(),
  jobTitle: jobTitleEnum("job_title").notNull(),

  // Course evaluation
  presenter: integer("presenter").notNull(), // 1-5
  usefulness: boolean("usefulness").notNull(), // true = yes, false = no
  satisfaction: integer("satisfaction").notNull(), // 1-5
  learned: text("learned").notNull(), // Max 300 chars
  place: placeEnum("place").notNull(),
  role: surveyRoleEnum("role").notNull(),
  recommendation: text("recommendation"), // Max 200 chars
  courseComments: text("course_comments").notNull(), // Max 500 chars

  date: timestamp("date").defaultNow(),
});

// ============================================
// CERTIFICATES
// ============================================

/**
 * Certificates generated for users
 */
export const certificateTable = pgTable("certificates", {
  id: text("id").primaryKey().$defaultFn(createId),
  userId: text("user_id").notNull(), // Reference to kitsuden-core-users
  courseId: text("course_id")
    .notNull()
    .references(() => courseTable.id, { onDelete: "cascade" }),
  code: text("code").notNull().unique(), // Unique verification code
  file: text("file"), // Reference to kon-media (generated PDF)
  generatedAt: timestamp("generated_at").defaultNow(),
  downloadedAt: timestamp("downloaded_at"),
  dataJson: jsonb("data_json"), // { userName, courseName, completedAt, etc. }
});

// ============================================
// NOTIFICATIONS AND ACTIVITY
// ============================================

/**
 * System activity log
 */
export const activityLogTable = pgTable("academy_activity_log", {
  id: text("id").primaryKey().$defaultFn(createId),
  userId: text("user_id"), // Reference to kitsuden-core-users
  type: text("type").notNull(), // course_completed, quiz_passed, certificate_downloaded, etc.
  entityType: text("entity_type"), // course, module, topic, quiz, etc.
  entityId: text("entity_id"),
  description: text("description").notNull(),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow(),
});

// ============================================
// INFERRED TYPES
// ============================================

export type UserProfile = typeof userProfileTable.$inferSelect;
export type Course = typeof courseTable.$inferSelect;
export type AssignmentGroup = typeof assignmentGroupTable.$inferSelect;
export type GroupUser = typeof groupUserTable.$inferSelect;
export type GroupSupervisor = typeof groupSupervisorTable.$inferSelect;
export type Module = typeof moduleTable.$inferSelect;
export type Topic = typeof topicTable.$inferSelect;
export type AdditionalFile = typeof additionalFileTable.$inferSelect;
export type Quiz = typeof quizTable.$inferSelect;
export type Question = typeof questionTable.$inferSelect;
export type Option = typeof optionTable.$inferSelect;
export type CourseProgress = typeof courseProgressTable.$inferSelect;
export type ModuleProgress = typeof moduleProgressTable.$inferSelect;
export type TopicProgress = typeof topicProgressTable.$inferSelect;
export type UserAnswer = typeof userAnswerTable.$inferSelect;
export type QuizResult = typeof quizResultTable.$inferSelect;
export type Assignment = typeof assignmentTable.$inferSelect;
export type Feedback = typeof feedbackTable.$inferSelect;
export type SatisfactionSurvey = typeof satisfactionSurveyTable.$inferSelect;
export type Certificate = typeof certificateTable.$inferSelect;
export type ActivityLog = typeof activityLogTable.$inferSelect;
export type LearningPath = typeof learningPathTable.$inferSelect;
export type LearningPathCourse = typeof learningPathCourseTable.$inferSelect;
export type LearningPathProgress = typeof learningPathProgressTable.$inferSelect;
export type LearningPathAssignment = typeof learningPathAssignmentTable.$inferSelect;

// Enum types
export type TrainingRole = (typeof trainingRoleEnum.enumValues)[number];
export type CourseType = (typeof courseTypeEnum.enumValues)[number];
export type AssignmentMethod = (typeof assignmentMethodEnum.enumValues)[number];
export type Department = (typeof departmentEnum.enumValues)[number];
export type JobTitle = (typeof jobTitleEnum.enumValues)[number];
export type Place = (typeof placeEnum.enumValues)[number];
export type SurveyRole = (typeof surveyRoleEnum.enumValues)[number];
