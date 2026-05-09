import { OpenRouter } from "@openrouter/sdk";
import { config, type ModelConfig } from "./config.ts";

export type LLMResponse = {
  model: string;
  content: string;
};

export class OpenRouterService {
  private client: OpenRouter;
  private config: ModelConfig;
  constructor(configOverride?: ModelConfig) {
    this.config = configOverride ?? config;

    this.client = new OpenRouter({
      apiKey: config.apiKey,
      httpReferer: config.httpReferer,
      appTitle: config.appTitle,
    });
  }

  async generate(prompt: string): Promise<LLMResponse> {

    const response = await this.client.chat.send({
        chatRequest: {
            models: this.config.models,
            messages: [
                { role: 'system', content: this.config.systemPrompt },
                { role: 'user', content: prompt}
            ],
            stream: false,
            temperature: this.config.temperature,
            maxTokens: this.config.maxTokens,
            provider: this.config.provider
        }
    })

    const content = String(response.choices.at(0)?.message.content) ?? "";
    return {
      model: response.model,
      content,
    };
  }
}
