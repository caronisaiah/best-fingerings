from __future__ import annotations

from dataclasses import dataclass, field
from itertools import combinations
from typing import Dict, List, Mapping, Optional, Sequence, Tuple

from app.models.events import ChordEvent, Event, Hand, NoteEvent
from app.models.fingerings import ChordFingering, FingeringsResponse, NoteFingering

ALGO_VERSION = "0.0.4-deterministic-locks"

# ---------------------------
# Search parameters
# ---------------------------

BEAM_WIDTH = 24
MAX_CHORD_NOTES = 5

# Comfortable pitch span (in semitones) for a given finger-distance.
# These are not "truth", they are practical heuristics.
MAX_SPAN_BY_FINGER_DISTANCE = {
    0: 0,
    1: 3,
    2: 5,
    3: 7,
    4: 10,
}

MIN_SPAN_BY_FINGER_DISTANCE = {
    0: 0,
    1: 1,
    2: 2,
    3: 4,
    4: 6,
}

# Outer-note chord span allowances by outer finger distance
MAX_CHORD_OUTER_SPAN = {
    1: 5,
    2: 8,
    3: 11,
    4: 15,
}

VALID_DIFFICULTIES = {"easy", "standard", "hard"}
VALID_STYLE_BIASES = {"neutral", "legato", "staccato"}
VALID_HAND_SIZES = {"small", "medium", "large"}
VALID_ARTICULATION_BIASES = {"auto", "neutral", "legato", "staccato"}


def _is_black_key(pitch_midi: int) -> bool:
    return (pitch_midi % 12) in {1, 3, 6, 8, 10}


@dataclass(frozen=True)
class FingeringConfig:
    difficulty: str = "standard"
    style_bias: str = "neutral"
    hand_size: str = "medium"
    articulation_bias: str = "auto"
    locked_note_fingerings: Dict[str, int] = field(default_factory=dict)


@dataclass
class CandidateAssignment:
    fingerings: List[int]            # aligned to output_indices
    output_indices: List[int]        # indices into original event pitches/anchors
    rep_pitch: int                   # representative pitch for search state
    rep_finger: int                  # representative finger for search state
    cost: float


@dataclass
class SearchState:
    cost: float
    last_pitch: Optional[int]
    last_finger: Optional[int]
    assignments: List[CandidateAssignment]


def normalize_config(config: Optional[FingeringConfig] = None) -> FingeringConfig:
    cfg = config or FingeringConfig()

    difficulty = str(cfg.difficulty or "standard").lower()
    style_bias = str(cfg.style_bias or "neutral").lower()
    hand_size = str(cfg.hand_size or "medium").lower()
    articulation_bias = str(cfg.articulation_bias or "auto").lower()

    if difficulty not in VALID_DIFFICULTIES:
        difficulty = "standard"
    if style_bias not in VALID_STYLE_BIASES:
        style_bias = "neutral"
    if hand_size not in VALID_HAND_SIZES:
        hand_size = "medium"
    if articulation_bias not in VALID_ARTICULATION_BIASES:
        articulation_bias = "auto"

    locked: Dict[str, int] = {}
    for note_id, finger in (cfg.locked_note_fingerings or {}).items():
        if note_id is None:
            continue
        try:
            finger_val = int(finger)
        except Exception:
            continue
        if 1 <= finger_val <= 5:
            locked[str(note_id)] = finger_val

    return FingeringConfig(
        difficulty=difficulty,
        style_bias=style_bias,
        hand_size=hand_size,
        articulation_bias=articulation_bias,
        locked_note_fingerings=locked,
    )


def _effective_articulation_bias(config: FingeringConfig) -> str:
    if config.articulation_bias != "auto":
        return config.articulation_bias
    if config.style_bias in {"legato", "staccato"}:
        return config.style_bias
    return "neutral"


def _difficulty_scale(config: FingeringConfig) -> float:
    return {
        "easy": 1.2,
        "standard": 1.0,
        "hard": 0.86,
    }.get(config.difficulty, 1.0)


def _hand_size_span_adjustment(config: FingeringConfig) -> int:
    return {
        "small": -2,
        "medium": 0,
        "large": 2,
    }.get(config.hand_size, 0)


