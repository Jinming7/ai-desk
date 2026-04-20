import type { SupportCaseFrame } from "./types.js";

export type SupportEvidencePolicy = {
  strict: boolean;
  allowedProductAreas: string[];
  allowedEvidenceKinds: string[];
  allowedDeploymentModels?: string[];
  requiresPermissionSignal?: boolean;
};

export type SupportEvidenceLike = {
  supportMetadata?: Record<string, unknown>;
  title?: string | null;
  headingPath?: string | null;
  snippet?: string | null;
  path?: string | null;
  docKind?: string | null;
  objectType?: string | null;
  productArea?: string | null;
  deploymentModel?: string | null;
  evidenceKind?: string | null;
};

export type SupportEvidenceProfile = {
  title: string;
  heading: string;
  snippet: string;
  path: string;
  docKind: string;
  objectType: string;
  evidenceKind: string;
  productArea: string;
  deploymentModel: string;
  permissions: string[];
  prerequisites: string[];
  actions: string[];
  appliesTo: string[];
};

function normalizeString(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function uniqueStrings(input: Array<string | null | undefined>, limit = 12): string[] {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const item of input) {
    const value = String(item ?? "").trim().toLowerCase();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    values.push(value);
    if (values.length >= limit) break;
  }
  return values;
}

function normalizeExplicitDomain(value: unknown): string {
  switch (value) {
    case "openapi":
    case "deployment":
    case "integrations":
    case "product":
    case "troubleshooting":
    case "docs":
      return value;
    default:
      return "";
  }
}

function resolvePolicyDomain(caseFrame: SupportCaseFrame): string {
  const explicitDomain = normalizeExplicitDomain(caseFrame.primary_domain);
  if (explicitDomain === "docs") return "product";
  return explicitDomain;
}

function expandEvidenceKindAliases(value: string): string[] {
  const normalized = normalizeString(value);
  if (!normalized) return [];
  const aliases = new Set<string>([normalized]);
  if (normalized === "api_operation") {
    aliases.add("capability");
    aliases.add("procedure");
  }
  if (normalized === "integration_guidance") {
    aliases.add("procedure");
    aliases.add("capability");
    aliases.add("troubleshooting");
  }
  if (normalized === "procedure") {
    aliases.add("capability");
  }
  if (normalized === "constraint") {
    aliases.add("capability");
  }
  return [...aliases];
}

function getMetadata(input: SupportEvidenceLike): Record<string, unknown> {
  return (input.supportMetadata ?? {}) as Record<string, unknown>;
}

function getMetadataList(metadata: Record<string, unknown>, key: string): string[] {
  const raw = metadata[key];
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => normalizeString(item)).filter(Boolean);
}

