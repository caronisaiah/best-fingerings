import { useEffect, useRef } from "react";
import { OpenSheetMusicDisplay } from "opensheetmusicdisplay";

type Props = {
  musicXml: string | null;
};

export default function OSMDViewer({ musicXml }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const osmdRef = useRef<OpenSheetMusicDisplay | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    if (!osmdRef.current) {
      osmdRef.current = new OpenSheetMusicDisplay(containerRef.current, {
        autoResize: true,
        drawTitle: true,
        drawSubtitle: false,
        backend: "svg",
      });
    }

    const osmd = osmdRef.current;
    if (!musicXml) {
      containerRef.current.innerHTML = "";
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        await osmd.load(musicXml);
        if (cancelled) return;
        osmd.render();
      } catch (e) {
        // Don’t crash the app if OSMD can’t parse a file
        console.error("OSMD load/render failed:", e);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [musicXml]);

  return (
    <div
      ref={containerRef}
      style={{
        width: "100%",
        overflowX: "auto",
        border: "1px solid #e5e5e5",
        borderRadius: 12,
        padding: 12,
        background: "white",
      }}
    />
  );
}