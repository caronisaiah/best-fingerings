import { Suspense, lazy, startTransition, useDeferredValue, useEffect, useMemo, useState } from "react";
import "./App.css";

import { getJob, getResult, getResultByKey, postFingerings } from "./api";
import brandPortrait from "../assets/Metner_N.K._Postcard-1910.jpg";
import {
  applyManualEdits,
  flattenFingeringItems,
  getKeyboardPreviewChunksForMeasure,
  getDisplayedFinger,
  type NoteEditorItem,
  validateFingerEdit,
} from "./fingeringEditor";
import { fileToMusicXMLText, injectFingerings } from "./musicxml";
import { PianoKeyboard } from "./components/PianoKeyboard";
import type { ResultPayload, ScorePassageTarget } from "./types";

const LazyScoreView = lazy(async () => {
  const module = await import("./ScoreView");
  return { default: module.ScoreView };
});

type Status = "idle" | "uploading" | "queued" | "running" | "done" | "error";

function downloadText(filename: string, text: string, mime: string) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function xmlDownloadName(file: File | null) {
  if (!file) {
    return "best-fingerings.musicxml";
  }
  const stem = file.name.replace(/\.(xml|musicxml|mxl)$/i, "");
  return `${stem}.fingered.musicxml`;
}

function toErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function midiToNoteName(midi: number) {
  const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const octave = Math.floor(midi / 12) - 1;
  return `${names[midi % 12]} ${octave}`;
}

