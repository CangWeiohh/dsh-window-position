// dsh-window-position — browser half.
//
// Hand-written in the lazy-CJS bundle protocol (window.__ModuleLoader__.load
// with a factory returning cordis-plugin exports), like the host half with
// zero dsh package imports.
//
// What this plugin does: DSH Desktop's main process creates its window with a
// fixed size and no x/y, so Electron centers it on the primary display every
// launch. This half restores the last saved bounds with window.moveTo() /
// window.resizeTo(), then keeps saving the live window position so a manual
// drag is remembered for the next launch.
//
// Design rules learned the hard way:
//  - window.moveTo is a no-op during the DSH page's early boot (~first 2s),
//    so the first attempt must wait for the page to settle.
//  - The window is 1380x875 on a 1440x900 built-in display, so a moveTo to a
//    built-in coordinate gets clamped to the right edge — that is NOT a
//    failure of moveTo, it is Chromium keeping the window on screen.
//  - Restore must be a short, bounded attempt. A long retry loop fights the
//    user's own drag. After restore settles (success OR failure), saving
//    resumes immediately so a manual drag is always remembered.
window.__ModuleLoader__.load({
  id: 'dsh-window-position',
  factory: () => {
    const API = '/window-position/bounds';
    const DIAGNOSTIC_API = '/window-position/diagnostic';
    const MOVE_API = '/window-position/move';
    const POLL_MS = 3000;
    const RESTORE_INITIAL_DELAY_MS = 800;
    const RESTORE_RETRY_MS = 300;
    const RESTORE_MAX_ATTEMPTS = 3;
    const POSITION_EPSILON = 4;

    function snapshot() {
      return {
        x: Math.round(window.screenX),
        y: Math.round(window.screenY),
        width: Math.round(window.outerWidth),
        height: Math.round(window.outerHeight),
      };
    }

    function finite(value) {
      return typeof value === 'number' && Number.isFinite(value);
    }

    function diagnostic(stage, extra = {}) {
      const payload = JSON.stringify({ stage, ...extra, position: snapshot(), at: new Date().toISOString() });
      void fetch(DIAGNOSTIC_API, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: payload,
        keepalive: true,
      }).catch(() => {});
    }

    async function readSavedBounds() {
      const response = await fetch(API, {
        headers: { accept: 'application/json' },
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(`bounds GET failed: ${response.status}`);
      const result = await response.json();
      const bounds = result?.bounds;
      if (!bounds || !finite(bounds.x) || !finite(bounds.y)) return null;
      return bounds;
    }

    // window.moveTo() cannot cross displays in the real DSH Desktop (the
    // window is 1380x900 on a 1440x900 built-in, so Chromium clamps it to the
    // primary display). The host half moves the window through osascript +
    // System Events instead, which CAN cross displays. This half just asks the
    // host to move, then verifies the result.
    async function restoreOnce(bounds) {
      const response = await fetch(MOVE_API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ x: bounds.x, y: bounds.y }),
      });
      if (!response.ok) throw new Error(`move POST failed: ${response.status}`);
      await new Promise((resolve) => setTimeout(resolve, 120));
      const after = snapshot();
      return Math.abs(after.x - bounds.x) <= POSITION_EPSILON &&
        Math.abs(after.y - bounds.y) <= POSITION_EPSILON;
    }

    // Restore is a short, bounded attempt. It never blocks saving afterwards:
    // whether it succeeds or fails, the live window position is saved from
    // then on, so a manual drag always wins and is remembered.
    async function restore() {
      diagnostic('restore-start');
      try {
        const bounds = await readSavedBounds();
        diagnostic('bounds-read', { bounds });
        if (!bounds) return;
        await new Promise((resolve) => setTimeout(resolve, RESTORE_INITIAL_DELAY_MS));
        for (let attempt = 0; attempt < RESTORE_MAX_ATTEMPTS; attempt += 1) {
          const ok = await restoreOnce(bounds);
          diagnostic('restore-attempt', { attempt: attempt + 1, target: bounds, ok });
          if (ok) return;
          await new Promise((resolve) => setTimeout(resolve, RESTORE_RETRY_MS));
        }
      } catch (error) {
        diagnostic('restore-error', { error: String(error?.message ?? error) });
      }
    }

    let restoring = true;
    let inFlight = false;

    function report() {
      if (restoring || document.hidden || document.fullscreenElement || inFlight) return;
      inFlight = true;
      const body = JSON.stringify(snapshot());
      Promise.resolve(
        fetch(API, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body,
          keepalive: true,
        }).catch(() => {})
      ).finally(() => {
        inFlight = false;
      });
    }

    function apply(ctx) {
      diagnostic('apply');
      void restore().then(() => {
        restoring = false;
        diagnostic('restore-finished');
        report();
      });
      const timer = setInterval(report, POLL_MS);
      const onHide = () => report();
      const onVisibility = () => {
        if (document.hidden) report();
      };
      window.addEventListener('pagehide', onHide);
      document.addEventListener('visibilitychange', onVisibility);
      const dispose = () => {
        clearInterval(timer);
        window.removeEventListener('pagehide', onHide);
        document.removeEventListener('visibilitychange', onVisibility);
      };
      if (ctx && typeof ctx.effect === 'function') {
        ctx.effect(() => dispose, 'dsh-window-position: bounds reporter');
      }
    }

    return { apply, inject: [] };
  },
});