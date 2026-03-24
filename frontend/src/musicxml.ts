// src/musicxml.ts
import JSZip from "jszip";
import type { ChordFingeringEvent, MusicXmlAnchor, NoteFingeringEvent, ResultPayload } from "./types";

type Anchor = MusicXmlAnchor;

function stripNs(tagName: string) {
  const i = tagName.indexOf("}");
  return i >= 0 ? tagName.slice(i + 1) : tagName;
}

function anchorKey(a: Anchor) {
  return [
    a.part_id,
    a.measure_no,
    a.voice ?? "1",
    a.staff ?? "null",
    a.note_ordinal,
    a.chord_ordinal,
  ].join("|");
}

/**
 * Returns decompressed MusicXML text from either .musicxml/.xml OR .mxl
 */
export async function fileToMusicXMLText(file: File): Promise<string> {
  const name = (file.name || "").toLowerCase();

  if (!name.endsWith(".mxl")) {
    return await file.text();
  }

  const zip = await JSZip.loadAsync(await file.arrayBuffer());

  // Try META-INF/container.xml
  const containerFile = zip.file("META-INF/container.xml");
  if (containerFile) {
    const containerText = await containerFile.async("text");
    const m = containerText.match(/full-path="([^"]+)"/);
    if (m?.[1]) {
      const inner = zip.file(m[1]);
      if (inner) return await inner.async("text");
    }
  }

  // Fallback: first .xml not in META-INF
  const xmlNames = Object.keys(zip.files).filter(
    (n) => n.toLowerCase().endsWith(".xml") && !n.startsWith("META-INF/")
  );
  if (!xmlNames.length) throw new Error("MXL contains no XML score file");
  return await zip.file(xmlNames[0])!.async("text");
}

/**
 * Build a map from MusicXMLAnchor -> actual <note> element.
 *
 * IMPORTANT: This mirrors your backend’s group logic:
 * - groupCounter increments for chord-start notes (not chord tones)
 * - chord tones reuse the previous group's noteOrdinal
 * - cursor advances for non-chord notes (including rests)
 *
 * NOTE: Your current anchor schema does NOT include divisions or onset_div,
 * so we intentionally do not track them here (keeps lint clean + behavior aligned).
 */
export function indexNotesByAnchor(xmlText: string) {
  const dom = new DOMParser().parseFromString(xmlText, "application/xml");

  // DOMParser often inserts <parsererror> if XML is invalid
  const parserError = dom.getElementsByTagName("parsererror")[0];
  if (parserError) {
    throw new Error("MusicXML parse error (parsererror). Check file contents.");
  }

  const score = dom.documentElement;

  // Be robust to namespaces/prefixes: pick direct children named "part"
  const parts = Array.from(score.children).filter((c) => stripNs(c.tagName) === "part") as Element[];

  const map = new Map<string, Element>(); // anchorKey -> <note>

  for (const part of parts) {
    const partId = part.getAttribute("id") ?? "P0";

    const measures = Array.from(part.children).filter((c) => stripNs(c.tagName) === "measure") as Element[];

    for (let mi = 0; mi < measures.length; mi++) {
      const meas = measures[mi];

      const rawNo = meas.getAttribute("number") ?? "";
      const parsedNo = parseInt(rawNo, 10);
      const measureNo = Number.isFinite(parsedNo) ? parsedNo : mi + 1;

      // per (voice, staff) cursor and counters
      const cursor = new Map<string, number>(); // voice|staff -> onsetDiv (relative)
      const groupCounter = new Map<string, number>(); // voice|staff -> next note_ordinal (group ordinal)
      const lastGroup = new Map<string, { onsetDiv: number; noteOrdinal: number }>();

      // per group chord_ordinal counter
      const chordOrdinalCounter = new Map<string, number>(); // part|meas|voice|staff|noteOrdinal -> next chord_ordinal

      const notes = Array.from(meas.children).filter((c) => stripNs(c.tagName) === "note") as Element[];

      for (const noteEl of notes) {
        const isRest = Array.from(noteEl.children).some((c) => stripNs(c.tagName) === "rest");

        const voiceEl = Array.from(noteEl.children).find((c) => stripNs(c.tagName) === "voice") as Element | undefined;
        const voice = voiceEl?.textContent?.trim() || "1";

        const staffEl = Array.from(noteEl.children).find((c) => stripNs(c.tagName) === "staff") as Element | undefined;
        const staff = staffEl?.textContent?.trim() ? parseInt(staffEl.textContent.trim(), 10) : null;

        const durEl = Array.from(noteEl.children).find((c) => stripNs(c.tagName) === "duration") as Element | undefined;
        const durDiv = durEl?.textContent?.trim() ? parseInt(durEl.textContent.trim(), 10) : 0;

        const isChordTone = Array.from(noteEl.children).some((c) => stripNs(c.tagName) === "chord");

        const vsKey = `${voice}|${staff ?? "null"}`;
        const cur = cursor.get(vsKey) ?? 0;

        let onsetDiv = cur;
        let noteOrdinal: number;

        if (isChordTone) {
          const prev = lastGroup.get(vsKey);
          if (prev) {
            onsetDiv = prev.onsetDiv;
            noteOrdinal = prev.noteOrdinal;
          } else {
            // chord without prior start -> treat as new group
            noteOrdinal = groupCounter.get(vsKey) ?? 0;
            groupCounter.set(vsKey, noteOrdinal + 1);
            lastGroup.set(vsKey, { onsetDiv, noteOrdinal });
          }
        } else {
          noteOrdinal = groupCounter.get(vsKey) ?? 0;
          groupCounter.set(vsKey, noteOrdinal + 1);
          lastGroup.set(vsKey, { onsetDiv, noteOrdinal });
        }

        // advance cursor for non-chord notes (including rests)
        if (!isChordTone && durDiv > 0) {
          cursor.set(vsKey, cur + durDiv);
        }

        if (isRest) continue;

        // chord_ordinal increments within the group in document order
        const groupKey = `${partId}|${measureNo}|${voice}|${staff ?? "null"}|${noteOrdinal}`;
        const chordOrd = chordOrdinalCounter.get(groupKey) ?? 0;
        chordOrdinalCounter.set(groupKey, chordOrd + 1);

        const a: Anchor = {
          part_id: partId,
          measure_no: measureNo,
          voice,
          staff,
          note_ordinal: noteOrdinal,
          chord_ordinal: chordOrd,
        };

        map.set(anchorKey(a), noteEl);
      }
    }
  }

  return { dom, map };
}

