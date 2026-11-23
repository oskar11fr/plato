import type { IDockviewPanelProps } from "dockview-react";
import { PdfView } from "../pdf/PdfView";
import { openChat, type FileParams } from "./open";

export function PdfPane({ params, containerApi }: IDockviewPanelProps<FileParams>) {
  return (
    <PdfView
      path={params.path}
      onOpenChat={() => openChat(containerApi, params.path)}
      // Next step: the highlight becomes a new turn in the document's chat.
      onAskAi={() => openChat(containerApi, params.path)}
    />
  );
}
