/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_AGENT_ACCESS_CODE?: string;
  readonly VITE_SUPPORT_WORKBENCH_V2?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
