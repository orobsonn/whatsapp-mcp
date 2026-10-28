// Flue contributes runtime classes, never an implicit public agent router.
import { installEpisodeRuntime } from "./agent-runtime/install";
import { resolveInstalledRuntime } from "./agent-runtime/runtime";
installEpisodeRuntime(resolveInstalledRuntime);
export { default } from "./index";
