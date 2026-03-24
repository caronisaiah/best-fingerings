// src/ScoreView.tsx
import { useEffect, useEffectEvent, useRef } from "react";
import * as OSMD from "opensheetmusicdisplay";

type ViewMode = "page" | "scroll";

type Props = {
  xmlText: string | null;
  viewMode?: ViewMode;
  pageIndex?: number; // 0-based
  zoom?: number; // 1.0 = 100%
  onPageCountChange?: (count: number) => void;
};

export function ScoreView({
  xmlText,
  viewMode = "page",
  pageIndex = 0,
  zoom = 1.0,
  onPageCountChange,
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const osmdRef = useRef<OSMD.OpenSheetMusicDisplay | null>(null);
  const renderCurrentView = useEffectEvent((host: HTMLDivElement, osmd: OSMD.OpenSheetMusicDisplay) => {
    const instance = osmd as OSMD.OpenSheetMusicDisplay & { Zoom: number };
    instance.Zoom = zoom;
    instance.render();
    applyPaginationAndStyling(host, viewMode, pageIndex, zoom, onPageCountChange);
  });

  // Load + render whenever xmlText changes
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    // ✅ TS-safe across async
    const hostEl: HTMLDivElement = host;

    if (typeof xmlText !== "string" || xmlText.length === 0) return;
    const xml: string = xmlText;

    let cancelled = false;

    (async () => {
      hostEl.innerHTML = "";

      const osmd = new OSMD.OpenSheetMusicDisplay(hostEl, {
        autoResize: true,
        drawTitle: false,
        backend: "svg",
        drawingParameters: "compact",
      });

      osmdRef.current = osmd;

      await osmd.load(xml);
      if (cancelled) return;

      renderCurrentView(hostEl, osmd);
    })().catch((e) => console.error("OSMD render failed:", e));

    return () => {
      cancelled = true;
      osmdRef.current = null;
    };
  }, [xmlText]); // only reload when XML changes

  // Re-apply zoom/page mode without reloading XML
  useEffect(() => {
    const host = hostRef.current;
    const osmd = osmdRef.current;
    if (!host || !osmd) return;

    if (typeof xmlText !== "string" || xmlText.length === 0) return;

    renderCurrentView(host, osmd);
  }, [zoom, viewMode, pageIndex, xmlText]);

  return <div ref={hostRef} className="osmdHost" />;
}

function applyPaginationAndStyling(
  host: HTMLDivElement,
  viewMode: ViewMode,
  pageIndex: number,
  zoom: number,
  onPageCountChange?: (count: number) => void
) {
  const svgs = Array.from(host.querySelectorAll("svg")) as SVGSVGElement[];
  const pageCount = Math.max(1, svgs.length);
  onPageCountChange?.(pageCount);

  // ✅ Host styling: fixes “sliver” + centers pages
  host.style.display = "flex";
  host.style.flexDirection = "column";
  host.style.alignItems = "center";
  host.style.gap = "16px";
  host.style.padding = "16px";

  // IMPORTANT:
  // - In scroll mode, allow normal scrolling
  // - In page mode, do NOT accidentally clip the SVG width; allow horizontal scroll when zoomed
  host.style.overflowY = "auto";
  host.style.overflowX = zoom > 1.05 ? "auto" : "hidden";

  for (const svg of svgs) {
    svg.style.background = "#ffffff";
    svg.style.borderRadius = "12px";
    svg.style.boxShadow = "0 10px 30px rgba(15, 23, 42, 0.10)";
    svg.style.display = "block";

    // ✅ Critical: make page fill container width
    svg.style.width = "min(1100px, 100%)";
    svg.style.height = "auto";
  }

  if (viewMode === "scroll") {
    for (const svg of svgs) svg.style.display = "block";
    return;
  }

  const idx = clamp(pageIndex, 0, pageCount - 1);
  svgs.forEach((svg, i) => {
    svg.style.display = i === idx ? "block" : "none";
  });
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}
