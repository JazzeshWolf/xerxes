/// <reference types="vite/client" />

declare const __BUILD_ID__: string;

interface ImportMetaEnv {
  /** Optional on-demand stock-refresh proxy (Cloudflare Worker) URL. */
  readonly VITE_STOCK_REFRESH_URL?: string;
}