def _max_span_for_distance(config: FingeringConfig, finger_distance: int) -> int:
    base = MAX_SPAN_BY_FINGER_DISTANCE[finger_distance]
    return max(0, base + _hand_size_span_adjustment(config))


def _max_outer_span(config: FingeringConfig, outer_finger_span: int) -> int:
    base = MAX_CHORD_OUTER_SPAN.get(outer_finger_span, 0)
    return max(0, base + _hand_size_span_adjustment(config))


def _locked_finger_for_note(config: FingeringConfig, note_id: Optional[str]) -> Optional[int]:
    if note_id is None:
        return None
    return config.locked_note_fingerings.get(note_id)


# ---------------------------
# Core scoring helpers
# ---------------------------

def _intrinsic_note_cost(finger: int, pitch_midi: int, config: FingeringConfig) -> float:
    cost = 0.0
    difficulty_scale = _difficulty_scale(config)

    # Thumb on black is often awkward
    if finger == 1 and _is_black_key(pitch_midi):
        cost += 3.0 * difficulty_scale

    # Pinky on black is also often awkward, but less catastrophic than thumb
    if finger == 5 and _is_black_key(pitch_midi):
        cost += 1.0 * difficulty_scale

    # Mild preference away from extreme fingers for isolated notes
    if finger in {1, 5}:
        cost += 0.15 * difficulty_scale

    return cost


def _direction_compatibility_penalty(
    hand: Hand,
    prev_pitch: int,
    prev_finger: int,
    curr_pitch: int,
    curr_finger: int,
    config: FingeringConfig,
) -> float:
    """
    Models whether finger motion matches pitch direction.

    RH:
      - ascending pitch usually likes increasing finger numbers
      - descending pitch usually likes decreasing finger numbers
      - special-case thumb-under / finger-over-thumb patterns

    LH is mirrored.
    """
    interval = curr_pitch - prev_pitch
    if interval == 0:
        return 0.0

    direction_scale = {
        "easy": 1.15,
        "standard": 1.0,
        "hard": 0.9,
    }.get(config.difficulty, 1.0)

    oriented_interval = interval if hand == Hand.RH else -interval
    finger_move = curr_finger - prev_finger
    abs_interval = abs(interval)

    if oriented_interval > 0:
        if finger_move > 0:
            return 0.0

        if curr_finger == 1 and prev_finger in {2, 3, 4} and abs_interval <= 5:
            return 0.45 * direction_scale

        return (2.8 + 0.6 * abs(finger_move)) * direction_scale

    if finger_move < 0:
        return 0.0

    if prev_finger == 1 and curr_finger in {2, 3, 4} and abs_interval <= 5:
        return 0.45 * direction_scale

    return (2.8 + 0.6 * abs(finger_move)) * direction_scale


def _transition_cost(
    hand: Hand,
    prev_pitch: Optional[int],
    prev_finger: Optional[int],
    curr_pitch: int,
    curr_finger: int,
    config: FingeringConfig,
) -> float:
    if prev_pitch is None or prev_finger is None:
        return 0.0

    interval = curr_pitch - prev_pitch
    abs_interval = abs(interval)
    articulation = _effective_articulation_bias(config)
    difficulty_scale = _difficulty_scale(config)

    if abs_interval == 0:
        if articulation == "legato":
            return 0.18 if curr_finger == prev_finger else 0.6
        if articulation == "staccato":
            return 0.72 if curr_finger == prev_finger else 0.1
        return 0.55 if curr_finger == prev_finger else 0.25

    cost = 0.0

    if curr_finger == prev_finger:
        cost += (5.0 + 0.5 * max(0, abs_interval - 1)) * difficulty_scale

    finger_distance = abs(curr_finger - prev_finger)
    max_span = _max_span_for_distance(config, finger_distance)
    min_span = MIN_SPAN_BY_FINGER_DISTANCE[finger_distance]

    if abs_interval > max_span:
        stretch_scale = {
            "easy": 1.65,
            "standard": 1.4,
            "hard": 1.1,
        }.get(config.difficulty, 1.4)
        cost += stretch_scale * (abs_interval - max_span)

    if finger_distance > 0 and abs_interval < min_span:
        compress_scale = {
            "easy": 0.7,
            "standard": 0.6,
            "hard": 0.45,
        }.get(config.difficulty, 0.6)
        cost += compress_scale * (min_span - abs_interval)

    cost += _direction_compatibility_penalty(
        hand=hand,
        prev_pitch=prev_pitch,
        prev_finger=prev_finger,
        curr_pitch=curr_pitch,
        curr_finger=curr_finger,
        config=config,
    )

    if abs_interval >= 12:
        leap_scale = {
            "easy": 0.65,
            "standard": 0.5,
            "hard": 0.35,
        }.get(config.difficulty, 0.5)
        cost += leap_scale * (abs_interval - 11)

    return cost


