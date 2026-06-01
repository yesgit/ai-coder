import type { AppApi } from "../../shared/types";

declare global {
  interface Window {
    aiCoder: AppApi;
  }
}

export {};
