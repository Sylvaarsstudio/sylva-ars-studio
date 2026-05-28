const inquiryRoutes = {
  contact: "contact.html",
  "artwork-inquiry": "artwork-inquiry.html",
  "commission-request": "commission-request.html",
  collaboration: "collaboration.html"
};

const requestEndpoint = "/.netlify/functions/create-request";

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

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
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

function setFormLoading(form, isLoading) {
  const button = form.querySelector('button[type="submit"]');

  if (!button) {
    return;
  }

  if (!button.dataset.defaultText) {
    button.dataset.defaultText = button.textContent;
  }

  button.disabled = isLoading;
  button.textContent = isLoading ? "Sending..." : button.dataset.defaultText;
}

function buildStructuredRequest(form) {
  const formData = new FormData(form);
  const request = {};

  formData.forEach((value, key) => {
    if (key === "bot-field" || key === "form-name") {
      return;
    }

    request[toCamelCase(key)] = String(value).trim();
  });

  request.formType = getFieldValue(formData, "form-type", "form-name");
  request.clientName = getFieldValue(formData, "client-name", "name");
  request.clientEmail = getFieldValue(formData, "email", "client-email");
  request.clientPhone = getFieldValue(formData, "phone", "client-phone");

  return request;
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
  const forms = document.querySelectorAll('form[data-netlify="true"]');

  forms.forEach((form) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();

      if (!form.reportValidity()) {
        return;
      }

      setFormLoading(form, true);
      setFormStatus(form, "Sending your request...");

      try {
        const requestData = buildStructuredRequest(form);
        const result = await submitToRequestFunction(requestData);
        const requestId = result.requestId;

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
        initArtworkPrefill();
      } catch (error) {
        setFormStatus(
          form,
          error.message || "Something went wrong. Please try again.",
          "error"
        );
      } finally {
        setFormLoading(form, false);
      }
    });
  });
}

async function initArtworkPrefill() {
  const artworkInput = document.querySelector('input[name="artwork-title"]');

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
