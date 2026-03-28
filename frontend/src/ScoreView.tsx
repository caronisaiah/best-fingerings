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

type FractionLike = {
  RealValue?: number;
  realValue?: number;
  WholeValue?: number;
  wholeValue?: number;
  Numerator?: number;
  numerator?: number;
  Denominator?: number;
  denominator?: number;
};

type GraphicalMusicPageLike = GraphicalObjectLike & {
  PageNumber?: number;
  MusicSystems?: MusicSystemLike[];
};

type MusicSystemLike = GraphicalObjectLike & {
  Parent?: GraphicalMusicPageLike;
  StaffLines?: StaffLineLike[];
};

type GraphicalMeasureLike = GraphicalObjectLike & {
  MeasureNumber?: number;
  staffEntries?: unknown[];
  ParentMusicSystem?: MusicSystemLike;
  ParentStaffLine?: StaffLineLike;
};

type SourceStaffEntryLike = {
  Timestamp?: FractionLike;
  hasNotes?: () => boolean;
};

type GraphicalStaffEntryLike = GraphicalObjectLike & {
  parentMeasure?: GraphicalMeasureLike;
  ParentMeasure?: GraphicalMeasureLike;
  relInMeasureTimestamp?: FractionLike;
  sourceStaffEntry?: SourceStaffEntryLike;
  SourceStaffEntry?: SourceStaffEntryLike;
  graphicalVoiceEntries?: unknown[];
  getAbsoluteStartAndEnd?: () => [number, number];
};

type StaffLineLike = GraphicalObjectLike & {
  ParentMusicSystem?: MusicSystemLike;
  findClosestStaffEntry?: (xPosition: number) => unknown;
};

type GraphicalMusicSheetLike = {
  domToSvg?: (point: { x: number; y: number }) => { x: number; y: number };
  svgToOsmd?: (point: { x: number; y: number }) => { x: number; y: number };
  MusicPages?: GraphicalMusicPageLike[];
};

