const inquiryRoutes = {
  contact: "contact.html",
  "artwork-inquiry": "artwork-inquiry.html",
  "commission-request": "commission-request.html",
  collaboration: "collaboration.html"
};

const requestEndpoint = "/api/inquiries";
let turnstileScriptPromise;

function initInquiryRouter() {
  const router = document.querySelector("#inquiry-router");

  if (!router) {
    return;
  }

  router.addEventListener("change", () => {
    const route = inquiryRoutes[router.value];

    if (route && route !== window.location.pathname.split("/").pop()) {
      window.location.href = route;
    }
  });
}

function titleFromSlug(slug) {
  return slug
    .split("-")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

async function getArtworkTitleFromSlug(slug) {
  try {
    const response = await fetch("data/artworks.json");

    if (!response.ok) {
      return titleFromSlug(slug);
    }

    const artworks = await response.json();
    const artwork = artworks.find((item) => item.slug === slug);

    return artwork?.title || titleFromSlug(slug);
  } catch {
    return titleFromSlug(slug);
  }
}

function getFieldValue(formData, ...names) {
  for (const name of names) {
    const value = formData.get(name);

    if (value) {
      return String(value).trim();
    }
  }

  return "";
}

function createStatusElement(form) {
  const existingStatus = form.querySelector(".form-status");

  if (existingStatus) {
    return existingStatus;
  }

  const status = document.createElement("p");
  status.className = "form-status";
  status.setAttribute("aria-live", "polite");
  form.append(status);

  return status;
}

function setFormStatus(form, message, type = "") {
  const status = createStatusElement(form);
  status.textContent = message;
  status.className = `form-status ${type}`.trim();
}

function setFormLoading(form, isLoading, verificationState = null) {
  const button = form.querySelector('button[type="submit"]');

  if (!button) {
    return;
  }

  if (!button.dataset.defaultText) {
    button.dataset.defaultText = button.textContent;
  }

  button.disabled = isLoading || (verificationState !== null && !verificationState.token);
  button.textContent = isLoading ? "Sending..." : button.dataset.defaultText;
}

function buildStructuredRequest(form, requestId = null, turnstileToken = "") {
  const formData = new FormData(form);
  const request = {};

  formData.forEach((value, key) => {
    if (
      key === "bot-field"
      || key === "form-name"
      || key === "cf-turnstile-response"
      || key === "turnstile_token"
    ) {
      return;
    }

    request[key] = String(value).trim();
  });

  request.form_type = getFieldValue(
    formData,
    "form_type",
    "form-type",
    "form-name"
  );
  request.client_name = getFieldValue(
    formData,
    "client_name",
    "client-name",
    "name"
  );
  request.client_email = getFieldValue(
    formData,
    "client_email",
    "client-email",
    "email"
  );
  request.client_phone = getFieldValue(
    formData,
    "client_phone",
    "client-phone",
    "phone"
  );
  if (requestId) {
    request.request_id = requestId;
  }
  request.turnstile_token = turnstileToken;

  return request;
}

async function fetchVerificationConfiguration() {
  const response = await fetch(requestEndpoint, {
    method: "GET",
    headers: { Accept: "application/json" }
  });
  const result = await response.json();

  if (
    !response.ok
    || !result.success
    || result.provider !== "turnstile"
    || !result.site_key
    || !result.action
  ) {
    throw new Error(result.message || "Inquiry verification is unavailable.");
  }

  return result;
}

function loadTurnstileScript() {
  if (window.turnstile?.render) {
    return Promise.resolve(window.turnstile);
  }

  if (!turnstileScriptPromise) {
    turnstileScriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      script.defer = true;
      script.onload = () => resolve(window.turnstile);
      script.onerror = () => reject(new Error("Inquiry verification failed to load."));
      document.head.append(script);
    });
  }

  return turnstileScriptPromise;
}

