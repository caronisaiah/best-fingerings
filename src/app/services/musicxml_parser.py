from __future__ import annotations

from dataclasses import dataclass
from typing import List, Tuple, Optional

from music21 import converter, note, chord, stream

from app.models.events import (
    AnalyzeScoreResponse,
    Hand,
    Staff,
    NoteEvent,
    ChordEvent,
)


@dataclass
class ParseConfig:
    # v1 definition: staff mapping only, no redistribution
    treble_hand: Hand = Hand.RH
    bass_hand: Hand = Hand.LH


def _staff_to_hand_and_label(part_el: stream.Stream, cfg: ParseConfig) -> Tuple[Hand, Staff]:
    """
    music21 doesn't always give a perfect 'staff' label.
    For v1 we infer using clef context when possible; otherwise fallback to unknown.
    """
    # Heuristic: if the part has multiple staffs/clefs it can get messy.
    # We'll keep it simple and infer from clef of the element's context if available.
    clefs = list(part_el.recurse().getElementsByClass("Clef"))
    # If we see a treble clef anywhere, assume treble unless clearly bass-only.
    has_treble = any(getattr(c, "sign", "") == "G" for c in clefs)
    has_bass = any(getattr(c, "sign", "") == "F" for c in clefs)

    if has_treble and not has_bass:
        return cfg.treble_hand, Staff.treble
    if has_bass and not has_treble:
        return cfg.bass_hand, Staff.bass

    # If both exist, it's likely a piano grand staff or clef changes.
    # We'll return unknown and let route layer split by part/staff later if needed.
    return Hand.RH, Staff.unknown  # default RH, but mark unknown


def parse_musicxml_to_events(xml_bytes: bytes, cfg: Optional[ParseConfig] = None) -> AnalyzeScoreResponse:
    cfg = cfg or ParseConfig()
    warnings: List[str] = []

    score = converter.parseData(xml_bytes)

    # Basic sanity: expect a piano score-ish structure
    parts = list(score.parts) if hasattr(score, "parts") else []
    if not parts:
        # music21 might represent it differently; still attempt recursion
        parts = [score]

    events = []
    event_id = 0

    # We’ll parse beat offsets (music21 offsets are quarterLength-based)
    # beat == quarterLength in 4/4. In other meters it’s still a consistent score unit.
    # For v1 we treat quarterLength as "beat units" (stable for DP).
    for p_idx, part in enumerate(parts):
        hand_guess, staff_label = _staff_to_hand_and_label(part, cfg)

        # If multiple clefs exist, warn. This is where cross-staff/clef-changes happen.
        clefs = list(part.recurse().getElementsByClass("Clef"))
        if len({(getattr(c, "sign", None), getattr(c, "line", None)) for c in clefs}) > 1:
            warnings.append(f"PART_{p_idx}:CLEF_CHANGES_DETECTED_V1")

        # Notes + chords
        for el in part.recurse().notesAndRests:
            if el.isRest:
                continue

            # Onset and duration in quarterLength units
            t = float(el.offset)
            dur = float(el.duration.quarterLength)

            meas_num = None
            try:
                m = el.getContextByClass(stream.Measure)
                if m is not None and getattr(m, "number", None) is not None:
                    meas_num = int(m.number)
            except Exception:
                meas_num = None

            voice_val = None
            try:
                v = el.getContextByClass(stream.Voice)
                if v is not None and getattr(v, "id", None) is not None:
                    voice_val = v.id
            except Exception:
                voice_val = None

            if isinstance(el, note.Note):
                events.append(
                    NoteEvent(
                        event_id=event_id,
                        hand=hand_guess,
                        staff=staff_label,
                        t_beats=t,
                        duration_beats=dur,
                        measure=meas_num,
                        voice=voice_val,
                        pitch_midi=int(el.pitch.midi),
                    )
                )
                event_id += 1
            elif isinstance(el, chord.Chord):
                pitches = sorted(int(p.midi) for p in el.pitches)
                if len(pitches) < 2:
                    # chord with 1 pitch is effectively a note; treat as note
                    events.append(
                        NoteEvent(
                            event_id=event_id,
                            hand=hand_guess,
                            staff=staff_label,
                            t_beats=t,
                            duration_beats=dur,
                            measure=meas_num,
                            voice=voice_val,
                            pitch_midi=int(pitches[0]),
                        )
                    )
                else:
                    events.append(
                        ChordEvent(
                            event_id=event_id,
                            hand=hand_guess,
                            staff=staff_label,
                            t_beats=t,
                            duration_beats=dur,
                            measure=meas_num,
                            voice=voice_val,
                            pitches_midi=pitches,
                        )
                    )
                event_id += 1
            else:
                warnings.append(f"UNSUPPORTED_ELEMENT_TYPE:{type(el).__name__}")

    # Sort events by time, then by hand for stability
    events.sort(key=lambda e: (e.t_beats, e.hand.value, e.event_id))

    stats = {
        "event_count": len(events),
        "note_count": sum(1 for e in events if getattr(e, "type", "") == "note"),
        "chord_count": sum(1 for e in events if getattr(e, "type", "") == "chord"),
        "hands": {
            "RH": sum(1 for e in events if e.hand == Hand.RH),
            "LH": sum(1 for e in events if e.hand == Hand.LH),
        },
    }

    return AnalyzeScoreResponse(events=events, stats=stats, warnings=warnings)