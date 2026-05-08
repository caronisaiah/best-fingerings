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

type BoundingBoxLike = {
  AbsolutePosition?: PointLike;
  BorderLeft?: number;
  BorderRight?: number;
  BorderTop?: number;
  BorderBottom?: number;
};

type GraphicalObjectLike = {
  PositionAndShape?: BoundingBoxLike;
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

type ResolvedPointerTarget = {
  target: ScorePassageTarget;
  rect: HighlightRect;
};

type MeasureRegion = {
  measureNumber: number;
  system: MusicSystemLike;
  bounds: RectBounds;
  rowIndex: number;
  rowCount: number;
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
  const [hoverRect, setHoverRect] = useState<HighlightRect | null>(null);
  const [selectedRect, setSelectedRect] = useState<HighlightRect | null>(null);

  const renderCurrentView = useEffectEvent((host: HTMLDivElement, osmd: OSMD.OpenSheetMusicDisplay) => {
    const instance = osmd as OSMD.OpenSheetMusicDisplay & { Zoom: number };
    instance.Zoom = zoom;
    instance.render();
    applyPaginationAndStyling(host, viewMode, pageIndex, zoom, onPageCountChange);
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
        newPageFromXML: false,
      });

      osmdRef.current = osmd;

      await osmd.load(xml);
      if (cancelled) return;

      renderCurrentView(hostEl, osmd);
    })().catch((error) => console.error("OSMD render failed:", error));

    return () => {
      cancelled = true;
      osmdRef.current = null;
      setHoverRect(null);
      setSelectedRect(null);
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
    setSelectedRect(resolveTargetRectFromSelection(hostRef.current, osmdRef.current, pageIndex, selectedTarget));
  }, [pageIndex, selectedTarget, xmlText, zoom]);

  function resolvePointerTarget(clientX: number, clientY: number): ResolvedPointerTarget | null {
    const host = hostRef.current;
    const osmd = osmdRef.current;
    const graphicSheet = (osmd as OSMD.OpenSheetMusicDisplay & {
      GraphicSheet?: GraphicalMusicSheetLike;
    }).GraphicSheet;

    if (!host || !graphicSheet) {
      return null;
    }

    const visibleSvg = getVisibleSvg(host, pageIndex);
    if (!visibleSvg) {
      return null;
    }

    const svgRect = visibleSvg.getBoundingClientRect();
    if (
      clientX < svgRect.left
      || clientX > svgRect.right
      || clientY < svgRect.top
      || clientY > svgRect.bottom
    ) {
      return null;
    }

    const visiblePage = getVisiblePage(graphicSheet, pageIndex);
    if (!visiblePage) {
      return null;
    }

    const osmdPoint = clientPointToPagePoint(visibleSvg, visiblePage, clientX, clientY);
    if (!osmdPoint) {
      return null;
    }

    const measureRegion = findVisiblePageMeasureRegion(visibleSvg, visiblePage, clientY, osmdPoint);
    if (!measureRegion) {
      return null;
    }

    const target: ScorePassageTarget = {
      measureNumber: measureRegion.measureNumber,
      staffEntryIndex: 0,
      staffEntryCount: 1,
      tMeasBeats: null,
    };

    const rect = buildMeasureHighlightRect(host, visibleSvg, visiblePage, measureRegion, target);
    if (!rect) {
      return null;
    }

    return { target, rect };
  }

  return (
    <div className="osmdHostWrap">
      <div
        ref={hostRef}
        className="osmdHost scoreInteractiveHost"
        onMouseMove={(event) => {
          const resolved = resolvePointerTarget(event.clientX, event.clientY);
          if (!resolved) {
            setHoverRect(null);
            onHoverTargetChange?.(null);
            return;
          }

          setHoverRect(resolved.rect);
          onHoverTargetChange?.(resolved.target);
        }}
        onMouseLeave={() => {
          setHoverRect(null);
          onHoverTargetChange?.(null);
        }}
        onClick={(event) => {
          const resolved = resolvePointerTarget(event.clientX, event.clientY);
          if (resolved) {
            onSelectTarget?.(resolved.target);
          }
        }}
      />

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

function findVisiblePageMeasureRegion(
  visibleSvg: SVGSVGElement,
  visiblePage: GraphicalMusicPageLike,
  clientY: number,
  osmdPoint: { x: number; y: number },
) {
  const measureRegions = getVisiblePageMeasureRegions(visiblePage);
  const rowCount = Math.max(1, ...measureRegions.map((region) => region.rowCount));
  const rowIndex = getDomRowIndex(visibleSvg, rowCount, clientY);
  const rowRegions = measureRegions.filter((region) => region.rowIndex === rowIndex);

  const hit = rowRegions.find((region) => (
    osmdPoint.x >= region.bounds.left - 4
    && osmdPoint.x <= region.bounds.right + 4
  ));

  if (hit) {
    return hit;
  }

  const nearestRowRegion = rowRegions
    .map((region) => ({
      region,
      distance: distanceToBand(osmdPoint.x, region.bounds.left, region.bounds.right),
    }))
    .sort((left, right) => left.distance - right.distance)[0];

  if (nearestRowRegion && nearestRowRegion.distance <= 18) {
    return nearestRowRegion.region;
  }

  const systems = visiblePage.MusicSystems ?? [];
  if (systems.length === 0) {
    return null;
  }

  const system = findBestSystemForPoint(systems, osmdPoint);
  if (!system) {
    return null;
  }

  const systemRegions = getSystemMeasureRegions(system);
  const exactSystemHit = systemRegions.find((region) => (
    osmdPoint.x >= region.bounds.left - 4
    && osmdPoint.x <= region.bounds.right + 4
  ));
  if (exactSystemHit) {
    return exactSystemHit;
  }

  const nearestSystemRegion = systemRegions
    .map((region) => ({
      region,
      distance: distanceToBand(osmdPoint.x, region.bounds.left, region.bounds.right),
    }))
    .sort((left, right) => left.distance - right.distance)[0];

  return nearestSystemRegion && nearestSystemRegion.distance <= 18
    ? nearestSystemRegion.region
    : null;
}

function getDomRowIndex(visibleSvg: SVGSVGElement, rowCount: number, clientY: number) {
  const svgRect = visibleSvg.getBoundingClientRect();
  const rowHeight = Math.max(1, svgRect.height / Math.max(1, rowCount));
  return clamp(Math.floor((clientY - svgRect.top) / rowHeight), 0, rowCount - 1);
}

function getVisiblePageMeasureRegions(visiblePage: GraphicalMusicPageLike) {
  const systems = visiblePage.MusicSystems ?? [];
  const rawRegions = systems.flatMap((system) => {
    const grouped = new Map<number, RectBounds[]>();
    const measures = getAllGraphicalMeasuresForSystem(system);

    measures.forEach((measure) => {
      if (typeof measure.MeasureNumber !== "number" || measure.MeasureNumber < 0 || measure.IsExtraGraphicalMeasure) {
        return;
      }

      if (typeof measure.isVisible === "function" && !measure.isVisible()) {
        return;
      }

      const bounds = getObjectBounds(measure);
      if (!bounds) {
        return;
      }

      const current = grouped.get(measure.MeasureNumber) ?? [];
      current.push(bounds);
      grouped.set(measure.MeasureNumber, current);
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

  return normalizeMeasureRows(rawRegions);
}

function findBestSystemForPoint(systems: MusicSystemLike[], osmdPoint: { x: number; y: number }) {
  const candidates = systems
    .map((system) => {
      const bounds = getObjectBounds(system);
      if (!bounds) {
        return null;
      }

      const withinX = osmdPoint.x >= bounds.left - 12 && osmdPoint.x <= bounds.right + 12;
      const verticalDistance = distanceToBand(osmdPoint.y, bounds.top, bounds.bottom);
      return { system, withinX, verticalDistance };
    })
    .filter((candidate): candidate is { system: MusicSystemLike; withinX: boolean; verticalDistance: number } => Boolean(candidate))
    .filter((candidate) => candidate.withinX)
    .sort((left, right) => left.verticalDistance - right.verticalDistance);

  return candidates[0]?.system ?? null;
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

function resolveTargetRectFromSelection(
  host: HTMLDivElement | null,
  osmd: OSMD.OpenSheetMusicDisplay | null,
  pageIndex: number,
  target: ScorePassageTarget | null,
) {
  if (!host || !osmd || !target) {
    return null;
  }

  const graphicSheet = (osmd as OSMD.OpenSheetMusicDisplay & {
    GraphicSheet?: GraphicalMusicSheetLike;
  }).GraphicSheet;
  if (!graphicSheet) {
    return null;
  }

  const visiblePage = getVisiblePage(graphicSheet, pageIndex);
  const visibleSvg = getVisibleSvg(host, pageIndex);
  if (!visiblePage || !visibleSvg) {
    return null;
  }

  const measureRegion = getVisiblePageMeasureRegions(visiblePage)
    .find((region) => region.measureNumber === target.measureNumber) ?? null;
  if (measureRegion) {
    return buildMeasureHighlightRect(host, visibleSvg, visiblePage, measureRegion, target);
  }

  return null;
}

function getSystemMeasureRegions(system: MusicSystemLike) {
  const grouped = new Map<number, RectBounds[]>();
  const systemBounds = getObjectBounds(system);
  const staffLineBounds = getScopedStaffLines(system)
    .map(getObjectBounds)
    .filter((bounds): bounds is RectBounds => Boolean(bounds));

  const systemMeasures = getGraphicalMeasuresForSystem(system);
  systemMeasures.forEach((measure) => {
    if (typeof measure.MeasureNumber !== "number" || measure.MeasureNumber < 0 || measure.IsExtraGraphicalMeasure) {
      return;
    }

    if (typeof measure.isVisible === "function" && !measure.isVisible()) {
      return;
    }

    const bounds = getObjectBounds(measure);
    if (!bounds) {
      return;
    }

    const current = grouped.get(measure.MeasureNumber) ?? [];
    current.push(bounds);
    grouped.set(measure.MeasureNumber, current);
  });

  const rawRegions = Array.from(grouped.entries())
    .map(([measureNumber, boundsList]) => {
      if (boundsList.length === 0) {
        return null;
      }

      const rawBounds = {
        left: Math.min(...boundsList.map((bounds) => bounds.left)),
        right: Math.max(...boundsList.map((bounds) => bounds.right)),
        top: Math.min(...boundsList.map((bounds) => bounds.top)),
        bottom: Math.max(...boundsList.map((bounds) => bounds.bottom)),
      };

      return {
        measureNumber,
        system,
        rowIndex: 0,
        rowCount: 1,
        bounds: rawBounds,
      };
    })
    .filter((region): region is MeasureRegion => Boolean(region))
    .sort((left, right) => (
      left.bounds.left - right.bounds.left
      || left.measureNumber - right.measureNumber
    ));

  if (rawRegions.length === 0) {
    return rawRegions.sort((left, right) => left.measureNumber - right.measureNumber);
  }

  const systemVisualBounds = {
    left: systemBounds?.left ?? Math.min(...rawRegions.map((region) => region.bounds.left)),
    right: systemBounds?.right ?? Math.max(...rawRegions.map((region) => region.bounds.right)),
    top: staffLineBounds.length > 0
      ? Math.min(...staffLineBounds.map((bounds) => bounds.top)) - 8
      : Math.min(...rawRegions.map((region) => region.bounds.top)) - 6,
    bottom: staffLineBounds.length > 0
      ? Math.max(...staffLineBounds.map((bounds) => bounds.bottom)) + 8
      : Math.max(...rawRegions.map((region) => region.bounds.bottom)) + 6,
  };

  return rawRegions
    .map((region, index) => {
      const previous = rawRegions[index - 1] ?? null;
      const next = rawRegions[index + 1] ?? null;
      const previousBoundary = previous ? midpoint(previous.bounds.right, region.bounds.left) : systemVisualBounds.left;
      const nextBoundary = next ? midpoint(region.bounds.right, next.bounds.left) : systemVisualBounds.right;

      return {
        ...region,
        bounds: {
          left: Math.min(region.bounds.left, Math.max(systemVisualBounds.left, previousBoundary)),
          right: Math.max(region.bounds.right, Math.min(systemVisualBounds.right, nextBoundary)),
          top: systemVisualBounds.top,
          bottom: systemVisualBounds.bottom,
        },
      };
    })
    .sort((left, right) => left.measureNumber - right.measureNumber);
}

function midpoint(left: number, right: number) {
  return left + (right - left) / 2;
}

function normalizeMeasureRows(regions: MeasureRegion[]) {
  const rows: MeasureRegion[][] = [];
  const sortedByMeasure = [...regions].sort((left, right) => left.measureNumber - right.measureNumber);

  sortedByMeasure.forEach((region) => {
    const currentRow = rows[rows.length - 1] ?? null;

    if (!currentRow) {
      rows.push([region]);
      return;
    }

    const previous = currentRow[currentRow.length - 1];
    const leftReset = previous && region.bounds.left < previous.bounds.left - 20;

    if (!leftReset) {
      currentRow.push(region);
      return;
    }

    rows.push([region]);
  });

  const rowCount = Math.max(1, rows.length);

  return rows.flatMap((row, rowIndex) => {
    const sortedRow = [...row].sort((left, right) => (
      left.bounds.left - right.bounds.left
      || left.measureNumber - right.measureNumber
    ));
    const rowTop = Math.min(...sortedRow.map((region) => region.bounds.top)) - 8;
    const rowBottom = Math.max(...sortedRow.map((region) => region.bounds.bottom)) + 8;
    const rowLeft = Math.min(...sortedRow.map((region) => region.bounds.left));
    const rowRight = Math.max(...sortedRow.map((region) => region.bounds.right));

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
          top: rowTop,
          bottom: rowBottom,
        },
      };
    });
  }).sort((left, right) => left.measureNumber - right.measureNumber);
}

function getGraphicalMeasuresForSystem(system: MusicSystemLike) {
  const staffLines = getScopedStaffLines(system);
  const fromStaffLines = staffLines
    .flatMap((staffLine) => staffLine.Measures ?? [])
    .filter(Boolean)
    .filter((measure) => measureBelongsToSystem(measure, system));
  if (fromStaffLines.length > 0) {
    return dedupeMeasures(fromStaffLines);
  }

  const fromGraphicalMeasures = (system.GraphicalMeasures ?? [])
    .flat()
    .filter(Boolean)
    .filter((measure) => measureBelongsToSystem(measure, system));
  return dedupeMeasures(fromGraphicalMeasures);
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

function measureBelongsToSystem(measure: GraphicalMeasureLike, system: MusicSystemLike) {
  if (measure.ParentMusicSystem) {
    return measure.ParentMusicSystem === system;
  }

  if (measure.ParentStaffLine?.ParentMusicSystem) {
    return measure.ParentStaffLine.ParentMusicSystem === system;
  }

  return true;
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
  const absoluteX = box?.AbsolutePosition?.x;
  const absoluteY = box?.AbsolutePosition?.y;
  const leftBorder = box?.BorderLeft;
  const rightBorder = box?.BorderRight;
  const topBorder = box?.BorderTop;
  const bottomBorder = box?.BorderBottom;

  if (
    typeof absoluteX !== "number"
    || typeof absoluteY !== "number"
    || typeof leftBorder !== "number"
    || typeof rightBorder !== "number"
    || typeof topBorder !== "number"
    || typeof bottomBorder !== "number"
  ) {
    return null;
  }

  return {
    left: absoluteX + leftBorder,
    right: absoluteX + rightBorder,
    top: absoluteY + topBorder,
    bottom: absoluteY + bottomBorder,
  };
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
  const pageHeight = Math.max(1, pageBounds.bottom - pageBounds.top);
  const scaleX = svgRect.width / pageWidth;
  const scaleY = svgRect.height / pageHeight;

  const left = svgRect.left - hostRect.left + (rect.left - pageBounds.left) * scaleX;
  const top = svgRect.top - hostRect.top + (rect.top - pageBounds.top) * scaleY;
  const width = Math.max(18, (rect.right - rect.left) * scaleX);
  const height = Math.max(36, (rect.bottom - rect.top) * scaleY);

  return { left, top, width, height, target };
}

function clientPointToPagePoint(
  visibleSvg: SVGSVGElement,
  visiblePage: GraphicalMusicPageLike,
  clientX: number,
  clientY: number,
) {
  const pageBounds = getObjectBounds(visiblePage);
  if (!pageBounds) {
    return null;
  }

  const svgRect = visibleSvg.getBoundingClientRect();
  const pageWidth = Math.max(1, pageBounds.right - pageBounds.left);
  const pageHeight = Math.max(1, pageBounds.bottom - pageBounds.top);
  const scaleX = pageWidth / Math.max(1, svgRect.width);
  const scaleY = pageHeight / Math.max(1, svgRect.height);

  return {
    x: pageBounds.left + (clientX - svgRect.left) * scaleX,
    y: pageBounds.top + (clientY - svgRect.top) * scaleY,
  };
}

function distanceToBand(value: number, min: number, max: number) {
  if (value < min) {
    return min - value;
  }
  if (value > max) {
    return value - max;
  }
  return 0;
}

function sameTarget(left: ScorePassageTarget | null, right: ScorePassageTarget | null) {
  if (!left || !right) {
    return false;
  }

  return left.measureNumber === right.measureNumber;
}
