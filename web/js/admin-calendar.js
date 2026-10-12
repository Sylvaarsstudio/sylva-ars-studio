(function initializeAdminCalendar(globalObject) {
  const API_PATH = "/admin/api/calendar";
  const timeZone = "America/New_York";
  const domainValues = new Set(["all", "quotation", "production", "financial", "delivery"]);

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function dateKey(value) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit"
    }).formatToParts(new Date(value));
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  }

  function toDateKey(date) {
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
  }

  function getMonthRange(month) {
    const first = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1));
    const start = new Date(first);
    start.setUTCDate(start.getUTCDate() - start.getUTCDay());
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 41);
    return { from: toDateKey(start), to: toDateKey(end), start, end };
  }

  function formatEntryDate(entry) {
    return new Intl.DateTimeFormat("en-US", entry.all_day ? {
      timeZone, dateStyle: "medium"
    } : {
      timeZone, dateStyle: "medium", timeStyle: "short"
    }).format(new Date(entry.starts_at));
  }

  function commissionHref(entry) {
    return `commissions.html?commission_id=${encodeURIComponent(entry.commission_id)}`;
  }

  function renderEntry(entry) {
    return `<a class="calendar-entry" data-domain="${escapeHtml(entry.domain)}" href="${commissionHref(entry)}">
      ${escapeHtml(entry.title)}
      <span class="calendar-entry-meta">${escapeHtml(entry.metadata.commission_number)} · ${escapeHtml(entry.metadata.commission_title)}</span>
    </a>`;
  }

  function filterEntries(entries, domain = "all") {
    return domain === "all" ? [...entries] : entries.filter((entry) => entry.domain === domain);
  }

  function renderMonth(entries, month) {
    const range = getMonthRange(month);
    const grouped = new Map();
    entries.forEach((entry) => {
      const key = dateKey(entry.starts_at);
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(entry);
    });
    const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
      .map((day) => `<div class="calendar-weekday">${day}</div>`).join("");
    const days = [];
    for (let index = 0; index < 42; index += 1) {
      const day = new Date(range.start);
      day.setUTCDate(day.getUTCDate() + index);
      const key = toDateKey(day);
      const outside = day.getUTCMonth() !== month.getUTCMonth();
      days.push(`<div class="calendar-day${outside ? " is-outside-month" : ""}" data-date="${key}">
        <span class="calendar-day-number">${day.getUTCDate()}</span>
        ${(grouped.get(key) || []).map(renderEntry).join("")}
      </div>`);
    }
    return `<div class="calendar-grid">${weekdays}${days.join("")}</div>`;
  }

  function renderAgenda(entries) {
    if (!entries.length) return '<p class="calendar-empty">No calendar entries in this period.</p>';
    const ordered = [...entries].sort((left, right) =>
      String(left.starts_at).localeCompare(String(right.starts_at))
    );
    return `<ol class="calendar-agenda-list">${ordered.map((entry) => `
      <li class="calendar-agenda-item" data-domain="${escapeHtml(entry.domain)}">
        <p>${escapeHtml(formatEntryDate(entry))}</p>
        <p><strong>${escapeHtml(entry.title)}</strong><br>${escapeHtml(entry.metadata.commission_number)} · ${escapeHtml(entry.metadata.commission_title)}</p>
        <p><span class="calendar-entry-status">${escapeHtml(entry.status)}</span><br><a class="admin-text-link" href="${commissionHref(entry)}">View Commission</a></p>
      </li>`).join("")}</ol>`;
  }

  async function fetchJson(fetchImplementation, url) {
    const response = await fetchImplementation(url, { headers: { Accept: "application/json" } });
    let body = null;
    try { body = await response.json(); } catch { body = null; }
    if (!response.ok) throw new Error(body?.message || "Unable to load the calendar.");
    return body;
  }

  function createCalendarApp(documentObject, fetchImplementation, now = () => new Date()) {
    const elements = {
      title: documentObject.querySelector("#calendar-title"),
      status: documentObject.querySelector("#calendar-status"),
      month: documentObject.querySelector("#calendar-month"),
      agenda: documentObject.querySelector("#calendar-agenda"),
      previous: documentObject.querySelector("#calendar-previous"),
      today: documentObject.querySelector("#calendar-today"),
      next: documentObject.querySelector("#calendar-next"),
      monthView: documentObject.querySelector("#calendar-month-view"),
      agendaView: documentObject.querySelector("#calendar-agenda-view"),
      domain: documentObject.querySelector("#calendar-domain-filter")
    };
    const initial = now();
    const [initialYear, initialMonth] = dateKey(initial).split("-").map(Number);
    let currentMonth = new Date(Date.UTC(initialYear, initialMonth - 1, 1));
    let entries = [];
    let view = "month";

    function render() {
      const domain = domainValues.has(elements.domain.value) ? elements.domain.value : "all";
      const visible = filterEntries(entries, domain);
      elements.title.textContent = new Intl.DateTimeFormat("en-US", {
        timeZone: "UTC", month: "long", year: "numeric"
      }).format(currentMonth);
      elements.month.innerHTML = renderMonth(visible, currentMonth);
      elements.agenda.innerHTML = renderAgenda(visible);
      elements.month.hidden = view !== "month";
      elements.agenda.hidden = view !== "agenda";
      return visible;
    }

    async function load() {
      const range = getMonthRange(currentMonth);
      elements.status.textContent = "Loading calendar…";
      elements.status.classList?.remove("is-error");
      try {
        const body = await fetchJson(
          fetchImplementation,
          `${API_PATH}?from=${range.from}&to=${range.to}`
        );
        entries = body.entries || [];
        render();
        elements.status.textContent = entries.length ? "" : "No calendar entries in this period.";
        return entries;
      } catch (error) {
        entries = [];
        render();
        elements.status.textContent = error.message;
        elements.status.classList?.add("is-error");
        return [];
      }
    }

    function changeMonth(offset) {
      currentMonth = new Date(Date.UTC(
        currentMonth.getUTCFullYear(), currentMonth.getUTCMonth() + offset, 1
      ));
      return load();
    }

    function showView(nextView) {
      view = nextView === "agenda" ? "agenda" : "month";
      render();
      return view;
    }

    function bind() {
      elements.previous.addEventListener("click", () => changeMonth(-1));
      elements.next.addEventListener("click", () => changeMonth(1));
      elements.today.addEventListener("click", () => {
        const current = now();
        const [year, month] = dateKey(current).split("-").map(Number);
        currentMonth = new Date(Date.UTC(year, month - 1, 1));
        load();
      });
      elements.monthView.addEventListener("click", () => showView("month"));
      elements.agendaView.addEventListener("click", () => showView("agenda"));
      elements.domain.addEventListener("change", render);
    }

    return { bind, changeMonth, load, render, showView };
  }

  const api = {
    API_PATH,
    createCalendarApp,
    dateKey,
    filterEntries,
    getMonthRange,
    renderAgenda,
    renderMonth
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalObject.AdminCalendar = api;
  if (globalObject.document) {
    const app = createCalendarApp(globalObject.document, globalObject.fetch.bind(globalObject));
    app.bind();
    app.load();
  }
})(typeof window !== "undefined" ? window : globalThis);
