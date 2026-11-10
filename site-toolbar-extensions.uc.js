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

  const CSS = `
    [${HIDDEN}] { display: none !important; }
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
  `;
  const SHEET = "data:text/css;charset=utf-8," + encodeURIComponent(CSS);

  if (window.gBrowserInit?.delayedStartupFinished) {
    start();
  } else {
    const obs = (subject) => {
      if (subject !== window) return;
      Services.obs.removeObserver(obs, "browser-delayed-startup-finished");
      start();
    };
    Services.obs.addObserver(obs, "browser-delayed-startup-finished");
  }

  function start() {
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

    // Unchecking an extension's last site: sink it out, then move it back to the extensions
    // panel. Its slot has closed by then, so the move doesn't jump. "Show on every site" is
    // the way to keep it pinned with no sites.
    function unpinAfterSink(extId) {
      const wid = widgetIdFor(extId);
      unpinning.add(extId);
      setTimeout(() => {
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

      const box = from?.box ?? boxOf(node);
      st.anims.push(node.animate([box, zeroBox(node)],
        { duration: WIDTH_MS, easing: "cubic-bezier(0.4, 0, 0.2, 1)", fill: "both" }));
      if (await settled(st.anims)) finish(node, st, token, true);
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
      if (await settled(st.anims)) finish(node, st, token, false);
    }

    // ---- Apply ----------------------------------------------------------------------------------

    function apply() {
      const host = currentHost();
      const wanted = new Map(); // widget id -> show?
      for (const extId of Object.keys(rules)) wanted.set(widgetIdFor(extId), null);
      for (const wid of touched) wanted.set(wid, null);

      const out = [];
      const into = [];
      const instant = !animateOn() || customizing() || document.hidden;

      for (const wid of wanted.keys()) {
        const extId = extIdForWidget(wid);
        const node = toolbarNode(wid);
        if (!node) continue;
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
        if (st.shown === show) continue;
        st.shown = show;
        if (instant || node.hasAttribute("overflowedItem")) setInstant(node, st, show);
        else (show ? into : out).push([node, st]);
      }

      out.forEach(([node, st], i) => animateOut(node, st, i * STAGGER_MS));
      // Arrivals wait for the leavers to sink, then open while the leavers close.
      const wait = out.length ? SINK_MS : 0;
      into.forEach(([node, st], i) => animateIn(node, st, wait + i * STAGGER_MS));
    }

    let queued = 0;
    const schedule = () => {
      if (queued) return;
      queued = setTimeout(() => {
        queued = 0;
        apply();
      }, 0);
    };

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
    function hookMenus() {
      for (const id of MENUS) {
        const popup = document.getElementById(id);
        if (popup && !popup.hasAttribute("ste-hooked")) {
          popup.setAttribute("ste-hooked", "");
          menuCleanups.push(buildMenu(popup));
        }
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

    // The unified extensions panel's context menu is built lazily.
    const onPopupShowingCapture = () => hookMenus();

    window.windowUtils.loadSheetUsingURIString(SHEET, window.windowUtils.AUTHOR_SHEET);
    loadRules();
    hookMenus();
    gBrowser.addProgressListener(progress);
    gBrowser.tabContainer.addEventListener("TabSelect", schedule);
    CustomizableUI.addListener(cuiListener);
    for (const p of PREFS) Services.prefs.addObserver(p, onPref);
    document.addEventListener("popupshowing", onPopupShowingCapture, true);
    apply();

    function teardown() {
      clearTimeout(queued);
      gBrowser.removeProgressListener(progress);
      gBrowser.tabContainer.removeEventListener("TabSelect", schedule);
      CustomizableUI.removeListener(cuiListener);
      for (const p of PREFS) Services.prefs.removeObserver(p, onPref);
      document.removeEventListener("popupshowing", onPopupShowingCapture, true);
    }
    window.addEventListener("unload", teardown, { once: true });

    // Sine disable: everything visible again, menus and styles removed.
    window.addUnloadListener?.(() => {
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
      for (const id of MENUS) document.getElementById(id)?.removeAttribute("ste-hooked");
      try { window.windowUtils.removeSheetUsingURIString(SHEET, window.windowUtils.AUTHOR_SHEET); } catch {}
    }, SCRIPT_URI);
  }
})();
