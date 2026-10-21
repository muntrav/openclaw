import { defineSolidPage } from "../../app-route-types.tsx";

export const page = defineSolidPage("agent-rooms", () =>
  import("./agent-rooms-page.tsx").then((module) => module.AgentRoomsPage),
);
