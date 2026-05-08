import json

from fastapi.testclient import TestClient

from app.api import fingerings as fingerings_api
from app.main import app
from app.services.musicxml_parser import parse_musicxml_to_events


client = TestClient(app)


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


def _upload_sync(data: bytes, filename: str = "score.musicxml", form: dict | None = None):
    return client.post(
        "/fingerings/sync",
        files={"file": (filename, data, "application/xml")},
        data=form or {},
    )


def test_fingerings_sync_returns_full_result_payload():
    response = _upload_sync(TWO_NOTES_XML)

    assert response.status_code == 200
    payload = response.json()
    assert payload["mode"] == "sync"
    assert payload["job_id"] is None
    assert payload["analysis"]["hands"]["RH"]
    assert payload["fingerings"]["hands"]["RH"]
    assert payload["versions"]["result_schema_version"] == fingerings_api.RESULT_SCHEMA_VERSION


def test_fingerings_sync_rejects_invalid_file_type():
    response = _upload_sync(TWO_NOTES_XML, filename="score.txt")

    assert response.status_code == 400
    assert "MusicXML" in response.json()["detail"]


def test_fingerings_sync_rejects_empty_file():
    response = _upload_sync(b"")

    assert response.status_code == 400
    assert response.json()["detail"] == "Empty file"


def test_fingerings_sync_rejects_too_large_file(monkeypatch):
    monkeypatch.setattr(fingerings_api, "DEMO_SYNC_MAX_UPLOAD_BYTES", 4)

    response = _upload_sync(TWO_NOTES_XML)

    assert response.status_code == 413
    assert "too large" in response.json()["detail"]


def test_fingerings_sync_rejects_parse_failures():
    response = _upload_sync(b"<score-partwise><broken></score-partwise>")

    assert response.status_code == 422
    assert "Failed to parse MusicXML" in response.json()["detail"]


def test_fingerings_sync_respects_locked_note_fingerings():
    analysis = parse_musicxml_to_events(TWO_NOTES_XML)
    locked_note_id = analysis.hands["RH"][0].note_id

    response = _upload_sync(
        TWO_NOTES_XML,
        form={"locked_note_fingerings_json": json.dumps({locked_note_id: 5})},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["fingerings"]["hands"]["RH"][0]["fingering"] == 5
