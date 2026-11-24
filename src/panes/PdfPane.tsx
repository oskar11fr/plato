import type { IDockviewPanelProps } from "dockview-react";
import { passageToChat } from "../lib/bus";
import { PdfView } from "../pdf/PdfView";
import { openChat, type FileParams } from "./open";

export function PdfPane({ params, containerApi }: IDockviewPanelProps<FileParams>) {
  return (
    <PdfView
      path={params.path}
      onOpenChat={() => openChat(containerApi, params.path)}
      onAskAi={(h, pageText) => {
        // Attach the passage to the document's chat (delivered once it opens).
        passageToChat.emit(params.path, { highlightId: h.id, page: h.page, quote: h.quote, pageText });
        openChat(containerApi, params.path);
      }}
      onShowChat={(chatPath) => openChat(containerApi, params.path, chatPath)}
    />
  );
}
