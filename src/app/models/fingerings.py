from __future__ import annotations

from typing import Dict, List, Literal, Optional, Union

from pydantic import BaseModel, Field, ConfigDict

from app.models.events import Hand, Staff, MusicXMLAnchor


class FingeringBase(BaseModel):
    model_config = ConfigDict(extra="forbid")

    event_id: int
    hand: Hand
    staff: Staff
    measure: Optional[int] = Field(default=None, ge=0)
    voice: Optional[Union[str, int]] = None

    # Existing measure-local anchors (still useful)
    t_meas_beats: float = Field(..., ge=0)
    idx_meas_voice: int = Field(..., ge=0)

    # Canonical MusicXML anchor for OSMD overlay
    xml_anchor: Optional[MusicXMLAnchor] = None
    note_id: Optional[str] = None

    type: Literal["note", "chord"]


class NoteFingering(FingeringBase):
    type: Literal["note"] = "note"
    pitch_midi: int
    fingering: int = Field(..., ge=1, le=5)


class ChordFingering(FingeringBase):
    type: Literal["chord"] = "chord"
    pitches_midi: List[int] = Field(..., min_length=2)
    fingerings: List[int] = Field(..., min_length=2)

    # Per-notehead anchors aligned with pitches_midi & fingerings
    xml_note_anchors: Optional[List[Optional[MusicXMLAnchor]]] = None
    note_ids: Optional[List[Optional[str]]] = None

    def model_post_init(self, __context) -> None:
        if len(self.pitches_midi) != len(self.fingerings):
            raise ValueError("pitches_midi and fingerings must be same length")
        if len(set(self.fingerings)) != len(self.fingerings):
            raise ValueError("duplicate finger in chord")
        if any(f < 1 or f > 5 for f in self.fingerings):
            raise ValueError("finger out of range 1-5")

        if self.xml_note_anchors is not None and len(self.xml_note_anchors) != len(self.pitches_midi):
            raise ValueError("xml_note_anchors must be same length as pitches_midi")
        if self.note_ids is not None and len(self.note_ids) != len(self.pitches_midi):
            raise ValueError("note_ids must be same length as pitches_midi")


FingeringEvent = Union[NoteFingering, ChordFingering]


class FingeringsResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    hands: Dict[str, List[FingeringEvent]]  # keys: "RH", "LH"
    stats: Dict[str, Union[int, float, str]]
    warnings: List[str] = []
    algorithm_version: str
