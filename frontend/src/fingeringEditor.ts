import type { FingeringEvent, HandName, ResultPayload } from "./types";

export type NoteEditorItem = {
  noteId: string;
  hand: HandName;
  eventId: number;
  measure: number | null;
  staffNumber: number | null;
  pitchMidi: number;
  fingering: number;
  locked: boolean;
  kind: "note" | "chord-note";
  chordIndex: number | null;
  chordSize: number;
  label: string;
};

export type KeyboardPreviewNote = {
  noteId: string;
  hand: HandName;
  pitchMidi: number;
  finger: number | null;
  selected: boolean;
  locked: boolean;
};

type NoteLocation = {
  hand: HandName;
  eventIndex: number;
  noteIndex: number | null;
  event: FingeringEvent;
};

function clonePayload<T>(payload: T): T {
  return JSON.parse(JSON.stringify(payload));
}

function sortEditorItems(a: NoteEditorItem, b: NoteEditorItem) {
  return (
    (a.measure ?? 0) - (b.measure ?? 0) ||
    a.eventId - b.eventId ||
    (a.chordIndex ?? 0) - (b.chordIndex ?? 0) ||
    a.hand.localeCompare(b.hand)
  );
}

export function flattenFingeringItems(payload: ResultPayload | null, lockedFingerings: Record<string, number>): NoteEditorItem[] {
  const out: NoteEditorItem[] = [];
  const hands = payload?.fingerings?.hands ?? {};

  (["RH", "LH"] as HandName[]).forEach((hand) => {
    const events = hands[hand] ?? [];
    for (const evt of events) {
      if (!evt) {
        continue;
      }

      if (evt.type === "note" && evt.note_id) {
        out.push({
          noteId: evt.note_id,
          hand,
          eventId: evt.event_id,
          measure: evt.measure ?? null,
          staffNumber: evt.xml_anchor?.staff ?? null,
          pitchMidi: evt.pitch_midi,
          fingering: evt.fingering,
          locked: lockedFingerings[evt.note_id] !== undefined,
          kind: "note",
          chordIndex: null,
          chordSize: 1,
          label: `${hand} m.${evt.measure ?? "?"} pitch ${evt.pitch_midi}`,
        });
        continue;
      }

      if (evt.type === "chord" && Array.isArray(evt.note_ids)) {
        evt.note_ids.forEach((noteId: string | null, idx: number) => {
          if (!noteId) {
            return;
          }
          out.push({
            noteId,
            hand,
            eventId: evt.event_id,
            measure: evt.measure ?? null,
            staffNumber: evt.xml_note_anchors?.[idx]?.staff ?? evt.xml_anchor?.staff ?? null,
            pitchMidi: Array.isArray(evt.pitches_midi) ? evt.pitches_midi[idx] : -1,
            fingering: Array.isArray(evt.fingerings) ? evt.fingerings[idx] : 1,
            locked: lockedFingerings[noteId] !== undefined,
            kind: "chord-note",
            chordIndex: idx,
            chordSize: Array.isArray(evt.fingerings) ? evt.fingerings.length : 0,
            label: `${hand} m.${evt.measure ?? "?"} chord tone ${idx + 1}`,
          });
        });
      }
    }
  });

  out.sort(sortEditorItems);
  return out;
}

export function findNoteLocation(payload: ResultPayload | null, noteId: string): NoteLocation | null {
  const hands = payload?.fingerings?.hands ?? {};

  for (const hand of ["RH", "LH"] as HandName[]) {
    const events = hands[hand] ?? [];
    for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
      const evt = events[eventIndex];
      if (!evt) {
        continue;
      }

      if (evt.type === "note" && evt.note_id === noteId) {
        return { hand, eventIndex, noteIndex: null, event: evt };
      }

      if (evt.type === "chord" && Array.isArray(evt.note_ids)) {
        const noteIndex = evt.note_ids.findIndex((candidate: string | null) => candidate === noteId);
        if (noteIndex !== -1) {
          return { hand, eventIndex, noteIndex, event: evt };
        }
      }
    }
  }

  return null;
}

