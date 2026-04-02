import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  type AnswerGoldenCase,
  type BuildValidationFixtureCase,
  type DatasetEnvelope,
  type RegressionReplayCase,
  type RetrievalSeedCase,
  type RuntimeScenarioCase,
  answerGoldenCaseSchema,
  buildValidationFixtureCaseSchema,
  datasetEnvelopeSchemas,
  regressionReplayCaseSchema,
  retrievalSeedCaseSchema,
  runtimeScenarioCaseSchema
} from "./types.js";

async function readJson(absolutePath: string): Promise<unknown> {
  const raw = await readFile(absolutePath, "utf8");
  return JSON.parse(raw) as unknown;
}

function normalizeEnvelope<TCase>(input: unknown, caseParser: { parse(value: unknown): TCase }, kind: keyof typeof datasetEnvelopeSchemas): DatasetEnvelope<TCase> {
  const envelopeSchema = datasetEnvelopeSchemas[kind];
  const parsedEnvelope = envelopeSchema.safeParse(input);
  if (parsedEnvelope.success) {
    return {
      version: parsedEnvelope.data.version,
      cases: parsedEnvelope.data.cases as TCase[]
    };
  }

  const parsedArray = Array.isArray(input) ? input.map((item) => caseParser.parse(item)) : null;
  if (parsedArray) {
    return {
      version: "unversioned",
      cases: parsedArray
    };
  }

  return {
    version: "unversioned",
    cases: [caseParser.parse(input)]
  };
}

async function loadDataset<TCase>(
  datasetPath: string,
  caseParser: { parse(value: unknown): TCase },
  kind: keyof typeof datasetEnvelopeSchemas
): Promise<DatasetEnvelope<TCase>> {
  const absolutePath = path.resolve(datasetPath);
  const parsed = await readJson(absolutePath);
  return normalizeEnvelope(parsed, caseParser, kind);
}

export async function loadRetrievalSeedDataset(datasetPath: string): Promise<DatasetEnvelope<RetrievalSeedCase>> {
  return await loadDataset(datasetPath, retrievalSeedCaseSchema, "retrieval");
}

export async function loadRuntimeScenarioDataset(datasetPath: string): Promise<DatasetEnvelope<RuntimeScenarioCase>> {
  return await loadDataset(datasetPath, runtimeScenarioCaseSchema, "runtime");
}

export async function loadAnswerGoldenDataset(datasetPath: string): Promise<DatasetEnvelope<AnswerGoldenCase>> {
  return await loadDataset(datasetPath, answerGoldenCaseSchema, "answer");
}

export async function loadRegressionReplayDataset(datasetPath: string): Promise<DatasetEnvelope<RegressionReplayCase>> {
  return await loadDataset(datasetPath, regressionReplayCaseSchema, "regression");
}

export async function loadBuildValidationFixtureDataset(datasetPath: string): Promise<DatasetEnvelope<BuildValidationFixtureCase>> {
  return await loadDataset(datasetPath, buildValidationFixtureCaseSchema, "build");
}

