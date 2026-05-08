import { useEffect, useEffectEvent, useRef, useState } from "react";
import * as OSMD from "opensheetmusicdisplay";

import type { ScorePassageTarget } from "./types";

type ViewMode = "page" | "scroll";

type HighlightRect = {
  left: number;
  top: number;
  width: number;
  height: number;
  target: ScorePassageTarget;
};

type RectBounds = {
  left: number;
  right: number;
  top: number;
  bottom: number;
};

type Props = {
  xmlText: string | null;
  viewMode?: ViewMode;
  pageIndex?: number;
  zoom?: number;
  onPageCountChange?: (count: number) => void;
  selectedTarget?: ScorePassageTarget | null;
  hoveredTarget?: ScorePassageTarget | null;
  onHoverTargetChange?: (target: ScorePassageTarget | null) => void;
  onSelectTarget?: (target: ScorePassageTarget) => void;
};

type PointLike = {
  x?: number;
  y?: number;
};

type ResolvedPoint = {
  x: number;
  y: number;
};

type BoundingBoxLike = {
  AbsolutePosition?: PointLike;
  RelativePosition?: PointLike;
  Parent?: BoundingBoxLike;
  BorderLeft?: number;
  BorderRight?: number;
  BorderTop?: number;
  BorderBottom?: number;
};

type GraphicalObjectLike = {
  PositionAndShape?: BoundingBoxLike;
};

type SourceMeasureLike = {
  MeasureNumber?: number;
  MeasureNumberXML?: number;
  MeasureNumberPrinted?: number;
  measureListIndex?: number;
  getPrintedMeasureNumber?: () => number;
};

type GraphicalMusicPageLike = GraphicalObjectLike & {
  PageNumber?: number;
  MusicSystems?: MusicSystemLike[];
};

type MusicSystemLike = GraphicalObjectLike & {
  Parent?: GraphicalMusicPageLike;
  StaffLines?: StaffLineLike[];
  GraphicalMeasures?: GraphicalMeasureLike[][];
};

type GraphicalMeasureLike = GraphicalObjectLike & {
  MeasureNumber?: number;
  parentSourceMeasure?: SourceMeasureLike;
  staffEntries?: unknown[];
  ParentMusicSystem?: MusicSystemLike;
  ParentStaffLine?: StaffLineLike;
  IsExtraGraphicalMeasure?: boolean;
  isVisible?: () => boolean;
};

type StaffLineLike = GraphicalObjectLike & {
  ParentMusicSystem?: MusicSystemLike;
  Measures?: GraphicalMeasureLike[];
};

type GraphicalMusicSheetLike = {
  MusicPages?: GraphicalMusicPageLike[];
};

type MeasureRegion = {
  measureNumber: number;
  system: MusicSystemLike;
  bounds: RectBounds;
  rowIndex: number;
  rowCount: number;
};

type MeasureHitRegion = {
  key: string;
  measureNumber: number;
  target: ScorePassageTarget;
  rect: HighlightRect;
};

