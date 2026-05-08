from app.services.fingering_engine import generate_fingerings
from app.services.musicxml_parser import parse_musicxml_to_events


TWO_STAFF_PIANO_XML = b"""<?xml version="1.0" encoding="UTF-8"?>
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
        <staves>2</staves>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef number="1"><sign>G</sign><line>2</line></clef>
        <clef number="2"><sign>F</sign><line>4</line></clef>
      </attributes>
      <note>
        <pitch><step>C</step><octave>5</octave></pitch>
        <duration>1</duration><voice>1</voice><type>quarter</type><staff>1</staff>
      </note>
      <backup><duration>1</duration></backup>
      <note>
        <pitch><step>C</step><octave>3</octave></pitch>
        <duration>1</duration><voice>2</voice><type>quarter</type><staff>2</staff>
      </note>
    </measure>
  </part>
</score-partwise>
"""


def test_single_piano_part_uses_musicxml_staff_numbers_for_hands():
    analysis = parse_musicxml_to_events(TWO_STAFF_PIANO_XML)

    assert len(analysis.hands["RH"]) == 1
    assert len(analysis.hands["LH"]) == 1
    assert analysis.hands["RH"][0].pitch_midi == 72
    assert analysis.hands["LH"][0].pitch_midi == 48
    assert analysis.hands["RH"][0].xml_anchor.staff == 1
    assert analysis.hands["LH"][0].xml_anchor.staff == 2


def test_generated_fingerings_keep_split_hands_from_single_piano_part():
    analysis = parse_musicxml_to_events(TWO_STAFF_PIANO_XML)
    fingerings = generate_fingerings(analysis.hands)

    assert len(fingerings.hands["RH"]) == 1
    assert len(fingerings.hands["LH"]) == 1
    assert fingerings.hands["RH"][0].hand == "RH"
    assert fingerings.hands["LH"][0].hand == "LH"
