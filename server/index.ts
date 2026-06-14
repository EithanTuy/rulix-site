import { createApp } from "./app";
import { getAnthropicRuntime } from "./anthropicCouncil";

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";
const app = createApp();
const provider = getAnthropicRuntime();

app.listen(port, host, () => {
  console.log(
    `Rulix ECCN API listening on http://${host}:${port} (${provider.configured ? "Anthropic configured" : "local fallback"}, model ${provider.model})`
  );
});
