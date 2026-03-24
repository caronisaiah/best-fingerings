from __future__ import annotations

import io
import zipfile
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict
from dataclasses import dataclass
from fractions import Fraction
from typing import Dict, List, Optional, Tuple

from music21 import chord, converter, note, stream

from app.models.events import (
    AnalyzeHandsResponse,
    ChordEvent,
    Event,
    Hand,
    MusicXMLAnchor,
    NoteEvent,
    Staff,
    musicxml_anchor_to_note_id,
)

# -------------------------------------------------------------------
# Versioning (USED BY /fingerings cache key)
# -------------------------------------------------------------------
# Bump PARSER_VERSION whenever:
# - you change anchor matching logic
# - you change how pitches/onsets/voice/staff are derived
# - you change warnings behavior that affects output payload
PARSER_VERSION = "0.0.4"

# Bump ANCHOR_SCHEMA_VERSION whenever you change fields/meaning of MusicXMLAnchor
ANCHOR_SCHEMA_VERSION = 2

# Safety: cap warning spam in responses
_MAX_WARNINGS = 250


@dataclass
class ParseConfig:
    # v1 definition: staff mapping only, no redistribution
    treble_hand: Hand = Hand.RH
    bass_hand: Hand = Hand.LH


# ---------------------------
# MusicXML helpers (anchors)
# ---------------------------

def _mxl_bytes_to_xml_root(xml_bytes: bytes) -> ET.Element:
    return ET.fromstring(xml_bytes)


def _strip_ns(tag: str) -> str:
    if "}" in tag:
        return tag.split("}", 1)[1]
    return tag


def _child_text(el: ET.Element, name: str) -> Optional[str]:
    for ch in el:
        if _strip_ns(ch.tag) == name:
            return (ch.text or "").strip()
    return None


def _find_children(el: ET.Element, name: str) -> List[ET.Element]:
    return [ch for ch in el if _strip_ns(ch.tag) == name]


def _pitch_to_midi(note_el: ET.Element) -> Optional[int]:
    pitch = None
    for ch in note_el:
        if _strip_ns(ch.tag) == "pitch":
            pitch = ch
            break
    if pitch is None:
        return None

    step = _child_text(pitch, "step")
    octv = _child_text(pitch, "octave")
    if step is None or octv is None:
        return None

    alter_txt = _child_text(pitch, "alter")
    # MusicXML can contain fractional alters; we can't represent quarter-tones here,
    # so we round toward int as best-effort.
    alter = int(round(float(alter_txt))) if alter_txt not in (None, "") else 0

    step_map = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
    base = step_map.get(step.upper())
    if base is None:
        return None

    octave = int(octv)
    return (octave + 1) * 12 + base + alter


def _read_transpose_semitones(attributes_el: ET.Element) -> Optional[int]:
    """
    MusicXML transposition lives under:
      <attributes><transpose><chromatic>...</chromatic><octave-change>...</octave-change></transpose></attributes>
    Not common for piano, but when present it WILL break pitch matching if ignored.
    """
    for tr in _find_children(attributes_el, "transpose"):
        chrom = _child_text(tr, "chromatic")
        octchg = _child_text(tr, "octave-change")
        semis = 0
        if chrom:
            semis += int(round(float(chrom)))
        if octchg:
            semis += 12 * int(round(float(octchg)))
        return semis
    return None


class _AnchorNote:
    __slots__ = ("anchor", "pitch_midi")

    def __init__(self, anchor: MusicXMLAnchor, pitch_midi: int):
        self.anchor = anchor
        self.pitch_midi = pitch_midi


