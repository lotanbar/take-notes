import { invoke } from "@tauri-apps/api/core";
import { detectDirection } from "../lib/textDirection";
import { MAX_ATTACHMENT_BYTES } from "../lib/attachmentOps";
import type { InlineImage } from "../types/vault";
import {
  addInlineImage,
  getInlineImages,
  removeInlineImage,
  subscribeInlineImages,
  updateInlineImageSize,
  type NoteModelState,
} from "./noteModel";
import { monaco } from "./monacoSetup";

const DEFAULT_MAX_WIDTH = 640;
const DEFAULT_MAX_HEIGHT = 480;

interface NativeClipboardContent {
  image: {
    mimeType: string;
    size: number;
    data: string;
    width: number;
    height: number;
  } | null;
  text: string | null;
}

function displaySize(naturalWidth: number, naturalHeight: number): { width: number; height: number } {
  const scale = Math.min(1, DEFAULT_MAX_WIDTH / naturalWidth, DEFAULT_MAX_HEIGHT / naturalHeight);
  return {
    width: Math.max(80, Math.round(naturalWidth * scale)),
    height: Math.max(60, Math.round(naturalHeight * scale)),
  };
}

function readImage(file: File): Promise<{ data: string; naturalWidth: number; naturalHeight: number }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read clipboard image"));
    reader.onload = () => {
      const url = String(reader.result);
      const image = new Image();
      image.onerror = () => reject(new Error("The clipboard image could not be decoded"));
      image.onload = () => resolve({
        data: url.slice(url.indexOf(",") + 1),
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
      });
      image.src = url;
    };
    reader.readAsDataURL(file);
  });
}

export async function fileToInlineImage(file: File, at: number): Promise<InlineImage> {
  if (file.size > MAX_ATTACHMENT_BYTES) throw new Error("Screenshot exceeds the 10MB attachment limit.");
  const { data, naturalWidth, naturalHeight } = await readImage(file);
  const size = displaySize(naturalWidth, naturalHeight);
  return {
    id: crypto.randomUUID(),
    mimeType: file.type || "image/png",
    size: file.size,
    data,
    at,
    width: size.width,
    height: size.height,
  };
}

export function clipboardImageFiles(event?: ClipboardEvent): File[] {
  const data = event?.clipboardData;
  if (!data) return [];
  const images = new Map<string, File>();
  for (const file of Array.from(data.files ?? [])) {
    if (file.type.startsWith("image/")) images.set(`${file.name}:${file.size}:${file.type}`, file);
  }
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) images.set(`${file.name}:${file.size}:${file.type}`, file);
  }
  return [...images.values()];
}

export interface InlineImageView {
  dispose(): void;
  render(): void;
}

