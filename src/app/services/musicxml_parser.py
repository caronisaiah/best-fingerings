from __future__ import annotations
import io
import zipfile
from dataclasses import dataclass
from typing import List, Tuple, Optional

from music21 import converter, note, chord, stream

from app.models.events import (
    AnalyzeHandsResponse,
    Event,
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

def _abs_offset_in_part(el, part) -> float:
    """
    Get a global onset in quarterLength units relative to the start of the part.
    This avoids measure-local offsets that often appear when iterating recurse().
    """
    try:
        return float(el.getOffsetInHierarchy(part))
    except Exception:
        # Fallback if hierarchy lookup fails
        return float(el.offset)

def _maybe_decompress_mxl(data: bytes) -> bytes:
    # MXL is a ZIP container. ZIP files begin with PK\x03\x04.
    if not data.startswith(b"PK\x03\x04"):
        return data

    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        # Try the official container.xml first
        try:
            container = zf.read("META-INF/container.xml").decode("utf-8", errors="ignore")
            # Extremely small, safe parse: find the "full-path" attribute
            # Example: full-path="score.xml"
            marker = 'full-path="'
            i = container.find(marker)
            if i != -1:
                j = container.find('"', i + len(marker))
                inner_path = container[i + len(marker): j]
                return zf.read(inner_path)
        except KeyError:
            pass

        # Fallback: pick the first .xml file that isn't in META-INF
        xml_files = [n for n in zf.namelist() if n.lower().endswith(".xml") and not n.startswith("META-INF/")]
        if not xml_files:
            raise ValueError("MXL archive contains no XML score file")
        return zf.read(xml_files[0])

def parse_musicxml_to_events(xml_bytes: bytes, cfg: Optional[ParseConfig] = None) -> AnalyzeHandsResponse:
    cfg = cfg or ParseConfig()
    warnings: List[str] = []

    xml_bytes = _maybe_decompress_mxl(xml_bytes)
    score = converter.parseData(xml_bytes)

    parts = list(score.parts) if hasattr(score, "parts") else []
    if not parts:
        parts = [score]

    events: List[Event] = []
    event_id = 0

    # NEW: per-measure/voice/hand index counter for stable anchors
    idx_counter = {}  # key: (measure, staff, voice, hand) -> next idx

    for p_idx, part in enumerate(parts):
        hand_guess, staff_label = _staff_to_hand_and_label(part, cfg)

        clefs = list(part.recurse().getElementsByClass("Clef"))
        if len({(getattr(c, "sign", None), getattr(c, "line", None)) for c in clefs}) > 1:
            warnings.append(f"PART_{p_idx}:CLEF_CHANGES_DETECTED_V1")

        for el in part.recurse().notesAndRests:
            if el.isRest:
                continue

            # Global onset and duration in quarterLength units
            t = _abs_offset_in_part(el, part)
            dur = float(el.duration.quarterLength)
            if dur <= 0:
                warnings.append(f"ZERO_DURATION_EVENT_SKIPPED_V1:t={t}")
                continue

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

            # NEW: measure-local onset + idx within (measure, staff, voice, hand)
            t_meas = float(el.offset)

            key = (
                meas_num,
                staff_label.value,
                str(voice_val),
                hand_guess.value,
            )
            idx = idx_counter.get(key, 0)
            idx_counter[key] = idx + 1

            if isinstance(el, note.Note):
                events.append(
                    NoteEvent(
                        event_id=event_id,
                        hand=hand_guess,
                        staff=staff_label,
                        t_beats=t,
                        t_meas_beats=t_meas,      # NEW
                        duration_beats=dur,
                        measure=meas_num,
                        voice=voice_val,
                        idx_meas_voice=idx,       # NEW
                        pitch_midi=int(el.pitch.midi),
                    )
                )
                event_id += 1

            elif isinstance(el, chord.Chord):
                pitches = sorted(int(p.midi) for p in el.pitches)
                if len(pitches) < 2:
                    events.append(
                        NoteEvent(
                            event_id=event_id,
                            hand=hand_guess,
                            staff=staff_label,
                            t_beats=t,
                            t_meas_beats=t_meas,  # NEW
                            duration_beats=dur,
                            measure=meas_num,
                            voice=voice_val,
                            idx_meas_voice=idx,   # NEW
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
                            t_meas_beats=t_meas,  # NEW
                            duration_beats=dur,
                            measure=meas_num,
                            voice=voice_val,
                            idx_meas_voice=idx,   # NEW
                            pitches_midi=pitches,
                        )
                    )
                event_id += 1
            else:
                warnings.append(f"UNSUPPORTED_ELEMENT_TYPE:{type(el).__name__}")

    # Stable sort: global time -> hand -> measure -> voice -> measure-local time -> idx -> event_id
    def _voice_key(v):
        return "" if v is None else str(v)

    events.sort(
        key=lambda e: (
            e.t_beats,
            e.hand.value,
            (e.measure or 0),
            _voice_key(e.voice),
            e.t_meas_beats,
            e.idx_meas_voice,
            e.event_id,
        )
    )

    rh_events = [e for e in events if e.hand == Hand.RH]
    lh_events = [e for e in events if e.hand == Hand.LH]

    unknown_staff_count = sum(1 for e in events if e.staff == Staff.unknown)
    if unknown_staff_count:
        warnings.append(f"UNKNOWN_STAFF_EVENTS_V1:count={unknown_staff_count}")

    def _counts(evts: List[Event]) -> dict:
        return {
            "event_count": len(evts),
            "note_count": sum(1 for e in evts if getattr(e, "type", "") == "note"),
            "chord_count": sum(1 for e in evts if getattr(e, "type", "") == "chord"),
        }

    stats = {
        "overall": _counts(events),
        "RH": _counts(rh_events),
        "LH": _counts(lh_events),
    }

    return AnalyzeHandsResponse(
        hands={"RH": rh_events, "LH": lh_events},
        stats=stats,
        warnings=warnings,
    )