async function initializeInquiryVerification(form, state) {
  setFormLoading(form, false, state);

  try {
    const configuration = await fetchVerificationConfiguration();
    const turnstile = await loadTurnstileScript();
    if (!turnstile?.render) {
      throw new Error("Inquiry verification failed to load.");
    }

    const container = document.createElement("div");
    container.className = "inquiry-verification";
    container.setAttribute("aria-label", "Inquiry verification");
    form.append(container);

    state.widgetId = turnstile.render(container, {
      sitekey: configuration.site_key,
      action: configuration.action,
      callback(token) {
        state.token = token;
        setFormStatus(form, "");
        setFormLoading(form, false, state);
      },
      "expired-callback"() {
        state.token = null;
        setFormStatus(form, "Verification expired. Please complete it again.", "error");
        setFormLoading(form, false, state);
      },
      "error-callback"() {
        state.token = null;
        setFormStatus(form, "Inquiry verification failed. Please try again.", "error");
        setFormLoading(form, false, state);
      }
    });
  } catch (error) {
    state.token = null;
    setFormStatus(
      form,
      error.message || "Inquiry verification is unavailable.",
      "error"
    );
    setFormLoading(form, false, state);
  }
}

function resetInquiryVerification(form, state) {
  state.token = null;
  if (state.widgetId !== null) {
    window.turnstile?.reset?.(state.widgetId);
  }
  setFormLoading(form, false, state);
}

function createRequestId() {
  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (character) => {
    const random = Math.floor(Math.random() * 16);
    const value = character === "x" ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

async function submitToNetlifyForms(form) {
  const formData = new FormData(form);

  await fetch(window.location.pathname, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams(formData).toString()
  });
}

async function submitToRequestFunction(requestData) {
  const response = await fetch(requestEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(requestData)
  });

  const result = await response.json();

  if (!response.ok || !result.success) {
    throw new Error(result.message || "Unable to process request.");
  }

  return result;
}

function initNetlifyRequestBridge() {
  const forms = document.querySelectorAll("form.contact-form");
  const pendingRequestIds = new WeakMap();

  forms.forEach((form) => {
    if (!form.querySelector('input[name="form_type"]')) {
      return;
    }

    const verificationState = { token: null, widgetId: null };
    initializeInquiryVerification(form, verificationState);

    form.addEventListener("submit", async (event) => {
      event.preventDefault();

      if (!form.reportValidity()) {
        return;
      }

      if (!verificationState.token) {
        setFormStatus(
          form,
          "Complete the inquiry verification before submitting.",
          "error"
        );
        return;
      }

      setFormLoading(form, true, verificationState);
      setFormStatus(form, "Sending your request...");

      try {
        const stableRequestId = pendingRequestIds.get(form) || createRequestId();
        pendingRequestIds.set(form, stableRequestId);
        const requestData = buildStructuredRequest(
          form,
          stableRequestId,
          verificationState.token
        );
        const result = await submitToRequestFunction(requestData);
        const requestId = result.request_id || result.requestId;

        if (!requestId) {
          throw new Error("Request received, but no reference ID was returned.");
        }

        setFormStatus(
          form,
          `Request received. Reference ID: ${requestId}`,
          "success"
        );

        try {
          await submitToNetlifyForms(form);
        } catch (netlifyFormsError) {
          console.warn("Netlify Forms submission failed.", netlifyFormsError);
        }

        form.reset();
        pendingRequestIds.delete(form);
        initArtworkPrefill();
      } catch (error) {
        setFormStatus(
          form,
          error.message || "Something went wrong. Please try again.",
          "error"
        );
      } finally {
        resetInquiryVerification(form, verificationState);
      }
    });
  });
}

async function initArtworkPrefill() {
  const artworkInput = document.querySelector('input[name="artwork_title"]');

  if (!artworkInput) {
    return;
  }

  const params = new URLSearchParams(window.location.search);
  const artworkParam = params.get("artwork");

  if (!artworkParam) {
    return;
  }

  artworkInput.value = await getArtworkTitleFromSlug(artworkParam);
}

initInquiryRouter();
initArtworkPrefill();
initNetlifyRequestBridge();
