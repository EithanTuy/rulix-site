import { createApp } from "./app";
import { getBedrockRuntime } from "./bedrockCouncil";

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";
const app = createApp();
const provider = getBedrockRuntime();

app.listen(port, host, () => {
  console.log(
    `Rulix ECCN API listening on http://${host}:${port} (${provider.configured ? "Bedrock configured" : "live AI unavailable"}, model ${provider.model})`
  );
});