def build_musicxml_anchor_index(
    xml_bytes: bytes,
) -> tuple[Dict[tuple, List[_AnchorNote]], Dict[tuple, int], List[str]]:
    """
    Returns:
      - chord_index: dict key -> list[_AnchorNote] for each chord group
      - divisions_map: dict (part_id, measure_no) -> divisions (int)
      - part_ids_in_order: list of MusicXML <part id="..."> in document order

    chord_index key:
      (part_id, measure_no, voice, staff, onset_div, divisions, note_ordinal)

    Notes:
    - We index note *groups* (a chord-start note + subsequent <chord/> tones) and store
      note_ordinal as the ordinal of groups within (part, measure, voice, staff) excluding rests.
    - chord_ordinal is ordinal within the group in MusicXML document order (0..k-1).
    - divisions and transpose can be omitted in measures; they inherit. We implement that here.
    """
    root = _mxl_bytes_to_xml_root(xml_bytes)

    # Collect <part> elements in document order
    parts: List[ET.Element] = []
    for ch in root.iter():
        if _strip_ns(ch.tag) == "part":
            parts.append(ch)

    part_ids_in_order = [p.attrib.get("id", "P0") for p in parts]

    chord_index: Dict[tuple, List[_AnchorNote]] = {}
    divisions_map: Dict[tuple, int] = {}

    # Persistent inherited values per part
    last_divisions_by_part: Dict[str, int] = {}
    last_transpose_by_part: Dict[str, int] = {}

    for part in parts:
        part_id = part.attrib.get("id", "P0")
        last_divisions = last_divisions_by_part.get(part_id, 1)
        last_transpose = last_transpose_by_part.get(part_id, 0)

        fallback_meas_no = 0
        for meas in list(part):
            if _strip_ns(meas.tag) != "measure":
                continue
            fallback_meas_no += 1

            meas_no_raw = meas.attrib.get("number", "")
            try:
                measure_no = int(meas_no_raw)
            except Exception:
                measure_no = fallback_meas_no

            # Inherited <divisions> and <transpose>
            for attr in _find_children(meas, "attributes"):
                div_txt = _child_text(attr, "divisions")
                if div_txt:
                    dv = int(round(float(div_txt)))
                    if dv > 0:
                        last_divisions = dv

                tr = _read_transpose_semitones(attr)
                if tr is not None:
                    last_transpose = tr

            last_divisions_by_part[part_id] = last_divisions
            last_transpose_by_part[part_id] = last_transpose

            divisions = last_divisions
            transpose = last_transpose

            divisions_map[(part_id, measure_no)] = divisions

            # time cursor per (voice, staff) in divisions
            cursor = defaultdict(int)

            # group ordinal counters per (voice, staff)
            note_group_counter = defaultdict(int)

            # last chord-start group tracking per (voice, staff)
            last_group_key: Dict[tuple, tuple] = {}  # (voice, staff) -> (onset_div, note_ordinal)

            for note_el in list(meas):
                if _strip_ns(note_el.tag) != "note":
                    continue

                is_rest = any(_strip_ns(ch.tag) == "rest" for ch in list(note_el))
                voice = _child_text(note_el, "voice") or "1"

                staff_txt = _child_text(note_el, "staff")
                staff = int(staff_txt) if staff_txt and staff_txt.isdigit() else None

                dur_txt = _child_text(note_el, "duration")
                dur_div = int(round(float(dur_txt))) if dur_txt not in (None, "") else 0

                is_chord_tone = any(_strip_ns(ch.tag) == "chord" for ch in list(note_el))

                # Determine onset + group ordinal in divisions
                if is_chord_tone:
                    onset_div, note_ordinal = last_group_key.get((voice, staff), (cursor[(voice, staff)], None))
                    if note_ordinal is None:
                        onset_div = cursor[(voice, staff)]
                        note_ordinal = note_group_counter[(voice, staff)]
                        note_group_counter[(voice, staff)] += 1
                        last_group_key[(voice, staff)] = (onset_div, note_ordinal)
                else:
                    onset_div = cursor[(voice, staff)]
                    note_ordinal = note_group_counter[(voice, staff)]
                    note_group_counter[(voice, staff)] += 1
                    last_group_key[(voice, staff)] = (onset_div, note_ordinal)

                # Advance cursor only for non-chord tones (rests still advance time)
                if (not is_chord_tone) and dur_div > 0:
                    cursor[(voice, staff)] += dur_div

                if is_rest:
                    continue

                pitch_midi = _pitch_to_midi(note_el)
                if pitch_midi is None:
                    continue

                # Apply transpose so pitches align with music21 (which typically applies transposition)
                pitch_midi += int(transpose)

                key = (part_id, measure_no, str(voice), staff, int(onset_div), int(divisions), int(note_ordinal))
                group = chord_index.get(key)
                if group is None:
                    group = []
                    chord_index[key] = group

                chord_ordinal = len(group)
                is_grace = any(_strip_ns(ch.tag) == "grace" for ch in list(note_el))

                anchor = MusicXMLAnchor(
                    part_id=str(part_id),
                    measure_no=int(measure_no),
                    voice=str(voice),
                    staff=staff,
                    note_ordinal=int(note_ordinal),
                    chord_ordinal=int(chord_ordinal),
                    # raw <chord/> truth here; we normalize later when emitting events
                    is_chord=bool(is_chord_tone),
                    is_grace=bool(is_grace),
                )
                group.append(_AnchorNote(anchor=anchor, pitch_midi=pitch_midi))

    return chord_index, divisions_map, part_ids_in_order


