const defaultArtworkDescription =
  "Original artwork created by Sylva Ars Studio. This piece forms part of the studio’s exploration of memory, migration, emotional transition, and visual storytelling.";

function formatDocumentDate(date = new Date()) {
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric"
  });
}

function applyDocumentDate(root = document) {
  const dateElements = root.querySelectorAll("[data-current-date]");

  dateElements.forEach((element) => {
    element.textContent = formatDocumentDate();
  });
}

function getArtworkDescription(artwork = {}) {
  const description =
    artwork.artworkDescription ||
    artwork.description ||
    artwork.longDescription ||
    artwork.shortDescription ||
    "";

  return description.trim() || defaultArtworkDescription;
}

window.defaultArtworkDescription = defaultArtworkDescription;
window.formatDocumentDate = formatDocumentDate;
window.applyDocumentDate = applyDocumentDate;
window.getArtworkDescription = getArtworkDescription;

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => applyDocumentDate());
} else {
  applyDocumentDate();
}
