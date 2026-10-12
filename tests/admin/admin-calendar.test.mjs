import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const {
  createCalendarApp,
  filterEntries,
  getMonthRange,
  renderAgenda,
  renderMonth
} = require("../../web/js/admin-calendar.js");

function element(value = "") {
  const listeners = new Map();
  const classes = new Set();
  return {
    value,
    textContent: "",
    innerHTML: "",
    hidden: false,
    listeners,
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); }
    },
    addEventListener(type, listener) { listeners.set(type, listener); }
  };
}

function documentFixture() {
  const elements = {
    "#calendar-title": element(),
    "#calendar-status": element(),
    "#calendar-month": element(),
    "#calendar-agenda": element(),
    "#calendar-previous": element(),
    "#calendar-today": element(),
    "#calendar-next": element(),
    "#calendar-month-view": element(),
    "#calendar-agenda-view": element(),
    "#calendar-domain-filter": element("all")
  };
  return {
    elements,
    querySelector(selector) { return elements[selector]; }
  };
}

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    async json() { return body; }
  };
}

const entries = [
  {
    id: "quotation_expires:quotation:1",
    commission_id: "10",
    type: "quotation_expires",
    domain: "quotation",
    title: "Quotation expires",
    starts_at: "2026-10-15T14:00:00.000Z",
    all_day: false,
    status: "upcoming",
    metadata: { commission_number: "SAS-COM-2026-0001", commission_title: "Still Here" }
  },
  {
    id: "obligation_due:obligation:2",
    commission_id: "11",
    type: "obligation_due",
    domain: "financial",
    title: "Financial obligation due",
    starts_at: "2026-10-08T14:00:00.000Z",
    all_day: false,
    status: "overdue",
    metadata: { commission_number: "SAS-COM-2026-0002", commission_title: "Quiet Field" }
  }
];

test("Month view renders a six-week grid with safe Commission links", () => {
  const html = renderMonth(entries, new Date(Date.UTC(2026, 9, 1)));
  assert.equal((html.match(/class="calendar-day(?: |")/g) || []).length, 42);
  assert.match(html, /Quotation expires/);
  assert.match(html, /commissions\.html\?commission_id=10/);
  assert.doesNotMatch(html, /client_email|address|phone/);
});

test("Agenda view renders chronological status and has an empty state", () => {
  const html = renderAgenda(entries);
  assert.ok(html.indexOf("Financial obligation due") < html.indexOf("Quotation expires"));
  assert.match(html, /overdue/);
  assert.match(renderAgenda([]), /No calendar entries/);
});

test("domain filters expose only the selected Calendar domain", () => {
  assert.equal(filterEntries(entries, "all").length, 2);
  assert.deepEqual(filterEntries(entries, "quotation").map((entry) => entry.type), ["quotation_expires"]);
  assert.deepEqual(filterEntries(entries, "delivery"), []);
});

test("Calendar app loads the month range and switches to Agenda", async () => {
  const documentObject = documentFixture();
  const calls = [];
  const app = createCalendarApp(documentObject, async (url) => {
    calls.push(url);
    return response({ success: true, entries });
  }, () => new Date("2026-10-11T16:00:00Z"));
  app.bind();
  await app.load();
  assert.equal(calls[0], "/admin/api/calendar?from=2026-09-27&to=2026-11-07");
  assert.equal(documentObject.elements["#calendar-title"].textContent, "October 2026");
  assert.match(documentObject.elements["#calendar-month"].innerHTML, /Still Here/);
  documentObject.elements["#calendar-agenda-view"].listeners.get("click")();
  assert.equal(documentObject.elements["#calendar-month"].hidden, true);
  assert.equal(documentObject.elements["#calendar-agenda"].hidden, false);
});

test("Calendar app applies domain filters and reports API errors", async () => {
  const documentObject = documentFixture();
  const app = createCalendarApp(documentObject, async () => response({ message: "Calendar unavailable." }, 500));
  app.bind();
  assert.deepEqual(await app.load(), []);
  assert.equal(documentObject.elements["#calendar-status"].textContent, "Calendar unavailable.");
  assert.equal(documentObject.elements["#calendar-status"].classList.contains("is-error"), true);
});

test("Calendar page provides Month, Agenda, filters, glossary help, and protected Admin navigation", () => {
  const html = readFileSync(new URL("../../web/admin/calendar.html", import.meta.url), "utf8");
  const dashboard = readFileSync(new URL("../../web/admin/dashboard.html", import.meta.url), "utf8");
  assert.match(html, /id="calendar-month"/);
  assert.match(html, /id="calendar-agenda"/);
  assert.match(html, /id="calendar-domain-filter"/);
  assert.match(html, /data-glossary-key="calendar"/);
  assert.match(html, /admin-calendar\.js/);
  assert.match(dashboard, /href="calendar\.html"/);
  assert.deepEqual(getMonthRange(new Date(Date.UTC(2026, 9, 1))).to, "2026-11-07");
});
