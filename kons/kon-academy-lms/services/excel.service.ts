/**
 * Academy LMS - Excel Service
 *
 * Service for exporting data to Excel.
 * Uses exceljs to generate xlsx files.
 */

import type { Fill } from "exceljs";

// ExcelJS is lazy-loaded to avoid issues when the optional dependency is not installed
let ExcelJSModule: any = null;

async function getExcelJS(): Promise<typeof import("exceljs")> {
  if (!ExcelJSModule) {
    ExcelJSModule = await import("exceljs");
  }
  return ExcelJSModule;
}

export interface AssignmentExcelRow {
  date: Date;
  course: string;
  courseType: string;
  durationHours: string | number;
  user: string;
  employeeNumber?: string;
  group?: string;
  method: string;
  progress: number;
  finishedAt?: Date | null;
  status: string;
}

export interface ProgressExcelRow {
  user: string;
  email?: string;
  course: string;
  module?: string;
  completedTopics: number;
  totalTopics: number;
  passedQuizzes: number;
  totalQuizzes: number;
  progressPercent: number;
  status: string;
  startDate?: Date;
  completedAt?: Date;
}

export interface SurveyExcelRow {
  date: Date;
  course: string;
  user: string;
  department: string;
  jobTitle: string;
  presenter: number;
  usefulness: string;
  satisfaction: number;
  learned: string;
  place: string;
  role: string;
  recommendation?: string;
  comments: string;
}

/**
 * Generates an Excel file with the assignment history
 */
export async function generateAssignmentsExcel(
  data: AssignmentExcelRow[],
  title?: string
): Promise<Buffer> {
  const ExcelJS = await getExcelJS();
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Assignments");

  // Title
  worksheet.mergeCells("A1:K1");
  worksheet.getCell("A1").value = title || "Assignment History";
  worksheet.getCell("A1").font = { size: 16, bold: true };
  worksheet.getCell("A1").alignment = { horizontal: "center" };
  worksheet.getRow(1).height = 30;

  // Headers
  const headers = [
    "Date",
    "Course",
    "Type",
    "Duration (hrs)",
    "User",
    "N° Colaborador",
    "Group",
    "Method",
    "Progress (%)",
    "Completion Date",
    "Status",
  ];

  const headerRow = worksheet.addRow(headers);
  headerRow.font = { bold: true, color: { argb: "FFFFFF" } };
  headerRow.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "009C3C" },
  };
  headerRow.alignment = { horizontal: "center", vertical: "middle" };
  headerRow.height = 25;

  // Data rows
  data.forEach((row) => {
    const dataRow = worksheet.addRow([
      row.date,
      row.course,
      row.courseType,
      row.durationHours,
      row.user,
      row.employeeNumber || "N/A",
      row.group || "Individual",
      row.method,
      row.progress,
      row.finishedAt || "-",
      row.status,
    ]);

    // Conditional formatting for progress
    const progressCell = dataRow.getCell(9);
    if (row.progress === 100) {
      progressCell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "C6EFCE" },
      };
      progressCell.font = { color: { argb: "006100" } };
    } else if (row.progress > 0) {
      progressCell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFEB9C" },
      };
      progressCell.font = { color: { argb: "9C5700" } };
    }

    // Formatting for status
    const statusCell = dataRow.getCell(11);
    if (row.status === "Completed") {
      statusCell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "C6EFCE" },
      };
      statusCell.font = { color: { argb: "006100" } };
    } else if (row.status === "In Progress") {
      statusCell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFEB9C" },
      };
      statusCell.font = { color: { argb: "9C5700" } };
    } else {
      statusCell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFC7CE" },
      };
      statusCell.font = { color: { argb: "9C0006" } };
    }
  });

  // Column formatting
  worksheet.getColumn(1).width = 15; // Date
  worksheet.getColumn(2).width = 35; // Course
  worksheet.getColumn(3).width = 15; // Type
  worksheet.getColumn(4).width = 12; // Duration
  worksheet.getColumn(5).width = 25; // User
  worksheet.getColumn(6).width = 15; // N° Colaborador
  worksheet.getColumn(7).width = 20; // Group
  worksheet.getColumn(8).width = 12; // Method
  worksheet.getColumn(9).width = 12; // Progress
  worksheet.getColumn(10).width = 18; // Completion Date
  worksheet.getColumn(11).width = 15; // Status

  // Date format
  worksheet.getColumn(1).numFmt = "DD/MM/YYYY HH:mm";
  worksheet.getColumn(10).numFmt = "DD/MM/YYYY";

  // Filters
  worksheet.autoFilter = {
    from: { row: 2, column: 1 },
    to: { row: 2, column: 11 },
  };

  // Freeze panes
  worksheet.views = [{ state: "frozen", xSplit: 0, ySplit: 2 }];

  return workbook.xlsx.writeBuffer() as unknown as Promise<Buffer>;
}

/**
 * Generates an Excel file with a progress report
 */