# ---------------------------
# Note candidates
# ---------------------------

def _note_candidates(
    hand: Hand,
    event: NoteEvent,
    prev_pitch: Optional[int],
    prev_finger: Optional[int],
    config: FingeringConfig,
) -> List[CandidateAssignment]:
    out: List[CandidateAssignment] = []

    locked_finger = _locked_finger_for_note(config, event.note_id)
    candidate_fingers = [locked_finger] if locked_finger is not None else list(range(1, 6))

    for finger in candidate_fingers:
        cost = 0.0
        cost += _intrinsic_note_cost(finger, event.pitch_midi, config)
        cost += _transition_cost(hand, prev_pitch, prev_finger, event.pitch_midi, finger, config)

        out.append(
            CandidateAssignment(
                fingerings=[finger],
                output_indices=[0],
                rep_pitch=event.pitch_midi,
                rep_finger=finger,
                cost=cost,
            )
        )

    out.sort(key=lambda c: c.cost)
    return out


# ---------------------------
# Chord candidates
# ---------------------------

def _ordered_finger_templates(hand: Hand, n: int) -> List[List[int]]:
    """
    Generate all monotone ordered distinct-finger templates of length n.

    RH low->high pitch => increasing finger numbers
    LH low->high pitch => decreasing finger numbers
    """
    combos = list(combinations([1, 2, 3, 4, 5], n))
    if hand == Hand.RH:
        return [list(c) for c in combos]
    return [list(reversed(c)) for c in combos]


def _chord_internal_cost(
    hand: Hand,
    pitches_sorted: Sequence[int],
    template: Sequence[int],
    config: FingeringConfig,
) -> float:
    cost = 0.0
    n = len(pitches_sorted)
    difficulty_scale = _difficulty_scale(config)

    for p, f in zip(pitches_sorted, template):
        cost += 0.7 * _intrinsic_note_cost(f, p, config)

    for i in range(n - 1):
        pitch_gap = pitches_sorted[i + 1] - pitches_sorted[i]
        finger_gap = abs(template[i + 1] - template[i])

        max_gap = _max_span_for_distance(config, finger_gap) + 2
        min_gap = 0 if finger_gap == 0 else 1

        if pitch_gap > max_gap:
            cost += 1.2 * difficulty_scale * (pitch_gap - max_gap)

        if pitch_gap < min_gap:
            cost += 0.4 * difficulty_scale * (min_gap - pitch_gap)

    outer_pitch_span = pitches_sorted[-1] - pitches_sorted[0]
    outer_finger_span = abs(template[-1] - template[0])

    max_outer = _max_outer_span(config, outer_finger_span)
    if outer_pitch_span > max_outer:
        cost += 2.0 * difficulty_scale * (outer_pitch_span - max_outer)

    if outer_pitch_span <= 2 and outer_finger_span >= 3:
        cost += 1.0 * difficulty_scale

    if hand == Hand.RH and template[-1] < 3:
        cost += 0.5
    if hand == Hand.LH and template[0] > 3:
        cost += 0.5

    return cost


def _locked_chord_requirements(
    config: FingeringConfig,
    event: ChordEvent,
    output_indices: Sequence[int],
) -> Dict[int, int]:
    locked: Dict[int, int] = {}
    note_ids = event.note_ids or []
    for local_idx, original_idx in enumerate(output_indices):
        note_id = note_ids[original_idx] if original_idx < len(note_ids) else None
        locked_finger = _locked_finger_for_note(config, note_id)
        if locked_finger is not None:
            locked[local_idx] = locked_finger
    return locked


