from __future__ import annotations

from dataclasses import dataclass
from typing import List, Tuple

from app.models.events import ChordEvent, Event, Hand, NoteEvent
from app.models.fingerings import ChordFingering, FingeringsResponse, NoteFingering

ALGO_VERSION = "0.0.2-greedy+anchors"


def _is_black_key(pitch_midi: int) -> bool:
    # C=0, C#=1, D=2, D#=3, E=4, F=5, F#=6, G=7, G#=8, A=9, A#=10, B=11
    return (pitch_midi % 12) in {1, 3, 6, 8, 10}


@dataclass
class HandState:
    last_pitch: int | None = None
    last_finger: int | None = None


def _finger_change_cost(prev_finger: int | None, finger: int, pitch_changed: bool) -> float:
    # discourage reusing same finger if the pitch changes (awkward in legato contexts)
    if prev_finger is None:
        return 0.0
    if pitch_changed and finger == prev_finger:
        return 2.0
    return 0.0


def _thumb_black_penalty(finger: int, pitch_midi: int) -> float:
    # common heuristic: thumb on black key is often less comfortable
    if finger == 1 and _is_black_key(pitch_midi):
        return 1.5
    return 0.0


def _distance_cost(prev_pitch: int | None, pitch_midi: int, finger: int, prev_finger: int | None) -> float:
    # simple movement proxy: penalize big jumps; also penalize big finger jumps
    if prev_pitch is None:
        return 0.0
    dp = abs(pitch_midi - prev_pitch)
    df = abs(finger - (prev_finger or finger))
    return (dp / 3.0) + (df * 0.3)


def _pick_greedy_finger(hand: Hand, pitch_midi: int, state: HandState) -> int:
    # Greedy: pick finger 1–5 minimizing a simple cost function.
    # (No crossings model yet; that’s DP territory.)
    best_f = 3
    best_cost = float("inf")

    pitch_changed = (state.last_pitch is not None and pitch_midi != state.last_pitch)

    for f in range(1, 6):
        cost = 0.0
        cost += _distance_cost(state.last_pitch, pitch_midi, f, state.last_finger)
        cost += _finger_change_cost(state.last_finger, f, pitch_changed)
        cost += _thumb_black_penalty(f, pitch_midi)

        # tiny hand-specific bias: RH slightly prefers higher fingers for higher notes,
        # LH slightly prefers higher fingers for lower notes (very weak bias)
        if state.last_pitch is not None:
            direction = pitch_midi - state.last_pitch
            if hand == Hand.RH and direction > 0:
                cost += max(0, (3 - f)) * 0.1  # discourage too-low finger on ascending
            if hand == Hand.LH and direction < 0:
                cost += max(0, (f - 3)) * 0.1  # discourage too-high finger on descending

        if cost < best_cost:
            best_cost = cost
            best_f = f

    state.last_pitch = pitch_midi
    state.last_finger = best_f
    return best_f


def _assign_chord_fingers(hand: Hand, pitches_sorted: List[int]) -> List[int]:
    """
    Placeholder chord policy (deterministic, chord-safe):
    - RH: lowest pitch -> 1, next -> 2, ...
    - LH: lowest pitch -> 5, next -> 4, ...
    Caps at 5 notes; if chord > 5 notes, we use first 5 pitches and warn later.
    """
    n = min(5, len(pitches_sorted))
    if hand == Hand.RH:
        return list(range(1, n + 1))
    else:
        return list(range(5, 5 - n, -1))


def generate_fingerings_for_hand(hand: Hand, events: List[Event]) -> Tuple[List[object], List[str]]:
    warnings: List[str] = []
    out = []
    state = HandState()

    for e in events:
        if isinstance(e, NoteEvent):
            f = _pick_greedy_finger(hand, e.pitch_midi, state)
            out.append(
                NoteFingering(
                    event_id=e.event_id,
                    hand=hand,
                    staff=e.staff,
                    measure=e.measure,
                    voice=e.voice,
                    t_meas_beats=e.t_meas_beats,
                    idx_meas_voice=e.idx_meas_voice,
                    type="note",
                    pitch_midi=e.pitch_midi,
                    fingering=f,
                )
            )

        elif isinstance(e, ChordEvent):
            pitches_sorted = sorted(list(e.pitches_midi))
            if len(pitches_sorted) > 5:
                warnings.append(f"CHORD_GT_5_NOTES_TRUNCATED:event_id={e.event_id}")
                pitches_sorted = pitches_sorted[:5]

            fingers = _assign_chord_fingers(hand, pitches_sorted)

            out.append(
                ChordFingering(
                    event_id=e.event_id,
                    hand=hand,
                    staff=e.staff,
                    measure=e.measure,
                    voice=e.voice,
                    t_meas_beats=e.t_meas_beats,
                    idx_meas_voice=e.idx_meas_voice,
                    type="chord",
                    pitches_midi=pitches_sorted,
                    fingerings=fingers,
                )
            )

            # update state to something reasonable after chord:
            # set last_pitch to top note (RH) / bottom note (LH), last_finger to extreme finger used
            if pitches_sorted:
                if hand == Hand.RH:
                    state.last_pitch = pitches_sorted[-1]
                    state.last_finger = max(fingers)
                else:
                    state.last_pitch = pitches_sorted[0]
                    state.last_finger = max(fingers)

        else:
            warnings.append(f"UNSUPPORTED_EVENT_TYPE:{type(e).__name__}:event_id={getattr(e,'event_id',None)}")

    return out, warnings


def generate_fingerings(hands_events: dict) -> FingeringsResponse:
    rh_events = hands_events.get("RH", [])
    lh_events = hands_events.get("LH", [])

    rh_f, rh_w = generate_fingerings_for_hand(Hand.RH, rh_events)
    lh_f, lh_w = generate_fingerings_for_hand(Hand.LH, lh_events)

    return FingeringsResponse(
        hands={"RH": rh_f, "LH": lh_f},
        stats={
            "rh_events": len(rh_events),
            "lh_events": len(lh_events),
            "rh_fingerings": len(rh_f),
            "lh_fingerings": len(lh_f),
        },
        warnings=[*rh_w, *lh_w],
        algorithm_version=ALGO_VERSION,
    )