from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)

TWO_MEASURE_XML = b"""<?xml version="1.0" encoding="UTF-8"?>
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
        <duration>1</duration>
        <type>quarter</type>
      </note>
    </measure>
    <measure number="2">
      <note>
        <pitch><step>D</step><octave>4</octave></pitch>
        <duration>1</duration>
        <type>quarter</type>
      </note>
    </measure>
  </part>
</score-partwise>
"""

def test_offsets_increase_across_measures():
    files = {"file": ("two.musicxml", TWO_MEASURE_XML, "application/xml")}
    r = client.post("/analyze-score", files=files)
    assert r.status_code == 200, r.text
    events = r.json()["events"]
    # should be at least 2 note events with increasing t_beats
    ts = [e["t_beats"] for e in events if e["type"] == "note"]
    assert len(ts) >= 2
    assert ts[1] > ts[0]