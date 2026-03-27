// src/ScoreView.tsx
import { useEffect, useEffectEvent, useRef, useState } from "react";
import * as OSMD from "opensheetmusicdisplay";
import type { NoteEditorItem } from "./fingeringEditor";

type ViewMode = "page" | "scroll";

type MeasureOverlay = {
  key: string;
  measureNumber: number;
  pageIndex: number;
  left: number;
  top: number;
  width: number;
  height: number;
};

type NoteOverlay = {
  key: string;
  noteId: string;
  pageIndex: number;
  left: number;
  top: number;
  width: number;
  height: number;
};

type Props = {
  xmlText: string | null;
  viewMode?: ViewMode;
  pageIndex?: number; // 0-based
  zoom?: number; // 1.0 = 100%
  onPageCountChange?: (count: number) => void;
  selectableNotes?: NoteEditorItem[];
  selectedNoteId?: string | null;
  onNoteSelect?: (noteId: string) => void;
  selectedMeasure?: number | null;
  hoveredMeasure?: number | null;
  onMeasureHoverChange?: (measure: number | null) => void;
  onMeasureSelect?: (measure: number) => void;
};

export function ScoreView({
  xmlText,
  viewMode = "page",
  pageIndex = 0,
  zoom = 1.0,
  onPageCountChange,
  selectableNotes = [],
  selectedNoteId = null,
  onNoteSelect,
  selectedMeasure = null,
  hoveredMeasure = null,
  onMeasureHoverChange,
  onMeasureSelect,
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const osmdRef = useRef<OSMD.OpenSheetMusicDisplay | null>(null);
  const [measureOverlays, setMeasureOverlays] = useState<MeasureOverlay[]>([]);
  const [noteOverlays, setNoteOverlays] = useState<NoteOverlay[]>([]);

  const syncMeasureOverlays = useEffectEvent((host: HTMLDivElement, osmd: OSMD.OpenSheetMusicDisplay) => {
    setMeasureOverlays(collectMeasureOverlays(host, osmd));
  });
  const syncNoteOverlays = useEffectEvent((host: HTMLDivElement, osmd: OSMD.OpenSheetMusicDisplay) => {
    setNoteOverlays(collectNoteOverlays(host, osmd, selectableNotes));
  });

  const renderCurrentView = useEffectEvent((host: HTMLDivElement, osmd: OSMD.OpenSheetMusicDisplay) => {
    const instance = osmd as OSMD.OpenSheetMusicDisplay & { Zoom: number };
    instance.Zoom = zoom;
    instance.render();
    applyPaginationAndStyling(host, viewMode, pageIndex, zoom, onPageCountChange);
    syncMeasureOverlays(host, osmd);
    syncNoteOverlays(host, osmd);
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
      setMeasureOverlays([]);
      setNoteOverlays([]);
    };
  }, [xmlText]); // only reload when XML changes

  // Re-apply zoom/page mode without reloading XML
  useEffect(() => {
    const host = hostRef.current;
    const osmd = osmdRef.current;
    if (!host || !osmd) return;

    if (typeof xmlText !== "string" || xmlText.length === 0) return;

    renderCurrentView(host, osmd);
  }, [zoom, viewMode, pageIndex, xmlText, selectableNotes]);

  useEffect(() => {
    const host = hostRef.current;
    const osmd = osmdRef.current;

    if (!host || !osmd) {
      return;
    }

    const observer = new ResizeObserver(() => {
      syncMeasureOverlays(host, osmd);
      syncNoteOverlays(host, osmd);
    });

    observer.observe(host);
    return () => observer.disconnect();
  }, [xmlText]);

  const visibleOverlays = measureOverlays.filter((overlay) => (
    viewMode === "scroll" ? true : overlay.pageIndex === pageIndex
  ));
  const visibleNoteOverlays = noteOverlays.filter((overlay) => (
    viewMode === "scroll" ? true : overlay.pageIndex === pageIndex
  ));

  return (
    <div className="osmdHostWrap">
      <div
        ref={hostRef}
        className="osmdHost"
        onMouseLeave={() => onMeasureHoverChange?.(null)}
      />

      {visibleOverlays.length > 0 ? (
        <div className="measureOverlayLayer" aria-hidden="true">
          {visibleOverlays.map((overlay) => {
            const isSelected = selectedMeasure === overlay.measureNumber;
            const isHovered = hoveredMeasure === overlay.measureNumber;

            return (
              <button
                key={overlay.key}
                type="button"
                className={[
                  "measureOverlay",
                  isSelected ? "measureOverlay-selected" : "",
                  isHovered ? "measureOverlay-hovered" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                style={{
                  left: overlay.left,
                  top: overlay.top,
                  width: overlay.width,
                  height: overlay.height,
                }}
                onMouseEnter={() => onMeasureHoverChange?.(overlay.measureNumber)}
                onFocus={() => onMeasureHoverChange?.(overlay.measureNumber)}
                onBlur={() => onMeasureHoverChange?.(null)}
                onClick={() => onMeasureSelect?.(overlay.measureNumber)}
                title={`Measure ${overlay.measureNumber}`}
              >
                <span className="measureOverlayLabel">m.{overlay.measureNumber}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      {visibleNoteOverlays.length > 0 ? (
        <div className="noteOverlayLayer">
          {visibleNoteOverlays.map((overlay) => (
            <button
              key={overlay.key}
              type="button"
              className={[
                "noteOverlay",
                selectedNoteId === overlay.noteId ? "noteOverlay-selected" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              style={{
                left: overlay.left,
                top: overlay.top,
                width: overlay.width,
                height: overlay.height,
              }}
              onClick={() => onNoteSelect?.(overlay.noteId)}
              title="Select note"
            />
          ))}
        </div>
      ) : null}
    </div>
  );
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

function collectMeasureOverlays(host: HTMLDivElement, osmd: OSMD.OpenSheetMusicDisplay): MeasureOverlay[] {
  const graphicSheet = (osmd as OSMD.OpenSheetMusicDisplay & {
    GraphicSheet?: {
      MusicPages?: unknown[];
    };
  }).GraphicSheet;
  const pages = Array.isArray(graphicSheet?.MusicPages) ? graphicSheet.MusicPages : [];
  const svgs = Array.from(host.querySelectorAll("svg")) as SVGSVGElement[];
  const overlays: MeasureOverlay[] = [];
  const hostRect = host.getBoundingClientRect();

  pages.forEach((pageCandidate, pageIdx) => {
    const page = pageCandidate as {
      MusicSystems?: unknown[];
      PositionAndShape?: unknown;
    };
    const svg = svgs[pageIdx];
    if (!svg) {
      return;
    }

    const pageOrigin = getPageOrigin(page.PositionAndShape);
    const scale = getSvgScale(svg);
    const systems = Array.isArray(page.MusicSystems) ? page.MusicSystems : [];

    systems.forEach((systemCandidate, systemIdx) => {
      const system = systemCandidate as {
        GraphicalMeasures?: unknown[][];
      };
      const groupedMeasures = new Map<number, { left: number; top: number; right: number; bottom: number }>();
      const rows = Array.isArray(system.GraphicalMeasures) ? system.GraphicalMeasures : [];

      rows.flat().forEach((measureCandidate) => {
        const measure = measureCandidate as {
          IsExtraGraphicalMeasure?: boolean;
          MeasureNumber?: number;
          PositionAndShape?: unknown;
        };
        if (!measure || measure.IsExtraGraphicalMeasure) {
          return;
        }

        const measureNumber = typeof measure.MeasureNumber === "number" ? measure.MeasureNumber : null;
        if (measureNumber == null || measureNumber < 1) {
          return;
        }

        const rect = getBoundingRect(measure.PositionAndShape);
        if (!rect) {
          return;
        }

        const localLeft = Math.max(0, rect.x - pageOrigin.x);
        const localTop = Math.max(0, rect.y - pageOrigin.y);
        const localRight = Math.max(localLeft, localLeft + rect.width);
        const localBottom = Math.max(localTop, localTop + rect.height);
        const existing = groupedMeasures.get(measureNumber);

        if (!existing) {
          groupedMeasures.set(measureNumber, {
            left: localLeft,
            top: localTop,
            right: localRight,
            bottom: localBottom,
          });
          return;
        }

        existing.left = Math.min(existing.left, localLeft);
        existing.top = Math.min(existing.top, localTop);
        existing.right = Math.max(existing.right, localRight);
        existing.bottom = Math.max(existing.bottom, localBottom);
      });

      groupedMeasures.forEach((rect, measureNumber) => {
        const svgRect = svg.getBoundingClientRect();
        const svgLeft = svgRect.left - hostRect.left + host.scrollLeft;
        const svgTop = svgRect.top - hostRect.top + host.scrollTop;

        overlays.push({
          key: `page-${pageIdx}-system-${systemIdx}-measure-${measureNumber}`,
          measureNumber,
          pageIndex: pageIdx,
          left: svgLeft + rect.left * scale.x,
          top: svgTop + rect.top * scale.y,
          width: Math.max(18, (rect.right - rect.left) * scale.x),
          height: Math.max(18, (rect.bottom - rect.top) * scale.y),
        });
      });
    });
  });

  return overlays;
}

function collectNoteOverlays(
  host: HTMLDivElement,
  osmd: OSMD.OpenSheetMusicDisplay,
  selectableNotes: NoteEditorItem[],
): NoteOverlay[] {
  if (selectableNotes.length === 0) {
    return [];
  }

  const graphicSheet = (osmd as OSMD.OpenSheetMusicDisplay & {
    GraphicSheet?: {
      MusicPages?: unknown[];
    };
  }).GraphicSheet;
  const pages = Array.isArray(graphicSheet?.MusicPages) ? graphicSheet.MusicPages : [];
  const svgs = Array.from(host.querySelectorAll("svg")) as SVGSVGElement[];
  const hostRect = host.getBoundingClientRect();
  const renderedNotes: Array<{
    pageIndex: number;
    measure: number;
    staffNumber: number;
    pitchMidi: number;
    left: number;
    top: number;
    width: number;
    height: number;
  }> = [];

  pages.forEach((pageCandidate, pageIdx) => {
    const page = pageCandidate as {
      MusicSystems?: unknown[];
      PositionAndShape?: unknown;
    };
    const svg = svgs[pageIdx];
    if (!svg) {
      return;
    }

    const svgRect = svg.getBoundingClientRect();
    const svgLeft = svgRect.left - hostRect.left + host.scrollLeft;
    const svgTop = svgRect.top - hostRect.top + host.scrollTop;
    const pageOrigin = getPageOrigin(page.PositionAndShape);
    const scale = getSvgScale(svg);
    const systems = Array.isArray(page.MusicSystems) ? page.MusicSystems : [];

    systems.forEach((systemCandidate) => {
      const system = systemCandidate as {
        GraphicalMeasures?: unknown[][];
      };
      const rows = Array.isArray(system.GraphicalMeasures) ? system.GraphicalMeasures : [];

      rows.forEach((row, rowIndex) => {
        row.forEach((measureCandidate) => {
          const measure = measureCandidate as {
            MeasureNumber?: number;
            staffEntries?: unknown[];
          };
          const measureNumber = typeof measure.MeasureNumber === "number" ? measure.MeasureNumber : null;
          if (measureNumber == null || !Array.isArray(measure.staffEntries)) {
            return;
          }

          measure.staffEntries.forEach((entryCandidate) => {
            const entry = entryCandidate as {
              graphicalVoiceEntries?: Array<{ notes?: unknown[] }>;
            };
            const voiceEntries = Array.isArray(entry.graphicalVoiceEntries) ? entry.graphicalVoiceEntries : [];

            voiceEntries.forEach((voiceEntry) => {
              const notes = Array.isArray(voiceEntry.notes) ? voiceEntry.notes : [];

              notes.forEach((noteCandidate) => {
                const note = noteCandidate as {
                  sourceNote?: {
                    isRest?: () => boolean;
                    Pitch?: { getHalfTone?: () => number };
                    halfTone?: number;
                  };
                  PositionAndShape?: unknown;
                };

                const sourceNote = note.sourceNote;
                if (sourceNote?.isRest?.()) {
                  return;
                }

                const rect = getBoundingRect(note.PositionAndShape);
                if (!rect) {
                  return;
                }

                const rawPitch = sourceNote?.Pitch?.getHalfTone?.() ?? sourceNote?.halfTone;
                if (typeof rawPitch !== "number") {
                  return;
                }

                const localLeft = Math.max(0, rect.x - pageOrigin.x);
                const localTop = Math.max(0, rect.y - pageOrigin.y);

                renderedNotes.push({
                  pageIndex: pageIdx,
                  measure: measureNumber,
                  staffNumber: rowIndex + 1,
                  pitchMidi: rawPitch,
                  left: svgLeft + localLeft * scale.x - 4,
                  top: svgTop + localTop * scale.y - 4,
                  width: Math.max(14, rect.width * scale.x + 8),
                  height: Math.max(14, rect.height * scale.y + 8),
                });
              });
            });
          });
        });
      });
    });
  });

  return mapRenderedNotesToSelectable(renderedNotes, selectableNotes);
}

function mapRenderedNotesToSelectable(
  renderedNotes: Array<{
    pageIndex: number;
    measure: number;
    staffNumber: number;
    pitchMidi: number;
    left: number;
    top: number;
    width: number;
    height: number;
  }>,
  selectableNotes: NoteEditorItem[],
): NoteOverlay[] {
  const buckets = new Map<string, NoteEditorItem[]>();

  selectableNotes
    .filter((note): note is NoteEditorItem & { measure: number } => typeof note.measure === "number")
    .forEach((note) => {
      const key = createNoteBucketKey(note.measure, note.staffNumber, note.pitchMidi);
      const existing = buckets.get(key) ?? [];
      existing.push(note);
      buckets.set(key, existing);
    });

  const usage = new Map<string, number>();
  const overlays: NoteOverlay[] = [];

  renderedNotes.forEach((note, index) => {
    const exactKey = createNoteBucketKey(note.measure, note.staffNumber, note.pitchMidi);
    const looseKey = createNoteBucketKey(note.measure, null, note.pitchMidi);
    const matchingKey = buckets.has(exactKey) ? exactKey : looseKey;
    const candidates = buckets.get(matchingKey);
    if (!candidates || candidates.length === 0) {
      return;
    }

    const usedCount = usage.get(matchingKey) ?? 0;
    const selected = candidates[usedCount];
    if (!selected) {
      return;
    }

    usage.set(matchingKey, usedCount + 1);
    overlays.push({
      key: `note-${selected.noteId}-${index}`,
      noteId: selected.noteId,
      pageIndex: note.pageIndex,
      left: note.left,
      top: note.top,
      width: note.width,
      height: note.height,
    });
  });

  return overlays;
}

function createNoteBucketKey(measure: number, staffNumber: number | null, pitchMidi: number) {
  return `${measure}|${staffNumber ?? "any"}|${pitchMidi}`;
}

function getPageOrigin(positionAndShape: unknown) {
  const rect = getBoundingRect(positionAndShape);
  if (rect) {
    return { x: rect.x, y: rect.y };
  }

  const absolute = (positionAndShape as { AbsolutePosition?: { x?: number; y?: number } } | null)?.AbsolutePosition;
  return {
    x: absolute?.x ?? 0,
    y: absolute?.y ?? 0,
  };
}

function getBoundingRect(positionAndShape: unknown) {
  const shape = positionAndShape as {
    BoundingMarginRectangle?: { x: number; y: number; width: number; height: number };
    BoundingRectangle?: { x: number; y: number; width: number; height: number };
  } | null;
  const rect = shape?.BoundingMarginRectangle ?? shape?.BoundingRectangle;
  if (!rect) {
    return null;
  }

  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
  };
}

function getSvgScale(svg: SVGSVGElement) {
  const viewBox = svg.viewBox?.baseVal;
  const widthUnits = viewBox?.width || svg.clientWidth || 1;
  const heightUnits = viewBox?.height || svg.clientHeight || 1;

  return {
    x: svg.clientWidth / widthUnits,
    y: svg.clientHeight / heightUnits,
  };
}
