/**
 * Moving a deal between stages
 * ============================================================================
 *
 * One place for what a move is, whoever asks for it: a person (`move-deal`), an agent through MCP, or an
 * automation rule (`kon-crm:move-stage`, crm.handlers.ts).
 *
 *   1. the target stage must be in the deal's own pipeline;
 *   2. its entry requirements must be met, unless an administrator skips them;
 *   3. the open transition is closed and a new one recorded (time in stage, who, why);
 *   4. the deal takes the stage's probability;
 *   5. the stages' own actions run (crm.automation.ts), each in its savepoint: a broken one leaves a note;
 *   6. `crm:deal:stage-changed` and `crm:deal.moved` go out after the commit.
 *
 * A deal already in the stage is not an error: `already: true`, nothing written, nothing emitted.
 */

import { AppError } from "@kitsuden/engine";
import { eq } from "drizzle-orm";

import { runStageActions } from "./crm.automation";
import type { CrmDb } from "./crm.db";
import { emitCrm } from "./crm.events";
import {
  crmDeals,
  crmDocuments,
  crmPipelineStages,
  crmStageTransitions,
  type StageAction,
  type StageEntryRequirements,
  type ValidationResult,
} from "./crm.schema";

/**
 * Whether a deal may enter a stage: its required custom fields and custom validations (blocking) and its
 * required documents (a warning only). Changes nothing; `validate-move` returns it as is.
 */
export async function validateStageTransition(
  dealId: string,
  targetStageId: string,
  tx: CrmDb
): Promise<ValidationResult> {
  const result: ValidationResult = {
    canMove: true,
    missingFields: [],
    missingDocuments: [],
    failedValidations: [],
    warnings: [],
  };

  // Get deal with custom fields
  const [deal] = await tx.select().from(crmDeals).where(eq(crmDeals.id, dealId));

  if (!deal) {
    result.canMove = false;
    result.warnings.push("Deal not found");
    return result;
  }

  // Get target stage with requirements
  const [stage] = await tx
    .select()
    .from(crmPipelineStages)
    .where(eq(crmPipelineStages.id, targetStageId));

  if (!stage) {
    result.canMove = false;
    result.warnings.push("Target stage not found");
    return result;
  }

  const requirements = (stage.entryRequirements || {}) as StageEntryRequirements;
  const customFields = (deal.customFields || {}) as Record<string, unknown>;

  // Validate required fields
  if (requirements.requiredFields?.length) {
    for (const fieldKey of requirements.requiredFields) {
      const value = customFields[fieldKey];
      if (value === undefined || value === null || value === "") {
        result.missingFields.push({
          key: fieldKey,
          label: fieldKey, // Could be enhanced to get from schema
          currentValue: value,
        });
        result.canMove = false;
      }
    }
  }

  // Validate custom validations
  if (requirements.customValidations?.length) {
    for (const validation of requirements.customValidations) {
      const value = customFields[validation.field];
      let passes = false;

      switch (validation.operator) {
        case "==":
          passes = value === validation.value;
          break;
        case "!=":
          passes = value !== validation.value;
          break;
        case ">":
          passes = Number(value) > Number(validation.value);
          break;
        case "<":
          passes = Number(value) < Number(validation.value);
          break;
        case ">=":
          passes = Number(value) >= Number(validation.value);
          break;
        case "<=":
          passes = Number(value) <= Number(validation.value);
          break;
        case "exists":
          passes = value !== undefined && value !== null && value !== "";
          break;
      }

      if (!passes) {
        result.failedValidations.push({
          field: validation.field,
          operator: validation.operator,
          expected: validation.value,
          actual: value,
          message: `Field ${validation.field} must be ${validation.operator} ${validation.value}`,
        });
        result.canMove = false;
      }
    }
  }

  // Validate required documents (basic check for Phase 1)
  if (requirements.requiredDocuments?.length) {
    const uploadedDocs = await tx
      .select({ type: crmDocuments.documentType })
      .from(crmDocuments)
      .where(eq(crmDocuments.dealId, dealId));

    const uploadedTypes = new Set(uploadedDocs.map((d: { type: string | null }) => d.type));

    for (const docType of requirements.requiredDocuments) {
      if (!uploadedTypes.has(docType)) {
        result.missingDocuments.push({
          type: docType,
          label: docType,
        });
        // Note: Not blocking move in Phase 1, just warning
        result.warnings.push(`Missing required document: ${docType}`);
      }
    }
  }

  return result;
}

