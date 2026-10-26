// Flue contributes runtime classes, never an implicit public agent router.
import { installEpisodeRuntime } from "./agent-runtime/install";
import { resolveRuntimeEpisode } from "./agent-runtime/runtime";
installEpisodeRuntime(resolveRuntimeEpisode);
export { default } from "./index";