type ResolvedPointerTarget = {
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

    const domPoint = { x: clientX, y: clientY };
    const svgPoint = graphicSheet.domToSvg ? graphicSheet.domToSvg(domPoint) : domPoint;
    const osmdPoint = graphicSheet.svgToOsmd ? graphicSheet.svgToOsmd(svgPoint) : svgPoint;
    const visiblePage = getVisiblePage(graphicSheet, pageIndex);
    if (!visiblePage) {
      return null;
    }

    const staffEntry = findVisiblePageStaffEntry(visiblePage, osmdPoint);
    if (!staffEntry) {
      return null;
    }

    const measure = getParentMeasure(staffEntry);
    const measureNumber = typeof measure?.MeasureNumber === "number" ? measure.MeasureNumber : null;
    if (measureNumber == null) {
      return null;
    }

    const interactiveEntries = getInteractiveStaffEntries(measure);
    const staffEntryIndex = Math.max(0, interactiveEntries.indexOf(staffEntry));
    const staffEntryCount = Math.max(1, interactiveEntries.length);
    const tMeasBeats = getFractionRealValue(
      staffEntry.relInMeasureTimestamp
      ?? staffEntry.sourceStaffEntry?.Timestamp
      ?? staffEntry.SourceStaffEntry?.Timestamp
      ?? null,
    );

    const target: ScorePassageTarget = {
      measureNumber,
      staffEntryIndex,
      staffEntryCount,
      tMeasBeats,
    };

    const rect = buildHighlightRect(host, visibleSvg, visiblePage, staffEntry, interactiveEntries, target);
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

function getParentMeasure(staffEntry: GraphicalStaffEntryLike | null) {
  return staffEntry?.parentMeasure ?? staffEntry?.ParentMeasure ?? null;
}

function getInteractiveStaffEntries(parentMeasure: GraphicalMeasureLike | null) {
  const entries = Array.isArray(parentMeasure?.staffEntries) ? [...parentMeasure.staffEntries] as GraphicalStaffEntryLike[] : [];

  const filtered = entries.filter((entry) => {
    const sourceStaffEntry = entry.sourceStaffEntry ?? entry.SourceStaffEntry;
    if (typeof sourceStaffEntry?.hasNotes === "function") {
      return sourceStaffEntry.hasNotes();
    }
    return Array.isArray(entry.graphicalVoiceEntries) ? entry.graphicalVoiceEntries.length > 0 : true;
  });

  filtered.sort((left, right) => {
    const leftTime = getFractionRealValue(left.relInMeasureTimestamp ?? left.sourceStaffEntry?.Timestamp ?? null) ?? 0;
    const rightTime = getFractionRealValue(right.relInMeasureTimestamp ?? right.sourceStaffEntry?.Timestamp ?? null) ?? 0;
    return leftTime - rightTime;
  });

  return filtered;
}

function findVisiblePageStaffEntry(visiblePage: GraphicalMusicPageLike, osmdPoint: { x: number; y: number }) {
  const systems = visiblePage.MusicSystems ?? [];
  if (systems.length === 0) {
    return null;
  }

  const system = findBestSystemForPoint(systems, osmdPoint);
  if (!system) {
    return null;
  }

  const staffLines = system.StaffLines ?? [];
  if (staffLines.length === 0) {
    return null;
  }

  const closestStaffLine = findClosestStaffLine(staffLines, osmdPoint.y);
  if (!closestStaffLine?.findClosestStaffEntry) {
    return null;
  }

  const staffEntry = closestStaffLine.findClosestStaffEntry(osmdPoint.x) as GraphicalStaffEntryLike | null;
  if (!staffEntry) {
    return null;
  }

  const staffEntryPage = getPageOfStaffEntry(staffEntry);
  if (staffEntryPage && staffEntryPage !== visiblePage) {
    return null;
  }

  return staffEntry;
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

function findClosestStaffLine(staffLines: StaffLineLike[], y: number) {
  const ranked = staffLines
    .map((staffLine) => {
      const bounds = getObjectBounds(staffLine);
      if (!bounds) {
        return null;
      }
      return {
        staffLine,
        distance: distanceToBand(y, bounds.top, bounds.bottom),
      };
    })
    .filter((entry): entry is { staffLine: StaffLineLike; distance: number } => Boolean(entry))
    .sort((left, right) => left.distance - right.distance);

  return ranked[0]?.staffLine ?? null;
}

function buildHighlightRect(
  host: HTMLDivElement,
  visibleSvg: SVGSVGElement,
  visiblePage: GraphicalMusicPageLike,
  staffEntry: GraphicalStaffEntryLike,
  interactiveEntries: GraphicalStaffEntryLike[],
  target: ScorePassageTarget,
): HighlightRect | null {
  const measure = getParentMeasure(staffEntry);
  const system = measure?.ParentMusicSystem ?? measure?.ParentStaffLine?.ParentMusicSystem ?? null;
  const staffLines = system?.StaffLines ?? [];
  const firstStaffLine = staffLines[0] ?? null;
  const lastStaffLine = staffLines[staffLines.length - 1] ?? firstStaffLine;
  const pageBounds = getObjectBounds(visiblePage);
  const firstStaffBounds = firstStaffLine ? getObjectBounds(firstStaffLine) : null;
  const lastStaffBounds = lastStaffLine ? getObjectBounds(lastStaffLine) : firstStaffBounds;
  const measureBounds = measure ? getObjectBounds(measure) : null;

  if (!pageBounds || !firstStaffBounds || !lastStaffBounds || !measureBounds) {
    return null;
  }

  const currentEntry = interactiveEntries[target.staffEntryIndex] ?? staffEntry;
  const nextEntry = interactiveEntries[target.staffEntryIndex + 1] ?? null;
  const currentSpan = getStaffEntrySpan(currentEntry);
  const nextSpan = nextEntry ? getStaffEntrySpan(nextEntry) : null;

  const left = currentSpan?.left ?? measureBounds.left;
  const right = nextSpan?.left ?? currentSpan?.right ?? measureBounds.right;
  const safeRight = Math.max(right, left + 18);

  return osmdRectToDomRect(
    host,
    visibleSvg,
    pageBounds,
    {
      left: left - 2,
      right: safeRight + 2,
      top: firstStaffBounds.top - 4,
      bottom: lastStaffBounds.bottom + 4,
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

  const systems = visiblePage.MusicSystems ?? [];
  for (const system of systems) {
    const staffLines = system.StaffLines ?? [];
    for (const staffLine of staffLines) {
      const staffLineBounds = getObjectBounds(staffLine);
      if (!staffLineBounds) {
        continue;
      }

      const candidateMeasures = getSystemMeasuresByNumber(system, target.measureNumber);
      for (const measure of candidateMeasures) {
        const interactiveEntries = getInteractiveStaffEntries(measure);
        const entry = interactiveEntries[target.staffEntryIndex];
        if (!entry) {
          continue;
        }

        const entryTime = getFractionRealValue(
          entry.relInMeasureTimestamp
          ?? entry.sourceStaffEntry?.Timestamp
          ?? entry.SourceStaffEntry?.Timestamp
          ?? null,
        );
        if (
          target.tMeasBeats != null
          && entryTime != null
          && Math.abs(target.tMeasBeats - entryTime) > 0.001
        ) {
          continue;
        }

        return buildHighlightRect(host, visibleSvg, visiblePage, entry, interactiveEntries, target);
      }
    }
  }

  return null;
}

function getSystemMeasuresByNumber(system: MusicSystemLike, measureNumber: number) {
  const staffLines = system.StaffLines ?? [];
  const measures = staffLines.flatMap((staffLine) => {
    const measuresList = (staffLine as { Measures?: GraphicalMeasureLike[] }).Measures ?? [];
    return measuresList.filter((measure) => measure.MeasureNumber === measureNumber);
  });

  const unique = new Set<GraphicalMeasureLike>();
  return measures.filter((measure) => {
    if (unique.has(measure)) {
      return false;
    }
    unique.add(measure);
    return true;
  });
}

function getPageOfStaffEntry(staffEntry: GraphicalStaffEntryLike) {
  return getParentMeasure(staffEntry)?.ParentMusicSystem?.Parent ?? null;
}

function getStaffEntrySpan(staffEntry: GraphicalStaffEntryLike | null) {
  if (!staffEntry) {
    return null;
  }

  if (typeof staffEntry.getAbsoluteStartAndEnd === "function") {
    const [left, right] = staffEntry.getAbsoluteStartAndEnd();
    return { left, right };
  }

  const bounds = getObjectBounds(staffEntry);
  if (!bounds) {
    return null;
  }

  return {
    left: bounds.left,
    right: bounds.right,
  };
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

  const left = svgRect.left - hostRect.left + host.scrollLeft + (rect.left - pageBounds.left) * scaleX;
  const top = svgRect.top - hostRect.top + host.scrollTop + (rect.top - pageBounds.top) * scaleY;
  const width = Math.max(18, (rect.right - rect.left) * scaleX);
  const height = Math.max(36, (rect.bottom - rect.top) * scaleY);

  return { left, top, width, height, target };
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

function getFractionRealValue(value: FractionLike | null) {
  if (!value) {
    return null;
  }

  if (typeof value.RealValue === "number") {
    return value.RealValue;
  }

  if (typeof value.realValue === "number") {
    return value.realValue;
  }

  const wholeValue = typeof value.WholeValue === "number"
    ? value.WholeValue
    : typeof value.wholeValue === "number"
      ? value.wholeValue
      : 0;
  const numerator = typeof value.Numerator === "number"
    ? value.Numerator
    : typeof value.numerator === "number"
      ? value.numerator
      : 0;
  const denominator = typeof value.Denominator === "number"
    ? value.Denominator
    : typeof value.denominator === "number"
      ? value.denominator
      : 1;

  if (!denominator) {
    return wholeValue + numerator;
  }

  return wholeValue + numerator / denominator;
}

function sameTarget(left: ScorePassageTarget | null, right: ScorePassageTarget | null) {
  if (!left || !right) {
    return false;
  }

  const sameMeasure = left.measureNumber === right.measureNumber;
  const sameIndex = left.staffEntryIndex === right.staffEntryIndex;
  const sameTime = left.tMeasBeats == null || right.tMeasBeats == null
    ? true
    : Math.abs(left.tMeasBeats - right.tMeasBeats) < 0.0001;

  return sameMeasure && sameIndex && sameTime;
}
