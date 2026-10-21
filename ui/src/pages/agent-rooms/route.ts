import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";

export const page = definePage({
  ...routePageSpec("agent-rooms"),
  component: () =>
    import("./agent-rooms-page.ts").then(() => ({
      header: true,
      render: () => html`<openclaw-agent-rooms-page></openclaw-agent-rooms-page>`,
    })),
});
