(function initializeAdminSecurity(globalObject) {
  "use strict";

  const API_PATH = "/admin/api/sessions";

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function formatDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Unavailable";
    return new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short"
    }).format(date);
  }

  function renderSessionsMarkup(sessions) {
    if (!sessions.length) {
      return '<p class="inquiry-empty">No active sessions found.</p>';
    }
    return sessions.map((session) => `
      <article class="admin-session-card${session.current_session ? " is-current" : ""}">
        <div class="admin-session-heading">
          <h2>${escapeHtml(session.user_agent_summary)}</h2>
          ${session.current_session ? '<span class="admin-session-current">Current session</span>' : ""}
        </div>
        <dl class="admin-session-details">
          <div><dt>Created</dt><dd>${escapeHtml(formatDate(session.created_at))}</dd></div>
          <div><dt>Last activity</dt><dd>${escapeHtml(formatDate(session.last_seen_at))}</dd></div>
          <div><dt>Expires</dt><dd>${escapeHtml(formatDate(session.expires_at))}</dd></div>
        </dl>
        ${session.current_session
          ? '<p class="admin-session-help">Use normal Log out to end this session.</p>'
          : `<button type="button" class="admin-text-button" data-revoke-session="${escapeHtml(session.id)}">Revoke</button>`}
      </article>
    `).join("");
  }

  async function parseResponse(response) {
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body.message || "The session request could not be completed.");
      error.status = response.status;
      throw error;
    }
    return body;
  }

  function createApp(
    documentObject,
    fetchImplementation,
    confirmImplementation = () => true
  ) {
    const elements = {
      list: documentObject.querySelector("#session-list"),
      status: documentObject.querySelector("#session-status"),
      signOutOthers: documentObject.querySelector("#sign-out-other-sessions")
    };

    function showStatus(message, isError = false) {
      elements.status.textContent = message;
      elements.status.classList?.toggle?.("is-error", isError);
    }

    async function request(url, options = {}) {
      return parseResponse(await fetchImplementation(url, {
        ...options,
        credentials: "same-origin",
        headers: { Accept: "application/json", ...(options.headers || {}) }
      }));
    }

    async function loadSessions() {
      showStatus("Loading active sessions…");
      try {
        const body = await request(API_PATH);
        elements.list.innerHTML = renderSessionsMarkup(body.sessions);
        elements.signOutOthers.hidden = !body.sessions.some((session) => !session.current_session);
        showStatus("");
        return body.sessions;
      } catch (error) {
        showStatus(error.message, true);
        return [];
      }
    }

    async function revokeSession(sessionId) {
      if (!confirmImplementation("Revoke this Admin session?")) return false;
      showStatus("Revoking session…");
      try {
        await request(`${API_PATH}/${encodeURIComponent(sessionId)}/revoke`, {
          method: "POST"
        });
        await loadSessions();
        showStatus("Session revoked.");
        return true;
      } catch (error) {
        showStatus(error.message, true);
        return false;
      }
    }

    async function signOutOtherSessions() {
      if (!confirmImplementation("Sign out all other Admin sessions?")) return false;
      showStatus("Signing out other sessions…");
      try {
        const body = await request(`${API_PATH}/sign-out-others`, { method: "POST" });
        await loadSessions();
        showStatus(`${body.revoked_count} other session${body.revoked_count === 1 ? "" : "s"} signed out.`);
        return true;
      } catch (error) {
        showStatus(error.message, true);
        return false;
      }
    }

    elements.list.addEventListener("click", (event) => {
      const button = event.target.closest?.("[data-revoke-session]");
      if (button) revokeSession(button.dataset.revokeSession);
    });
    elements.signOutOthers.addEventListener("click", signOutOtherSessions);

    return { loadSessions, revokeSession, signOutOtherSessions };
  }

  const api = { API_PATH, createApp, escapeHtml, formatDate, renderSessionsMarkup };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalObject.SylvaAdminSecurity = api;

  if (globalObject.document && globalObject.fetch) {
    const app = createApp(
      globalObject.document,
      globalObject.fetch.bind(globalObject),
      globalObject.confirm?.bind(globalObject) || (() => true)
    );
    app.loadSessions();
  }
})(typeof window !== "undefined" ? window : globalThis);
