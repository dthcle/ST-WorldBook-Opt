import { defaultLayout, clampLayout } from "./window-layout.js";

/** DOM wiring for the floating window. Geometry maths lives in window-layout.js
 *  so it stays unit-testable without a browser. */

export function applyGeometry(panel, geometry) {
    panel.classList.add("wbo-floating");
    panel.style.setProperty("--wbo-left", geometry.left + "px");
    panel.style.setProperty("--wbo-panel-top", geometry.top + "px");
    panel.style.setProperty("--wbo-width", geometry.width + "px");
    panel.style.setProperty("--wbo-height", geometry.height + "px");
}

export function readGeometry(panel) {
    const read = name => Number.parseFloat(panel.style.getPropertyValue(name)) || 0;
    const rect = panel.getBoundingClientRect();
    return {
        left: read("--wbo-left"),
        top: read("--wbo-panel-top"),
        width: read("--wbo-width") || rect.width,
        height: read("--wbo-height") || rect.height,
    };
}

function pointerGesture(host, element, onStart, onMove, onEnd) {
    let active = false;
    const down = event => {
        if (event.button !== undefined && event.button !== 0) return;
        active = true;
        if (element.setPointerCapture && event.pointerId !== undefined) {
            try { element.setPointerCapture(event.pointerId); } catch { /* capture is optional */ }
        }
        onStart(event);
        event.preventDefault();
    };
    const move = event => { if (active) { onMove(event); event.preventDefault(); } };
    const up = event => { if (!active) return; active = false; onEnd(event); };
    element.addEventListener("pointerdown", down);
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", up);
    element.addEventListener("pointercancel", up);
    return () => {
        element.removeEventListener("pointerdown", down);
        element.removeEventListener("pointermove", move);
        element.removeEventListener("pointerup", up);
        element.removeEventListener("pointercancel", up);
    };
}

/** Drag the window by its header; clamped so a reachable header always remains. */
export function makeMovable(panel, host, dragHandle, resizeHandle) {
    const viewportOf = () => host.visualViewport ?? { width: host.innerWidth, height: host.innerHeight };
    const detachers = [];
    if (dragHandle) {
        let start = null;
        detachers.push(pointerGesture(host, dragHandle,
            event => { const rect = panel.getBoundingClientRect(); start = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top }; },
            event => {
                if (!start) return;
                const size = readGeometry(panel);
                applyGeometry(panel, clampLayout({ left: start.left + (event.clientX - start.x), top: start.top + (event.clientY - start.y), width: size.width, height: size.height }, viewportOf()));
            },
            () => { start = null; }));
    }
    if (resizeHandle) {
        let start = null;
        detachers.push(pointerGesture(host, resizeHandle,
            event => { const geometry = readGeometry(panel); start = { x: event.clientX, y: event.clientY, width: geometry.width, height: geometry.height }; },
            event => {
                if (!start) return;
                const geometry = readGeometry(panel);
                applyGeometry(panel, clampLayout({ left: geometry.left, top: geometry.top, width: start.width + (event.clientX - start.x), height: start.height + (event.clientY - start.y) }, viewportOf()));
            },
            () => { start = null; }));
    }
    return () => { for (const detach of detachers) detach(); };
}

export function initialGeometry(host) {
    return defaultLayout(host.visualViewport ?? { width: host.innerWidth, height: host.innerHeight });
}

export { clampLayout };
