from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)

# Minimal MusicXML snippet (single note). Enough to validate endpoint wiring.
MINI_XML = b"""<?xml version="1.0" encoding="UTF-8"?>
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
        <key><fifths>0</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <note>
        <pitch><step>C</step><octave>4</octave></pitch>
        <duration>1</duration>
        <type>quarter</type>
      </note>
    </measure>
  </part>
</score-partwise>
"""

def test_analyze_score_ok():
    files = {"file": ("mini.musicxml", MINI_XML, "application/xml")}
    r = client.post("/analyze-score", files=files)
    assert r.status_code == 200, r.text
    body = r.json()
    assert "events" in body
    assert body["stats"]["event_count"] >= 1