export function mountInlineImageView(
  editor: monaco.editor.IStandaloneCodeEditor,
  state: NoteModelState,
): InlineImageView {
  const MIN_WIDTH = 80;
  const MIN_HEIGHT = 60;
  const MAX_HEIGHT = 2000;
  const ZONE_PADDING = 24;
  const HANDLE_DIRECTIONS = ["se"] as const;
  let zoneIds: string[] = [];
  let zoneCleanup: Array<() => void> = [];
  let frames = new Map<string, HTMLDivElement>();
  let selectedId: string | null = null;
  let disposed = false;

  function applySelection(focus: boolean): void {
    for (const [id, frame] of frames) {
      const selected = id === selectedId;
      frame.classList.toggle("inline-image-selected", selected);
      frame.setAttribute("aria-selected", String(selected));
      frame.tabIndex = selected ? 0 : -1;
    }
    if (focus && selectedId) {
      const focusId = selectedId;
      frames.get(focusId)?.focus({ preventScroll: true });
      requestAnimationFrame(() => {
        if (selectedId === focusId) frames.get(focusId)?.focus({ preventScroll: true });
      });
    }
  }

  function selectImage(id: string | null, focus = false): void {
    selectedId = id;
    applySelection(focus);
  }

  function clearZones(): void {
    for (const cleanup of zoneCleanup) cleanup();
    zoneCleanup = [];
    editor.changeViewZones((accessor) => {
      for (const id of zoneIds) accessor.removeZone(id);
    });
    zoneIds = [];
    frames = new Map();
  }

  function render(): void {
    if (disposed) return;
    clearZones();
    const model = editor.getModel();
    if (!model) return;
    const images = getInlineImages(state);
    if (selectedId && !images.some((image) => image.id === selectedId)) selectedId = null;

    editor.changeViewZones((accessor) => {
      images.forEach((inlineImage) => {
        const position = model.getPositionAt(inlineImage.at);
        const nearbyText = model.getLineContent(position.lineNumber).trim() || model.getValue();
        const direction = detectDirection(nearbyText);
        const zone = document.createElement("div");
        zone.className = "inline-image-zone";
        const alignment = document.createElement("div");
        alignment.className = `inline-image-zone-content inline-image-zone-${direction}`;

        const frame = document.createElement("div");
        frame.className = "inline-image-frame";
        frame.dataset.imageId = inlineImage.id;
        frame.setAttribute("role", "group");
        frame.setAttribute("aria-label", "Pasted screenshot. Press Delete to remove.");
        frame.style.width = `${inlineImage.width}px`;
        frame.style.height = `${inlineImage.height}px`;
        const selectFromPointer = (event: PointerEvent) => {
          event.preventDefault();
          event.stopPropagation();
          selectImage(inlineImage.id, true);
        };
        frame.addEventListener("pointerdown", selectFromPointer);
        frames.set(inlineImage.id, frame);

        const image = document.createElement("img");
        image.src = `data:${inlineImage.mimeType};base64,${inlineImage.data}`;
        image.alt = "Pasted screenshot";
        image.draggable = false;
        frame.appendChild(image);

        alignment.appendChild(frame);
        zone.appendChild(alignment);

        const viewZone: monaco.editor.IViewZone = {
          afterLineNumber: position.lineNumber,
          afterColumn: position.column,
          heightInPx: inlineImage.height + ZONE_PADDING,
          domNode: zone,
        };
        const zoneId = accessor.addZone(viewZone);
        zoneIds.push(zoneId);

        let normalizationFrame = 0;
        const normalizeToSourceAspectRatio = () => {
          if (!image.naturalWidth || !image.naturalHeight || !frame.isConnected) return;
          if (alignment.clientWidth === 0) {
            normalizationFrame = requestAnimationFrame(normalizeToSourceAspectRatio);
            return;
          }
          const ratio = image.naturalWidth / image.naturalHeight;
          const maxWidth = Math.max(MIN_WIDTH, alignment.clientWidth);
          let width = Math.min(maxWidth, inlineImage.width);
          let height = width / ratio;
          if (height < MIN_HEIGHT) {
            height = MIN_HEIGHT;
            width = Math.min(maxWidth, height * ratio);
            height = width / ratio;
          }
          if (height > MAX_HEIGHT) {
            height = MAX_HEIGHT;
            width = Math.min(maxWidth, height * ratio);
            height = width / ratio;
          }
          if (Math.abs(inlineImage.width - width) < 1 && Math.abs(inlineImage.height - height) < 1) return;
          frame.style.width = `${Math.round(width)}px`;
          frame.style.height = `${Math.round(height)}px`;
          viewZone.heightInPx = Math.round(height) + ZONE_PADDING;
          editor.changeViewZones((zones) => zones.layoutZone(zoneId));
          updateInlineImageSize(state, inlineImage.id, width, height, true);
        };
        image.addEventListener("load", normalizeToSourceAspectRatio);
        if (image.complete) requestAnimationFrame(normalizeToSourceAspectRatio);

        for (const direction of HANDLE_DIRECTIONS) {
          const handle = document.createElement("button");
          handle.type = "button";
          handle.tabIndex = -1;
          handle.className = `inline-image-handle inline-image-handle-${direction}`;
          handle.setAttribute("aria-label", `Resize screenshot ${direction}`);
          let cancelActiveResize: (() => void) | null = null;

          const beginResize = (event: PointerEvent) => {
            event.preventDefault();
            event.stopPropagation();
            selectImage(inlineImage.id, true);
            const startX = event.clientX;
            const startY = event.clientY;
            const rect = frame.getBoundingClientRect();
            const startWidth = rect.width;
            const startHeight = rect.height;
            const maxWidth = Math.max(MIN_WIDTH, alignment.clientWidth);

            const move = (moveEvent: PointerEvent) => {
              const dx = moveEvent.clientX - startX;
              const dy = moveEvent.clientY - startY;
              let width = startWidth;
              let height = startHeight;
              if (direction.includes("e")) width = startWidth + dx;
              if (direction.includes("w")) width = startWidth - dx;
              if (direction.includes("s")) height = startHeight + dy;
              if (direction.includes("n")) height = startHeight - dy;

              const widthScale = width / startWidth;
              const heightScale = height / startHeight;
              const requestedScale = Math.abs(widthScale - 1) >= Math.abs(heightScale - 1)
                ? widthScale
                : heightScale;
              const minScale = Math.max(MIN_WIDTH / startWidth, MIN_HEIGHT / startHeight);
              const maxScale = Math.min(maxWidth / startWidth, MAX_HEIGHT / startHeight);
              const scale = Math.min(maxScale, Math.max(minScale, requestedScale));
              width = startWidth * scale;
              height = startHeight * scale;

              frame.style.width = `${Math.round(width)}px`;
              frame.style.height = `${Math.round(height)}px`;
              viewZone.heightInPx = Math.round(height) + ZONE_PADDING;
              editor.changeViewZones((zones) => zones.layoutZone(zoneId));
              updateInlineImageSize(state, inlineImage.id, width, height);
            };

            const finish = () => {
              cancelActiveResize?.();
              cancelActiveResize = null;
              updateInlineImageSize(state, inlineImage.id, frame.offsetWidth, frame.offsetHeight, true);
            };
            cancelActiveResize = () => {
              window.removeEventListener("pointermove", move);
              window.removeEventListener("pointerup", finish);
              window.removeEventListener("pointercancel", finish);
            };
            window.addEventListener("pointermove", move);
            window.addEventListener("pointerup", finish);
            window.addEventListener("pointercancel", finish);
          };

          handle.addEventListener("pointerdown", beginResize);
          frame.appendChild(handle);
          zoneCleanup.push(() => {
            cancelActiveResize?.();
            handle.removeEventListener("pointerdown", beginResize);
          });
        }

        zoneCleanup.push(() => {
          cancelAnimationFrame(normalizationFrame);
          image.removeEventListener("load", normalizeToSourceAspectRatio);
          frame.removeEventListener("pointerdown", selectFromPointer);
        });
      });
    });
    applySelection(!!selectedId);
  }

  const unsubscribe = subscribeInlineImages(state, render);
  const editorMouseSubscription = editor.onMouseDown(() => selectImage(null));
  const editorDomNode = editor.getDomNode();
  const handleSelectedImageKey = (event: KeyboardEvent) => {
    if (!selectedId) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      selectImage(null);
      editor.focus();
      return;
    }
    if (event.key !== "Delete" && event.key !== "Backspace") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const removingId = selectedId;
    selectedId = null;
    removeInlineImage(state, removingId);
    editor.focus();
  };
  editorDomNode?.addEventListener("keydown", handleSelectedImageKey, true);
  render();
  return {
    render,
    dispose() {
      disposed = true;
      unsubscribe();
      editorMouseSubscription.dispose();
      editorDomNode?.removeEventListener("keydown", handleSelectedImageKey, true);
      clearZones();
    },
  };
}