function normalizeDocsPath(pathValue: string): string {
  return pathValue
    .replace(/^i18n\/[^/]+\/docusaurus-plugin-content-docs-open-docs\/current\//, "open-docs/docs/")
    .replace(/^i18n\/[^/]+\/docusaurus-plugin-content-docs\/current\//, "docs/");
}

function inferDocKind(input: {
  explicitDocKind: string;
  productArea: string;
  evidenceKind: string;
}): string {
  if (input.explicitDocKind) return input.explicitDocKind;
  if (input.evidenceKind === "api_operation") return "openapi/api";
  if (input.evidenceKind === "troubleshooting") return "troubleshooting";
  if (input.evidenceKind === "constraint") return "rules";
  if (input.productArea === "deployment") return "deployment_runbook";
  if (input.evidenceKind === "procedure" || input.evidenceKind === "capability") return "product_guide";
  return "";
}

function normalizePolicyProductArea(value: string): string {
  switch (normalizeString(value)) {
    case "integration":
      return "integrations";
    case "deployment_environment":
      return "deployment";
    case "docs":
      return "product";
    default:
      return normalizeString(value);
  }
}

function normalizePolicyEvidenceKind(value: string): string {
  const normalized = normalizeString(value);
  if (normalized === "integration_guidance") return "procedure";
  return normalized;
}

export function getSupportEvidenceProfile(input: SupportEvidenceLike): SupportEvidenceProfile {
  const metadata = getMetadata(input);
  const title = normalizeString(input.title);
  const heading = normalizeString(input.headingPath);
  const snippet = normalizeString(input.snippet);
  const path = normalizeDocsPath(normalizeString(input.path));
  const evidenceKind = normalizePolicyEvidenceKind(
    String(input.evidenceKind ?? metadata.evidence_kind ?? metadata.source_family ?? "")
  );
  const productArea = normalizePolicyProductArea(String(input.productArea ?? metadata.product_area ?? ""));
  const deploymentModel = normalizeString(input.deploymentModel ?? metadata.deployment_model);
  const explicitDocKind = normalizeString(input.docKind ?? metadata.doc_kind);
  const docKind = inferDocKind({
    explicitDocKind,
    productArea,
    evidenceKind
  });
  const objectType =
    normalizeString(input.objectType ?? metadata.object_type) || getMetadataList(metadata, "objects")[0] || "";
  const appliesTo = uniqueStrings([
    ...getMetadataList(metadata, "applies_to"),
    deploymentModel,
    productArea
  ]);
  return {
    title,
    heading,
    snippet,
    path,
    docKind,
    objectType,
    evidenceKind,
    productArea,
    deploymentModel,
    permissions: getMetadataList(metadata, "permissions"),
    prerequisites: getMetadataList(metadata, "prerequisites"),
    actions: getMetadataList(metadata, "actions"),
    appliesTo
  };
}

function hasPermissionSignal(profile: SupportEvidenceProfile): boolean {
  if (profile.permissions.length > 0) return true;
  const semanticText = [
    ...profile.permissions,
    ...profile.prerequisites,
    ...profile.actions
  ]
    .filter(Boolean)
    .join(" ");
  return /\b(scope|scopes|permission|permissions|oauth|token|auth|authorization|authentication)\b/.test(semanticText);
}

export function buildSupportEvidencePolicy(caseFrame: SupportCaseFrame): SupportEvidencePolicy | null {
  const questionType = String(caseFrame.question_type ?? "");
  const domain = resolvePolicyDomain(caseFrame);
  const deploymentModel = normalizeString(caseFrame.deployment_model);

  if (domain === "openapi") {
    if (caseFrame.question_type === "api_scope_auth") {
      return {
        strict: true,
        allowedProductAreas: ["openapi"],
        allowedEvidenceKinds: ["api_operation", "capability", "constraint"],
        requiresPermissionSignal: true
      };
    }
    return {
      strict: true,
      allowedProductAreas: ["openapi"],
      allowedEvidenceKinds:
        questionType === "troubleshooting"
          ? ["api_operation", "troubleshooting", "procedure", "constraint", "capability"]
          : ["api_operation", "capability", "constraint", "procedure"]
    };
  }

  if (domain === "deployment") {
    return {
      strict: true,
      allowedProductAreas: ["deployment"],
      allowedEvidenceKinds:
        questionType === "how_to_product" || questionType === "config_setup"
          ? ["procedure", "troubleshooting", "constraint", "capability"]
          : ["capability", "constraint", "procedure", "troubleshooting"],
      allowedDeploymentModels: deploymentModel === "private_deployment" ? ["private_deployment"] : undefined
    };
  }

  if (domain === "integrations") {
    return {
      strict: true,
      allowedProductAreas: ["integrations"],
      allowedEvidenceKinds:
        questionType === "troubleshooting"
          ? ["integration_guidance", "troubleshooting", "procedure", "constraint", "capability"]
          : ["integration_guidance", "procedure", "capability", "constraint", "troubleshooting"]
    };
  }

  if (!domain) {
    return null;
  }

  if (questionType === "how_to_product" || questionType === "config_setup" || questionType === "data_export_reporting") {
    return {
      strict: true,
      allowedProductAreas: [domain],
      allowedEvidenceKinds: ["procedure", "capability", "constraint", "troubleshooting"]
    };
  }

  if (questionType === "why_behavior" || questionType === "capability_confirmation" || questionType === "troubleshooting") {
    return {
      strict: true,
      allowedProductAreas: [domain],
      allowedEvidenceKinds: ["capability", "constraint", "procedure", "troubleshooting"]
    };
  }

  return null;
}

export function matchesSupportEvidencePolicy(input: SupportEvidenceLike, caseFrame: SupportCaseFrame): boolean {
  const policy = buildSupportEvidencePolicy(caseFrame);
  if (!policy) return true;

  const profile = getSupportEvidenceProfile(input);
  const allowedProductAreas = new Set(policy.allowedProductAreas.map((item) => normalizeString(item)).filter(Boolean));
  const candidateProductAreas = [normalizeString(profile.productArea)].filter(Boolean);
  const productMatched =
    !policy.allowedProductAreas.length ||
    !candidateProductAreas.length ||
    candidateProductAreas.some((item) => allowedProductAreas.has(item));
  const allowedEvidenceKinds = new Set(policy.allowedEvidenceKinds.flatMap((item) => expandEvidenceKindAliases(item)));
  const candidateEvidenceKinds = expandEvidenceKindAliases(profile.evidenceKind);
  const kindMatched =
    !policy.allowedEvidenceKinds.length ||
    !candidateEvidenceKinds.length ||
    candidateEvidenceKinds.some((item) => allowedEvidenceKinds.has(item));
  const deploymentMatched =
    !policy.allowedDeploymentModels?.length ||
    !profile.deploymentModel ||
    policy.allowedDeploymentModels.includes(profile.deploymentModel) ||
    profile.appliesTo.some((item) => policy.allowedDeploymentModels?.includes(item));
  const permissionMatched = policy.requiresPermissionSignal ? hasPermissionSignal(profile) : true;
  const matched = productMatched && kindMatched && deploymentMatched && permissionMatched;
  return matched ? true : !policy.strict;
}

export function filterSupportEvidenceByPolicy<T>(
  items: T[],
  caseFrame: SupportCaseFrame,
  projector: (item: T) => SupportEvidenceLike
): T[] {
  const policy = buildSupportEvidencePolicy(caseFrame);
  if (!policy?.strict) return items;
  return items.filter((item) => matchesSupportEvidencePolicy(projector(item), caseFrame));
}