def _template_matches_locked_fingers(
    sorted_template: Sequence[int],
    sorted_local_indices: Sequence[int],
    locked_by_local_index: Mapping[int, int],
) -> bool:
    for sorted_pos, local_idx in enumerate(sorted_local_indices):
        required = locked_by_local_index.get(local_idx)
        if required is not None and sorted_template[sorted_pos] != required:
            return False
    return True


def _chord_candidates(
    hand: Hand,
    event: ChordEvent,
    prev_pitch: Optional[int],
    prev_finger: Optional[int],
    warnings: List[str],
    config: FingeringConfig,
) -> List[CandidateAssignment]:
    pitches_original = list(event.pitches_midi)

    output_indices = list(range(len(pitches_original)))
    if len(output_indices) > MAX_CHORD_NOTES:
        warnings.append(f"CHORD_GT_5_NOTES_TRUNCATED:event_id={event.event_id}")
        output_indices = output_indices[:MAX_CHORD_NOTES]

    working_pitches_original_order = [pitches_original[i] for i in output_indices]

    sorted_pairs = sorted(
        [(local_idx, p) for local_idx, p in enumerate(working_pitches_original_order)],
        key=lambda x: x[1],
    )
    sorted_local_indices = [idx for idx, _ in sorted_pairs]
    pitches_sorted = [p for _, p in sorted_pairs]

    n = len(pitches_sorted)
    templates = _ordered_finger_templates(hand, n)
    locked_by_local_index = _locked_chord_requirements(config, event, output_indices)

    out: List[CandidateAssignment] = []

    for template_sorted_order in templates:
        if not _template_matches_locked_fingers(
            template_sorted_order,
            sorted_local_indices,
            locked_by_local_index,
        ):
            continue

        cost = 0.0
        cost += _chord_internal_cost(hand, pitches_sorted, template_sorted_order, config)

        if hand == Hand.RH:
            rep_pitch = pitches_sorted[-1]
            rep_finger = template_sorted_order[-1]
        else:
            rep_pitch = pitches_sorted[0]
            rep_finger = template_sorted_order[0]

        cost += _transition_cost(hand, prev_pitch, prev_finger, rep_pitch, rep_finger, config)

        fingerings_by_local_index = [0] * n
        for sorted_pos, local_idx in enumerate(sorted_local_indices):
            fingerings_by_local_index[local_idx] = template_sorted_order[sorted_pos]

        out.append(
            CandidateAssignment(
                fingerings=fingerings_by_local_index,
                output_indices=output_indices,
                rep_pitch=rep_pitch,
                rep_finger=rep_finger,
                cost=cost,
            )
        )

    if not out and locked_by_local_index:
        warnings.append(f"LOCKED_CHORD_CONSTRAINTS_UNSATISFIED:event_id={event.event_id}")

    out.sort(key=lambda c: c.cost)
    return out[:10]


# ---------------------------
# Beam search
# ---------------------------

def _event_candidates(
    hand: Hand,
    event: Event,
    prev_pitch: Optional[int],
    prev_finger: Optional[int],
    warnings: List[str],
    config: FingeringConfig,
) -> List[CandidateAssignment]:
    if isinstance(event, NoteEvent):
        return _note_candidates(hand, event, prev_pitch, prev_finger, config)
    if isinstance(event, ChordEvent):
        return _chord_candidates(hand, event, prev_pitch, prev_finger, warnings, config)
    return []


def _state_signature(state: SearchState) -> Tuple[Optional[int], Optional[int], int]:
    return (state.last_pitch, state.last_finger, len(state.assignments))


