import { defineConfig, devices } from "@playwright/test";

// Test-Profile: Desktop + Mobile. Worker seriell, weil alle Tests dieselbe
// single-row SQLite-Notiz (id=1) teilen -- parallele Edits würden sich überlagern.
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 15_000,
  expect: { timeout: 4_000 },
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: "http://127.0.0.1:3737",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    ignoreHTTPSErrors: true,
  },
  webServer: {
    command: "node server.js",
    url: "http://127.0.0.1:3737",
    reuseExistingServer: !process.env.CI,
    timeout: 10_000,
    env: {
      PORT: "3737",
      DB_PATH: "data/test-notiz.db",
      UPLOADS_DIR: "data/test-uploads",
    },
  },
  projects: [
    {
      name: "desktop-chrome",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
    },
    {
      name: "mobile-iphone14",
      // Webkit würde gstreamer/gtk-4 als Systemdeps brauchen -- nicht installiert.
      // Chromium emuliert denselben iPhone-14-Viewport + Touch + mobile UA und
      // liefert für Layout/Tap-Target-Prüfungen die gleichen Render-Ergebnisse.
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
});