function upsertFingering(dom: Document, noteEl: Element, finger: number) {
  const ns = dom.documentElement.namespaceURI || null;
  const create = (name: string) => (ns ? dom.createElementNS(ns, name) : dom.createElement(name));

  // find/create <notations>
  let notations = Array.from(noteEl.children).find((c) => stripNs(c.tagName) === "notations") as Element | undefined;
  if (!notations) {
    notations = create("notations");
    noteEl.appendChild(notations);
  }

  // find/create <technical>
  let technical = Array.from(notations.children).find((c) => stripNs(c.tagName) === "technical") as Element | undefined;
  if (!technical) {
    technical = create("technical");
    notations.appendChild(technical);
  }

  // remove existing <fingering>
  Array.from(technical.children)
    .filter((c) => stripNs(c.tagName) === "fingering")
    .forEach((c) => technical!.removeChild(c));

  const fingering = create("fingering");
  fingering.textContent = String(finger);
  technical.appendChild(fingering);
}

/**
 * Injects computed fingerings into MusicXML and returns new XML text.
 * Works for notes and chords using xml_anchor / xml_note_anchors.
 */
export function injectFingerings(xmlText: string, resultPayload: ResultPayload): string {
  const { dom, map } = indexNotesByAnchor(xmlText);

  const hands = resultPayload?.fingerings?.hands;
  if (!hands) return xmlText;

  const all = [...(hands.RH ?? []), ...(hands.LH ?? [])];

  for (const evt of all) {
    if (!evt) continue;

    if (evt.type === "note") {
      const noteEvent = evt as NoteFingeringEvent;
      const a = noteEvent.xml_anchor as Anchor | null;
      if (!a) continue;
      const el = map.get(anchorKey(a));
      if (!el) continue;

      const f = Number(noteEvent.fingering);
      if (!Number.isFinite(f)) continue;
      upsertFingering(dom, el, f);
    } else if (evt.type === "chord") {
      const chordEvent = evt as ChordFingeringEvent;
      const anchors = (chordEvent.xml_note_anchors as Anchor[] | null) ?? null;
      const fingers: number[] = Array.isArray(chordEvent.fingerings) ? chordEvent.fingerings : [];

      if (anchors && anchors.length === fingers.length) {
        for (let i = 0; i < anchors.length; i++) {
          const el = map.get(anchorKey(anchors[i]));
          if (!el) continue;

          const f = Number(fingers[i]);
          if (!Number.isFinite(f)) continue;
          upsertFingering(dom, el, f);
        }
      } else {
        // fallback: at least put the first chord fingering on the chord-start note
        const a = chordEvent.xml_anchor as Anchor | null;
        if (!a) continue;
        const el = map.get(anchorKey(a));
        if (!el) continue;

        const f0 = Number(fingers[0] ?? 1);
        upsertFingering(dom, el, Number.isFinite(f0) ? f0 : 1);
      }
    }
  }

  return new XMLSerializer().serializeToString(dom);
}
