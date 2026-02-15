/// <reference types="vite/client" />

import { SncodeApi } from "../shared/types";

declare global {
  interface Window {
    sncode: SncodeApi;
  }
}

export {};
