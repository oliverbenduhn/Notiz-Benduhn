import { test, expect } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

// E2E-Suite: 5 User-Flows + 2 UX-Audits.
// Hinweise für Agenten, die hier Tests ergänzen:
//  - workers=1 in playwright.config.js -- alle Specs teilen die Singleton-Notiz (id=1).
//  - beforeEach setzt die Notiz auf {type:"doc",content:[]} zurück, sonst kollidieren Specs.
//  - Confirm-Dialoge sind native <dialog>; page.on('dialog') greift NICHT -- stattdessen
//    auf .confirm-dialog button[data-action="ok"] klicken.
//  - Tiptap lädt von esm.sh; erste Spec kann 2-3 s länger brauchen (Module-Cache).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_IMAGE = path.join(__dirname, "fixtures", "pixel.png");

// Setzt die geteilte Notiz auf leer zurück, damit Tests sich nicht überlagern.
async function resetNote(request) {
  await request.put("/api/note", { data: { content: { type: "doc", content: [] } } });
}

test.beforeEach(async ({ request }) => {
  await resetNote(request);
});

// Tiptap-Toolbar wirft DOM-Änderungen erst nach kurzer Verzögerung.
async function waitForEditor(page) {
  await page.goto("/");
  await page.locator("#editor .ProseMirror").waitFor({ state: "visible" });
  await page.locator(".tiptap").waitFor({ state: "visible" });
}

test.describe("Flow 1: Schreiben + Auto-Save + Persistenz", () => {
  test("Notiz wird sichtbar gespeichert und überlebt Reload", async ({ page }) => {
    await waitForEditor(page);

    await page.locator("#editor .ProseMirror").click();
    await page.keyboard.type("Einkaufsliste");
    // Save-Indikator MUSS sichtbar "Gespeichert." anzeigen.
    await expect(page.locator("#save-status.saved")).toHaveText("Gespeichert.", { timeout: 5_000 });

    await page.reload();
    await page.locator("#editor .ProseMirror").waitFor({ state: "visible" });

    await expect(page.locator("#editor .ProseMirror")).toContainText("Einkaufsliste");
  });
});

test.describe("Flow 2: Formatierung via Toolbar", () => {
  test("H1 + Bold über Toolbar anwendbar, State reflektiert", async ({ page }) => {
    await waitForEditor(page);

    await page.locator("#editor .ProseMirror").click();
    await page.keyboard.type("Titel");
    // Caret ans Ende, Zeile als H1 markieren.
    await page.locator('button[data-action="h1"]').click();
    await expect(page.locator("#editor h1")).toContainText("Titel");
    await expect(page.locator('button[data-action="h1"]')).toHaveClass(/active/);

    // Neue Zeile, Wort markieren, Bold.
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("wichtig");
    await page.keyboard.down("Shift");
    for (let i = 0; i < "wichtig".length; i++) await page.keyboard.press("ArrowLeft");
    await page.keyboard.up("Shift");
    await page.locator('button[data-action="bold"]').click();
    await expect(page.locator("#editor strong")).toContainText("wichtig");
  });
});

test.describe("Flow 3: Slash-Befehlsmenü", () => {
  test("/ öffnet Menü, Filter + Enter erzeugt H1", async ({ page }) => {
    await waitForEditor(page);

    await page.locator("#editor .ProseMirror").click();
    await page.keyboard.type("/");
    await expect(page.locator(".slash-menu")).toBeVisible();

    await page.keyboard.type("h1");
    await expect(page.locator(".slash-item")).toHaveCount(1);

    await page.keyboard.press("Enter");
    await expect(page.locator(".slash-menu")).toBeHidden();
    // Caret sitzt jetzt in einer H1-Zeile (ggf. leer -- auf Existenz prüfen).
    await expect(page.locator("#editor h1")).toHaveCount(1);
  });
});