export async function pasteInlineImages(
  editor: monaco.editor.IStandaloneCodeEditor,
  state: NoteModelState,
  files: File[],
): Promise<void> {
  if (!state.loaded || files.length === 0) return;
  const position = editor.getPosition();
  if (!position) return;
  const at = state.model.getOffsetAt(position);
  for (const file of files) addInlineImage(state, await fileToInlineImage(file, at));
}

export async function pasteNativeClipboard(
  editor: monaco.editor.IStandaloneCodeEditor,
  state: NoteModelState,
): Promise<void> {
  const clipboard = await invoke<NativeClipboardContent>("read_native_clipboard");
  if (clipboard.image) {
    if (clipboard.image.size > MAX_ATTACHMENT_BYTES) throw new Error("Screenshot exceeds the 10MB attachment limit.");
    const position = editor.getPosition();
    if (!position) return;
    const size = displaySize(clipboard.image.width, clipboard.image.height);
    addInlineImage(state, {
      id: crypto.randomUUID(),
      mimeType: clipboard.image.mimeType,
      size: clipboard.image.size,
      data: clipboard.image.data,
      at: state.model.getOffsetAt(position),
      width: size.width,
      height: size.height,
    });
    return;
  }
  if (clipboard.text) {
    editor.trigger("native-clipboard", "paste", {
      text: clipboard.text,
      pasteOnNewLine: false,
      multicursorText: null,
      mode: null,
    });
  }
}