def _quantize_to_divisions(t_meas_beats: float, divisions: int) -> int:
    frac = Fraction(t_meas_beats).limit_denominator(4096)
    return int(round(float(frac) * divisions))


def _score_group(required_pitches: List[int], group: List[_AnchorNote]) -> tuple[int, int]:
    """
    Returns (missing, extra) vs required pitch multiset, lower is better.
    """
    req = Counter(required_pitches)
    got = Counter([an.pitch_midi for an in group])

    overlap = 0
    for p, c in req.items():
        overlap += min(c, got.get(p, 0))

    missing = len(required_pitches) - overlap
    extra = len(group) - overlap
    return missing, extra


def _best_anchor_group_for_event(
    chord_index: Dict[tuple, List[_AnchorNote]],
    part_id: str,
    measure_no: int,
    voice: str,
    staff: Optional[int],
    onset_div: int,
    divisions: int,
    required_pitches: Optional[List[int]] = None,
    note_ordinal_guess: Optional[int] = None,
) -> Optional[tuple[tuple, List[_AnchorNote]]]:
    """
    Find the best chord group key.
    Key improvement: when required_pitches is provided, prefer PITCH MATCH over onset delta,
    and expand onset tolerance to ±2 only if needed.
    """
    # exact lookup if ordinal guess is provided
    if note_ordinal_guess is not None:
        key = (part_id, measure_no, voice, staff, onset_div, divisions, note_ordinal_guess)
        if key in chord_index:
            return key, chord_index[key]

    def collect_candidates(max_delta: int) -> List[tuple]:
        out: List[tuple] = []
        for k, group in chord_index.items():
            pid, mno, v, st, odiv, div, nord = k
            if pid != part_id or mno != measure_no or v != voice or div != divisions:
                continue
            if st != staff:
                continue

            delta = abs(int(odiv) - int(onset_div))
            if delta > max_delta:
                continue

            if required_pitches is not None:
                missing, extra = _score_group(required_pitches, group)
                # Prefer pitch match first, then onset delta
                out.append((missing, extra, delta, int(nord), k, group))
            else:
                out.append((delta, int(nord), k, group))
        return out

    # First pass: ±1 tick
    candidates = collect_candidates(1)

    # Second pass: if no candidates and we have required pitches, widen to ±2
    if (not candidates) and (required_pitches is not None):
        candidates = collect_candidates(2)

    if not candidates:
        return None

    candidates.sort()
    best = candidates[0]
    # unpack based on mode
    if required_pitches is not None:
        _, _, _, _, best_k, best_group = best
    else:
        _, _, best_k, best_group = best
    return best_k, best_group


# ---------------------------
# music21 parsing helpers
# ---------------------------

def _staff_to_hand_and_label(part_el: stream.Stream, cfg: ParseConfig) -> Tuple[Hand, Staff]:
    clefs = list(part_el.recurse().getElementsByClass("Clef"))
    has_treble = any(getattr(c, "sign", "") == "G" for c in clefs)
    has_bass = any(getattr(c, "sign", "") == "F" for c in clefs)

    if has_treble and not has_bass:
        return cfg.treble_hand, Staff.treble
    if has_bass and not has_treble:
        return cfg.bass_hand, Staff.bass

    return Hand.RH, Staff.unknown


