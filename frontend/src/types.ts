export type HandName = "RH" | "LH";

export type MusicXmlAnchor = {
  part_id: string;
  measure_no: number;
  voice: string;
  staff: number | null;
  note_ordinal: number;
  chord_ordinal: number;
  is_chord?: boolean;
  is_grace?: boolean;
};

export type NoteFingeringEvent = {
  type: "note";
  event_id: number;
  hand: HandName;
  measure?: number | null;
  pitch_midi: number;
  fingering: number;
  note_id?: string | null;
  xml_anchor?: MusicXmlAnchor | null;
};

export type ChordFingeringEvent = {
  type: "chord";
  event_id: number;
  hand: HandName;
  measure?: number | null;
  pitches_midi: number[];
  fingerings: number[];
  note_id?: string | null;
  note_ids?: Array<string | null> | null;
  xml_anchor?: MusicXmlAnchor | null;
  xml_note_anchors?: Array<MusicXmlAnchor | null> | null;
};

export type FingeringEvent = NoteFingeringEvent | ChordFingeringEvent;

export type FingeringsPayload = {
  hands?: Partial<Record<HandName, FingeringEvent[]>>;
  stats?: Record<string, unknown>;
  warnings?: string[];
  algorithm_version?: string;
};

export type ResultPayload = {
  analysis?: {
    warnings?: string[];
  };
  fingerings?: FingeringsPayload;
  preferences?: Record<string, unknown>;
  versions?: Record<string, unknown>;
};
