const inquiryRoutes = {
  contact: "contact.html",
  "artwork-inquiry": "artwork-inquiry.html",
  "commission-request": "commission-request.html",
  collaboration: "collaboration.html"
};

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