def _abs_offset_in_part(el, part) -> float:
    try:
        return float(el.getOffsetInHierarchy(part))
    except Exception:
        return float(el.offset)


def _measure_local_offset(el, measure: stream.Measure, part) -> float:
    """
    Prefer hierarchy-based measure-local offsets (more stable than el.offset),
    fallback to global diff if needed.
    """
    try:
        return max(0.0, float(el.getOffsetInHierarchy(measure)))
    except Exception:
        # fallback: compute measure start globally
        try:
            measure_start = _abs_offset_in_part(measure, part)
            el_global = _abs_offset_in_part(el, part)
            return max(0.0, float(el_global - measure_start))
        except Exception:
            return max(0.0, float(el.offset))


def _maybe_decompress_mxl(data: bytes) -> bytes:
    if not data.startswith(b"PK\x03\x04"):
        return data

    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        # Try META-INF/container.xml first
        try:
            container = zf.read("META-INF/container.xml").decode("utf-8", errors="ignore")
            marker = 'full-path="'
            i = container.find(marker)
            if i != -1:
                j = container.find('"', i + len(marker))
                inner_path = container[i + len(marker): j]
                return zf.read(inner_path)
        except KeyError:
            pass

        # Fallback: first .xml not in META-INF
        xml_files = [n for n in zf.namelist() if n.lower().endswith(".xml") and not n.startswith("META-INF/")]
        if not xml_files:
            raise ValueError("MXL archive contains no XML score file")
        return zf.read(xml_files[0])


def _warn(warnings: List[str], msg: str) -> None:
    if len(warnings) < _MAX_WARNINGS:
        warnings.append(msg)


# ---------------------------
# Public API
# ---------------------------

