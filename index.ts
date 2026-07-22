import {
  definePluginEntry,
  type OpenClawPluginApi,
  type OpenClawPluginDefinition,
} from "openclaw/plugin-sdk/plugin-entry";
import { resolveConfiguredSecretInputWithFallback } from "openclaw/plugin-sdk/secret-input-runtime";
import {
  createBoundedSlackWebClient,
  registerSlackSubagentCardHandlers,
  type PluginApi,
} from "./plugin-handlers.js";

const plugin: OpenClawPluginDefinition = definePluginEntry({
  id: "slack-subagent-card",
  name: "Slack Subagent Card",
  description:
    "Posts and updates a Slack Block Kit status card for sub-agent work in Slack threads.",

  register(api: OpenClawPluginApi) {
    const pluginApi: PluginApi = Object.assign(api, {
      createSlackWebClient: createBoundedSlackWebClient,
      resolveConfiguredSecretInputWithFallback,
    });
    registerSlackSubagentCardHandlers(pluginApi);
  },
});

export default plugin;
