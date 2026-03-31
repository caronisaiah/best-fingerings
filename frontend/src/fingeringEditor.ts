import type { FingeringEvent, HandName, ResultPayload, ScorePassageTarget } from "./types";

export type NoteEditorItem = {
  noteId: string;
  hand: HandName;
  eventId: number;
  measure: number | null;
  staffNumber: number | null;
  tMeasBeats: number | null;
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

export type KeyboardPreviewGroup = {
  key: string;
  measure: number;
  onsetBeats: number;
  momentIndex: number;
  label: string;
  notes: KeyboardPreviewNote[];
  noteIds: string[];
  primaryNoteId: string | null;
};

export type KeyboardPreviewChunk = {
  key: string;
  measure: number;
  onsetBeats: number | null;
  chunkIndex: number;
  label: string;
  beatLabel: string;
  noteCount: number;
  notes: KeyboardPreviewNote[];
  noteIds: string[];
  primaryNoteId: string | null;
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
          tMeasBeats: typeof evt.t_meas_beats === "number" ? evt.t_meas_beats : null,
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
            tMeasBeats: typeof evt.t_meas_beats === "number" ? evt.t_meas_beats : null,
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

export function getKeyboardPreviewChunksForMeasure(
  payload: ResultPayload | null,
  measure: number | null,
  lockedFingerings: Record<string, number>,
  selectedNoteId: string | null = null,
): KeyboardPreviewChunk[] {
  if (measure == null) {
    return [];
  }

  const groups = new Map<
    string,
    {
      measure: number;
      onsetBeats: number | null;
      order: number;
      notes: KeyboardPreviewNote[];
      noteIds: string[];
      primaryNoteId: string | null;
    }
  >();
  const hands = payload?.fingerings?.hands ?? {};

  for (const hand of ["RH", "LH"] as HandName[]) {
    const events = hands[hand] ?? [];

    for (const evt of events) {
      if (!evt || evt.measure !== measure) {
        continue;
      }

      const onsetBeats = typeof evt.t_meas_beats === "number" && Number.isFinite(evt.t_meas_beats)
        ? evt.t_meas_beats
        : null;
      const order = getChunkOrder(evt, onsetBeats);
      const key = getChunkKey(measure, onsetBeats, order);
      const existing = groups.get(key) ?? {
        measure,
        onsetBeats,
        order,
        notes: [],
        noteIds: [],
        primaryNoteId: null,
      };

      existing.order = Math.min(existing.order, order);

      if (evt.type === "note" && evt.note_id) {
        existing.notes.push({
          noteId: evt.note_id,
          hand,
          pitchMidi: evt.pitch_midi,
          finger: evt.fingering,
          selected: evt.note_id === selectedNoteId,
          locked: lockedFingerings[evt.note_id] !== undefined,
        });
        existing.noteIds.push(evt.note_id);
        if (existing.primaryNoteId == null || evt.note_id === selectedNoteId) {
          existing.primaryNoteId = evt.note_id;
        }
      } else if (evt.type === "chord" && Array.isArray(evt.note_ids) && Array.isArray(evt.pitches_midi)) {
        evt.note_ids.forEach((noteId: string | null, idx: number) => {
          if (!noteId) {
            return;
          }

          existing.notes.push({
            noteId,
            hand,
            pitchMidi: evt.pitches_midi[idx],
            finger: evt.fingerings[idx] ?? null,
            selected: noteId === selectedNoteId,
            locked: lockedFingerings[noteId] !== undefined,
          });
          existing.noteIds.push(noteId);
          if (existing.primaryNoteId == null || noteId === selectedNoteId) {
            existing.primaryNoteId = noteId;
          }
        });
      }

      groups.set(key, existing);
    }
  }

  return Array.from(groups.entries())
    .map(([key, group]) => ({
      key,
      measure: group.measure,
      onsetBeats: group.onsetBeats,
      order: group.order,
      notes: group.notes.sort((a, b) => a.pitchMidi - b.pitchMidi || a.hand.localeCompare(b.hand)),
      noteIds: group.noteIds,
      primaryNoteId: group.primaryNoteId,
    }))
    .sort((a, b) => a.order - b.order || (a.onsetBeats ?? 0) - (b.onsetBeats ?? 0))
    .map((group, index) => ({
      key: group.key,
      measure: group.measure,
      onsetBeats: group.onsetBeats,
      chunkIndex: index,
      label: `Chunk ${index + 1}`,
      beatLabel: formatChunkBeatLabel(group.onsetBeats),
      noteCount: group.notes.length,
      notes: group.notes,
      noteIds: group.noteIds,
      primaryNoteId: group.primaryNoteId,
    }));
}

export function getKeyboardPreviewGroups(
  payload: ResultPayload | null,
  lockedFingerings: Record<string, number>,
  selectedNoteId: string | null = null,
): KeyboardPreviewGroup[] {
  const groups = new Map<
    string,
    {
      measure: number;
      onsetBeats: number;
      notes: KeyboardPreviewNote[];
      noteIds: string[];
      primaryNoteId: string | null;
    }
  >();
  const hands = payload?.fingerings?.hands ?? {};

  for (const hand of ["RH", "LH"] as HandName[]) {
    const events = hands[hand] ?? [];

    for (const evt of events) {
      if (!evt || evt.measure == null) {
        continue;
      }

      const onsetBeats = typeof evt.t_meas_beats === "number" ? evt.t_meas_beats : 0;
      const key = getPreviewGroupKey(evt.measure, onsetBeats);
      const existing = groups.get(key) ?? {
        measure: evt.measure,
        onsetBeats,
        notes: [],
        noteIds: [],
        primaryNoteId: null,
      };

      if (evt.type === "note" && evt.note_id) {
        existing.notes.push({
          noteId: evt.note_id,
          hand,
          pitchMidi: evt.pitch_midi,
          finger: evt.fingering,
          selected: evt.note_id === selectedNoteId,
          locked: lockedFingerings[evt.note_id] !== undefined,
        });
        existing.noteIds.push(evt.note_id);
        if (existing.primaryNoteId == null || evt.note_id === selectedNoteId) {
          existing.primaryNoteId = evt.note_id;
        }
      } else if (evt.type === "chord" && Array.isArray(evt.note_ids) && Array.isArray(evt.pitches_midi)) {
        evt.note_ids.forEach((noteId: string | null, idx: number) => {
          if (!noteId) {
            return;
          }

          existing.notes.push({
            noteId,
            hand,
            pitchMidi: evt.pitches_midi[idx],
            finger: evt.fingerings[idx] ?? null,
            selected: noteId === selectedNoteId,
            locked: lockedFingerings[noteId] !== undefined,
          });
          existing.noteIds.push(noteId);
          if (existing.primaryNoteId == null || noteId === selectedNoteId) {
            existing.primaryNoteId = noteId;
          }
        });
      }

      groups.set(key, existing);
    }
  }

  const grouped = Array.from(groups.entries())
    .map(([key, group]) => ({
      key,
      measure: group.measure,
      onsetBeats: group.onsetBeats,
      notes: group.notes.sort((a, b) => a.pitchMidi - b.pitchMidi || a.hand.localeCompare(b.hand)),
      noteIds: group.noteIds,
      primaryNoteId: group.primaryNoteId,
    }))
    .sort((a, b) => a.measure - b.measure || a.onsetBeats - b.onsetBeats);

  let currentMeasure = -1;
  let momentIndex = 0;

  return grouped.map((group) => {
    if (group.measure !== currentMeasure) {
      currentMeasure = group.measure;
      momentIndex = 1;
    } else {
      momentIndex += 1;
    }

    return {
      ...group,
      momentIndex,
      label: `Measure ${group.measure} • Moment ${momentIndex}`,
    };
  });
}

export function getKeyboardPreviewGroupForTarget(
  groups: KeyboardPreviewGroup[],
  target: ScorePassageTarget | null,
): KeyboardPreviewGroup | null {
  if (!target) {
    return null;
  }

  const groupsInMeasure = groups.filter((group) => group.measure === target.measureNumber);
  if (groupsInMeasure.length === 0) {
    return null;
  }

  if (typeof target.tMeasBeats === "number" && Number.isFinite(target.tMeasBeats)) {
    const targetBeats = target.tMeasBeats;
    return groupsInMeasure.reduce((best, group) => {
      if (!best) {
        return group;
      }
      return Math.abs(group.onsetBeats - targetBeats) < Math.abs(best.onsetBeats - targetBeats)
        ? group
        : best;
    }, groupsInMeasure[0] ?? null);
  }

  if (groupsInMeasure.length === 1) {
    return groupsInMeasure[0];
  }

  const normalizedIndex = target.staffEntryCount > 1
    ? target.staffEntryIndex / (target.staffEntryCount - 1)
    : 0;
  const groupIndex = Math.round(normalizedIndex * (groupsInMeasure.length - 1));
  return groupsInMeasure[Math.max(0, Math.min(groupsInMeasure.length - 1, groupIndex))] ?? groupsInMeasure[0];
}

function getPreviewGroupKey(measure: number, onsetBeats: number) {
  return `${measure}:${onsetBeats.toFixed(6)}`;
}

function getChunkKey(measure: number, onsetBeats: number | null, order: number) {
  return onsetBeats != null
    ? `${measure}:onset:${onsetBeats.toFixed(6)}`
    : `${measure}:order:${order}`;
}

function getChunkOrder(event: FingeringEvent, onsetBeats: number | null) {
  if (onsetBeats != null) {
    return onsetBeats;
  }

  if (typeof event.idx_meas_voice === "number" && Number.isFinite(event.idx_meas_voice)) {
    return event.idx_meas_voice;
  }

  return event.event_id;
}

function formatChunkBeatLabel(onsetBeats: number | null) {
  if (onsetBeats == null) {
    return "Beat position unavailable";
  }

  const beat = onsetBeats + 1;
  if (Math.abs(beat - Math.round(beat)) < 0.001) {
    return `Beat ${Math.round(beat)}`;
  }

  return `Beat ${beat.toFixed(2).replace(/\.?0+$/, "")}`;
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
