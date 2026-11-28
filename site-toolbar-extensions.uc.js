// Site Toolbar Extensions: pinned extension buttons that only show on the sites you pick.
//
// Each extension can have a list of sites. An extension with no sites behaves normally (always
// shown). One with sites shows only while the selected tab is on one of them, subdomains
// included. Sites are set by right-clicking an extension, on the toolbar or in the extensions
// (puzzle) panel. Giving an unpinned extension a site pins it to the toolbar.
//
// Rules live in one JSON pref, keyed by extension ID: { "x-posed@xaitax.com": ["x.com"] }.
//
// Buttons are hidden with an attribute, never removed from the toolbar, so pins and order are
// kept and every window can differ. Toolbar placements in CustomizableUI are shared by all
// windows, so moving widgets around couldn't do per-window anyway.
//
// The show and hide animations are the card rise and sink from Zia's glance thumbnails
// (z1n-k/Zia), with a shorter drop and timing to fit toolbar buttons.
(() => {
  const ID = "site-toolbar-extensions";
  const SCRIPT_URI = `chrome://sine/content/${ID}/${ID}.uc.js`;
  const PREFIX = `sine.${ID}.`;
  const PREF_ENABLED = PREFIX + "enabled"; // bool, default true
  const PREF_ANIMATE = PREFIX + "animate"; // bool, default true
  const PREF_RULES = PREFIX + "rules";     // JSON string
  const PREF_DRAG = PREFIX + "drag";       // bool, default true: hold and drag to reorder
  const PREFS = [PREF_ENABLED, PREF_ANIMATE, PREF_RULES];
  const DEFAULT_RULES = {
    "x-posed@xaitax.com": ["x.com", "twitter.com"],
    "x-like-count-toggle@local.example": ["x.com", "twitter.com"],
  };
  const TAG = "[SiteToolbarExt]";

  const HIDDEN = "ste-hidden";
  const ANIMATING = "ste-animating";

  // Timings (ms). Zia's rise is 1.1s, too long for something that runs on every tab switch.
  const RISE_MS = 550;
  const SINK_MS = 300;
  const WIDTH_MS = 180;
  const SETTLE_MS = 260; // reversing partway through
  const STAGGER_MS = 40;
  const FADE_MS = 150;   // reduced motion
  const DROP = 26;       // px below the resting spot: enough for the icon to clear the button's edge

  // Zia's zia-glance-rise / zia-glance-sink, with the travel scaled by DROP / 34.
  const k = DROP / 34;
  const px = (v) => `${(v * k).toFixed(2)}px`;
  const RISE = [
    { offset: 0, transform: `translateY(${DROP}px) rotate(4deg)` },
    { offset: 0.27, transform: `translateY(${px(-4)})` },
    { offset: 0.46, transform: `translateY(${px(1.5)})` },
    { offset: 0.65, transform: `translateY(${px(-1)})` },
    { offset: 0.83, transform: `translateY(${px(0.4)})` },
    { offset: 1, transform: "none" },
  ];
  const SINK = [
    { offset: 0, transform: "none" },
    { offset: 0.32, transform: `translateY(${px(-3)})` },
    { offset: 1, transform: `translateY(${DROP}px) rotate(4deg)` },
  ];
  const OUT_POSE = `translateY(${DROP}px) rotate(4deg)`;

  // Hold-to-drag reordering.
  const DRAGGING = "ste-dragging";
  const SHIFTING = "ste-shifting";
  const HOLD_MS = 350;     // press this long without moving to pick a button up
  const SLOP_PX = 5;       // moving further than this before then is a normal click/drag
  const LIFT_SCALE = 1.08;
  const SHIFT_MS = 180;    // neighbours sliding aside
  const DROP_MS = 320;     // the dropped button settling, with the same overshoot curve as Zia's spring
  const SPRING = "cubic-bezier(0.3, 1.4, 0.5, 1)";

  const CSS = `
    toolbar [${HIDDEN}] { display: none !important; }
    /* While animating, the button is clipped at the bottom edge of its visible button, so
       the icon passes through it. Zen makes the outer box taller than the toolbar, so its
       own edge would let the icon show over the page; --ste-clip-bottom is the gap, set
       from the script. Room above for the overshoot; none at the sides, where the width
       is shrinking. */
    [${ANIMATING}] {
      clip-path: inset(-12px 0 var(--ste-clip-bottom, 0px) 0) !important;
      min-width: 0 !important;
      box-sizing: border-box !important;
    }
    [${ANIMATING}] > * {
      flex-shrink: 0 !important;
      transform-origin: 50% 50%;
    }
    /* A picked-up button floats above its neighbours. */
    [${DRAGGING}] {
      position: relative;
      z-index: 10;
      filter: drop-shadow(0 3px 6px rgba(0, 0, 0, 0.35));
      cursor: grabbing !important;
    }
    [${DRAGGING}] * { cursor: grabbing !important; }
    [${SHIFTING}] {
      transition: translate ${SHIFT_MS}ms cubic-bezier(0.2, 0, 0, 1);
    }
  `;
  const SHEET = "data:text/css;charset=utf-8," + encodeURIComponent(CSS);

  let started = false;
  let disposed = false;
  let startupObs = null;
  let cleanupWindow = null;
  let cleanupSine = null;

  function removeStartupObs() {
    if (!startupObs) return;
    try { Services.obs.removeObserver(startupObs, "browser-delayed-startup-finished"); } catch {}
    startupObs = null;
  }

  window.addEventListener("unload", () => {
    disposed = true;
    removeStartupObs();
    cleanupWindow?.();
  }, { once: true });

  window.addUnloadListener?.(() => {
    disposed = true;
    removeStartupObs();
    cleanupSine?.();
  }, SCRIPT_URI);

  if (window.gBrowserInit?.delayedStartupFinished) {
    start();
  } else {
    startupObs = (subject) => {
      if (subject !== window) return;
      removeStartupObs();
      start();
    };
    Services.obs.addObserver(startupObs, "browser-delayed-startup-finished");
  }

  function start() {
    if (started || disposed) return;
    started = true;
    // The module's path has moved between Firefox versions; browser windows always have it.
    const CustomizableUI = window.CustomizableUI;

    // ---- Prefs --------------------------------------------------------------------------------

    const enabled = () => Services.prefs.getBoolPref(PREF_ENABLED, true);
    const animateOn = () => Services.prefs.getBoolPref(PREF_ANIMATE, true);

    let rules = {};
    function loadRules() {
      if (Services.prefs.getPrefType(PREF_RULES) !== Services.prefs.PREF_STRING) {
        rules = structuredClone(DEFAULT_RULES);
        return;
      }
      const text = Services.prefs.getStringPref(PREF_RULES, "").trim();
      if (!text) {
        rules = {};
        return;
      }
      try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new TypeError("Expected a JSON object");
        }
        const next = {};
        for (const [extId, sites] of Object.entries(parsed || {})) {
          const list = (Array.isArray(sites) ? sites : [sites]).map(normalizeSite).filter(Boolean);
          if (list.length) next[extId] = [...new Set(list)];
        }
        rules = next;
      } catch (e) {
        console.warn(TAG, "Couldn't read the site rules pref, keeping the last good ones.", e);
      }
    }
    function saveRules() {
      Services.prefs.setStringPref(PREF_RULES, JSON.stringify(rules));
    }

    // "https://www.YouTube.com/x" -> "youtube.com"
    function normalizeSite(s) {
      s = String(s ?? "").trim().toLowerCase();
      if (!s) return "";
      s = s.replace(/^[a-z]+:\/\//, "").replace(/[/:?#].*$/, "").replace(/^\*\./, "");
      return s.replace(/^www\./, "");
    }
    const siteMatches = (host, site) => host === site || host.endsWith("." + site);

    // ---- Current site ---------------------------------------------------------------------------

    function currentHost() {
      const uri = gBrowser.currentURI;
      if (!uri || !/^https?$/.test(uri.scheme)) return null;
      try {
        return normalizeSite(uri.host);
      } catch {
        return null;
      }
    }

    // ---- Widgets --------------------------------------------------------------------------------

    // Same as ExtensionCommon.makeWidgetId.
    const widgetIdFor = (extId) => extId.toLowerCase().replace(/[^a-z0-9_-]/g, "_") + "-browser-action";

    function extIdForWidget(wid) {
      for (const p of WebExtensionPolicy.getActiveExtensions()) {
        if (widgetIdFor(p.id) === wid) return p.id;
      }
      return null;
    }

    function onToolbar(wid) {
      const area = CustomizableUI.getPlacementOfWidget(wid)?.area;
      return !!area && CustomizableUI.getAreaType(area) === CustomizableUI.TYPE_TOOLBAR;
    }

    // The button in this window, if it sits on a toolbar here. Panel copies are left alone.
    function toolbarNode(wid) {
      if (!onToolbar(wid)) return null;
      const node = document.getElementById(wid);
      if (!node || node.closest("panel, panelview, #unified-extensions-area")) return null;
      return node;
    }

    function shouldShow(extId, host) {
      if (!enabled() || customizing()) return true;
      if (unpinning.has(extId)) return false;
      const sites = rules[extId];
      if (!sites?.length) return true;
      return !!host && sites.some((s) => siteMatches(host, s));
    }
    const customizing = () => document.documentElement.hasAttribute("customizing");

    // ---- Animation ------------------------------------------------------------------------------

    // node -> { shown, token, anims }
    const states = new WeakMap();
    // widget IDs this window has touched, so a button whose rules were removed comes back
    const touched = new Set();
    // extension IDs sinking out before they go back to the extensions panel
    const unpinning = new Set();
    const unpinTimers = new Set();

    // Unchecking an extension's last site: sink it out, then move it back to the extensions
    // panel. Its slot has closed by then, so the move doesn't jump. "Show on every site" is
    // the way to keep it pinned with no sites.
    function unpinAfterSink(extId) {
      const wid = widgetIdFor(extId);
      unpinning.add(extId);
      const timer = setTimeout(() => {
        unpinTimers.delete(timer);
        unpinning.delete(extId);
        if (rules[extId] || !onToolbar(wid)) return schedule();
        // The same node moves to the panel, so clear its hidden state first.
        const node = document.getElementById(wid);
        const st = node && states.get(node);
        if (st) {
          setInstant(node, st, true);
          states.delete(node);
        }
        CustomizableUI.addWidgetToArea(wid, CustomizableUI.AREA_ADDONS ?? "unified-extensions-area");
      }, SINK_MS + WIDTH_MS + 120);
      unpinTimers.add(timer);
    }

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

    function stop(st) {
      for (const a of st.anims) {
        try { a.cancel(); } catch {}
      }
      st.anims = [];
    }

    // Size of the button's slot. The flex gap after it comes off as a negative end margin, so the
    // neighbours close up all the way before the button goes to display: none.
    function boxOf(node) {
      const cs = getComputedStyle(node);
      return {
        width: node.getBoundingClientRect().width + "px",
        paddingInlineStart: cs.paddingInlineStart,
        paddingInlineEnd: cs.paddingInlineEnd,
        marginInlineStart: cs.marginInlineStart,
        marginInlineEnd: cs.marginInlineEnd,
      };
    }
    function zeroBox(node) {
      const gap = parseFloat(getComputedStyle(node.parentNode).columnGap) || 0;
      return {
        width: "0px",
        paddingInlineStart: "0px",
        paddingInlineEnd: "0px",
        marginInlineStart: "0px",
        marginInlineEnd: `${-gap}px`,
      };
    }

    // Gap between the outer box's bottom and the visible button's bottom. Computed heights
    // ignore transforms, so this is right even partway through an animation.
    function setClip(node) {
      const outer = parseFloat(getComputedStyle(node).height) || 0;
      const inner = Math.max(0, ...[...node.children].map((c) => parseFloat(getComputedStyle(c).height) || 0));
      const gap = inner && outer > inner ? (outer - inner) / 2 : 0;
      node.style.setProperty("--ste-clip-bottom", `${gap}px`);
    }

    const settled = (anims) => Promise.all(anims.map((a) => a.finished)).then(() => true, () => false);

    function finish(node, st, token, hide) {
      if (st.token !== token) return;
      node.toggleAttribute(HIDDEN, hide);
      stop(st);
      node.removeAttribute(ANIMATING);
    }

    function setInstant(node, st, show) {
      st.token++;
      stop(st);
      node.removeAttribute(ANIMATING);
      node.toggleAttribute(HIDDEN, !show);
    }

    // Partway through an animation? Note where the button is now, to carry on from there.
    function midFlight(node, st) {
      if (!st.anims.length || node.hasAttribute(HIDDEN)) return null;
      return {
        box: boxOf(node),
        kids: [...node.children].map((c) => getComputedStyle(c).transform),
        opacity: getComputedStyle(node).opacity,
      };
    }

    async function animateOut(node, st, delay) {
      const token = ++st.token;
      const from = midFlight(node, st);
      stop(st);
      if (node.hasAttribute(HIDDEN)) return;

      if (reducedMotion.matches) {
        const fade = node.animate([{ opacity: from?.opacity ?? 1 }, { opacity: 0 }],
          { duration: FADE_MS, delay, fill: "both" });
        st.anims = [fade];
        if (await settled(st.anims)) finish(node, st, token, true);
        return;
      }

      setClip(node);
      node.setAttribute(ANIMATING, "");
      const kids = [...node.children];
      st.anims = kids.map((c, i) =>
        from
          ? c.animate([{ transform: from.kids[i] }, { transform: OUT_POSE }],
              { duration: SINK_MS * 0.7, delay, easing: "ease-in", fill: "both" })
          : c.animate(SINK, { duration: SINK_MS, delay, easing: "ease-in-out", fill: "both" }));
      if (!(await settled(st.anims)) || st.token !== token) return;
      if (!node.isConnected || !node.parentNode) return;

      const box = from?.box ?? boxOf(node);
      st.anims.push(node.animate([box, zeroBox(node)],
        { duration: WIDTH_MS, easing: "cubic-bezier(0.4, 0, 0.2, 1)", fill: "both" }));
      if ((await settled(st.anims)) && node.isConnected) finish(node, st, token, true);
    }

    async function animateIn(node, st, delay) {
      const token = ++st.token;
      const from = midFlight(node, st);
      stop(st);
      if (!from && !node.hasAttribute(HIDDEN)) return;
      node.removeAttribute(HIDDEN);

      if (reducedMotion.matches) {
        st.anims = [node.animate([{ opacity: from?.opacity ?? 0 }, { opacity: 1 }],
          { duration: FADE_MS, delay, fill: "both" })];
        if (await settled(st.anims)) finish(node, st, token, false);
        return;
      }

      setClip(node);
      node.setAttribute(ANIMATING, "");
      const box = boxOf(node); // full size, measured with nothing running
      const kids = [...node.children];

      if (from) {
        // Turn around from wherever it got to, without the full bounce.
        st.anims = [
          node.animate([from.box, box], { duration: WIDTH_MS, easing: "ease-out", fill: "both" }),
          ...kids.map((c, i) => c.animate([{ transform: from.kids[i] }, { transform: "none" }],
            { duration: SETTLE_MS, easing: "cubic-bezier(0.3, 1.4, 0.5, 1)", fill: "both" })),
        ];
      } else {
        // Open the slot, then rise into it while it finishes opening.
        st.anims = [
          node.animate([zeroBox(node), box],
            { duration: WIDTH_MS, delay, easing: "cubic-bezier(0.4, 0, 0.2, 1)", fill: "both" }),
          ...kids.map((c) => c.animate(RISE,
            { duration: RISE_MS, delay: delay + WIDTH_MS * 0.6, easing: "ease-in-out", fill: "both" })),
        ];
      }
      if ((await settled(st.anims)) && node.isConnected) finish(node, st, token, false);
    }

    // ---- Apply ----------------------------------------------------------------------------------

    function apply() {
      const host = currentHost();
      const wanted = new Map(); // widget id -> extId | null
      for (const extId of Object.keys(rules)) wanted.set(widgetIdFor(extId), extId);
      for (const wid of touched) if (!wanted.has(wid)) wanted.set(wid, null);

      const out = [];
      const into = [];
      const instant = !animateOn() || customizing() || document.hidden;

      for (const [wid, knownExtId] of wanted) {
        const node = toolbarNode(wid);
        if (!node) {
          if (touched.has(wid) && !onToolbar(wid)) {
            const stray = document.getElementById(wid);
            if (stray) {
              const st = states.get(stray);
              if (st) { stop(st); states.delete(stray); }
              stray.removeAttribute(HIDDEN);
              stray.removeAttribute(ANIMATING);
              stray.style.removeProperty("--ste-clip-bottom");
            }
            touched.delete(wid);
          }
          continue;
        }
        const extId = knownExtId ?? extIdForWidget(wid);
        const show = extId ? shouldShow(extId, host) : true;
        let st = states.get(node);
        if (!st) {
          // First time this window sees the button (startup, new window, extension reloaded).
          st = { shown: show, token: 0, anims: [] };
          states.set(node, st);
          touched.add(wid);
          setInstant(node, st, show);
          continue;
        }
        touched.add(wid);
        // Leave a button alone while it's being dragged; the drop reschedules this.
        if (node.hasAttribute(DRAGGING)) continue;
        if (st.shown === show) continue;
        st.shown = show;
        if (instant || node.hasAttribute("overflowedItem")) setInstant(node, st, show);
        else (show ? into : out).push([node, st]);
      }

      out.forEach(([node, st], i) => animateOut(node, st, i * STAGGER_MS));
      // Arrivals wait for the leavers to sink, then open while the leavers close.
      const wait = out.length ? SINK_MS : 0;
      into.forEach(([node, st], i) => animateIn(node, st, wait + i * STAGGER_MS));
      if (openView) fillPanel(openView);
    }

    // ---- Extensions panel -----------------------------------------------------------------------
    //
    // Firefox's extensions (puzzle) panel leaves out pinned extensions, since their buttons are
    // on the toolbar. One this mod hides on the current site would be out of reach, so it gets a
    // row in the panel's list while it's hidden. The row is Firefox's own panel item, so its ⋯
    // button and right-click open the usual menu, with "Show on <site>". The row has no id:
    // the toolbar button keeps its widget id to itself.

    const PANEL_ROW = "ste-panel-row";
    let openView = null;

    function hiddenHereExtensions() {
      const host = currentHost();
      const found = [];
      for (const extId of Object.keys(rules)) {
        if (unpinning.has(extId)) continue; // about to move into the panel for real
        const node = toolbarNode(widgetIdFor(extId));
        if (!node || node.hasAttribute("overflowedItem")) continue; // overflowed ones are listed already
        const policy = WebExtensionPolicy.getByID(extId);
        if (!policy?.extension || !policy.canAccessWindow(window)) continue;
        if (!shouldShow(extId, host)) found.push(policy.extension);
      }
      return found.sort((a, b) => a.name.localeCompare(b.name));
    }

    function fillPanel(view) {
      const list = view.querySelector(".unified-extensions-list");
      if (!list) return;
      for (const row of list.querySelectorAll(`.${PANEL_ROW}`)) row.remove();
      const extensions = hiddenHereExtensions();
      for (const extension of extensions) {
        const row = document.createElement("unified-extensions-item");
        row.setExtension(extension);
        row.classList.add(PANEL_ROW);
        list.append(row); // renders it, which disables (greys out) its main button
        // Firefox only enables that button for extensions that need a permission grant. Here a
        // click opens the extension's menu instead, the same one its ⋯ button opens.
        const button = row.querySelector(".unified-extensions-item-action-button");
        if (button) {
          button.disabled = false;
          button.setAttribute("closemenu", "none"); // keep the panel open, like the ⋯ button
          button.addEventListener("command", openRowMenu, true);
        }
      }
      // With every other extension pinned, Firefox would show its "no extensions" message.
      if (extensions.length) {
        try { gUnifiedExtensions._updateEmptyStateBox({ panelview: view, hidden: true }); } catch {}
      } else if (!list.children.length) {
        try { gUnifiedExtensions._updateEmptyStateBox({ panelview: view, hidden: false }); } catch {}
      }
    }

    function openRowMenu(e) {
      // Firefox's own handler would grant the extension access to the tab; this row is a menu.
      e.stopImmediatePropagation();
      document.getElementById("unified-extensions-context-menu")
        ?.openPopup(e.target, "after_end", 0, 0, true, false, e);
    }

    const onViewShowing = (e) => {
      if (e.target.id !== "unified-extensions-view") return;
      openView = e.target;
      // After Firefox has built its own list for this showing.
      queueMicrotask(() => openView === e.target && fillPanel(e.target));
    };
    const onViewHiding = (e) => {
      if (e.target.id === "unified-extensions-view") openView = null;
    };

    let queued = 0;
    const schedule = () => {
      if (queued) return;
      queued = setTimeout(() => {
        queued = 0;
        apply();
      }, 0);
    };

    // ---- Hold to drag ---------------------------------------------------------------------------
    //
    // Press an extension button for HOLD_MS without moving and it lifts; drag it along the
    // other visible extension buttons and they slide aside; let go and it moves there. The new
    // order is saved through CustomizableUI, the same as Customize Toolbar, so it's shared by
    // every window and survives restarts. Escape puts it back.

    const dragOn = () => Services.prefs.getBoolPref(PREF_DRAG, true);
    const isExtItem = (el) => el?.nodeType === 1 && el.id?.endsWith("-browser-action");

    let hold = null; // { node, pointerId, x, y, timer }
    let drag = null; // see beginDrag

    function itemFrom(target) {
      for (let el = target; el && el.nodeType === 1; el = el.parentElement) {
        if (isExtItem(el)) return toolbarNode(el.id) === el ? el : null;
        if (el.localName === "toolbar") return null;
      }
      return null;
    }

    // The visible, settled extension buttons contiguous with `node`, in toolbar order.
    function rowOf(node) {
      const children = [...(node.parentNode?.children || [])];
      const idx = children.indexOf(node);
      if (idx < 0) return [];
      let start = idx;
      while (start > 0 && isExtItem(children[start - 1])) start--;
      let end = idx;
      while (end + 1 < children.length && isExtItem(children[end + 1])) end++;
      return children.slice(start, end + 1).filter((el) =>
        !el.hasAttribute(HIDDEN) && !el.hasAttribute("overflowedItem") &&
        el.getBoundingClientRect().width > 0);
    }

    function onPointerDown(e) {
      if (e.button !== 0 || !e.isPrimary || drag || !dragOn() || customizing()) return;
      const node = itemFrom(e.target);
      if (!node) return;
      cancelHold();
      hold = {
        node, pointerId: e.pointerId, x: e.screenX, y: e.screenY,
        timer: setTimeout(() => beginDrag(), HOLD_MS),
      };
    }

    function cancelHold() {
      if (hold) clearTimeout(hold.timer);
      hold = null;
    }

    function beginDrag() {
      const { node, pointerId, x } = hold;
      hold = null;
      if (!node.isConnected || !node.parentNode) return;
      const row = rowOf(node);
      const st = states.get(node);
      // Nothing to reorder against, or something is still sinking or rising.
      if (row.length < 2 || !row.includes(node) || row.some((el) => el.hasAttribute(ANIMATING)) ||
          (st && st.anims.length)) {
        return;
      }
      const rects = row.map((el) => el.getBoundingClientRect());
      const from = row.indexOf(node);
      const gap = parseFloat(getComputedStyle(node.parentNode).columnGap) || 0;
      const cs = getComputedStyle(node);
      drag = {
        node, pointerId, startX: x, row, rects, from, to: from, dx: 0,
        slot: rects[from].width + (parseFloat(cs.marginInlineStart) || 0) + (parseFloat(cs.marginInlineEnd) || 0) + gap,
        minDx: rects[0].left - rects[from].left,
        maxDx: rects.at(-1).right - rects[from].right,
      };
      try { node.setPointerCapture(pointerId); } catch {}
      // The extension's own popup must not open for this press.
      window.addEventListener("click", swallow, true);
      window.addEventListener("command", swallow, true);
      window.addEventListener("keydown", onDragKey, true);
      node.setAttribute(DRAGGING, "");
      for (const el of row) if (el !== node) el.setAttribute(SHIFTING, "");
      setLift(node, true);
    }

    // The lift scales the button's contents, not the button: Firefox decides whether the
    // toolbar overflows by adding up its buttons' on-screen widths, and a scaled button would
    // tip it over and push buttons into the overflow menu.
    function setLift(node, up) {
      for (const kid of node.children) {
        if (up && !reducedMotion.matches) {
          kid.animate([{ scale: "1" }, { scale: String(LIFT_SCALE) }], { duration: 120, easing: "ease-out" });
        }
        kid.style.scale = up ? String(LIFT_SCALE) : "";
      }
    }

    function swallow(e) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }

    function onPointerMove(e) {
      if (hold && e.pointerId === hold.pointerId) {
        if (Math.abs(e.screenX - hold.x) > SLOP_PX || Math.abs(e.screenY - hold.y) > SLOP_PX) cancelHold();
        return;
      }
      if (!drag || e.pointerId !== drag.pointerId) return;
      e.preventDefault();
      // A little give past either end, then stop.
      let dx = e.screenX - drag.startX;
      if (dx < drag.minDx) dx = drag.minDx - Math.min(12, (drag.minDx - dx) / 4);
      if (dx > drag.maxDx) dx = drag.maxDx + Math.min(12, (dx - drag.maxDx) / 4);
      drag.dx = dx;
      drag.node.style.translate = `${dx}px 0`;

      // Where it would land: past the middle of a neighbour means swapping with it.
      const { rects, from } = drag;
      const center = rects[from].left + rects[from].width / 2 + dx;
      let to = 0;
      for (let i = 0; i < rects.length; i++) {
        if (i !== from && rects[i].left + rects[i].width / 2 < center) to++;
      }
      if (to === drag.to) return;
      drag.to = to;
      drag.row.forEach((el, i) => {
        if (el === drag.node) return;
        let shift = 0;
        if (from < to && i > from && i <= to) shift = -drag.slot;
        else if (to < from && i >= to && i < from) shift = drag.slot;
        el.style.translate = shift ? `${shift}px 0` : "";
      });
    }

    function onPointerUp(e) {
      if (hold && e.pointerId === hold.pointerId) {
        cancelHold();
        return;
      }
      if (drag && e.pointerId === drag.pointerId) {
        endDrag(true);
      } else if (awaitingRelease) {
        // Cancelled with Escape while still pressed: this is that press's release.
        stopSwallowing();
      }
    }

    // A pickup's own release fires a click (and the extension's command) after pointerup,
    // so clicks stay blocked until just after the release. Cancelling with Escape happens
    // before the release, so then it waits for it, with a fallback in case it never comes.
    let awaitingRelease = 0;
    let swallowTimer = 0;
    function stopSwallowingNow() {
      clearTimeout(awaitingRelease);
      awaitingRelease = 0;
      clearTimeout(swallowTimer);
      swallowTimer = 0;
      window.removeEventListener("click", swallow, true);
      window.removeEventListener("command", swallow, true);
    }
    function stopSwallowing(wait = 0) {
      clearTimeout(awaitingRelease);
      awaitingRelease = 0;
      clearTimeout(swallowTimer);
      swallowTimer = setTimeout(() => {
        swallowTimer = 0;
        window.removeEventListener("click", swallow, true);
        window.removeEventListener("command", swallow, true);
      }, wait);
    }

    function onDragKey(e) {
      if (e.key !== "Escape") return;
      swallow(e);
      endDrag(false, true);
    }

    function endDrag(commit, waitForRelease = false) {
      const { node, row, from, to, pointerId } = drag;
      drag = null;
      try { node.releasePointerCapture(pointerId); } catch {}
      window.removeEventListener("keydown", onDragKey, true);
      if (commit || !waitForRelease) stopSwallowing();
      else awaitingRelease = setTimeout(() => stopSwallowing(), 5000);

      // Where everything is drawn right now, to animate from (FLIP).
      const before = new Map(row.map((el) => [el, el.getBoundingClientRect().left]));

      if (commit && to !== from) {
        const wid = node.id;
        const area = CustomizableUI.getPlacementOfWidget(wid)?.area;
        if (area) {
          const others = row.filter((el) => el !== node);
          const ids = CustomizableUI.getWidgetIdsInArea(area);
          // CustomizableUI's position is an index into the current list, and it allows for the
          // widget's own old slot, so "before X" is X's index and "after X" is X's index + 1.
          const targetIdx = to < others.length ? ids.indexOf(others[to].id) : ids.indexOf(others.at(-1).id);
          const pos = targetIdx >= 0 ? (to < others.length ? targetIdx : targetIdx + 1) : -1;
          if (pos >= 0) CustomizableUI.moveWidgetWithinArea(wid, pos);
        }
      }

      for (const el of row) {
        el.removeAttribute(SHIFTING);
        el.style.translate = "";
      }
      node.removeAttribute(DRAGGING);
      setLift(node, false);

      if (!reducedMotion.matches) {
        for (const el of row) {
          const dx = before.get(el) - el.getBoundingClientRect().left;
          if (el === node) {
            el.animate([{ translate: `${dx}px 0` }, { translate: "0 0" }], { duration: DROP_MS, easing: SPRING });
            for (const kid of el.children) {
              kid.animate([{ scale: String(LIFT_SCALE) }, { scale: "1" }], { duration: DROP_MS, easing: SPRING });
            }
          } else if (Math.abs(dx) > 0.5) {
            el.animate([{ translate: `${dx}px 0` }, { translate: "0 0" }],
              { duration: SHIFT_MS, easing: "cubic-bezier(0.2, 0, 0, 1)" });
          }
        }
      }
      schedule();
    }

    function stopDragging() {
      cancelHold();
      if (drag) endDrag(false);
    }

    // ---- Context menu ---------------------------------------------------------------------------

    const MENUS = ["toolbar-context-menu", "unified-extensions-context-menu"];
    const added = [];

    function extIdFromTrigger(node) {
      for (let el = node; el && el.nodeType === 1; el = el.parentElement) {
        const direct = el.dataset?.extensionid || el.getAttribute("extension-id");
        if (direct) return direct;
        if (el.id?.endsWith("-browser-action")) return extIdForWidget(el.id);
      }
      return null;
    }

    function buildMenu(popup) {
      const sep = document.createXULElement("menuseparator");
      const toggle = document.createXULElement("menuitem");
      const everywhere = document.createXULElement("menuitem");
      toggle.setAttribute("type", "checkbox");
      for (const el of [sep, toggle, everywhere]) el.classList.add("ste-menu");
      popup.append(sep, toggle, everywhere);
      added.push(sep, toggle, everywhere);

      let extId = null;
      let host = null;

      const onShowing = (e) => {
        if (e.target !== popup) return;
        extId = extIdFromTrigger(popup.triggerNode);
        host = currentHost();
        const sites = (extId && rules[extId]) || [];
        const show = !!extId && enabled();
        sep.hidden = !show || (!host && !sites.length);
        toggle.hidden = !show || !host;
        if (host) {
          toggle.setAttribute("label", `Show on ${host}`);
          // XUL reads any `checked` attribute as checked, even "false", so add or remove it.
          toggle.toggleAttribute("checked", sites.some((s) => siteMatches(host, s)));
        }
        everywhere.hidden = !show || !sites.length;
        everywhere.setAttribute("label", `Show on every site (now: ${sites.join(", ")})`);
      };

      toggle.addEventListener("command", () => {
        if (!extId || !host) return;
        const sites = rules[extId] || [];
        const matching = sites.filter((s) => siteMatches(host, s));
        if (matching.length) {
          const rest = sites.filter((s) => !matching.includes(s));
          if (rest.length) {
            rules[extId] = rest;
          } else {
            delete rules[extId];
            unpinAfterSink(extId);
          }
        } else {
          rules[extId] = [...sites, host];
          const wid = widgetIdFor(extId);
          if (!onToolbar(wid)) CustomizableUI.addWidgetToArea(wid, CustomizableUI.AREA_NAVBAR);
        }
        saveRules();
      });
      everywhere.addEventListener("command", () => {
        if (!extId) return;
        delete rules[extId];
        saveRules();
      });

      popup.addEventListener("popupshowing", onShowing);
      return () => popup.removeEventListener("popupshowing", onShowing);
    }

    const menuCleanups = [];
    // The unified extensions panel's context menu is built lazily.
    const onPopupShowingCapture = () => hookMenus();
    function hookMenus() {
      for (const id of MENUS) {
        const popup = document.getElementById(id);
        if (popup && !popup.hasAttribute("ste-hooked")) {
          popup.setAttribute("ste-hooked", "");
          menuCleanups.push(buildMenu(popup));
        }
      }
      if (menuCleanups.length === MENUS.length) {
        document.removeEventListener("popupshowing", onPopupShowingCapture, true);
      }
    }

    // ---- Listeners ------------------------------------------------------------------------------

    const progress = {
      onLocationChange(webProgress) {
        if (webProgress && !webProgress.isTopLevel) return;
        schedule();
      },
      QueryInterface: ChromeUtils.generateQI(["nsIWebProgressListener", "nsISupportsWeakReference"]),
    };

    const cuiListener = {
      onWidgetAdded: schedule,
      onWidgetMoved: schedule,
      onWidgetRemoved: schedule,
      onWidgetAfterCreation: schedule,
      onWidgetAfterDOMChange: schedule,
      onAreaNodeRegistered: schedule,
      onCustomizeStart: (win) => win === window && schedule(),
      onCustomizeEnd: (win) => win === window && schedule(),
    };

    const onPref = (_s, _t, name) => {
      if (name === PREF_RULES) loadRules();
      schedule();
    };

    window.windowUtils.loadSheetUsingURIString(SHEET, window.windowUtils.AUTHOR_SHEET);
    loadRules();
    document.addEventListener("popupshowing", onPopupShowingCapture, true);
    hookMenus();
    gBrowser.addProgressListener(progress);
    gBrowser.tabContainer.addEventListener("TabSelect", schedule);
    CustomizableUI.addListener(cuiListener);
    for (const p of PREFS) Services.prefs.addObserver(p, onPref);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("pointercancel", stopDragging, true);
    window.addEventListener("blur", stopDragging);
    document.addEventListener("ViewShowing", onViewShowing, true);
    document.addEventListener("ViewHiding", onViewHiding, true);
    apply();

    let tornDown = false;
    function teardown() {
      if (tornDown) return;
      tornDown = true;
      clearTimeout(queued);
      for (const id of unpinTimers) clearTimeout(id);
      unpinTimers.clear();
      gBrowser.removeProgressListener(progress);
      gBrowser.tabContainer.removeEventListener("TabSelect", schedule);
      CustomizableUI.removeListener(cuiListener);
      for (const p of PREFS) Services.prefs.removeObserver(p, onPref);
      document.removeEventListener("popupshowing", onPopupShowingCapture, true);
      stopDragging();
      stopSwallowingNow();
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("pointercancel", stopDragging, true);
      window.removeEventListener("blur", stopDragging);
      document.removeEventListener("ViewShowing", onViewShowing, true);
      document.removeEventListener("ViewHiding", onViewHiding, true);
    }
    cleanupWindow = teardown;

    // Sine disable: everything visible again, menus and styles removed.
    cleanupSine = () => {
      teardown();
      for (const wid of new Set([...touched, ...Object.keys(rules).map(widgetIdFor)])) {
        const node = document.getElementById(wid);
        if (!node) continue;
        const st = states.get(node);
        if (st) stop(st);
        node.removeAttribute(HIDDEN);
        node.removeAttribute(ANIMATING);
        node.style.removeProperty("--ste-clip-bottom");
      }
      for (const fn of menuCleanups) fn();
      for (const el of added) el.remove();
      for (const row of document.querySelectorAll(`.${PANEL_ROW}`)) row.remove();
      for (const id of MENUS) document.getElementById(id)?.removeAttribute("ste-hooked");
      try { window.windowUtils.removeSheetUsingURIString(SHEET, window.windowUtils.AUTHOR_SHEET); } catch {}
    };
  }
})();
