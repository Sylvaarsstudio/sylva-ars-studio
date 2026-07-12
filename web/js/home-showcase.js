(function () {
  const showcase = document.querySelector("[data-home-showcase]");
  const dataEl = document.getElementById("home-artworks-data");

  if (!showcase || !dataEl) {
    return;
  }

  let artworks = [];

  try {
    artworks = JSON.parse(dataEl.textContent || "[]");
  } catch (error) {
    return;
  }

  if (artworks.length < 2) {
    return;
  }

  const slots = Array.from(showcase.querySelectorAll("[data-showcase-slot]"));
  const prevControl = showcase.querySelector("[data-showcase-prev]");
  const nextControl = showcase.querySelector("[data-showcase-next]");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const compactMobile = window.matchMedia("(max-width: 520px)");
  const mobile = window.matchMedia("(max-width: 768px)");
  const state = {
    visible: [],
    activeCount: 4,
    slotCursor: 0,
    artCursor: 4,
    paused: false,
    animating: false,
    timer: null
  };

  function wait(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function getActiveCount() {
    if (compactMobile.matches) {
      return 1;
    }

    if (mobile.matches) {
      return 2;
    }

    return 4;
  }

  function getSide(slotIndex) {
    return slotIndex % 2 === 0 ? "left" : "right";
  }

  function getAvailableIndex(step) {
    for (let checked = 0; checked < artworks.length; checked += 1) {
      const nextIndex = (state.artCursor + artworks.length) % artworks.length;
      state.artCursor += step;

      if (!state.visible.includes(nextIndex)) {
        return nextIndex;
      }
    }

    return state.visible[0] || 0;
  }

  function createArtwork(artwork, slotIndex, visible) {
    const side = getSide(slotIndex);
    const link = document.createElement("a");
    const imageShell = document.createElement("span");
    const image = document.createElement("img");
    const titleClip = document.createElement("span");
    const title = document.createElement("span");

    link.className = `home-showcase-artwork from-${side}`;
    link.href = `artworks/${artwork.slug}.html`;
    link.dataset.side = side;

    if (visible) {
      link.classList.add("is-visible");
    }

    imageShell.className = "home-showcase-image-shell";
    image.src = `images/${artwork.image}`;
    image.alt = artwork.altText || artwork.title;
    image.loading = "lazy";

    titleClip.className = "home-showcase-title-clip";
    title.className = "home-showcase-title";
    title.textContent = artwork.title;

    if (visible) {
      title.classList.add("is-visible");
    }

    imageShell.append(image);
    titleClip.append(title);
    link.append(imageShell, titleClip);

    return link;
  }

  function renderSlot(slotIndex, artworkIndex, visible) {
    const slot = slots[slotIndex];

    if (!slot || !artworks[artworkIndex]) {
      return;
    }

    slot.replaceChildren(createArtwork(artworks[artworkIndex], slotIndex, visible));
  }

  function renderInitial() {
    state.activeCount = getActiveCount();
    state.visible = artworks.slice(0, state.activeCount).map((_, index) => index);
    state.artCursor = state.activeCount;
    state.slotCursor = 0;

    slots.forEach((slot, index) => {
      const active = index < state.activeCount;
      slot.hidden = !active;
      slot.setAttribute("aria-hidden", active ? "false" : "true");

      if (active) {
        renderSlot(index, state.visible[index], true);
      } else {
        slot.replaceChildren();
      }
    });
  }

  function shouldPause() {
    return showcase.matches(":hover") || showcase.contains(document.activeElement);
  }

  async function replaceArtwork(step, force) {
    if ((!force && state.paused) || state.animating || artworks.length <= state.activeCount) {
      return;
    }

    state.animating = true;

    const slotIndex = state.slotCursor % state.activeCount;
    const slot = slots[slotIndex];
    const current = slot?.querySelector(".home-showcase-artwork");
    const currentTitle = slot?.querySelector(".home-showcase-title");
    const nextIndex = getAvailableIndex(step);
    const shortMotion = reduceMotion.matches;

    state.slotCursor = (slotIndex + 1) % state.activeCount;

    if (currentTitle) {
      currentTitle.classList.remove("is-visible");
    }

    await wait(shortMotion ? 180 : 520);

    if (current) {
      current.classList.remove("is-visible");
      current.classList.add("is-exiting");
    }

    await wait(shortMotion ? 260 : 700);

    renderSlot(slotIndex, nextIndex, false);
    state.visible[slotIndex] = nextIndex;

    const incoming = slot.querySelector(".home-showcase-artwork");
    const incomingTitle = slot.querySelector(".home-showcase-title");

    await wait(40);
    incoming?.classList.add("is-visible");

    await wait(shortMotion ? 160 : 600);
    incomingTitle?.classList.add("is-visible");

    await wait(shortMotion ? 180 : 300);
    state.animating = false;
    state.paused = shouldPause();
    scheduleNext();
  }

  function clearTimer() {
    if (state.timer) {
      window.clearTimeout(state.timer);
      state.timer = null;
    }
  }

  function scheduleNext() {
    clearTimer();

    if (!state.paused) {
      state.timer = window.setTimeout(() => replaceArtwork(1), 8200);
    }
  }

  function pause() {
    state.paused = true;
    clearTimer();
  }

  function resume() {
    state.paused = false;
    scheduleNext();
  }

  function manualChange(step) {
    clearTimer();
    replaceArtwork(step, true);
  }

  function refreshLayout() {
    const nextCount = getActiveCount();

    if (nextCount !== state.activeCount && !state.animating) {
      renderInitial();
      scheduleNext();
    }
  }

  showcase.addEventListener("mouseenter", pause);
  showcase.addEventListener("mouseleave", resume);
  showcase.addEventListener("focusin", pause);
  showcase.addEventListener("focusout", (event) => {
    if (!showcase.contains(event.relatedTarget)) {
      resume();
    }
  });

  prevControl?.addEventListener("click", () => manualChange(-1));
  nextControl?.addEventListener("click", () => manualChange(1));
  mobile.addEventListener("change", refreshLayout);
  compactMobile.addEventListener("change", refreshLayout);

  renderInitial();
  scheduleNext();
})();