export function getKeyboardPreviewNotes(
  payload: ResultPayload | null,
  noteId: string | null,
  lockedFingerings: Record<string, number>,
): KeyboardPreviewNote[] {
  if (!noteId) {
    return [];
  }

  const location = findNoteLocation(payload, noteId);
  if (!location) {
    return [];
  }

  if (location.event.type === "note") {
    return [
      {
        noteId,
        hand: location.hand,
        pitchMidi: location.event.pitch_midi,
        finger: location.event.fingering,
        selected: true,
        locked: lockedFingerings[noteId] !== undefined,
      },
    ];
  }

  const chordEvent = location.event;
  return chordEvent.pitches_midi.map((pitchMidi, idx) => {
    const chordNoteId = chordEvent.note_ids?.[idx] ?? `${noteId}-${idx}`;
    return {
      noteId: chordNoteId,
      hand: location.hand,
      pitchMidi,
      finger: chordEvent.fingerings[idx] ?? null,
      selected: idx === location.noteIndex,
      locked: chordNoteId ? lockedFingerings[chordNoteId] !== undefined : false,
    };
  });
}

export function getKeyboardPreviewNotesForMeasure(
  payload: ResultPayload | null,
  measure: number | null,
  lockedFingerings: Record<string, number>,
  selectedNoteId: string | null = null,
): KeyboardPreviewNote[] {
  if (measure == null) {
    return [];
  }

  const out: KeyboardPreviewNote[] = [];
  const hands = payload?.fingerings?.hands ?? {};

  for (const hand of ["RH", "LH"] as HandName[]) {
    const events = hands[hand] ?? [];

    for (const evt of events) {
      if (!evt || evt.measure !== measure) {
        continue;
      }

      if (evt.type === "note" && evt.note_id) {
        out.push({
          noteId: evt.note_id,
          hand,
          pitchMidi: evt.pitch_midi,
          finger: evt.fingering,
          selected: evt.note_id === selectedNoteId,
          locked: lockedFingerings[evt.note_id] !== undefined,
        });
        continue;
      }

      if (evt.type === "chord" && Array.isArray(evt.note_ids) && Array.isArray(evt.pitches_midi)) {
        evt.note_ids.forEach((noteId: string | null, idx: number) => {
          if (!noteId) {
            return;
          }

          out.push({
            noteId,
            hand,
            pitchMidi: evt.pitches_midi[idx],
            finger: evt.fingerings[idx] ?? null,
            selected: noteId === selectedNoteId,
            locked: lockedFingerings[noteId] !== undefined,
          });
        });
      }
    }
  }

  return out.sort((a, b) => a.pitchMidi - b.pitchMidi || a.hand.localeCompare(b.hand));
}

export function getDisplayedFinger(payload: ResultPayload | null, noteId: string): number | null {
  const location = findNoteLocation(payload, noteId);
  if (!location) {
    return null;
  }

  if (location.event.type === "note") {
    return typeof location.event.fingering === "number" ? location.event.fingering : null;
  }

  const finger = location.event.fingerings[location.noteIndex ?? 0];
  return typeof finger === "number" ? finger : null;
}

export function validateFingerEdit(
  payload: ResultPayload | null,
  noteId: string,
  nextFinger: number,
): { ok: true } | { ok: false; reason: string } {
  const location = findNoteLocation(payload, noteId);
  if (!location) {
    return { ok: false, reason: "That note no longer exists in the current result." };
  }

  if (location.event.type === "note") {
    return { ok: true };
  }

  const existing = [...location.event.fingerings];
  existing[location.noteIndex ?? 0] = nextFinger;

  if (new Set(existing).size !== existing.length) {
    return { ok: false, reason: "Chord tones must use distinct fingers." };
  }

  return { ok: true };
}

export function applyManualEdits(payload: ResultPayload | null, manualEdits: Record<string, number>) {
  if (!payload) {
    return null;
  }

  const next = clonePayload(payload);
  const hands = next?.fingerings?.hands ?? {};

  for (const hand of ["RH", "LH"] as HandName[]) {
    const events = hands[hand] ?? [];
    for (const evt of events) {
      if (!evt) {
        continue;
      }

      if (evt.type === "note" && evt.note_id) {
        const override = manualEdits[evt.note_id];
        if (override !== undefined) {
          evt.fingering = override;
        }
        continue;
      }

      if (evt.type === "chord" && Array.isArray(evt.note_ids) && Array.isArray(evt.fingerings)) {
        evt.note_ids.forEach((noteId: string | null, idx: number) => {
          if (!noteId) {
            return;
          }
          const override = manualEdits[noteId];
          if (override !== undefined) {
            evt.fingerings[idx] = override;
          }
        });
      }
    }
  }

  return next;
}
