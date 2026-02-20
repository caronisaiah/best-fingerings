from __future__ import annotations

from enum import Enum
from typing import List, Optional, Union

from pydantic import BaseModel, Field


class Hand(str, Enum):
    RH = "RH"
    LH = "LH"


class Staff(str, Enum):
    treble = "treble"
    bass = "bass"
    unknown = "unknown"


class EventBase(BaseModel):
    event_id: int
    hand: Hand
    staff: Staff
    t_beats: float = Field(..., ge=0)
    duration_beats: float = Field(..., gt=0)
    measure: Optional[int] = Field(default=None, ge=1)
    voice: Optional[Union[str, int]] = None


class NoteEvent(EventBase):
    type: str = "note"
    pitch_midi: int


class ChordEvent(EventBase):
    type: str = "chord"
    pitches_midi: List[int] = Field(..., min_length=2)


Event = Union[NoteEvent, ChordEvent]


class AnalyzeScoreResponse(BaseModel):
    events: List[Event]
    stats: dict
    warnings: List[str]