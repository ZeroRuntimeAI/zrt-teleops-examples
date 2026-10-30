import type { Metadata } from "next";
import { simFiles } from "../../server/simFiles";
import { Workspace } from "../../ui/Workspace";

export const metadata: Metadata = { title: "Tabletop · ZeroRuntime Studio" };

export default function TabletopPage() {
  return <Workspace files={simFiles} />;
}