def _beam_search_for_hand(
    hand: Hand,
    events: List[Event],
    config: FingeringConfig,
) -> Tuple[List[CandidateAssignment], List[str]]:
    warnings: List[str] = []

    states: List[SearchState] = [
        SearchState(cost=0.0, last_pitch=None, last_finger=None, assignments=[])
    ]

    for event in events:
        next_states: List[SearchState] = []

        for state in states:
            candidates = _event_candidates(
                hand=hand,
                event=event,
                prev_pitch=state.last_pitch,
                prev_finger=state.last_finger,
                warnings=warnings,
                config=config,
            )

            if not candidates:
                warnings.append(
                    f"UNSUPPORTED_EVENT_TYPE:{type(event).__name__}:event_id={getattr(event, 'event_id', None)}"
                )
                continue

            for cand in candidates:
                next_states.append(
                    SearchState(
                        cost=state.cost + cand.cost,
                        last_pitch=cand.rep_pitch,
                        last_finger=cand.rep_finger,
                        assignments=state.assignments + [cand],
                    )
                )

        if not next_states:
            break

        next_states.sort(key=lambda s: s.cost)

        deduped: List[SearchState] = []
        seen = set()
        for st in next_states:
            sig = _state_signature(st)
            if sig in seen:
                continue
            seen.add(sig)
            deduped.append(st)
            if len(deduped) >= BEAM_WIDTH:
                break

        states = deduped

    if not states:
        return [], warnings

    best = min(states, key=lambda s: s.cost)
    return best.assignments, warnings


# ---------------------------
# Output assembly
# ---------------------------

def _build_hand_output(
    hand: Hand,
    events: List[Event],
    assignments: List[CandidateAssignment],
) -> List[object]:
    out: List[object] = []

    for event, assign in zip(events, assignments):
        if isinstance(event, NoteEvent):
            out.append(
                NoteFingering(
                    event_id=event.event_id,
                    hand=hand,
                    staff=event.staff,
                    measure=event.measure,
                    voice=event.voice,
                    t_meas_beats=event.t_meas_beats,
                    idx_meas_voice=event.idx_meas_voice,
                    xml_anchor=event.xml_anchor,
                    note_id=event.note_id,
                    type="note",
                    pitch_midi=event.pitch_midi,
                    fingering=assign.fingerings[0],
                )
            )

        elif isinstance(event, ChordEvent):
            pitches = [event.pitches_midi[i] for i in assign.output_indices]
            anchors = (
                [event.xml_note_anchors[i] for i in assign.output_indices]
                if event.xml_note_anchors is not None
                else None
            )
            note_ids = (
                [event.note_ids[i] for i in assign.output_indices]
                if event.note_ids is not None
                else None
            )

            if len(pitches) < 2:
                out.append(
                    NoteFingering(
                        event_id=event.event_id,
                        hand=hand,
                        staff=event.staff,
                        measure=event.measure,
                        voice=event.voice,
                        t_meas_beats=event.t_meas_beats,
                        idx_meas_voice=event.idx_meas_voice,
                        xml_anchor=event.xml_anchor,
                        note_id=(note_ids[0] if note_ids else event.note_id),
                        type="note",
                        pitch_midi=pitches[0],
                        fingering=assign.fingerings[0],
                    )
                )
            else:
                out.append(
                    ChordFingering(
                        event_id=event.event_id,
                        hand=hand,
                        staff=event.staff,
                        measure=event.measure,
                        voice=event.voice,
                        t_meas_beats=event.t_meas_beats,
                        idx_meas_voice=event.idx_meas_voice,
                        xml_anchor=event.xml_anchor,
                        note_id=event.note_id,
                        type="chord",
                        pitches_midi=pitches,
                        fingerings=assign.fingerings,
                        xml_note_anchors=anchors,
                        note_ids=note_ids,
                    )
                )

    return out


# ---------------------------
# Fallback generation
# ---------------------------

def _fallback_chord_fingers(
    hand: Hand,
    note_ids: Sequence[Optional[str]],
    n: int,
    config: FingeringConfig,
) -> List[int]:
    preferred = list(range(1, n + 1)) if hand == Hand.RH else list(range(5, 5 - n, -1))
    available = [1, 2, 3, 4, 5]
    out = [0] * n

    for idx, note_id in enumerate(note_ids):
        locked = _locked_finger_for_note(config, note_id)
        if locked is None:
            continue
        if locked in available:
            out[idx] = locked
            available.remove(locked)

    for idx in range(n):
        if out[idx] != 0:
            continue
        preferred_finger = preferred[idx]
        if preferred_finger in available:
            out[idx] = preferred_finger
            available.remove(preferred_finger)
        else:
            out[idx] = available.pop(0)

    return out