test.describe("Flow 4: Bild hochladen + Vollbild-Overlay", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("Bild per Toolbar erscheint im Editor und öffnet Overlay beim Klick", async ({ page }) => {
    await waitForEditor(page);

    await page.locator('button[data-action="image"]').click();
    await page.locator("#image-input").setInputFiles(FIXTURE_IMAGE);

    await expect(page.locator("#editor img")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#save-status.saved")).toHaveText("Gespeichert.", { timeout: 5_000 });

    await page.locator("#editor img").click();
    await expect(page.locator(".image-overlay")).toBeVisible();
    await page.locator(".image-overlay").click({ position: { x: 5, y: 5 } });
    await expect(page.locator(".image-overlay")).toBeHidden();
  });
});

test.describe("UX-Audit: Touch-Targets, Layout-Stabilität", () => {
  test("Toolbar-Buttons haben auf Mobile ausreichend Höhe (>= 32px)", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile-iphone14", "Touch-Targets nur mobil relevant");
    await waitForEditor(page);
    const heights = await page.locator("#toolbar button").evaluateAll(els =>
      els.map(el => ({ label: el.dataset.action || el.id, h: el.getBoundingClientRect().height }))
    );
    const violations = heights.filter(b => b.h < 32);
    expect(violations, JSON.stringify(violations)).toEqual([]);
  });

  test("Kein großer Layout-Shift nach erstem Tippen", async ({ page }) => {
    await waitForEditor(page);
    const before = await page.locator("#editor-wrapper").boundingBox();
    await page.locator("#editor .ProseMirror").click();
    await page.keyboard.type("Eine Zeile Text");
    await page.waitForTimeout(1200);
    const after = await page.locator("#editor-wrapper").boundingBox();
    const dy = Math.abs((after?.y ?? 0) - (before?.y ?? 0));
    expect(dy, `Layout verschiebt sich um ${dy}px`).toBeLessThan(20);
  });
});

test.describe("Flow 5: Bild löschen + Notiz leeren", () => {
  test("confirm-Dialoge akzeptiert, Inhalte verschwinden, Save erscheint", async ({ page }) => {
    await waitForEditor(page);

    // Setup: Bild rein, Text dazu.
    await page.locator('button[data-action="image"]').click();
    await page.locator("#image-input").setInputFiles(FIXTURE_IMAGE);
    await expect(page.locator("#editor img")).toBeVisible({ timeout: 10_000 });
    await page.locator("#editor .ProseMirror").click();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("danach");

    // 5a: Bild löschen. Native <dialog> ist nur ein DOM-Element -- OK klicken.
    const deleteBtn = page.locator(".image-delete-btn").first();
    await deleteBtn.click({ force: true });
    await expect(page.locator(".confirm-dialog")).toBeVisible();
    await page.locator('.confirm-dialog button[data-action="ok"]').click();
    await expect(page.locator("#editor img")).toHaveCount(0, { timeout: 5_000 });

    // 5b: Notiz leeren.
    await page.locator("#btn-clear").click();
    await expect(page.locator(".confirm-dialog")).toBeVisible();
    await page.locator('.confirm-dialog button[data-action="ok"]').click();
    await expect(page.locator("#editor .ProseMirror")).toHaveText("", { timeout: 5_000 });
    await expect(page.locator("#save-status.saved")).toHaveText("Gespeichert.", { timeout: 5_000 });
  });
});

test.describe("Flow 6: Service-Worker + Theme-Persistenz", () => {
  test("Service-Worker wird registriert (PWA-Features aktiv)", async ({ page }) => {
    await waitForEditor(page);
    // serviceWorker.register läuft nach DOMContentLoaded; ein Tick reicht.
    await page.waitForFunction(() => 'serviceWorker' in navigator);
    const registered = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      return !!reg;
    });
    expect(registered, "Service-Worker wurde nicht registriert").toBe(true);
  });

  test("Theme-Toggle persistiert in localStorage", async ({ page }) => {
    await waitForEditor(page);
    await page.locator("#btn-theme").click();
    const stored = await page.evaluate(() => localStorage.getItem("copy-theme"));
    expect(["light", "dark"]).toContain(stored);
  });
});