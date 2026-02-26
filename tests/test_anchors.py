from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)

TWO_NOTES_SAME_MEASURE = b"""<?xml version="1.0" encoding="UTF-8"?>
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

def test_anchor_fields_present_and_increment():
    files = {"file": ("mini.musicxml", TWO_NOTES_SAME_MEASURE, "application/xml")}
    r = client.post("/analyze-score", files=files)
    assert r.status_code == 200, r.text
    body = r.json()

    evts = body["hands"]["RH"] + body["hands"]["LH"]
    notes = [e for e in evts if e["type"] == "note"]
    assert len(notes) >= 2

    assert "t_meas_beats" in notes[0]
    assert "idx_meas_voice" in notes[0]

    assert notes[0]["measure"] == 1
    assert notes[1]["measure"] == 1
    assert notes[0]["idx_meas_voice"] == 0
    assert notes[1]["idx_meas_voice"] == 1