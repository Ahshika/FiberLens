import React, { useEffect, useRef } from 'react';
import { app } from '../app/controller';

/** Hosts the three stacked canvases (GPU drawing, text, interactive overlay). */
export function CadCanvas() {
  const host = useRef<HTMLDivElement>(null);
  const gl = useRef<HTMLCanvasElement>(null);
  const text = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    try {
      app.mount(host.current!, gl.current!, text.current!, overlay.current!);
    } catch (err) {
      console.error(err);
      alert('Graphics initialisation failed: ' + (err as Error).message);
    }
    return () => app.unmount();
  }, []);
  return (
    <div className="canvas-wrap" ref={host}>
      <canvas ref={gl} />
      <canvas ref={text} className="text" />
      <canvas ref={overlay} className="overlay" />
    </div>
  );
}