export function ScoreView({
  xmlText,
  viewMode = "page",
  pageIndex = 0,
  zoom = 1.0,
  onPageCountChange,
  selectedTarget = null,
  hoveredTarget = null,
  onHoverTargetChange,
  onSelectTarget,
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const osmdRef = useRef<OSMD.OpenSheetMusicDisplay | null>(null);
  const [measureHitRegions, setMeasureHitRegions] = useState<MeasureHitRegion[]>([]);
  const [hoverRect, setHoverRect] = useState<HighlightRect | null>(null);

  const renderCurrentView = useEffectEvent((host: HTMLDivElement, osmd: OSMD.OpenSheetMusicDisplay) => {
    const instance = osmd as OSMD.OpenSheetMusicDisplay & { Zoom: number };
    instance.Zoom = zoom;
    instance.render();
    applyPaginationAndStyling(host, viewMode, pageIndex, zoom, onPageCountChange);
    setMeasureHitRegions(buildMeasureHitRegions(host, osmd, pageIndex));
  });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const hostEl: HTMLDivElement = host;
    if (typeof xmlText !== "string" || xmlText.length === 0) return;
    const xml = xmlText;

    let cancelled = false;

    (async () => {
      hostEl.innerHTML = "";

      const osmd = new OSMD.OpenSheetMusicDisplay(hostEl, {
        autoResize: true,
        drawTitle: false,
        backend: "svg",
        drawingParameters: "compact",
        pageFormat: "Letter_P",
        newPageFromXML: true,
        newSystemFromXML: true,
      });

      osmdRef.current = osmd;

      await osmd.load(xml);
      if (cancelled) return;

      renderCurrentView(hostEl, osmd);
    })().catch((error) => console.error("OSMD render failed:", error));

    return () => {
      cancelled = true;
      osmdRef.current = null;
      setMeasureHitRegions([]);
      setHoverRect(null);
    };
  }, [xmlText]);

  useEffect(() => {
    const host = hostRef.current;
    const osmd = osmdRef.current;
    if (!host || !osmd) return;

    if (typeof xmlText !== "string" || xmlText.length === 0) return;

    renderCurrentView(host, osmd);
  }, [zoom, viewMode, pageIndex, xmlText]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let frameId: number | null = null;
    const rebuild = () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }

      frameId = window.requestAnimationFrame(() => {
        const osmd = osmdRef.current;
        if (osmd) {
          setMeasureHitRegions(buildMeasureHitRegions(host, osmd, pageIndex));
        }
      });
    };

    host.addEventListener("scroll", rebuild, { passive: true });
    window.addEventListener("resize", rebuild);

    return () => {
      host.removeEventListener("scroll", rebuild);
      window.removeEventListener("resize", rebuild);
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, [pageIndex, xmlText, zoom, viewMode]);

  const selectedRect = measureHitRegions.find((region) => sameTarget(region.target, selectedTarget))?.rect ?? null;

  return (
    <div className="osmdHostWrap">
      <div
        ref={hostRef}
        className="osmdHost scoreInteractiveHost"
      />

      <div
        className="measureOverlayLayer"
        onMouseLeave={() => {
          setHoverRect(null);
          onHoverTargetChange?.(null);
        }}
      >
        {measureHitRegions.map((region) => (
          <button
            key={region.key}
            type="button"
            className="measureHitArea"
            aria-label={`Measure ${region.measureNumber}`}
            data-measure-number={region.measureNumber}
            style={{
              left: region.rect.left,
              top: region.rect.top,
              width: region.rect.width,
              height: region.rect.height,
            }}
            onMouseEnter={() => {
              setHoverRect(region.rect);
              onHoverTargetChange?.(region.target);
            }}
            onFocus={() => {
              setHoverRect(region.rect);
              onHoverTargetChange?.(region.target);
            }}
            onBlur={() => {
              setHoverRect(null);
              onHoverTargetChange?.(null);
            }}
            onClick={() => {
              onSelectTarget?.(region.target);
            }}
          />
        ))}
      </div>

      {selectedRect ? (
        <div
          className="scoreHoverBand scoreHoverBand-selected"
          style={{
            left: selectedRect.left,
            top: selectedRect.top,
            width: selectedRect.width,
            height: selectedRect.height,
          }}
        />
      ) : null}

      {hoverRect ? (
        <div
          className={[
            "scoreHoverBand",
            sameTarget(hoveredTarget, hoverRect.target) ? "scoreHoverBand-hovered" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          style={{
            left: hoverRect.left,
            top: hoverRect.top,
            width: hoverRect.width,
            height: hoverRect.height,
          }}
        />
      ) : null}
    </div>
  );
}

function applyPaginationAndStyling(
  host: HTMLDivElement,
  viewMode: ViewMode,
  pageIndex: number,
  zoom: number,
  onPageCountChange?: (count: number) => void,
) {
  const svgs = Array.from(host.querySelectorAll("svg")) as SVGSVGElement[];
  const pageCount = Math.max(1, svgs.length);
  onPageCountChange?.(pageCount);

  host.style.display = "flex";
  host.style.flexDirection = "column";
  host.style.alignItems = "center";
  host.style.gap = "16px";
  host.style.padding = "16px";
  host.style.overflowY = "auto";
  host.style.overflowX = zoom > 1.05 ? "auto" : "hidden";

  for (const svg of svgs) {
    svg.style.background = "#ffffff";
    svg.style.borderRadius = "12px";
    svg.style.boxShadow = "0 10px 30px rgba(15, 23, 42, 0.10)";
    svg.style.display = "block";
    svg.style.width = "min(1100px, 100%)";
    svg.style.height = "auto";
  }

  if (viewMode === "scroll") {
    for (const svg of svgs) {
      svg.style.display = "block";
    }
    return;
  }

  const visibleIndex = clamp(pageIndex, 0, pageCount - 1);
  svgs.forEach((svg, index) => {
    svg.style.display = index === visibleIndex ? "block" : "none";
  });
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function getVisibleSvg(host: HTMLDivElement, pageIndex: number) {
  const svgs = Array.from(host.querySelectorAll("svg")) as SVGSVGElement[];
  return svgs[clamp(pageIndex, 0, Math.max(0, svgs.length - 1))] ?? null;
}

function getVisiblePage(graphicSheet: GraphicalMusicSheetLike, pageIndex: number) {
  const pages = graphicSheet.MusicPages ?? [];
  return pages[clamp(pageIndex, 0, Math.max(0, pages.length - 1))] ?? null;
}

function buildMeasureHitRegions(
  host: HTMLDivElement,
  osmd: OSMD.OpenSheetMusicDisplay,
  pageIndex: number,
) {
  const graphicSheet = (osmd as OSMD.OpenSheetMusicDisplay & {
    GraphicSheet?: GraphicalMusicSheetLike;
  }).GraphicSheet;
  const visiblePage = graphicSheet ? getVisiblePage(graphicSheet, pageIndex) : null;
  const visibleSvg = getVisibleSvg(host, pageIndex);

  if (!visiblePage || !visibleSvg) {
    return [];
  }

  const regions = getVisiblePageMeasureRegions(visiblePage);

  const hitRegions = regions
    .map((region, index) => {
      const target: ScorePassageTarget = {
        measureNumber: region.measureNumber,
        staffEntryIndex: 0,
        staffEntryCount: 1,
        tMeasBeats: null,
      };
      const rect = buildMeasureHighlightRect(host, visibleSvg, visiblePage, region, target);

      if (!rect) {
        return null;
      }

      return {
        key: `${pageIndex}-${region.measureNumber}-${index}`,
        measureNumber: region.measureNumber,
        target,
        rect,
      };
    })
    .filter((region): region is MeasureHitRegion => Boolean(region));

  return hitRegions;
}

function getVisiblePageMeasureRegions(visiblePage: GraphicalMusicPageLike) {
  const systems = visiblePage.MusicSystems ?? [];
  const rawRegions = systems.flatMap((system) => {
    const grouped = new Map<number, RectBounds[]>();
    const measures = getAllGraphicalMeasuresForSystem(system);

    measures.forEach((measure) => {
      const measureNumber = getStableMeasureNumber(measure);
      if (measureNumber == null || measureNumber < 0 || measure.IsExtraGraphicalMeasure) {
        return;
      }

      if (typeof measure.isVisible === "function" && !measure.isVisible()) {
        return;
      }

      const bounds = getObjectBounds(measure);
      if (!bounds) {
        return;
      }

      const current = grouped.get(measureNumber) ?? [];
      current.push(bounds);
      grouped.set(measureNumber, current);
    });

    return Array.from(grouped.entries())
      .map(([measureNumber, boundsList]) => {
        if (boundsList.length === 0) {
          return null;
        }

        return {
          measureNumber,
          system,
          rowIndex: 0,
          rowCount: 1,
          bounds: {
            left: Math.min(...boundsList.map((bounds) => bounds.left)),
            right: Math.max(...boundsList.map((bounds) => bounds.right)),
            top: Math.min(...boundsList.map((bounds) => bounds.top)),
            bottom: Math.max(...boundsList.map((bounds) => bounds.bottom)),
          },
        };
      })
      .filter((region): region is MeasureRegion => Boolean(region));
  });

  return normalizeMeasureRowsByVertical(rawRegions);
}

function buildMeasureHighlightRect(
  host: HTMLDivElement,
  visibleSvg: SVGSVGElement,
  visiblePage: GraphicalMusicPageLike,
  region: MeasureRegion,
  target: ScorePassageTarget,
): HighlightRect | null {
  const pageBounds = getObjectBounds(visiblePage);
  if (!pageBounds) {
    return null;
  }

  return osmdRectToDomRect(
    host,
    visibleSvg,
    pageBounds,
    {
      left: region.bounds.left - 2,
      right: Math.max(region.bounds.right + 2, region.bounds.left + 18),
      top: region.bounds.top - 4,
      bottom: region.bounds.bottom + 4,
    },
    target,
  );
}

function midpoint(left: number, right: number) {
  return left + (right - left) / 2;
}

function normalizeMeasureRowsByVertical(regions: MeasureRegion[]) {
  const rows: Array<{ regions: MeasureRegion[]; top: number; bottom: number }> = [];
  const sortedByVerticalPosition = [...regions].sort((left, right) => (
    left.bounds.top - right.bounds.top
    || left.bounds.left - right.bounds.left
    || left.measureNumber - right.measureNumber
  ));

  sortedByVerticalPosition.forEach((region) => {
    const currentRow = rows[rows.length - 1] ?? null;

    if (!currentRow || region.bounds.top > currentRow.bottom + 3) {
      rows.push({
        regions: [region],
        top: region.bounds.top,
        bottom: region.bounds.bottom,
      });
      return;
    }

    currentRow.regions.push(region);
    currentRow.top = Math.min(currentRow.top, region.bounds.top);
    currentRow.bottom = Math.max(currentRow.bottom, region.bounds.bottom);
  });

  const rowCount = Math.max(1, rows.length);

  return rows.flatMap((row, rowIndex) => {
    const sortedRow = [...row.regions].sort((left, right) => (
      left.bounds.left - right.bounds.left
      || left.measureNumber - right.measureNumber
    ));
    const rowLeft = Math.min(...sortedRow.map((region) => region.bounds.left));
    const rowRight = Math.max(...sortedRow.map((region) => region.bounds.right));
    const rowCenter = midpoint(row.top, row.bottom);
    const previousRow = rows[rowIndex - 1] ?? null;
    const nextRow = rows[rowIndex + 1] ?? null;
    const previousRowCenter = previousRow ? midpoint(previousRow.top, previousRow.bottom) : null;
    const nextRowCenter = nextRow ? midpoint(nextRow.top, nextRow.bottom) : null;
    const visualTop = previousRowCenter === null ? row.top - 8 : midpoint(previousRowCenter, rowCenter);
    const visualBottom = nextRowCenter === null ? row.bottom + 8 : midpoint(rowCenter, nextRowCenter);

    return sortedRow.map((region, index) => {
      const previous = sortedRow[index - 1] ?? null;
      const next = sortedRow[index + 1] ?? null;
      const previousBoundary = previous ? midpoint(previous.bounds.right, region.bounds.left) : rowLeft;
      const nextBoundary = next ? midpoint(region.bounds.right, next.bounds.left) : rowRight;

      return {
        ...region,
        rowIndex,
        rowCount,
        bounds: {
          left: Math.min(region.bounds.left, previousBoundary),
          right: Math.max(region.bounds.right, nextBoundary),
          top: visualTop,
          bottom: visualBottom,
        },
      };
    });
  }).sort((left, right) => left.measureNumber - right.measureNumber);
}

function getAllGraphicalMeasuresForSystem(system: MusicSystemLike) {
  return dedupeMeasures([
    ...getScopedStaffLines(system).flatMap((staffLine) => staffLine.Measures ?? []).filter(Boolean),
    ...(system.GraphicalMeasures ?? []).flat().filter(Boolean),
  ]);
}

function getScopedStaffLines(system: MusicSystemLike) {
  return (system.StaffLines ?? [])
    .filter((staffLine) => !staffLine.ParentMusicSystem || staffLine.ParentMusicSystem === system);
}

function getStableMeasureNumber(measure: GraphicalMeasureLike) {
  const sourceMeasure = measure.parentSourceMeasure;
  const sourceCandidates = [
    sourceMeasure?.MeasureNumber,
    sourceMeasure?.MeasureNumberXML,
    sourceMeasure?.MeasureNumberPrinted,
  ];

  for (const candidate of sourceCandidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }
  }

  if (typeof sourceMeasure?.getPrintedMeasureNumber === "function") {
    const printed = sourceMeasure.getPrintedMeasureNumber();
    if (typeof printed === "number" && Number.isFinite(printed)) {
      return printed;
    }
  }

  if (typeof measure.MeasureNumber === "number" && Number.isFinite(measure.MeasureNumber)) {
    return measure.MeasureNumber;
  }

  if (typeof sourceMeasure?.measureListIndex === "number" && Number.isFinite(sourceMeasure.measureListIndex)) {
    return sourceMeasure.measureListIndex + 1;
  }

  return null;
}

function dedupeMeasures(measures: GraphicalMeasureLike[]) {
  const seen = new Set<GraphicalMeasureLike>();
  return measures.filter((measure) => {
    if (seen.has(measure)) {
      return false;
    }
    seen.add(measure);
    return true;
  });
}

function getObjectBounds(object: GraphicalObjectLike | null) {
  const box = object?.PositionAndShape;
  const origin = getBoundingBoxOrigin(box);
  const leftBorder = box?.BorderLeft;
  const rightBorder = box?.BorderRight;
  const topBorder = box?.BorderTop;
  const bottomBorder = box?.BorderBottom;

  if (
    !origin
    || typeof leftBorder !== "number"
    || typeof rightBorder !== "number"
    || typeof topBorder !== "number"
    || typeof bottomBorder !== "number"
  ) {
    return null;
  }

  return {
    left: origin.x + leftBorder,
    right: origin.x + rightBorder,
    top: origin.y + topBorder,
    bottom: origin.y + bottomBorder,
  };
}

function getBoundingBoxOrigin(box: BoundingBoxLike | null | undefined): ResolvedPoint | null {
  if (!box) {
    return null;
  }

  const relativeX = box.RelativePosition?.x;
  const relativeY = box.RelativePosition?.y;

  if (typeof relativeX === "number" && typeof relativeY === "number") {
    let x = 0;
    let y = 0;
    let current: BoundingBoxLike | undefined = box;
    let guard = 0;

    while (current && guard < 40) {
      const currentRelativeX = current.RelativePosition?.x;
      const currentRelativeY = current.RelativePosition?.y;

      if (typeof currentRelativeX !== "number" || typeof currentRelativeY !== "number") {
        break;
      }

      x += currentRelativeX;
      y += currentRelativeY;
      current = current.Parent;
      guard += 1;
    }

    return { x, y };
  }

  const absoluteX = box.AbsolutePosition?.x;
  const absoluteY = box.AbsolutePosition?.y;

  if (typeof absoluteX === "number" && typeof absoluteY === "number") {
    return { x: absoluteX, y: absoluteY };
  }

  return null;
}

function osmdRectToDomRect(
  host: HTMLDivElement,
  visibleSvg: SVGSVGElement,
  pageBounds: { left: number; right: number; top: number; bottom: number },
  rect: { left: number; right: number; top: number; bottom: number },
  target: ScorePassageTarget,
): HighlightRect {
  const hostRect = host.getBoundingClientRect();
  const svgRect = visibleSvg.getBoundingClientRect();
  const pageWidth = Math.max(1, pageBounds.right - pageBounds.left);
  const scale = svgRect.width / pageWidth;

  const left = svgRect.left - hostRect.left + (rect.left - pageBounds.left) * scale;
  const svgTop = svgRect.top - hostRect.top;
  const svgBottom = svgTop + svgRect.height;
  const rawTop = svgTop + (rect.top - pageBounds.top) * scale;
  const rawBottom = rawTop + (rect.bottom - rect.top) * scale;
  const top = clamp(rawTop, svgTop, Math.max(svgTop, svgBottom - 36));
  const bottom = clamp(rawBottom, top + 36, svgBottom);
  const width = Math.max(18, (rect.right - rect.left) * scale);
  const height = Math.max(36, bottom - top);

  return { left, top, width, height, target };
}

function sameTarget(left: ScorePassageTarget | null, right: ScorePassageTarget | null) {
  if (!left || !right) {
    return false;
  }

  return left.measureNumber === right.measureNumber;
}
