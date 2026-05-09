import type {
  OpenClawAdapter,
  OpenClawAnalyzeInput,
  OpenClawAnalyzeOutput,
  OpenClawClassifyIntentInput,
  OpenClawClassifyIntentOutput,
  OpenClawHealthCheckInput,
  OpenClawHealthCheckResult,
  OpenClawRuntimeContext,
  OpenClawSearchAnswerInput,
  OpenClawSearchAnswerOutput,
  OpenClawSearchInput,
  OpenClawSearchOutput,
  OpenClawSupportAnswerComposerInput,
  OpenClawSupportEvidencePlannerInput,
  OpenClawSupportEvidenceSelectorInput,
  OpenClawSupportPlannerInput,
  OpenClawSupportRouterInput,
  OpenClawSupportSpecialistInput,
  OpenClawSupportVerifierInput,
  OpenClawSupportWriterInput
} from "../openclaw/types.js";
import type {
  DraftSupportAnswer,
  SpecialistDraftAnswer,
  SupportAnswer,
  SupportCaseFrame,
  SupportEvidencePlan,
  SupportEvidenceSelection,
  SupportQuestionRoute,
  SupportVerificationResult,
  TriageSupportInsight
} from "../../modules/ai/types.js";
import { WsOpenClawAdapter } from "../openclaw/ws-adapter.js";

function bridgeDetail(detail?: string): string {
  return detail ? `${detail} (via hermes bridge)` : "Hermes bridge is healthy";
}

export class HermesOpenClawAdapter implements OpenClawAdapter {
  constructor(private readonly bridge: OpenClawAdapter = new WsOpenClawAdapter()) {}

  async healthCheck(input?: OpenClawHealthCheckInput): Promise<OpenClawHealthCheckResult> {
    const health = await this.bridge.healthCheck(input);
    return {
      ...health,
      mode: "hermes",
      detail: bridgeDetail(health.detail)
    };
  }

  analyzeTicket(input: OpenClawAnalyzeInput, idempotencyKey: string, runtime?: OpenClawRuntimeContext): Promise<OpenClawAnalyzeOutput> {
    return this.bridge.analyzeTicket(input, idempotencyKey, runtime);
  }

  searchKnowledge(input: OpenClawSearchInput, idempotencyKey: string, runtime?: OpenClawRuntimeContext): Promise<OpenClawSearchOutput> {
    return this.bridge.searchKnowledge(input, idempotencyKey, runtime);
  }

  answerSearchQuery(
    input: OpenClawSearchAnswerInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<OpenClawSearchAnswerOutput> {
    return this.bridge.answerSearchQuery(input, idempotencyKey, runtime);
  }

  classifyIntent(
    input: OpenClawClassifyIntentInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<OpenClawClassifyIntentOutput> {
    if (!this.bridge.classifyIntent) {
      throw new Error("Hermes bridge classifyIntent is unavailable");
    }
    return this.bridge.classifyIntent(input, idempotencyKey, runtime);
  }

  planSupportCase(input: OpenClawSupportPlannerInput, idempotencyKey: string, runtime?: OpenClawRuntimeContext): Promise<SupportCaseFrame> {
    return this.bridge.planSupportCase(input, idempotencyKey, runtime);
  }

  routeSupportQuestion(
    input: OpenClawSupportRouterInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<SupportQuestionRoute> {
    return this.bridge.routeSupportQuestion(input, idempotencyKey, runtime);
  }

  planSupportEvidence(
    input: OpenClawSupportEvidencePlannerInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<SupportEvidencePlan> {
    return this.bridge.planSupportEvidence(input, idempotencyKey, runtime);
  }

  selectSupportEvidence(
    input: OpenClawSupportEvidenceSelectorInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<SupportEvidenceSelection> {
    return this.bridge.selectSupportEvidence(input, idempotencyKey, runtime);
  }

  writeApiSpecialistAnswer(
    input: OpenClawSupportSpecialistInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<SpecialistDraftAnswer> {
    return this.bridge.writeApiSpecialistAnswer(input, idempotencyKey, runtime);
  }

  writeHowToSpecialistAnswer(
    input: OpenClawSupportSpecialistInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<SpecialistDraftAnswer> {
    return this.bridge.writeHowToSpecialistAnswer(input, idempotencyKey, runtime);
  }

  writeBehaviorSpecialistAnswer(
    input: OpenClawSupportSpecialistInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<SpecialistDraftAnswer> {
    return this.bridge.writeBehaviorSpecialistAnswer(input, idempotencyKey, runtime);
  }

  writeTroubleshootingSpecialistAnswer(
    input: OpenClawSupportSpecialistInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<SpecialistDraftAnswer> {
    return this.bridge.writeTroubleshootingSpecialistAnswer(input, idempotencyKey, runtime);
  }

  writeSupportAnswer(input: OpenClawSupportWriterInput, idempotencyKey: string, runtime?: OpenClawRuntimeContext): Promise<DraftSupportAnswer> {
    return this.bridge.writeSupportAnswer(input, idempotencyKey, runtime);
  }

  judgeSupportAnswer(
    input: OpenClawSupportVerifierInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<SupportVerificationResult> {
    return this.bridge.judgeSupportAnswer(input, idempotencyKey, runtime);
  }

  verifySupportAnswer(
    input: OpenClawSupportVerifierInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<SupportVerificationResult> {
    return this.bridge.verifySupportAnswer(input, idempotencyKey, runtime);
  }

  composeCustomerAnswer(
    input: OpenClawSupportAnswerComposerInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<Omit<SupportAnswer, "mode">> {
    return this.bridge.composeCustomerAnswer(input, idempotencyKey, runtime);
  }

  writeTriageInsight(
    input: OpenClawSupportWriterInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<TriageSupportInsight> {
    return this.bridge.writeTriageInsight(input, idempotencyKey, runtime);
  }

  verifyTriageInsight(
    input: OpenClawSupportVerifierInput,
    idempotencyKey: string,
    runtime?: OpenClawRuntimeContext
  ): Promise<SupportVerificationResult> {
    return this.bridge.verifyTriageInsight(input, idempotencyKey, runtime);
  }
}
