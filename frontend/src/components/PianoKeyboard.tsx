import { useEffect, useMemo, useRef } from "react";
import type { HandName } from "../types";

export type PianoKeyboardActiveNote = {
  noteId: string;
  hand: HandName;
  pitchMidi: number;
  finger: number | null;
  selected: boolean;
  locked: boolean;
};

type PianoKeyboardProps = {
  activeNotes: PianoKeyboardActiveNote[];
  selectedPitchMidi?: number | null;
};

type PianoKey = {
  midi: number;
  isWhite: boolean;
  left: number;
  whiteIndex: number;
};

const WHITE_KEY_WIDTH = 32;

function isWhiteKey(midi: number) {
  return new Set([0, 2, 4, 5, 7, 9, 11]).has(midi % 12);
}

function buildKeys(): PianoKey[] {
  const keys: PianoKey[] = [];
  let whiteIndex = 0;

  for (let midi = 21; midi <= 108; midi += 1) {
    const white = isWhiteKey(midi);
    if (white) {
      keys.push({
        midi,
        isWhite: true,
        left: whiteIndex * WHITE_KEY_WIDTH,
        whiteIndex,
      });
      whiteIndex += 1;
      continue;
    }

    keys.push({
      midi,
      isWhite: false,
      left: Math.max(0, (whiteIndex - 1) * WHITE_KEY_WIDTH + WHITE_KEY_WIDTH * 0.67),
      whiteIndex,
    });
  }

  return keys;
}

export function PianoKeyboard({ activeNotes, selectedPitchMidi }: PianoKeyboardProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const keyboardRef = useRef<HTMLDivElement | null>(null);

  const keys = useMemo(() => buildKeys(), []);
  const whiteCount = keys.filter((key) => key.isWhite).length;
  const totalWidth = whiteCount * WHITE_KEY_WIDTH;

  const activeByMidi = useMemo(() => {
    const map = new Map<number, PianoKeyboardActiveNote[]>();
    activeNotes.forEach((note) => {
      const existing = map.get(note.pitchMidi) ?? [];
      existing.push(note);
      map.set(note.pitchMidi, existing);
    });

    map.forEach((notes, midi) => {
      notes.sort((left, right) => {
        if (left.selected !== right.selected) {
          return left.selected ? -1 : 1;
        }
        if (left.hand !== right.hand) {
          return left.hand === "RH" ? -1 : 1;
        }
        return (left.finger ?? 0) - (right.finger ?? 0);
      });
      map.set(midi, notes);
    });

    return map;
  }, [activeNotes]);

  useEffect(() => {
    const viewport = viewportRef.current;
    const keyboard = keyboardRef.current;
    if (!viewport || !keyboard || activeNotes.length === 0) {
      return;
    }

    const sortedMidis = Array.from(new Set(activeNotes.map((note) => note.pitchMidi))).sort((a, b) => a - b);
    const leftTarget = keyboard.querySelector<HTMLElement>(`[data-midi="${sortedMidis[0]}"]`);
    const rightTarget = keyboard.querySelector<HTMLElement>(`[data-midi="${sortedMidis[sortedMidis.length - 1]}"]`);
    if (!leftTarget || !rightTarget) {
      return;
    }

    const padding = 24;
    const spanLeft = Math.max(0, leftTarget.offsetLeft - padding);
    const spanRight = rightTarget.offsetLeft + rightTarget.clientWidth + padding;
    const spanWidth = spanRight - spanLeft;
    let nextLeft: number;

    if (spanWidth <= viewport.clientWidth) {
      nextLeft = Math.max(0, spanLeft - (viewport.clientWidth - spanWidth) / 2);
    } else {
      const spanCenter = (spanLeft + spanRight) / 2;
      nextLeft = Math.max(0, spanCenter - viewport.clientWidth / 2);
      nextLeft = Math.min(nextLeft, Math.max(0, spanRight - viewport.clientWidth));
    }

    viewport.scrollTo({
      left: nextLeft,
      behavior: "smooth",
    });
  }, [activeNotes, selectedPitchMidi]);

  return (
    <div className="pianoKeyboardShell">
      <div className="pianoKeyboardLegend">
        <span className="legendDot legendDot-rh" /> Right hand
        <span className="legendSpacer" />
        <span className="legendDot legendDot-lh" /> Left hand
      </div>

      <div ref={viewportRef} className="pianoKeyboardViewport">
        <div ref={keyboardRef} className="pianoKeyboard" style={{ width: totalWidth }}>
          {keys
            .filter((key) => key.isWhite)
            .map((key) => {
              const notes = activeByMidi.get(key.midi) ?? [];
              const active = notes[0];
              const hasRh = notes.some((note) => note.hand === "RH");
              const hasLh = notes.some((note) => note.hand === "LH");
              return (
                <div
                  key={key.midi}
                  data-midi={key.midi}
                  className={[
                    "pianoKey",
                    "pianoKey-white",
                    hasRh && hasLh ? "pianoKey-both" : "",
                    active && !(hasRh && hasLh) ? `pianoKey-${active.hand.toLowerCase()}` : "",
                    active?.selected ? "pianoKey-selected" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  style={{ left: key.left, width: WHITE_KEY_WIDTH }}
                >
                  {notes.length > 0 ? (
                    <div className="pianoKeyLabels">
                      {notes.map((note) => (
                        <div key={note.noteId} className={`pianoKeyLabel pianoKeyLabel-${note.hand.toLowerCase()}`}>
                          <span>{note.finger ?? ""}</span>
                          {note.locked ? <span className="pianoKeyLock">L</span> : null}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}

          {keys
            .filter((key) => !key.isWhite)
            .map((key) => {
              const notes = activeByMidi.get(key.midi) ?? [];
              const active = notes[0];
              const hasRh = notes.some((note) => note.hand === "RH");
              const hasLh = notes.some((note) => note.hand === "LH");
              return (
                <div
                  key={key.midi}
                  data-midi={key.midi}
                  className={[
                    "pianoKey",
                    "pianoKey-black",
                    hasRh && hasLh ? "pianoKey-both" : "",
                    active && !(hasRh && hasLh) ? `pianoKey-${active.hand.toLowerCase()}` : "",
                    active?.selected ? "pianoKey-selected" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  style={{ left: key.left }}
                >
                  {notes.length > 0 ? (
                    <div className="pianoKeyLabels pianoKeyLabels-black">
                      {notes.map((note) => (
                        <div
                          key={note.noteId}
                          className={`pianoKeyLabel pianoKeyLabel-black pianoKeyLabel-${note.hand.toLowerCase()}`}
                        >
                          <span>{note.finger ?? ""}</span>
                          {note.locked ? <span className="pianoKeyLock">L</span> : null}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
        </div>
      </div>
    </div>
  );
}
