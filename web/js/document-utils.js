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

window.formatDocumentDate = formatDocumentDate;
window.applyDocumentDate = applyDocumentDate;

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => applyDocumentDate());
} else {
  applyDocumentDate();
}
