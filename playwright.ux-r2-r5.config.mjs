import {defineConfig} from "@playwright/test";
import base from "./playwright.config.mjs";
export default defineConfig({
  ...base,
  use:{...base.use,baseURL:"http://127.0.0.1:3193"},
  webServer:{
    ...base.webServer,
    command:"node tests/e2e/support/e2e-server.mjs",
    url:"http://127.0.0.1:3193/health",
    reuseExistingServer:false,
    env:{...process.env,PVS_E2E_PORT:"3193",PVS_E2E_DB_NAME:"uxr2r5-e2e.db",PVS_E2E_PROJECT_DIR:"uxr2r5-e2e-projects"}
  }
});
