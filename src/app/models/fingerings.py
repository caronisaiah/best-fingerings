from __future__ import annotations

from typing import Dict, List, Literal, Union

from pydantic import BaseModel, Field

from app.models.events import Hand


class FingeringBase(BaseModel):
    event_id: int
    hand: Hand
    type: Literal["note", "chord"]


class NoteFingering(FingeringBase):
    type: Literal["note"] = "note"
    pitch_midi: int
    fingering: int = Field(..., ge=1, le=5)


class ChordFingering(FingeringBase):
    type: Literal["chord"] = "chord"
    pitches_midi: List[int] = Field(..., min_length=2)
    fingerings: List[int] = Field(..., min_length=2)

    def model_post_init(self, __context) -> None:
        if len(self.pitches_midi) != len(self.fingerings):
            raise ValueError("pitches_midi and fingerings must be same length")
        if len(set(self.fingerings)) != len(self.fingerings):
            raise ValueError("duplicate finger in chord")
        if any(f < 1 or f > 5 for f in self.fingerings):
            raise ValueError("finger out of range 1-5")


FingeringEvent = Union[NoteFingering, ChordFingering]


class FingeringsResponse(BaseModel):
    hands: Dict[str, List[FingeringEvent]]  # keys: "RH", "LH"
    stats: Dict[str, Union[int, float, str]]
    warnings: List[str] = []
    algorithm_version: str  # required; set by fingering_engine