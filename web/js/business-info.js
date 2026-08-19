(function attachBusinessInformation(global) {
  const businessInformation = Object.freeze({
    name: "Sylva Ars Studio LLC",
    addressLine1: "204 St Charles Way, Unit E #362",
    addressLine2: "York, PA 17402",
    phone: "+1 (717) 220-5592",
    phoneHref: "+17172205592",
    email: "contact@sylvaarsstudio.com",
    website: "sylvaarsstudio.com",
    websiteHref: "https://sylvaarsstudio.com"
  });

  function applyBusinessInformation(root = document) {
    root.querySelectorAll("[data-business-field]").forEach((element) => {
      const field = element.dataset.businessField;
      const value = businessInformation[field];

      if (value) {
        element.textContent = value;
      }

      if (field === "email") {
        element.href = `mailto:${businessInformation.email}`;
      } else if (field === "phone") {
        element.href = `tel:${businessInformation.phoneHref}`;
      } else if (field === "website") {
        element.href = businessInformation.websiteHref;
      }
    });
  }

  global.SylvaArsBusiness = Object.freeze({
    information: businessInformation,
    apply: applyBusinessInformation
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => applyBusinessInformation());
  } else {
    applyBusinessInformation();
  }
})(globalThis);