def parse_musicxml_to_events(xml_bytes: bytes, cfg: Optional[ParseConfig] = None) -> AnalyzeHandsResponse:
    cfg = cfg or ParseConfig()
    warnings: List[str] = []

    xml_bytes = _maybe_decompress_mxl(xml_bytes)

    # Build MusicXML-native anchors
    chord_index, divisions_map, part_ids_in_order = build_musicxml_anchor_index(xml_bytes)

    score = converter.parseData(xml_bytes)
    parts = list(score.parts) if hasattr(score, "parts") else []
    if not parts:
        parts = [score]

    events: List[Event] = []
    event_id = 0
    idx_counter: Dict[tuple, int] = {}

    for p_idx, part in enumerate(parts):
        hand_guess, staff_label = _staff_to_hand_and_label(part, cfg)

        # Use MusicXML part order for reliable anchor matching
        part_id = part_ids_in_order[p_idx] if p_idx < len(part_ids_in_order) else f"P{p_idx}"

        # staff candidates for anchor lookup
        if staff_label == Staff.treble:
            staff_candidates: List[Optional[int]] = [1, None]
        elif staff_label == Staff.bass:
            staff_candidates = [2, None]
        else:
            staff_candidates = [1, 2, None]

        for el in part.recurse().notesAndRests:
            if el.isRest:
                continue

            t = _abs_offset_in_part(el, part)
            dur = float(el.duration.quarterLength)

            if dur <= 0:
                _warn(warnings, f"ZERO_DURATION_EVENT_SKIPPED_V1:t={t}")
                continue

            # measure context
            meas_num: Optional[int] = None
            m: Optional[stream.Measure] = None
            try:
                m = el.getContextByClass(stream.Measure)
                if m is not None and getattr(m, "number", None) is not None:
                    meas_num = int(m.number)
            except Exception:
                meas_num = None
                m = None

            if meas_num is None or m is None:
                _warn(warnings, f"ANCHOR_MISSING_MEASURE:event_id={event_id}")
                continue

            # robust measure-local onset (key for anchor matching)
            t_meas = _measure_local_offset(el, m, part)

            # voice: music21 voice ids can diverge from MusicXML <voice> text
            voice_val = None
            try:
                v = el.getContextByClass(stream.Voice)
                if v is not None and getattr(v, "id", None) is not None:
                    voice_val = v.id
            except Exception:
                voice_val = None

            divisions = divisions_map.get((str(part_id), meas_num), 1)
            onset_div = _quantize_to_divisions(t_meas, divisions)

            primary_voice = str(voice_val) if voice_val is not None else "1"
            voice_candidates = [primary_voice]
            if primary_voice != "1":
                voice_candidates.append("1")

            # pitch requirements for better group selection
            required_pitches: Optional[List[int]]
            if isinstance(el, note.Note):
                required_pitches = [int(el.pitch.midi)]
            elif isinstance(el, chord.Chord):
                required_pitches = [int(p.midi) for p in el.pitches]  # multiset scoring ignores order
            else:
                required_pitches = None

            found: Optional[tuple[tuple, List[_AnchorNote]]] = None
            found_voice: Optional[str] = None
            found_staff: Optional[int] = None

            for vstr in voice_candidates:
                for staff_num in staff_candidates:
                    found = _best_anchor_group_for_event(
                        chord_index=chord_index,
                        part_id=str(part_id),
                        measure_no=meas_num,
                        voice=vstr,
                        staff=staff_num,
                        onset_div=onset_div,
                        divisions=divisions,
                        required_pitches=required_pitches,
                        note_ordinal_guess=None,
                    )
                    if found is not None:
                        found_voice = vstr
                        found_staff = staff_num
                        break
                if found is not None:
                    break

            xml_anchor: MusicXMLAnchor
            xml_note_anchors: Optional[List[MusicXMLAnchor]] = None
            note_ids: Optional[List[str]] = None
            idx_meas_voice: int

            if found is None:
                # fallback
                key_fallback = (meas_num, staff_label.value, str(voice_val), hand_guess.value)
                idx = idx_counter.get(key_fallback, 0)
                idx_counter[key_fallback] = idx + 1
                note_ids = None

                xml_anchor = MusicXMLAnchor(
                    part_id=str(part_id),
                    measure_no=meas_num,
                    voice=primary_voice,
                    staff=staff_candidates[0] if staff_candidates else None,
                    note_ordinal=idx,
                    chord_ordinal=0,
                    is_chord=False,
                    is_grace=False,
                )
                idx_meas_voice = idx
            else:
                _, group = found
                any_anchor = group[0].anchor
                idx_meas_voice = any_anchor.note_ordinal

                # For chords, we want to preserve MusicXML document order so chord_ordinal stays meaningful.
                group_pitches = [an.pitch_midi for an in group]

                if isinstance(el, note.Note):
                    pm = int(el.pitch.midi)

                    # Find an anchor in the group matching this pitch (document order)
                    matched: Optional[MusicXMLAnchor] = None
                    for an in group:
                        if an.pitch_midi == pm:
                            matched = an.anchor
                            break

                    if matched is None:
                        matched = any_anchor
                        _warn(
                            warnings,
                            f"ANCHOR_PITCH_MISMATCH_NOTE:event_id={event_id}:"
                            f"part={part_id}:meas={meas_num}:voice={found_voice}:staff={found_staff}:"
                            f"onset_div={onset_div}:div={divisions}:m21_pitch={pm}:xml_group_pitches={group_pitches}",
                        )

                    # Normalize:
                    # - If the matched anchor belongs to a chord group (group size > 1), force is_chord=True
                    #   even for the first tone (which lacks <chord/> in MusicXML).
                    if len(group) > 1:
                        xml_anchor = matched.model_copy(update={"is_chord": True})
                    else:
                        # single note => non-chord
                        xml_anchor = matched.model_copy(update={"is_chord": False, "chord_ordinal": 0})

                    xml_note_anchors = None
                    note_ids = None

                elif isinstance(el, chord.Chord):
                    # Use MusicXML group order for determinism + stable OSMD mapping
                    missing, extra = (0, 0)
                    if required_pitches is not None:
                        missing, extra = _score_group(required_pitches, group)
                    if missing != 0 or extra != 0:
                        _warn(
                            warnings,
                            f"ANCHOR_PITCH_MISMATCH_CHORD:event_id={event_id}:"
                            f"part={part_id}:meas={meas_num}:voice={found_voice}:staff={found_staff}:"
                            f"onset_div={onset_div}:div={divisions}:m21_pitches={sorted(required_pitches)}:"
                            f"xml_group_pitches={group_pitches}:missing={missing}:extra={extra}",
                        )

                    # Normalize: every notehead in chord group is a chord tone
                    xml_note_anchors = [an.anchor.model_copy(update={"is_chord": True}) for an in group]
                    note_ids = [musicxml_anchor_to_note_id(anchor) for anchor in xml_note_anchors]

                    # Event-level anchor: choose chord_ordinal == 0 if present, else first
                    a0 = next((a for a in xml_note_anchors if a.chord_ordinal == 0), xml_note_anchors[0])
                    xml_anchor = a0

                else:
                    xml_anchor = any_anchor.model_copy(update={"is_chord": False, "chord_ordinal": 0})
                    xml_note_anchors = None
                    note_ids = None

            # Emit events
            if isinstance(el, note.Note):
                events.append(
                    NoteEvent(
                        event_id=event_id,
                        hand=hand_guess,
                        staff=staff_label,
                        t_beats=t,
                        t_meas_beats=t_meas,
                        duration_beats=dur,
                        measure=meas_num,
                        voice=voice_val,
                        idx_meas_voice=idx_meas_voice,
                        pitch_midi=int(el.pitch.midi),
                        xml_anchor=xml_anchor,
                        note_id=musicxml_anchor_to_note_id(xml_anchor),
                    )
                )
                event_id += 1

            elif isinstance(el, chord.Chord):
                # IMPORTANT: align pitches with xml_note_anchors (MusicXML order)
                if xml_note_anchors is not None and found is not None:
                    _, group = found
                    pitches_out = [an.pitch_midi for an in group]
                else:
                    # fallback: music21 order
                    pitches_out = [int(p.midi) for p in el.pitches]

                # Normalize to "note" if only one pitch
                if len(pitches_out) < 2:
                    events.append(
                        NoteEvent(
                            event_id=event_id,
                            hand=hand_guess,
                            staff=staff_label,
                            t_beats=t,
                            t_meas_beats=t_meas,
                            duration_beats=dur,
                            measure=meas_num,
                            voice=voice_val,
                            idx_meas_voice=idx_meas_voice,
                            pitch_midi=int(pitches_out[0]),
                            xml_anchor=xml_anchor,
                            note_id=musicxml_anchor_to_note_id(xml_anchor),
                        )
                    )
                else:
                    events.append(
                        ChordEvent(
                            event_id=event_id,
                            hand=hand_guess,
                            staff=staff_label,
                            t_beats=t,
                            t_meas_beats=t_meas,
                            duration_beats=dur,
                            measure=meas_num,
                            voice=voice_val,
                            idx_meas_voice=idx_meas_voice,
                            pitches_midi=pitches_out,
                            xml_anchor=xml_anchor,
                            note_id=(note_ids[0] if note_ids else musicxml_anchor_to_note_id(xml_anchor)),
                            xml_note_anchors=xml_note_anchors,
                            note_ids=note_ids,
                        )
                    )
                event_id += 1
            else:
                _warn(warnings, f"UNSUPPORTED_ELEMENT_TYPE:{type(el).__name__}")

    def _voice_key(v) -> str:
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
        _warn(warnings, f"UNKNOWN_STAFF_EVENTS_V1:count={unknown_staff_count}")

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
        "parser_version": PARSER_VERSION,
        "anchor_schema_version": ANCHOR_SCHEMA_VERSION,
    }

    return AnalyzeHandsResponse(
        hands={"RH": rh_events, "LH": lh_events},
        stats=stats,
        warnings=warnings,
    )
