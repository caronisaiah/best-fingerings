from __future__ import annotations

from enum import Enum
from typing import Dict, List, Optional, Union

from pydantic import BaseModel, Field


class Hand(str, Enum):
    RH = "RH"
    LH = "LH"


class Staff(str, Enum):
    treble = "treble"
    bass = "bass"
    unknown = "unknown"


class MusicXMLAnchor(BaseModel):
    """
    MusicXML-native anchor for OSMD overlay.
    """
    part_id: str
    measure_no: int = Field(..., ge=0)
    voice: str
    staff: Optional[int] = None

    # 0-based ordinal of NOTE elements within (part_id, measure_no, voice, staff)
    note_ordinal: int = Field(..., ge=0)

    # 0..k-1 within the chord group
    chord_ordinal: int = Field(..., ge=0)

    # Whether this anchor corresponds to a chord tone in MusicXML (<chord/>)
    is_chord: bool

    # Whether this anchor is a grace note (<grace/>)
    is_grace: bool


def musicxml_anchor_to_note_id(anchor: MusicXMLAnchor) -> str:
    """
    Stable notehead identity used across parsing, generation, UI edits, and export.
    """
    return "|".join(
        [
            str(anchor.part_id),
            str(anchor.measure_no),
            str(anchor.voice),
            str(anchor.staff if anchor.staff is not None else "null"),
            str(anchor.note_ordinal),
            str(anchor.chord_ordinal),
        ]
    )


class EventBase(BaseModel):
    event_id: int
    hand: Hand
    staff: Staff

    t_beats: float = Field(..., ge=0)
    t_meas_beats: float = Field(..., ge=0)
    duration_beats: float = Field(..., gt=0)

    measure: Optional[int] = Field(default=None, ge=0)
    voice: Optional[Union[str, int]] = None
    idx_meas_voice: int = Field(..., ge=0)

    xml_anchor: Optional[MusicXMLAnchor] = None
    note_id: Optional[str] = None


class NoteEvent(EventBase):
    type: str = "note"
    pitch_midi: int


class ChordEvent(EventBase):
    type: str = "chord"
    pitches_midi: List[int] = Field(..., min_length=2)

    # Option 2: per-notehead anchors aligned with pitches_midi
    xml_note_anchors: Optional[List[MusicXMLAnchor]] = None
    note_ids: Optional[List[str]] = None


Event = Union[NoteEvent, ChordEvent]


class AnalyzeHandsResponse(BaseModel):
    hands: Dict[str, List[Event]]
    stats: dict
    warnings: List[str]
