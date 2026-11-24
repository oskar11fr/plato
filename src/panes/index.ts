import type { IDockviewPanelProps } from "dockview-react";
import type { FunctionComponent } from "react";
import { ChatPane } from "./ChatPane";
import { PdfPane } from "./PdfPane";
import { SettingsPane } from "./SettingsPane";
import { SummaryPane } from "./SummaryPane";
import { TextPane } from "./TextPane";

export * from "./open";

export const paneComponents: Record<string, FunctionComponent<IDockviewPanelProps>> = {
  pdf: PdfPane,
  text: TextPane,
  chat: ChatPane,
  settings: SettingsPane,
  summary: SummaryPane,
};
