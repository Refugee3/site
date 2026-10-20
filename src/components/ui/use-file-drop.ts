"use client";

import { useRef, useState, type DragEvent } from "react";

/**
 * Lets any element (a file-picker button, say) take dropped files: spread `handlers` on it and style it by `dragging`.
 * Drags that carry no files (text, links) are left alone.
 */
export function useFileDrop(onFiles: (files: File[]) => void, disabled = false) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const carriesFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
  return {
    dragging: dragging && !disabled,
    handlers: {
      onDragEnter(e: DragEvent) {
        if (!carriesFiles(e)) return;
        e.preventDefault();
        depth.current++;
        setDragging(true);
      },
      onDragOver(e: DragEvent) {
        if (!carriesFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = disabled ? "none" : "copy";
      },
      onDragLeave(e: DragEvent) {
        if (!carriesFiles(e)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setDragging(false);
      },
      onDrop(e: DragEvent) {
        if (!carriesFiles(e)) return;
        e.preventDefault();
        depth.current = 0;
        setDragging(false);
        const files = Array.from(e.dataTransfer.files);
        if (!disabled && files.length > 0) onFiles(files);
      },
    },
  };
}