export interface MoveRequest {
  dealId: string;
  targetStageId: string;
  /** Only an administrator may; the caller checks that before asking. */
  skipValidation?: boolean;
  moveReason?: string | null;
  userId: string | null;
}

export interface MoveResult {
  deal: typeof crmDeals.$inferSelect;
  already: boolean;
  fromStageId: string;
  transition?: typeof crmStageTransitions.$inferSelect;
  automation?: { ran: unknown[]; failed: unknown[] };
}

export async function moveDeal(db: CrmDb, request: MoveRequest): Promise<MoveResult> {
  const { dealId, targetStageId, skipValidation, moveReason, userId } = request;

  const [deal] = await db.select().from(crmDeals).where(eq(crmDeals.id, dealId));
  if (!deal) throw AppError.notFound("Deal not found");
  if (deal.stageId === targetStageId) return { deal, already: true, fromStageId: deal.stageId };

  if (!skipValidation) {
    const validation = await validateStageTransition(dealId, targetStageId, db);
    if (!validation.canMove) throw AppError.badRequest("Validation failed", validation);
  }

  const [targetStage] = await db.select().from(crmPipelineStages).where(eq(crmPipelineStages.id, targetStageId));
  // A stage from ANOTHER pipeline left the deal on a board that is not
  // its own (and, with skipValidation, without passing any requirement).
  if (!targetStage || targetStage.pipelineId !== deal.pipelineId) {
    throw AppError.validation("Target stage not found in this pipeline");
  }

  // Close the open transition (time tracking).
  if (deal.currentTransitionId) {
    await db
      .update(crmStageTransitions)
      .set({ exitedAt: new Date() })
      .where(eq(crmStageTransitions.id, deal.currentTransitionId));
  }

  const [transition] = await db
    .insert(crmStageTransitions)
    .values({
      dealId,
      fromStageId: deal.stageId,
      toStageId: targetStageId,
      enteredAt: new Date(),
      estimatedDays: targetStage.estimatedDays ?? null,
      movedBy: userId,
      moveReason: moveReason ?? null,
      validationResult: skipValidation ? { skipped: true } : {},
    })
    .returning();

  const updateData: Record<string, unknown> = {
    stageId: targetStageId,
    currentTransitionId: transition!.id,
    updatedAt: new Date(),
  };
  // The probability is the stage's, as when creating it: otherwise the
  // weighted forecast keeps the origin stage's (phase D).
  if (targetStage.probability !== null && targetStage.probability !== undefined) {
    updateData.probability = targetStage.probability;
  }
  const [updated] = await db.update(crmDeals).set(updateData).where(eq(crmDeals.id, dealId)).returning();

  // The deal already moved: a broken action leaves a note, it does not undo the move.
  const [sourceStage] = await db
    .select({ onExitActions: crmPipelineStages.onExitActions })
    .from(crmPipelineStages)
    .where(eq(crmPipelineStages.id, deal.stageId));
  const exit = await runStageActions(db, sourceStage?.onExitActions as StageAction[], updated!, userId);
  const enter = await runStageActions(db, targetStage.onEnterActions as StageAction[], updated!, userId);
  emitCrm("deal:stage-changed", { dealId, fromStageId: deal.stageId, toStageId: targetStageId });

  return {
    deal: updated!,
    already: false,
    fromStageId: deal.stageId,
    transition: transition!,
    automation: { ran: [...exit.ran, ...enter.ran], failed: [...exit.failed, ...enter.failed] },
  };
}
