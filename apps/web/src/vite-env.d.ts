/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ELECTION_ID: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