def _fallback_generate_fingerings_for_hand(
    hand: Hand,
    events: List[Event],
    config: FingeringConfig,
) -> List[object]:
    out: List[object] = []

    for e in events:
        if isinstance(e, NoteEvent):
            finger = _locked_finger_for_note(config, e.note_id) or 3
            out.append(
                NoteFingering(
                    event_id=e.event_id,
                    hand=hand,
                    staff=e.staff,
                    measure=e.measure,
                    voice=e.voice,
                    t_meas_beats=e.t_meas_beats,
                    idx_meas_voice=e.idx_meas_voice,
                    xml_anchor=e.xml_anchor,
                    note_id=e.note_id,
                    type="note",
                    pitch_midi=e.pitch_midi,
                    fingering=finger,
                )
            )
        elif isinstance(e, ChordEvent):
            n = min(len(e.pitches_midi), MAX_CHORD_NOTES)
            pitches = e.pitches_midi[:n]
            anchors = e.xml_note_anchors[:n] if e.xml_note_anchors is not None else None
            note_ids = e.note_ids[:n] if e.note_ids is not None else [None] * n
            fingers = _fallback_chord_fingers(hand, note_ids, n, config)

            if len(pitches) < 2:
                out.append(
                    NoteFingering(
                        event_id=e.event_id,
                        hand=hand,
                        staff=e.staff,
                        measure=e.measure,
                        voice=e.voice,
                        t_meas_beats=e.t_meas_beats,
                        idx_meas_voice=e.idx_meas_voice,
                        xml_anchor=e.xml_anchor,
                        note_id=note_ids[0] if note_ids else e.note_id,
                        type="note",
                        pitch_midi=pitches[0],
                        fingering=fingers[0],
                    )
                )
            else:
                out.append(
                    ChordFingering(
                        event_id=e.event_id,
                        hand=hand,
                        staff=e.staff,
                        measure=e.measure,
                        voice=e.voice,
                        t_meas_beats=e.t_meas_beats,
                        idx_meas_voice=e.idx_meas_voice,
                        xml_anchor=e.xml_anchor,
                        note_id=e.note_id,
                        type="chord",
                        pitches_midi=pitches,
                        fingerings=fingers,
                        xml_note_anchors=anchors,
                        note_ids=note_ids,
                    )
                )

    return out


# ---------------------------
# Public API
# ---------------------------

def generate_fingerings_for_hand(
    hand: Hand,
    events: List[Event],
    config: Optional[FingeringConfig] = None,
) -> Tuple[List[object], List[str]]:
    cfg = normalize_config(config)
    assignments, warnings = _beam_search_for_hand(hand, events, cfg)

    if not assignments or len(assignments) != len(events):
        warnings.append(f"BEAM_SEARCH_FALLBACK_USED:hand={hand.value}")
        return _fallback_generate_fingerings_for_hand(hand, events, cfg), warnings

    return _build_hand_output(hand, events, assignments), warnings


def generate_fingerings(
    hands_events: dict,
    config: Optional[FingeringConfig] = None,
) -> FingeringsResponse:
    cfg = normalize_config(config)
    rh_events = hands_events.get("RH", [])
    lh_events = hands_events.get("LH", [])

    rh_f, rh_w = generate_fingerings_for_hand(Hand.RH, rh_events, cfg)
    lh_f, lh_w = generate_fingerings_for_hand(Hand.LH, lh_events, cfg)

    return FingeringsResponse(
        hands={"RH": rh_f, "LH": lh_f},
        stats={
            "rh_events": len(rh_events),
            "lh_events": len(lh_events),
            "rh_fingerings": len(rh_f),
            "lh_fingerings": len(lh_f),
            "difficulty": cfg.difficulty,
            "style_bias": cfg.style_bias,
            "hand_size": cfg.hand_size,
            "articulation_bias": _effective_articulation_bias(cfg),
            "locked_note_count": len(cfg.locked_note_fingerings),
        },
        warnings=[*rh_w, *lh_w],
        algorithm_version=ALGO_VERSION,
    )