function humanStatus(status: Status) {
  switch (status) {
    case "uploading":
      return "Uploading";
    case "queued":
      return "Queued";
    case "running":
      return "Generating";
    case "done":
      return "Ready";
    case "error":
      return "Attention needed";
    default:
      return "Ready";
  }
}

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [difficulty, setDifficulty] = useState("standard");
  const [styleBias, setStyleBias] = useState("neutral");
  const [handSize, setHandSize] = useState("medium");
  const [articulationBias, setArticulationBias] = useState("auto");
  const [forceRecompute, setForceRecompute] = useState(false);

  const [status, setStatus] = useState<Status>("idle");
  const [jobId, setJobId] = useState<string | null>(null);
  const [resultKey, setResultKey] = useState<string | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);

  const [serverPayload, setServerPayload] = useState<ResultPayload | null>(null);
  const [annotatedXml, setAnnotatedXml] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [manualEdits, setManualEdits] = useState<Record<string, number>>({});
  const [lockedNoteFingerings, setLockedNoteFingerings] = useState<Record<string, number>>({});
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [selectedMeasureNumber, setSelectedMeasureNumber] = useState<number | null>(null);
  const [hoveredTarget, setHoveredTarget] = useState<ScorePassageTarget | null>(null);
  const [keyboardTrayOpen, setKeyboardTrayOpen] = useState(false);
  const [selectedChunkIndex, setSelectedChunkIndex] = useState(0);
  const [keyboardPlaying, setKeyboardPlaying] = useState(false);

  const [zoom, setZoom] = useState(1.0);
  const [pageIndex, setPageIndex] = useState(0);
  const [pageCount, setPageCount] = useState(1);

  const effectiveEdits = useMemo(
    () => ({ ...lockedNoteFingerings, ...manualEdits }),
    [lockedNoteFingerings, manualEdits],
  );

  const displayPayload = useMemo(
    () => applyManualEdits(serverPayload, effectiveEdits),
    [serverPayload, effectiveEdits],
  );

  const editorItems = useMemo(
    () => flattenFingeringItems(displayPayload, lockedNoteFingerings),
    [displayPayload, lockedNoteFingerings],
  );

  const selectedItem = useMemo(
    () => editorItems.find((item) => item.noteId === selectedNoteId) ?? editorItems[0] ?? null,
    [editorItems, selectedNoteId],
  );

  const selectedServerFinger = useMemo(
    () => (selectedItem ? getDisplayedFinger(serverPayload, selectedItem.noteId) : null),
    [serverPayload, selectedItem],
  );
  const measureKeyboardChunks = useMemo(
    () => getKeyboardPreviewChunksForMeasure(
      displayPayload,
      selectedMeasureNumber,
      lockedNoteFingerings,
      selectedNoteId,
    ),
    [displayPayload, lockedNoteFingerings, selectedMeasureNumber, selectedNoteId],
  );
  const activeChunkIndex = measureKeyboardChunks.length > 0
    ? Math.max(0, Math.min(selectedChunkIndex, measureKeyboardChunks.length - 1))
    : 0;
  const selectedKeyboardChunk = measureKeyboardChunks[activeChunkIndex] ?? null;
  const keyboardPreviewNotes = selectedKeyboardChunk?.notes ?? [];

  const warnings = useMemo(() => {
    const analysisWarnings: string[] = displayPayload?.analysis?.warnings ?? [];
    const fingeringWarnings: string[] = displayPayload?.fingerings?.warnings ?? [];
    return [...analysisWarnings, ...fingeringWarnings].slice(0, 50);
  }, [displayPayload]);

  const stats = (displayPayload?.fingerings?.stats ?? {}) as Record<string, number | string>;
  const deferredAnnotatedXml = useDeferredValue(annotatedXml);

  const selectedHistory = useMemo(() => {
    const items: Array<{ key: string; label: string; meta: string; tone: "edit" | "lock" }> = [];

    Object.entries(manualEdits)
      .slice(-4)
      .reverse()
      .forEach(([noteId, finger]) => {
        const item = editorItems.find((entry) => entry.noteId === noteId);
        items.push({
          key: `edit-${noteId}`,
          label: `Set fingering ${finger}`,
          meta: item ? `${item.label}` : "Edited note",
          tone: "edit",
        });
      });

    Object.entries(lockedNoteFingerings)
      .slice(-4)
      .reverse()
      .forEach(([noteId, finger]) => {
        const item = editorItems.find((entry) => entry.noteId === noteId);
        items.push({
          key: `lock-${noteId}`,
          label: `Locked to ${finger}`,
          meta: item ? `${item.label}` : "Locked note",
          tone: "lock",
        });
      });

    return items.slice(0, 6);
  }, [editorItems, lockedNoteFingerings, manualEdits]);

  useEffect(() => {
    setPageIndex(0);
    setPageCount(1);
  }, [deferredAnnotatedXml]);

  useEffect(() => {
    if (!selectedItem) {
      setSelectedNoteId(null);
      return;
    }
    if (selectedNoteId !== selectedItem.noteId) {
      setSelectedNoteId(selectedItem.noteId);
    }
  }, [selectedItem, selectedNoteId]);

  useEffect(() => {
    if (selectedMeasureNumber == null) {
      return;
    }

    const measureStillExists = editorItems.some((item) => item.measure === selectedMeasureNumber);
    if (!measureStillExists) {
      setSelectedMeasureNumber(null);
    }
  }, [editorItems, selectedMeasureNumber]);

  useEffect(() => {
    setSelectedChunkIndex(0);
    setKeyboardPlaying(false);
  }, [selectedMeasureNumber]);

  useEffect(() => {
    if (measureKeyboardChunks.length === 0) {
      setKeyboardPlaying(false);
      if (selectedChunkIndex !== 0) {
        setSelectedChunkIndex(0);
      }
      return;
    }

    if (selectedChunkIndex >= measureKeyboardChunks.length) {
      setSelectedChunkIndex(0);
      setKeyboardPlaying(false);
    }
  }, [measureKeyboardChunks.length, selectedChunkIndex]);

  useEffect(() => {
    if (!keyboardTrayOpen && keyboardPlaying) {
      setKeyboardPlaying(false);
    }
  }, [keyboardPlaying, keyboardTrayOpen]);

  useEffect(() => {
    if (!selectedKeyboardChunk) {
      return;
    }

    if (selectedKeyboardChunk.noteIds.includes(selectedNoteId ?? "")) {
      return;
    }

    if (selectedKeyboardChunk.primaryNoteId) {
      setSelectedNoteId(selectedKeyboardChunk.primaryNoteId);
    }
  }, [selectedKeyboardChunk, selectedNoteId]);

  useEffect(() => {
    if (!keyboardPlaying) {
      return;
    }

    if (measureKeyboardChunks.length <= 1 || activeChunkIndex >= measureKeyboardChunks.length - 1) {
      setKeyboardPlaying(false);
      return;
    }

    const timer = window.setTimeout(() => {
      setSelectedChunkIndex((current) => Math.min(current + 1, measureKeyboardChunks.length - 1));
    }, 900);

    return () => window.clearTimeout(timer);
  }, [activeChunkIndex, keyboardPlaying, measureKeyboardChunks.length]);

  useEffect(() => {
    let cancelled = false;

    if (!file || !displayPayload) {
      setAnnotatedXml(null);
      return () => {
        cancelled = true;
      };
    }

    (async () => {
      try {
        const xmlText = await fileToMusicXMLText(file);
        const injected = injectFingerings(xmlText, displayPayload);
        if (!cancelled) {
          setAnnotatedXml(injected);
        }
      } catch (e: unknown) {
        if (!cancelled) {
          setErr(toErrorMessage(e));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [file, displayPayload]);

  async function poll(job_id: string) {
    setStatus("queued");
    for (;;) {
      const j = await getJob(job_id);
      setResultUrl(j.result_url ?? null);
      if (j.status === "QUEUED") {
        setStatus("queued");
      } else if (j.status === "RUNNING") {
        setStatus("running");
      } else if (j.status === "FAILED") {
        setStatus("error");
        setErr(j.error ?? "Job failed");
        return false;
      } else if (j.status === "SUCCEEDED") {
        return true;
      }

      const waitMs = j.retry_after_ms ?? 1200;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  async function onSubmit() {
    setErr(null);
    setJobId(null);
    setResultKey(null);
    setResultUrl(null);

    if (!file) {
      setErr("Pick a MusicXML or MXL file first.");
      return;
    }

    try {
      setStatus("uploading");

      const start = await postFingerings({
        file,
        difficulty,
        style_bias: styleBias,
        hand_size: handSize,
        articulation_bias: articulationBias,
        locked_note_fingerings: lockedNoteFingerings,
        force_recompute: forceRecompute,
      });

      let finalPayload: ResultPayload | null = null;

      if (start.status === "QUEUED") {
        setJobId(start.job_id);
        const ok = await poll(start.job_id);
        if (!ok) {
          return;
        }
        finalPayload = await getResult(start.job_id);
      } else {
        setResultKey(start.result_s3_key);
        setResultUrl(start.result_url ?? null);

        if (start.job_id) {
          finalPayload = await getResult(start.job_id);
        } else if (start.result_s3_key) {
          finalPayload = await getResultByKey(start.result_s3_key);
        } else {
          throw new Error("Cached result returned, but no result key was available.");
        }
      }

      startTransition(() => {
        setServerPayload(finalPayload);
        setManualEdits({});
        setStatus("done");
      });
    } catch (e: unknown) {
      setStatus("error");
      setErr(toErrorMessage(e));
    }
  }

  function onFileChange(nextFile: File | null) {
    setFile(nextFile);
    setStatus("idle");
    setJobId(null);
    setResultKey(null);
    setResultUrl(null);
    setServerPayload(null);
    setAnnotatedXml(null);
    setManualEdits({});
    setLockedNoteFingerings({});
    setSelectedNoteId(null);
    setSelectedMeasureNumber(null);
    setHoveredTarget(null);
    setKeyboardTrayOpen(false);
    setSelectedChunkIndex(0);
    setKeyboardPlaying(false);
    setErr(null);
  }

  function onChooseFinger(nextFinger: number) {
    if (!selectedItem || !displayPayload) {
      return;
    }

    const validation = validateFingerEdit(displayPayload, selectedItem.noteId, nextFinger);
    if (!validation.ok) {
      setErr(validation.reason);
      return;
    }

    setErr(null);
    setManualEdits((prev) => ({ ...prev, [selectedItem.noteId]: nextFinger }));
    if (lockedNoteFingerings[selectedItem.noteId] !== undefined) {
      setLockedNoteFingerings((prev) => ({ ...prev, [selectedItem.noteId]: nextFinger }));
    }
  }

  function toggleLock(item: NoteEditorItem) {
    const currentFinger = getDisplayedFinger(displayPayload, item.noteId);
    const serverFinger = getDisplayedFinger(serverPayload, item.noteId);
    const wasLocked = lockedNoteFingerings[item.noteId] !== undefined;
    if (currentFinger == null) {
      return;
    }

    setLockedNoteFingerings((prev) => {
      const next = { ...prev };
      if (wasLocked) {
        delete next[item.noteId];
      } else {
        next[item.noteId] = currentFinger;
      }
      return next;
    });

    if (wasLocked) {
      setManualEdits((prev) => {
        const next = { ...prev };
        if (serverFinger === currentFinger) {
          delete next[item.noteId];
        } else {
          next[item.noteId] = currentFinger;
        }
        return next;
      });
    }
  }

  function resetSelectedNote() {
    if (!selectedItem) {
      return;
    }

    const noteId = selectedItem.noteId;
    setManualEdits((prev) => {
      const next = { ...prev };
      delete next[noteId];
      return next;
    });
    setErr(null);
  }

  function onSelectTarget(target: ScorePassageTarget) {
    const nextMeasureNumber = target.measureNumber;
    if (nextMeasureNumber == null) {
      return;
    }

    setSelectedMeasureNumber(nextMeasureNumber);
    setKeyboardTrayOpen(true);
    setKeyboardPlaying(false);
    setSelectedChunkIndex(0);

    if (!selectedItem || selectedItem.measure !== nextMeasureNumber) {
      const firstMeasureItem = editorItems.find((item) => item.measure === nextMeasureNumber) ?? null;
      setSelectedNoteId(firstMeasureItem?.noteId ?? null);
    }
  }

  function stepKeyboardChunk(delta: number) {
    if (measureKeyboardChunks.length === 0) {
      return;
    }

    setKeyboardPlaying(false);
    setSelectedChunkIndex((current) => Math.max(0, Math.min(current + delta, measureKeyboardChunks.length - 1)));
  }

  function toggleKeyboardPlayback() {
    if (measureKeyboardChunks.length <= 1) {
      return;
    }

    setKeyboardTrayOpen(true);
    setKeyboardPlaying((current) => {
      if (current) {
        return false;
      }

      if (activeChunkIndex >= measureKeyboardChunks.length - 1) {
        setSelectedChunkIndex(0);
      }

      return true;
    });
  }

  const canRun = status !== "uploading" && status !== "queued" && status !== "running";
  const lockCount = Object.keys(lockedNoteFingerings).length;
  const localEditCount = Object.keys(manualEdits).length;
  const scoreName = file ? file.name.replace(/\.(xml|musicxml|mxl)$/i, "") : "No score loaded";
  const composerLabel = file ? "Imported MusicXML score" : "Upload MusicXML or MXL to begin";
  const selectedMeasureLabel = selectedMeasureNumber != null ? `Measure ${selectedMeasureNumber}` : "Choose a measure";
  const selectedChunkCount = measureKeyboardChunks.length;
  const selectedChunkNoteCount = keyboardPreviewNotes.length;
  const selectedMeasureNoteCount = selectedKeyboardChunk
    ? `${selectedKeyboardChunk.beatLabel} / ${selectedChunkNoteCount}`
    : String(selectedChunkNoteCount);
  const hoveredMeasureNumber = hoveredTarget?.measureNumber ?? null;
  const hoveredPreviewLabel = hoveredMeasureNumber != null ? `Measure ${hoveredMeasureNumber}` : null;
  const hasScorePreview = Boolean(deferredAnnotatedXml);

  return (
    <div className="appShell">
        <header className="topbar">
          <div className="topbarBrand">
            <div className="brandLockup">
              <div className="brandMark brandMark-portrait">
                <img className="brandPortrait" src={brandPortrait} alt="Portrait mark for Best Fingerings" />
              </div>
              <div>
                <div className="brandName">Best Fingerings</div>
                <div className="brandTag">The Composer&apos;s Study</div>
            </div>
          </div>
        </div>

        <div className="topbarActions">
          <div className={`statusBadge statusBadge-${status}`}>
            <span className={`dot dot-${status}`} />
            <span>{humanStatus(status)}</span>
            {jobId ? <span className="statusMeta">job {jobId.slice(0, 8)}...</span> : null}
          </div>

          <button className="topGenerateBtn" onClick={onSubmit} disabled={!canRun}>
            {serverPayload ? "Regenerate Fingerings" : "Generate Fingerings"}
          </button>
        </div>
      </header>

      <div className="workspaceShell">
        <aside className="leftRail">
          <div className="railPanel">
            <div className="railLabel">Current Project</div>
            <div className="projectCard">
              <div className="projectTitle">{scoreName}</div>
              <div className="projectSub">{composerLabel}</div>
            </div>
          </div>

          <div className="railPanel">
            <div className="railLabel">Algorithm Parameters</div>

            <label className="stackField">
              <span>Difficulty</span>
              <select value={difficulty} onChange={(e) => setDifficulty(e.target.value)}>
                <option value="easy">Easy</option>
                <option value="standard">Standard</option>
                <option value="hard">Advanced</option>
              </select>
            </label>

            <label className="stackField">
              <span>Style Bias</span>
              <select value={styleBias} onChange={(e) => setStyleBias(e.target.value)}>
                <option value="legato">Legato</option>
                <option value="neutral">Neutral</option>
                <option value="staccato">Staccato</option>
              </select>
            </label>

            <label className="stackField">
              <span>Hand Size</span>
              <select value={handSize} onChange={(e) => setHandSize(e.target.value)}>
                <option value="small">Small</option>
                <option value="medium">Standard</option>
                <option value="large">Large</option>
              </select>
            </label>

            <label className="stackField">
              <span>Articulation</span>
              <select value={articulationBias} onChange={(e) => setArticulationBias(e.target.value)}>
                <option value="auto">Auto</option>
                <option value="legato">Legato</option>
                <option value="neutral">Neutral</option>
                <option value="staccato">Staccato</option>
              </select>
            </label>

            <label className="forceToggle">
              <input type="checkbox" checked={forceRecompute} onChange={(e) => setForceRecompute(e.target.checked)} />
              <span>Force recompute instead of returning a cached result</span>
            </label>
          </div>

          <div className="railPanel">
            <div className="railLabel">Score Input</div>
            <label className="uploadCard">
              <input
                className="hiddenInput"
                type="file"
                accept=".xml,.musicxml,.mxl"
                onChange={(e) => onFileChange(e.target.files?.[0] ?? null)}
              />
              <span className="uploadIcon">+</span>
              <span className="uploadTitle">{file ? "Replace MusicXML" : "Upload MusicXML"}</span>
              <span className="uploadSub">Drag and drop or browse for a piano score</span>
            </label>
          </div>

          <div className="railFooter">
            <div className="footerPill">
              <span className="footerPillLabel">Locks</span>
              <strong>{lockCount}</strong>
            </div>
            <div className="footerPill">
              <span className="footerPillLabel">Local edits</span>
              <strong>{localEditCount}</strong>
            </div>
          </div>
        </aside>

        <main className="scoreStage">
          <section className="scoreHero">
            <div className="heroText">
              <div className="heroEyebrow">Digital Manuscript Workspace</div>
              <h1>{scoreName}</h1>
              <p>
                Generate deterministic fingerings, inspect them on the score, then lock and refine noteheads before the
                next regenerate.
              </p>
            </div>

            <div className="heroStats">
              <div className="heroStat">
                <span>RH outputs</span>
                <strong>{stats.rh_fingerings ?? 0}</strong>
              </div>
              <div className="heroStat">
                <span>LH outputs</span>
                <strong>{stats.lh_fingerings ?? 0}</strong>
              </div>
              <div className="heroStat">
                <span>Warnings</span>
                <strong>{warnings.length}</strong>
              </div>
            </div>
          </section>

          {err ? <div className="errorBox">{err}</div> : null}

          <section className="scoreViewport">
            <div className="scoreToolbar">
              <div className="toolbarSection">
                <span className="toolbarModePill">Page view</span>
              </div>

              <div className="toolbarDivider" />

              <div className="toolbarSection toolbarSection-wide">
                <span className="toolbarLabel">Zoom</span>
                <input
                  className="zoomRange"
                  type="range"
                  min={0.7}
                  max={1.6}
                  step={0.05}
                  value={zoom}
                  onChange={(e) => setZoom(parseFloat(e.target.value))}
                />
                <span className="toolbarValue">{Math.round(zoom * 100)}%</span>
              </div>

              <div className="toolbarDivider" />

              <div className="toolbarSection">
                <button
                  type="button"
                  className="toolbarGhostBtn"
                  onClick={() => setPageIndex((p) => Math.max(0, p - 1))}
                  disabled={pageIndex <= 0}
                >
                  Prev
                </button>
                <span className="toolbarValue">
                  {pageIndex + 1}/{pageCount}
                </span>
                <button
                  type="button"
                  className="toolbarGhostBtn"
                  onClick={() => setPageIndex((p) => Math.min(pageCount - 1, p + 1))}
                  disabled={pageIndex >= pageCount - 1}
                >
                  Next
                </button>
              </div>

              <div className="toolbarDivider" />

              <div className="toolbarSection">
                <button
                  type="button"
                  className={`toolbarGhostBtn toolbarToggleBtn ${keyboardTrayOpen ? "toolbarToggleBtn-active" : ""}`}
                  onClick={() => setKeyboardTrayOpen((open) => !open)}
                  disabled={!hasScorePreview}
                >
                  {keyboardTrayOpen ? "Keyboard On" : "Keyboard Off"}
                </button>
                {annotatedXml ? (
                  <button
                    className="toolbarExportBtn"
                    type="button"
                    onClick={() => downloadText(xmlDownloadName(file), annotatedXml, "application/xml")}
                  >
                    MusicXML
                  </button>
                ) : null}
                {resultUrl ? (
                  <a className="toolbarExportBtn toolbarExportBtn-muted" href={resultUrl} target="_blank" rel="noreferrer">
                    JSON
                  </a>
                ) : null}
              </div>
            </div>

            <div className={`scoreWorkspace ${keyboardTrayOpen ? "scoreWorkspace-withTray" : ""}`}>
              <div className="scoreViewportInner">
                {!deferredAnnotatedXml ? (
                  <div className="emptyState">
                    <div className="emptyInner">
                      <div className="emptyEyebrow">Ready for import</div>
                      <h2>Bring in a score and build from there</h2>
                      <p>
                        The live notation view will appear here once a MusicXML or MXL score has been loaded and fingerings
                        have been generated.
                      </p>
                    </div>
                  </div>
                ) : (
                  <Suspense
                    fallback={(
                      <div className="scoreLoadingState">
                        <div className="scoreLoadingCard">
                          <div className="emptyEyebrow">Loading workspace</div>
                          <h2>Preparing the score canvas</h2>
                          <p>The notation engine is loading so page rendering and note selection stay fast once it appears.</p>
                        </div>
                      </div>
                    )}
                  >
                    <LazyScoreView
                      xmlText={deferredAnnotatedXml}
                      viewMode="page"
                      pageIndex={pageIndex}
                      zoom={zoom}
                      selectedTarget={selectedMeasureNumber != null ? {
                        measureNumber: selectedMeasureNumber,
                        staffEntryIndex: 0,
                        staffEntryCount: 1,
                        tMeasBeats: null,
                      } : null}
                      hoveredTarget={hoveredTarget}
                      onHoverTargetChange={setHoveredTarget}
                      onSelectTarget={onSelectTarget}
                      onPageCountChange={(count) => {
                        setPageCount(count || 1);
                        setPageIndex((current) => Math.min(current, Math.max(0, (count || 1) - 1)));
                      }}
                    />
                  </Suspense>
                )}
              </div>

              <div className={`keyboardDock keyboardDock-fixed ${keyboardTrayOpen ? "keyboardDock-open" : "keyboardDock-closed"}`}>
                <div className="keyboardDockHeader">
                  <div className="keyboardDockIntro">
                    <div className="keyboardDockTitle">Keyboard Measure Preview</div>
                    <div className="keyboardDockMeta">
                      {selectedMeasureNumber != null && selectedKeyboardChunk
                        ? `${selectedMeasureLabel} • ${selectedMeasureNoteCount} noteheads mapped below`
                        : "Hover the score, then click a measure to pin its fingerings on the keyboard."}
                    </div>
                  </div>
                  {selectedKeyboardChunk ? (
                    <div className="keyboardTransport">
                      <div className="keyboardTransportMeta">
                        <strong>{selectedKeyboardChunk.label}</strong>
                        <span>{activeChunkIndex + 1}/{selectedChunkCount}</span>
                      </div>
                      <div className="keyboardTransportButtons">
                        <button
                          type="button"
                          className="toolbarGhostBtn keyboardTransportBtn"
                          onClick={() => stepKeyboardChunk(-1)}
                          disabled={activeChunkIndex <= 0}
                        >
                          Prev
                        </button>
                        <button
                          type="button"
                          className="toolbarGhostBtn keyboardTransportBtn keyboardTransportBtn-primary"
                          onClick={toggleKeyboardPlayback}
                          disabled={selectedChunkCount <= 1}
                        >
                          {keyboardPlaying ? "Pause" : "Play"}
                        </button>
                        <button
                          type="button"
                          className="toolbarGhostBtn keyboardTransportBtn"
                          onClick={() => stepKeyboardChunk(1)}
                          disabled={activeChunkIndex >= selectedChunkCount - 1}
                        >
                          Next
                        </button>
                      </div>
                    </div>
                  ) : null}
                  <div className="keyboardTrayActions">
                    {hoveredPreviewLabel && hoveredPreviewLabel !== selectedMeasureLabel ? (
                      <div className="keyboardDockHint">Hovering {hoveredPreviewLabel}</div>
                    ) : (
                      <div className="keyboardDockHint">Click a measure once, then step or play through the bar</div>
                    )}
                    <button
                      type="button"
                      className="toolbarGhostBtn keyboardTrayCloseBtn"
                      onClick={() => {
                        setKeyboardPlaying(false);
                        setKeyboardTrayOpen(false);
                      }}
                    >
                      Hide Keyboard
                    </button>
                  </div>
                </div>

                {keyboardPreviewNotes.length > 0 ? (
                  <PianoKeyboard
                    activeNotes={keyboardPreviewNotes}
                    selectedPitchMidi={selectedItem && selectedKeyboardChunk?.noteIds.includes(selectedItem.noteId)
                      ? selectedItem.pitchMidi
                      : null}
                  />
                ) : (
                  <div className="keyboardDockEmpty">
                    Click a visible measure on the page to load its first keyboard chunk, then step or play through the bar.
                  </div>
                )}
              </div>
            </div>
          </section>
        </main>

        <aside className="rightRail">
          <div className="railPanel">
            <div className="railLabel">Note Inspector</div>
            {!selectedItem ? (
              <div className="emptyPanel">Generate fingerings to inspect and edit noteheads.</div>
            ) : (
              <div className="inspectorCard">
                <div className="inspectorHeader">
                  <div>
                    <div className="inspectorPitch">{midiToNoteName(selectedItem.pitchMidi)}</div>
                    <div className="inspectorSub">
                      {selectedItem.kind === "chord-note"
                        ? `Chord tone ${Number(selectedItem.chordIndex) + 1} of ${selectedItem.chordSize}`
                        : "Single note"}
                      {` | MIDI ${selectedItem.pitchMidi}`}
                    </div>
                  </div>
                  <button className="lockIconBtn" type="button" onClick={() => toggleLock(selectedItem)}>
                    {selectedItem.locked ? "Unlock" : "Lock"}
                  </button>
                </div>

                <div className="measureMeta">
                  <div className="measureMetaItem">
                    <span>Measure</span>
                    <strong>{selectedItem.measure ?? "?"}</strong>
                  </div>
                  <div className="measureMetaItem">
                    <span>Hand</span>
                    <strong>{selectedItem.hand}</strong>
                  </div>
                </div>

                <div className="fingerRow keyboardRow">
                  {[1, 2, 3, 4, 5].map((finger) => (
                    <button
                      key={finger}
                      type="button"
                      className={`fingerKey ${selectedItem.fingering === finger ? "fingerKey-active" : ""}`}
                      onClick={() => onChooseFinger(finger)}
                    >
                      {finger}
                    </button>
                  ))}
                </div>

                <div className="editorActions">
                  <button className="softBtn" type="button" onClick={resetSelectedNote}>
                    Reset
                  </button>
                  <button className="softBtn" type="button" onClick={() => toggleLock(selectedItem)}>
                    {selectedItem.locked ? "Unlock note" : "Lock note"}
                  </button>
                </div>

                <div className="baselineNote">
                  Current finger <strong>{selectedItem.fingering}</strong>
                  {selectedServerFinger != null ? <span> | generated baseline {selectedServerFinger}</span> : null}
                </div>

              </div>
            )}
          </div>

          <div className="railPanel">
            <div className="railLabel">Edit History</div>
            {selectedHistory.length === 0 ? (
              <div className="emptyPanel">Your manual edits and locks will appear here.</div>
            ) : (
              <div className="historyList">
                {selectedHistory.map((item) => (
                  <div key={item.key} className={`historyRow historyRow-${item.tone}`}>
                    <div className="historyGlyph">{item.tone === "lock" ? "L" : "F"}</div>
                    <div>
                      <div className="historyTitle">{item.label}</div>
                      <div className="historyMeta">{item.meta}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {warnings.length > 0 ? (
            <div className="railPanel">
              <div className="railLabel">Warnings</div>
              <pre className="warnings">{warnings.join("\n")}</pre>
            </div>
          ) : null}

          {resultKey ? (
            <div className="railPanel">
              <div className="railLabel">Result Key</div>
              <code className="resultKeyBlock">{resultKey}</code>
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
