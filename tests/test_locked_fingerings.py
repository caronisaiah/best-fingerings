from app.services.fingering_engine import FingeringConfig, generate_fingerings
from app.services.musicxml_parser import parse_musicxml_to_events

TWO_NOTES_XML = b"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN"
  "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="3.1">
  <part-list>
    <score-part id="P1"><part-name>Piano</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>1</divisions>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <note>
        <pitch><step>C</step><octave>4</octave></pitch>
        <duration>1</duration><type>quarter</type>
      </note>
      <note>
        <pitch><step>D</step><octave>4</octave></pitch>
        <duration>1</duration><type>quarter</type>
      </note>
    </measure>
  </part>
</score-partwise>
"""

TWO_NOTE_CHORD_XML = b"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN"
  "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="3.1">
  <part-list>
    <score-part id="P1"><part-name>Piano</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>1</divisions>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <note>
        <pitch><step>C</step><octave>4</octave></pitch>
        <duration>2</duration><type>half</type>
      </note>
      <note>
        <chord/>
        <pitch><step>G</step><octave>4</octave></pitch>
        <duration>2</duration><type>half</type>
      </note>
    </measure>
  </part>
</score-partwise>
"""


def test_generated_note_fingerings_include_note_id():
    analysis = parse_musicxml_to_events(TWO_NOTES_XML)
    fingerings = generate_fingerings(analysis.hands).model_dump()

    rh = fingerings["hands"]["RH"]
    assert rh[0]["note_id"]
    assert rh[1]["note_id"]


def test_locked_single_note_fingering_is_respected():
    analysis = parse_musicxml_to_events(TWO_NOTES_XML)
    locked_note_id = analysis.hands["RH"][0].note_id

    fingerings = generate_fingerings(
        analysis.hands,
        config=FingeringConfig(locked_note_fingerings={locked_note_id: 5}),
    ).model_dump()

    assert fingerings["hands"]["RH"][0]["fingering"] == 5


def test_locked_chord_note_fingerings_are_respected():
    analysis = parse_musicxml_to_events(TWO_NOTE_CHORD_XML)
    chord_evt = analysis.hands["RH"][0]

    fingerings = generate_fingerings(
        analysis.hands,
        config=FingeringConfig(
            locked_note_fingerings={
                chord_evt.note_ids[0]: 1,
                chord_evt.note_ids[1]: 4,
            }
        ),
    ).model_dump()

    chord = fingerings["hands"]["RH"][0]
    assert chord["fingerings"] == [1, 4]