export async function generateProgressExcel(
  data: ProgressExcelRow[],
  title?: string
): Promise<Buffer> {
  const ExcelJS = await getExcelJS();
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Progress");

  // Title
  worksheet.mergeCells("A1:L1");
  worksheet.getCell("A1").value = title || "Progress Report";
  worksheet.getCell("A1").font = { size: 16, bold: true };
  worksheet.getCell("A1").alignment = { horizontal: "center" };
  worksheet.getRow(1).height = 30;

  // Headers
  const headers = [
    "User",
    "Email",
    "Course",
    "Module",
    "Completed Topics",
    "Total Topics",
    "Passed Quizzes",
    "Total Quizzes",
    "Progress (%)",
    "Status",
    "Start Date",
    "Completion Date",
  ];

  const headerRow = worksheet.addRow(headers);
  headerRow.font = { bold: true, color: { argb: "FFFFFF" } };
  headerRow.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "009C3C" },
  };
  headerRow.alignment = { horizontal: "center", vertical: "middle" };
  headerRow.height = 25;

  // Data rows
  data.forEach((row) => {
    const dataRow = worksheet.addRow([
      row.user,
      row.email || "-",
      row.course,
      row.module || "-",
      row.completedTopics,
      row.totalTopics,
      row.passedQuizzes,
      row.totalQuizzes,
      row.progressPercent,
      row.status,
      row.startDate || "-",
      row.completedAt || "-",
    ]);

    // Conditional formatting for progress
    const progressCell = dataRow.getCell(9);
    progressCell.fill = getProgressFill(row.progressPercent);
  });

  // Column formatting
  worksheet.getColumn(1).width = 25;
  worksheet.getColumn(2).width = 30;
  worksheet.getColumn(3).width = 35;
  worksheet.getColumn(4).width = 25;
  worksheet.getColumn(5).width = 12;
  worksheet.getColumn(6).width = 12;
  worksheet.getColumn(7).width = 12;
  worksheet.getColumn(8).width = 12;
  worksheet.getColumn(9).width = 12;
  worksheet.getColumn(10).width = 15;
  worksheet.getColumn(11).width = 15;
  worksheet.getColumn(12).width = 18;

  // Date format
  worksheet.getColumn(11).numFmt = "DD/MM/YYYY";
  worksheet.getColumn(12).numFmt = "DD/MM/YYYY";

  // Filters
  worksheet.autoFilter = {
    from: { row: 2, column: 1 },
    to: { row: 2, column: 12 },
  };

  // Freeze panes
  worksheet.views = [{ state: "frozen", xSplit: 0, ySplit: 2 }];

  return workbook.xlsx.writeBuffer() as unknown as Promise<Buffer>;
}

/**
 * Generates an Excel file with survey results
 */
export async function generateSurveysExcel(
  data: SurveyExcelRow[],
  title?: string
): Promise<Buffer> {
  const ExcelJS = await getExcelJS();
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Surveys");

  // Title
  worksheet.mergeCells("A1:M1");
  worksheet.getCell("A1").value = title || "Survey Results";
  worksheet.getCell("A1").font = { size: 16, bold: true };
  worksheet.getCell("A1").alignment = { horizontal: "center" };
  worksheet.getRow(1).height = 30;

  // Headers
  const headers = [
    "Date",
    "Course",
    "User",
    "Department",
    "Cargo",
    "Speaker",
    "Usefulness",
    "Satisfaction",
    "Learned",
    "Place",
    "Role",
    "Recommendation",
    "Comments",
  ];

  const headerRow = worksheet.addRow(headers);
  headerRow.font = { bold: true, color: { argb: "FFFFFF" } };
  headerRow.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "009C3C" },
  };
  headerRow.alignment = { horizontal: "center", vertical: "middle" };
  headerRow.height = 25;

  // Data rows
  data.forEach((row) => {
    const dataRow = worksheet.addRow([
      row.date,
      row.course,
      row.user,
      row.department,
      row.jobTitle,
      row.presenter,
      row.usefulness,
      row.satisfaction,
      row.learned,
      row.place,
      row.role,
      row.recommendation || "-",
      row.comments,
    ]);

    // Conditional formatting for satisfaction
    const satisfactionCell = dataRow.getCell(8);
    satisfactionCell.fill = getSatisfactionFill(row.satisfaction);
  });

  // Column formatting
  worksheet.getColumn(1).width = 15;
  worksheet.getColumn(2).width = 30;
  worksheet.getColumn(3).width = 25;
  worksheet.getColumn(4).width = 20;
  worksheet.getColumn(5).width = 15;
  worksheet.getColumn(6).width = 10;
  worksheet.getColumn(7).width = 10;
  worksheet.getColumn(8).width = 12;
  worksheet.getColumn(9).width = 40;
  worksheet.getColumn(10).width = 12;
  worksheet.getColumn(11).width = 12;
  worksheet.getColumn(12).width = 30;
  worksheet.getColumn(13).width = 40;

  // Date format
  worksheet.getColumn(1).numFmt = "DD/MM/YYYY";

  // Wrap text
  worksheet.getColumn(9).alignment = { wrapText: true };
  worksheet.getColumn(12).alignment = { wrapText: true };
  worksheet.getColumn(13).alignment = { wrapText: true };

  // Filters
  worksheet.autoFilter = {
    from: { row: 2, column: 1 },
    to: { row: 2, column: 13 },
  };

  // Freeze panes
  worksheet.views = [{ state: "frozen", xSplit: 0, ySplit: 2 }];

  return workbook.xlsx.writeBuffer() as unknown as Promise<Buffer>;
}

/**
 * Gets the fill color according to progress
 */
function getProgressFill(progress: number): Fill {
  if (progress === 100) {
    return {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "C6EFCE" },
    };
  } else if (progress >= 75) {
    return {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "D4EDDA" },
    };
  } else if (progress >= 50) {
    return {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFF3CD" },
    };
  } else if (progress >= 25) {
    return {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFE5CC" },
    };
  } else {
    return {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "F8D7DA" },
    };
  }
}

/**
 * Gets the fill color according to satisfaction
 */
function getSatisfactionFill(satisfaction: number): Fill {
  if (satisfaction >= 5) {
    return {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "C6EFCE" },
    };
  } else if (satisfaction >= 4) {
    return {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "D4EDDA" },
    };
  } else if (satisfaction >= 3) {
    return {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFF3CD" },
    };
  } else if (satisfaction >= 2) {
    return {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFE5CC" },
    };
  } else {
    return {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "F8D7DA" },
    };
  }
}
