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

function hasSpecificProductArea(value: string): boolean {
  return value !== "" && value !== "general" && value !== "unknown";
}

function hasSpecificDeploymentModel(value: string): boolean {
  return value === "private_deployment" || value === "public_cloud";
}

function expandProductAreaAliases(value: string): string[] {
  const normalized = normalizeString(value);
  if (!normalized) return [];
  const aliases = new Set<string>([normalized]);
  if (normalized === "deployment" || normalized === "deployment_environment" || normalized.startsWith("deployment_")) {
    aliases.add("deployment");
    aliases.add("deployment_environment");
  }
  return [...aliases];
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

function inferPathProductArea(pathValue: string): string {
  if (/(^|\/)deploy-docs\//.test(pathValue)) return "deployment";
  if (/(^|\/)(docs|open-docs\/docs)\/openapi\//.test(pathValue) || /\.api\.(md|mdx)$/i.test(pathValue)) return "openapi";
  if (/(^|\/)integrations?\//.test(pathValue)) return "integrations";
  if (/(^|\/)docs\/ones-wiki\//.test(pathValue)) return "wiki";
  return "";
}

function inferProductAreaFallback(input: {
  path: string;
  title: string;
  heading: string;
  snippet: string;
}): string {
  const pathArea = inferPathProductArea(input.path);
  if (pathArea) return pathArea;
  const semanticText = `${input.path} ${input.title} ${input.heading} ${input.snippet}`;
  if (
    /deploy|deployment|self-hosted|on-prem|kubernetes|cluster|database|storage|topology|architecture|私有部署|本地部署|系统要求|环境要求|操作系统要求|支持矩阵|兼容性/.test(
      semanticText
    )
  ) {
    return "deployment";
  }
  if (/<methodendpoint|<paramsitem|<schemaitem|openapi|oauth|scope|token|credential|api_path/.test(semanticText)) {
    return "openapi";
  }
  if (/oauth|sso|webhook|github|gitlab|slack|teams|integration|redirect uri|callback/.test(semanticText)) {
    return "integrations";
  }
  if (/wiki|space|page group/.test(semanticText)) return "wiki";
  if (/issue|project|sprint|field|comment|attachment/.test(semanticText)) return "project_management";
  return "";
}

function inferDeploymentModelFallback(input: { path: string; title: string; heading: string; snippet: string }): string {
  const semanticText = `${input.path} ${input.title} ${input.heading} ${input.snippet}`;
  if (/(^|\/)deploy-docs\//.test(input.path)) return "private_deployment";
  if (/private deployment|self-hosted|私有部署|本地部署|on-prem|air-gapped|closed network|offline|闭网|离线/.test(semanticText)) {
    return "private_deployment";
  }
  if (/public cloud|公有云|saas/.test(semanticText)) return "public_cloud";
  return "";
}

function inferEvidenceKindFallback(input: {
  path: string;
  title: string;
  heading: string;
  snippet: string;
  currentEvidenceKind: string;
}): string {
  const semanticText = `${input.path} ${input.title} ${input.heading} ${input.snippet}`;
  if (/troubleshoot|troubleshooting|排查|故障/.test(semanticText)) return "troubleshooting";
  if (
    /support matrix|compatibility|system requirements?|environment requirements?|operating system requirements?|requirements?|not support|unsupported|不支持|限制|兼容性|支持矩阵|系统要求|环境要求|操作系统要求/.test(
      semanticText
    )
  ) {
    return "constraint";
  }
  if (
    input.currentEvidenceKind === "" &&
    /guide|quick start|setup|configure|install|deployment flow|部署说明|安装步骤|配置步骤|操作步骤/.test(semanticText)
  ) {
    return "procedure";
  }
  return "";
}

function evidenceKindPriority(value: string): number {
  switch (value) {
    case "api_operation":
      return 5;
    case "troubleshooting":
      return 4;
    case "constraint":
      return 3;
    case "procedure":
      return 2;
    case "capability":
      return 1;
    default:
      return 0;
  }
}

function preferEvidenceKind(primary: string, fallback: string): string {
  return evidenceKindPriority(primary) >= evidenceKindPriority(fallback) ? primary || fallback : fallback;
}

function inferDocKind(input: {
  explicitDocKind: string;
  path: string;
  productArea: string;
  evidenceKind: string;
}): string {
  if (input.explicitDocKind) return input.explicitDocKind;
  if (input.evidenceKind === "api_operation") return "openapi/api";
  if (input.evidenceKind === "troubleshooting") return "troubleshooting";
  if (input.evidenceKind === "constraint") return "rules";
  if (input.productArea === "deployment" || /(^|\/)deploy-docs\//.test(input.path)) return "deployment_runbook";
  if (input.evidenceKind === "procedure" || input.evidenceKind === "capability") return "product_guide";
  return "";
}

export function getSupportEvidenceProfile(input: SupportEvidenceLike): SupportEvidenceProfile {
  const metadata = getMetadata(input);
  const title = normalizeString(input.title);
  const heading = normalizeString(input.headingPath);
  const snippet = normalizeString(input.snippet);
  const path = normalizeDocsPath(normalizeString(input.path));
  const baseEvidenceKind = normalizeString(input.evidenceKind ?? metadata.evidence_kind ?? metadata.source_family);
  const evidenceKind = preferEvidenceKind(
    baseEvidenceKind,
    inferEvidenceKindFallback({ path, title, heading, snippet, currentEvidenceKind: baseEvidenceKind })
  );
  const baseProductArea = normalizeString(input.productArea ?? metadata.product_area);
  const productArea =
    hasSpecificProductArea(baseProductArea)
      ? baseProductArea
      : inferProductAreaFallback({ path, title, heading, snippet }) || baseProductArea;
  const baseDeploymentModel = normalizeString(input.deploymentModel ?? metadata.deployment_model);
  const deploymentModel =
    hasSpecificDeploymentModel(baseDeploymentModel)
      ? baseDeploymentModel
      : inferDeploymentModelFallback({ path, title, heading, snippet }) || baseDeploymentModel;
  const explicitDocKind = normalizeString(input.docKind ?? metadata.doc_kind);
  const docKind = inferDocKind({
    explicitDocKind,
    path,
    productArea,
    evidenceKind
  });
  const objectType =
    normalizeString(input.objectType ?? metadata.object_type) || getMetadataList(metadata, "objects")[0] || "";
  const appliesTo = uniqueStrings([
    ...getMetadataList(metadata, "applies_to"),
    hasSpecificDeploymentModel(deploymentModel) ? deploymentModel : "",
    hasSpecificProductArea(productArea) ? productArea : ""
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
    profile.title,
    profile.heading,
    profile.snippet,
    ...profile.permissions,
    ...profile.prerequisites,
    ...profile.actions
  ]
    .filter(Boolean)
    .join(" ");
  return /\b(scope|scopes|permission|permissions|oauth|token|auth|authorization|authentication)\b/.test(semanticText);
}

export function buildSupportEvidencePolicy(caseFrame: SupportCaseFrame): SupportEvidencePolicy | null {
  if (String(caseFrame.question_type ?? "").startsWith("api_")) {
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
      allowedEvidenceKinds: ["api_operation"]
    };
  }

  const questionType = String(caseFrame.question_type ?? "");
  const productArea = normalizeString(caseFrame.product_area);
  const deploymentModel = normalizeString(caseFrame.deployment_model);
  const deploymentScoped = expandProductAreaAliases(productArea).includes("deployment");

  if (deploymentScoped) {
    return {
      strict: true,
      allowedProductAreas: expandProductAreaAliases(productArea),
      allowedEvidenceKinds:
        questionType === "how_to_product" || questionType === "config_setup"
          ? ["procedure", "troubleshooting", "constraint", "capability"]
          : ["capability", "constraint", "procedure", "troubleshooting"],
      allowedDeploymentModels: deploymentModel === "private_deployment" ? ["private_deployment"] : undefined
    };
  }

  if (productArea === "openapi") {
    return {
      strict: true,
      allowedProductAreas: ["openapi"],
      allowedEvidenceKinds:
        questionType === "troubleshooting"
          ? ["api_operation", "troubleshooting", "procedure", "constraint", "capability"]
          : ["api_operation", "capability", "constraint", "procedure"]
    };
  }

  if (productArea === "integrations") {
    return {
      strict: true,
      allowedProductAreas: ["integrations"],
      allowedEvidenceKinds:
        questionType === "troubleshooting"
          ? ["integration_guidance", "troubleshooting", "procedure", "constraint", "capability"]
          : ["integration_guidance", "procedure", "capability", "constraint", "troubleshooting"]
    };
  }

  if (questionType === "how_to_product" || questionType === "config_setup" || questionType === "data_export_reporting") {
    return {
      strict: hasSpecificProductArea(productArea),
      allowedProductAreas: hasSpecificProductArea(productArea) ? expandProductAreaAliases(productArea) : [],
      allowedEvidenceKinds: ["procedure", "capability", "constraint", "troubleshooting"]
    };
  }

  if (questionType === "why_behavior" || questionType === "capability_confirmation" || questionType === "troubleshooting") {
    return {
      strict: hasSpecificProductArea(productArea),
      allowedProductAreas: hasSpecificProductArea(productArea) ? expandProductAreaAliases(productArea) : [],
      allowedEvidenceKinds: ["capability", "constraint", "procedure", "troubleshooting"]
    };
  }

  return null;
}

export function matchesSupportEvidencePolicy(input: SupportEvidenceLike, caseFrame: SupportCaseFrame): boolean {
  const policy = buildSupportEvidencePolicy(caseFrame);
  if (!policy) return true;

  const profile = getSupportEvidenceProfile(input);
  const allowedProductAreas = new Set(policy.allowedProductAreas.flatMap((item) => expandProductAreaAliases(item)));
  const candidateProductAreas = expandProductAreaAliases(profile.productArea);
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
