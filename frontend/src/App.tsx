import { startTransition, useDeferredValue, useEffect, useMemo, useState } from "react";
import "./App.css";

import { getJob, getResult, getResultByKey, postFingerings } from "./api";
import {
  applyManualEdits,
  flattenFingeringItems,
  getDisplayedFinger,
  type NoteEditorItem,
  validateFingerEdit,
} from "./fingeringEditor";
import { fileToMusicXMLText, injectFingerings } from "./musicxml";
import { ScoreView } from "./ScoreView";
import type { ResultPayload } from "./types";

type Status = "idle" | "uploading" | "queued" | "running" | "done" | "error";
type ViewMode = "page" | "scroll";

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

  const [viewMode, setViewMode] = useState<ViewMode>("page");
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

  const warnings = useMemo(() => {
    const analysisWarnings: string[] = displayPayload?.analysis?.warnings ?? [];
    const fingeringWarnings: string[] = displayPayload?.fingerings?.warnings ?? [];
    return [...analysisWarnings, ...fingeringWarnings].slice(0, 50);
  }, [displayPayload]);

  const stats = (displayPayload?.fingerings?.stats ?? {}) as Record<string, number | string>;
  const deferredAnnotatedXml = useDeferredValue(annotatedXml);

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

  const canRun = status !== "uploading" && status !== "queued" && status !== "running";
  const lockCount = Object.keys(lockedNoteFingerings).length;
  const localEditCount = Object.keys(manualEdits).length;

  return (
    <div className="appShell">
      <header className="topbar">
        <div>
          <div className="eyebrow">Best Fingerings</div>
          <h1 className="brandTitle">Deterministic piano fingerings with editable score output</h1>
          <p className="brandSub">
            Upload MusicXML, generate fingerings, inspect the full score, then edit and lock notes before the next regenerate.
          </p>
        </div>

        <div className="statusCluster">
          <div className="statusPill">
            <span className={`dot dot-${status}`} />
            <span>{status}</span>
            {jobId ? <span className="muted">job {jobId.slice(0, 8)}...</span> : null}
          </div>
          <div className="miniStat">
            <span className="miniLabel">Locks</span>
            <strong>{lockCount}</strong>
          </div>
          <div className="miniStat">
            <span className="miniLabel">Local edits</span>
            <strong>{localEditCount}</strong>
          </div>
        </div>
      </header>

      <div className="workspace">
        <main className="scorePane">
          <section className="controlBar">
            <div className="controlGrid">
              <label className="field field-file">
                <span>Score</span>
                <input
                  className="fileInput"
                  type="file"
                  accept=".xml,.musicxml,.mxl"
                  onChange={(e) => onFileChange(e.target.files?.[0] ?? null)}
                />
              </label>

              <label className="field">
                <span>Difficulty</span>
                <select value={difficulty} onChange={(e) => setDifficulty(e.target.value)}>
                  <option value="easy">easy</option>
                  <option value="standard">standard</option>
                  <option value="hard">hard</option>
                </select>
              </label>

              <label className="field">
                <span>Style bias</span>
                <select value={styleBias} onChange={(e) => setStyleBias(e.target.value)}>
                  <option value="neutral">neutral</option>
                  <option value="legato">legato</option>
                  <option value="staccato">staccato</option>
                </select>
              </label>

              <label className="field">
                <span>Hand size</span>
                <select value={handSize} onChange={(e) => setHandSize(e.target.value)}>
                  <option value="small">small</option>
                  <option value="medium">medium</option>
                  <option value="large">large</option>
                </select>
              </label>

              <label className="field">
                <span>Articulation</span>
                <select value={articulationBias} onChange={(e) => setArticulationBias(e.target.value)}>
                  <option value="auto">auto</option>
                  <option value="legato">legato</option>
                  <option value="staccato">staccato</option>
                  <option value="neutral">neutral</option>
                </select>
              </label>
            </div>

            <div className="controlRow">
              <label className="checkbox">
                <input type="checkbox" checked={forceRecompute} onChange={(e) => setForceRecompute(e.target.checked)} />
                <span>Force recompute</span>
              </label>

              <button className="primaryBtn" onClick={onSubmit} disabled={!canRun}>
                {serverPayload ? "Regenerate" : "Generate"}
              </button>

              {resultUrl ? (
                <a className="ghostLink" href={resultUrl} target="_blank" rel="noreferrer">
                  Download JSON
                </a>
              ) : null}

              {annotatedXml ? (
                <button
                  className="ghostBtn"
                  type="button"
                  onClick={() => downloadText(xmlDownloadName(file), annotatedXml, "application/xml")}
                >
                  Download MusicXML
                </button>
              ) : null}
            </div>

            <div className="viewerBar">
              <label className="field compactField">
                <span>View</span>
                <select value={viewMode} onChange={(e) => setViewMode(e.target.value as ViewMode)}>
                  <option value="page">page</option>
                  <option value="scroll">scroll</option>
                </select>
              </label>

              <label className="field rangeField">
                <span>Zoom</span>
                <input
                  type="range"
                  min={0.7}
                  max={1.6}
                  step={0.05}
                  value={zoom}
                  onChange={(e) => setZoom(parseFloat(e.target.value))}
                />
              </label>

              {viewMode === "page" ? (
                <div className="pager">
                  <button
                    className="ghostBtn"
                    onClick={() => setPageIndex((p) => Math.max(0, p - 1))}
                    disabled={pageIndex <= 0}
                  >
                    Prev
                  </button>
                  <div className="pageLabel">
                    Page <strong>{pageIndex + 1}</strong> / {pageCount}
                  </div>
                  <button
                    className="ghostBtn"
                    onClick={() => setPageIndex((p) => Math.min(pageCount - 1, p + 1))}
                    disabled={pageIndex >= pageCount - 1}
                  >
                    Next
                  </button>
                </div>
              ) : null}

              <div className="metaRow">
                {resultKey ? <code className="resultKey">{resultKey}</code> : null}
              </div>
            </div>
          </section>

          {err ? <div className="errorBox">{err}</div> : null}

          <section className="scoreCard">
            {!deferredAnnotatedXml ? (
              <div className="emptyState">
                <h2>Ready for a score</h2>
                <p>Upload a MusicXML or MXL file, choose preferences, and generate fingerings.</p>
              </div>
            ) : (
              <ScoreView
                xmlText={deferredAnnotatedXml}
                viewMode={viewMode}
                pageIndex={pageIndex}
                zoom={zoom}
                onPageCountChange={(count) => {
                  setPageCount(count || 1);
                  setPageIndex((current) => Math.min(current, Math.max(0, (count || 1) - 1)));
                }}
              />
            )}
          </section>
        </main>

        <aside className="inspectorPane">
          <section className="panel">
            <div className="panelTitle">Generation summary</div>
            <div className="summaryGrid">
              <div className="summaryCard">
                <span>Total noteheads</span>
                <strong>{editorItems.length}</strong>
              </div>
              <div className="summaryCard">
                <span>Locked noteheads</span>
                <strong>{lockCount}</strong>
              </div>
              <div className="summaryCard">
                <span>RH outputs</span>
                <strong>{stats.rh_fingerings ?? 0}</strong>
              </div>
              <div className="summaryCard">
                <span>LH outputs</span>
                <strong>{stats.lh_fingerings ?? 0}</strong>
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="panelTitle">Selected note</div>
            {!selectedItem ? (
              <div className="panelEmpty">Generate fingerings to start editing.</div>
            ) : (
              <div className="editorCard">
                <div className="editorMeta">
                  <div className="editorLabel">{selectedItem.label}</div>
                  <div className="editorSub">
                    pitch {selectedItem.pitchMidi}
                    {selectedItem.kind === "chord-note"
                      ? ` | chord tone ${Number(selectedItem.chordIndex) + 1}/${selectedItem.chordSize}`
                      : ""}
                  </div>
                </div>

                <div className="fingerRow">
                  {[1, 2, 3, 4, 5].map((finger) => (
                    <button
                      key={finger}
                      type="button"
                      className={`fingerBtn ${selectedItem.fingering === finger ? "fingerBtn-active" : ""}`}
                      onClick={() => onChooseFinger(finger)}
                    >
                      {finger}
                    </button>
                  ))}
                </div>

                <div className="editorActions">
                  <button className="ghostBtn" type="button" onClick={() => toggleLock(selectedItem)}>
                    {selectedItem.locked ? "Unlock note" : "Lock note"}
                  </button>
                  <button className="ghostBtn" type="button" onClick={resetSelectedNote}>
                    Reset local edit
                  </button>
                </div>

                <div className="editorFootnote">
                  Current finger <strong>{selectedItem.fingering}</strong>
                  {selectedServerFinger != null ? (
                    <span className="muted"> | generated baseline {selectedServerFinger}</span>
                  ) : null}
                </div>
              </div>
            )}
          </section>

          <section className="panel growPanel">
            <div className="panelHeader">
              <div className="panelTitle">Editable noteheads</div>
              <div className="panelMeta">{editorItems.length}</div>
            </div>

            {editorItems.length === 0 ? (
              <div className="panelEmpty">No fingerings loaded yet.</div>
            ) : (
              <div className="noteList">
                {editorItems.map((item) => {
                  const isSelected = selectedItem?.noteId === item.noteId;
                  return (
                    <button
                      key={item.noteId}
                      type="button"
                      className={`noteRow ${isSelected ? "noteRow-selected" : ""}`}
                      onClick={() => setSelectedNoteId(item.noteId)}
                    >
                      <div className="noteRowMain">
                        <span className="noteRowTitle">{item.label}</span>
                        <span className="noteRowMeta">finger {item.fingering}</span>
                      </div>
                      <div className="noteBadges">
                        <span className={`badge badge-hand badge-${item.hand.toLowerCase()}`}>{item.hand}</span>
                        {item.locked ? <span className="badge badge-lock">locked</span> : null}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          {warnings.length > 0 ? (
            <section className="panel">
              <div className="panelTitle">Warnings</div>
              <pre className="warnings">{warnings.join("\n")}</pre>
            </section>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
